import { DialectError } from '../src/template-derive/templateMetadata';
import type { ExportProviderHost } from './agentProvider';
import { loadNoteTemplate } from './templateLoader';
import { readBoundBytes, summarizeDerivedBlocks } from './derivedExport';
import { dependenciesCurrent, mergeDependencies, DeriveProviderError, userPath } from './deriveProvider';
import { readStructureSource } from '../src/template-derive/structure';
import { inspectTemplateXml } from '../src/templateInspector';
import { serialize } from '../src/template-derive/dom';
import { conversionFingerprint } from '../src/conversionFingerprint';

export async function previewTemplateExport(
    host: ExportProviderHost,
    args: Record<string, unknown>,
    signal?: AbortSignal
): Promise<Record<string, unknown>> {
    const keys = ['note_path', 'expected_note_sha256', 'expected_template_sha256'];
    if (
        Object.keys(args).length !== keys.length ||
        keys.some((k) => !(k in args)) ||
        typeof args.expected_note_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(args.expected_note_sha256)
    )
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Bound note and template SHA-256 required.');
    const note = userPath(args.note_path);
    if (!/\.md$/i.test(note)) throw new DeriveProviderError('INVALID_ARGUMENT', 'Markdown note required.');
    await readBoundBytes(host, note, args.expected_note_sha256);
    const loaded = await loadNoteTemplate(host, note, undefined, args.expected_template_sha256, signal);
    if (loaded.source !== 'frontmatter') throw new DeriveProviderError('INVALID_ARGUMENT', 'Template preview requires note hwpx-template.');
    const dependencies = [
        { path: note, sha256: args.expected_note_sha256 },
        { path: loaded.path, sha256: loaded.sha256 },
    ];
    const source = await readStructureSource(loaded.bytes, signal);
    const markers = inspectTemplateXml(serialize(source.header), serialize(source.section)).markers.map((m) => m.marker.slice(2, -2));
    const base = { templateSha256: loaded.sha256, derivedMode: loaded.derivedMode, ...(loaded.dialect === 'hwpx-exporter-md/2' ? { dialect: loaded.dialect } : {}) };
    try {
        const rendered = await host.render(note, loaded.path, signal, false, true);
        if (!(await dependenciesCurrent(host, mergeDependencies([...dependencies, ...(rendered.inputDependencies ?? [])]))))
            throw new DeriveProviderError('SOURCE_CHANGED', 'Inputs changed during template preview.');
        if (!rendered.blockIndex) throw new Error('Template output observations unavailable.');
        const result = {
            ...base,
            converts: true,
            ...summarizeDerivedBlocks(rendered.blockIndex, { bindings: markers.map((marker) => ({ marker })) }),
            warnings: rendered.report.warnings,
            conversionFingerprint: await conversionFingerprint(rendered.bytes, signal),
        };
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024)
            throw new DeriveProviderError('PREVIEW_RESULT_TOO_LARGE', 'Preview result exceeds 256 KiB.');
        return result;
    } catch (error) {
        if (signal?.aborted || error instanceof DeriveProviderError || error instanceof DialectError) throw error;
        if (!(await dependenciesCurrent(host, dependencies)))
            throw new DeriveProviderError('SOURCE_CHANGED', 'Inputs changed during template preview.');
        return {
            ...base,
            converts: false,
            failure: { code: 'CONVERSION_FAILED', message: String(error).slice(0, 1000) || 'Conversion failed.' },
        };
    }
}
