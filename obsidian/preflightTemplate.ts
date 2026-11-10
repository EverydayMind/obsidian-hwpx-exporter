import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const PREFLIGHT_MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Read from one open handle with a hard allocation cap, even if the file grows. */
export function readBoundedPreflightInput(inputPath: string, maxBytes: number): Buffer {
    const fd = fs.openSync(inputPath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > maxBytes) throw new Error('Preflight input exceeds byte budget.');
        const bytes = Buffer.allocUnsafe(stat.size + 1);
        let used = 0;
        while (used < bytes.length) {
            const read = fs.readSync(fd, bytes, used, bytes.length - used, null);
            if (read === 0) break;
            used += read;
        }
        if (used > stat.size) throw new Error('Preflight input grew while being read.');
        return bytes.subarray(0, used);
    } finally {
        fs.closeSync(fd);
    }
}

// The caller owns the private work directory and removes it after the check.
export async function withPreflightTemplate<T, I>(
    templatePath: string,
    outputPath: string,
    convert: (frozenTemplatePath: string) => Promise<T>,
    inspect: (frozenTemplatePath: string) => Promise<I>,
    maxBytes?: number,
    signal?: AbortSignal,
): Promise<{ report: T; templateSha256: string; inspection?: I }> {
    signal?.throwIfAborted();
    const templateBytes = maxBytes === undefined
        ? fs.readFileSync(templatePath)
        : readBoundedPreflightInput(templatePath, maxBytes);
    const frozenTemplate = path.join(path.dirname(outputPath), 'check-template.hwpx');
    signal?.throwIfAborted();
    fs.writeFileSync(frozenTemplate, templateBytes, { flag: 'wx' });
    const report = await convert(frozenTemplate);
    signal?.throwIfAborted();
    let inspection: I | undefined;
    try { inspection = await inspect(frozenTemplate); } catch { /* Inspection is best-effort. */ }
    signal?.throwIfAborted();
    return { report, templateSha256: createHash('sha256').update(templateBytes).digest('hex'), inspection };
}
