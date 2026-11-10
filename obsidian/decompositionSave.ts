import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommitPreparation, CommitReceipt, ExportProviderHost } from './agentProvider';
import { DeriveProviderError, userPath } from './deriveProvider';
import { validatedBundle, readBoundBytes } from './derivedExport';
import { deriveFromBindings } from '../src/template-derive/derive';
import { byteDigest } from '../src/template-derive/digest';
import { conversionFingerprint } from '../src/conversionFingerprint';
import { convertString } from '../src/converterApi';
import { DEFAULT_CONFIG, type ConversionConfig } from '../src/config';

export type PreparedDecompositionFile = { path: string; bytes: Uint8Array };
function validateOutputName(output: string): void {
    const name = path.posix.basename(output),
        stem = name.slice(0, -path.posix.extname(name).length);
    // Match Document Jobs' cross-platform output_name rules and final filename cap.
    if (
        !stem.trim() ||
        stem.length > 250 ||
        name.length > 255 ||
        /[. ]$/.test(stem) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ||
        [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Invalid decomposition output name.');
}
export async function assertDecompositionPathsFree(host: ExportProviderHost, paths: string[]): Promise<void> {
    if (!host.hasPathCollision) throw new DeriveProviderError('INVALID_ARGUMENT', 'Normalized path collision check unavailable.');
    for (const p of paths)
        if ((await host.hasPathCollision(p)) || host.exists(p) || (await host.readBytes(p)))
            throw new DeriveProviderError('ALREADY_EXISTS', `Decomposition output already exists: ${p}`);
}

export async function resolveDecompositionSave(host: ExportProviderHost, args: Record<string, unknown>) {
    const keys = ['derive_from', 'markdown', 'expected_markdown_sha256', 'template_output_path', 'text_output_path', 'record'];
    if (Object.keys(args).length !== keys.length || keys.some((k) => !(k in args)))
        throw new DeriveProviderError(
            'INVALID_ARGUMENT',
            'Exact decomposition arguments required; profile arguments are mutually exclusive.'
        );
    const template = userPath(args.template_output_path),
        text = userPath(args.text_output_path);
    validateOutputName(template);
    validateOutputName(text);
    if (
        !/\.hwpx$/i.test(template) ||
        !/\.md$/i.test(text) ||
        path.posix.dirname(template) !== path.posix.dirname(text) ||
        /[:*?"<>|]/.test(template + text)
    )
        throw new DeriveProviderError('INVALID_ARGUMENT', 'New HWPX and Markdown outputs must be in the same folder.');
    if (typeof args.markdown !== 'string' || Buffer.byteLength(args.markdown, 'utf8') > 512 * 1024)
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Markdown must be UTF-8 <=512 KiB.');
    const markdownBytes = Buffer.from(args.markdown, 'utf8');
    if (typeof args.expected_markdown_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expected_markdown_sha256))
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Expected Markdown SHA-256 required.');
    if (byteDigest(markdownBytes) !== args.expected_markdown_sha256)
        throw new DeriveProviderError('SOURCE_CHANGED', 'Markdown hash mismatch.');
    const bundle = validatedBundle(args.derive_from);
    const record = args.record as Record<string, unknown> | null;
    const fields = ['decompositionId', 'dialect', 'sourcePath', 'sourceSha256', 'textFile'];
    fields.push('rulesVersion', 'catalogVersion');
    if (
        !record ||
        typeof record !== 'object' ||
        Object.keys(record).length !== fields.length ||
        fields.some((k) => typeof record[k] !== 'string' || (record[k]).length > 4096) ||
        !/^[a-f0-9]{64}$/.test(record.decompositionId as string) ||
        record.dialect !== bundle.dialect ||
        (record.rulesVersion !== bundle.rulesVersion || record.catalogVersion !== bundle.catalogVersion) ||
        record.sourcePath !== bundle.sample_path ||
        record.sourceSha256 !== bundle.expected_sample_sha256 ||
        record.textFile !== path.posix.basename(text)
    )
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Invalid decomposition pair record or textFile mismatch.');
    await assertDecompositionPathsFree(host, [template, text]);
    await readBoundBytes(host, bundle.sample_path, bundle.expected_sample_sha256);
    return {
        target: {
            kind: 'new' as const,
            destination: template,
            template: { path: bundle.sample_path, sha256: bundle.expected_sample_sha256 },
        },
        bundle,
        markdownBytes,
        text,
        record: {
            rulesVersion: bundle.rulesVersion, catalogVersion: bundle.catalogVersion,
            decompositionId: record.decompositionId as string,
            dialect: bundle.dialect,
            sourcePath: record.sourcePath,
            sourceSha256: record.sourceSha256,
            textFile: record.textFile,
            textSha256: args.expected_markdown_sha256,
        },
    };
}

/** Same conversion options as the decomposition trial; no Vault writes. */
async function decompositionConversionFingerprint(
    host: ExportProviderHost,
    markdown: string,
    templateBytes: Uint8Array,
    signal?: AbortSignal
) {
    signal?.throwIfAborted();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-decomposition-save-'));
    try {
        const template = path.join(work, 'template.hwpx'),
            output = path.join(work, 'output.hwpx');
        fs.writeFileSync(template, templateBytes);
        await convertString(markdown, output, {
            referenceDoc: template,
            config: { ...DEFAULT_CONFIG, PAGE_BREAK_BEFORE_H1: host.options().pageBreakBeforeH1 } as ConversionConfig,
            splitRoleMarkerLines: true,
            strictImageAssetResolver: true,
            signal,
        });
        signal?.throwIfAborted();
        return {
            fingerprint: await conversionFingerprint(new Uint8Array(fs.readFileSync(output)), signal),
            providerInternalWrites: [work, template, output],
        };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

export async function prepareDecompositionSave(host: ExportProviderHost, args: Record<string, unknown>, signal?: AbortSignal) {
    const resolved = await resolveDecompositionSave(host, args);
    signal?.throwIfAborted();
    const sampleBytes = await readBoundBytes(host, resolved.bundle.sample_path, resolved.bundle.expected_sample_sha256);
    const result = await deriveFromBindings({ sampleBytes, bundle: resolved.bundle, record: resolved.record, signal });
    // The decomposition trial uses the unrecorded template. Pair data also changes
    // manifest provenance, so reproduce that trial rather than changing its digest.
    const trial = await deriveFromBindings({ sampleBytes, bundle: resolved.bundle, signal });
    const conversion = await decompositionConversionFingerprint(host, resolved.markdownBytes.toString('utf8'), trial.bytes, signal);
    const files = [
        { path: resolved.target.destination, bytes: result.bytes },
        { path: resolved.text, bytes: Uint8Array.from(resolved.markdownBytes) },
    ];
    const folders = [...new Set(files.flatMap((f) => host.missingFolders(f.path)))];
    const writeSet: CommitPreparation['writeSet'] = [
        ...folders.map((p) => ({
            kind: 'folder' as const,
            path: p,
            op: 'create' as const,
            role: 'folder' as const,
            existedBefore: false as const,
        })),
        ...files.map((f, i) => ({
            kind: 'file' as const,
            path: f.path,
            op: 'create' as const,
            role: i === 0 ? ('primary' as const) : ('derived' as const),
            sha256Before: null,
            sha256Expected: byteDigest(f.bytes),
            sizeBytes: f.bytes.byteLength,
        })),
    ];
    return {
        files,
        writeSet,
        notePath: resolved.text,
        providerInternalWrites: conversion.providerInternalWrites,
        inputDependencies: [{ path: resolved.bundle.sample_path, sha256: resolved.bundle.expected_sample_sha256 }],
        report: {
            decompositionId: resolved.record.decompositionId,
            textSha256: resolved.record.textSha256,
            templateSha256: byteDigest(result.bytes),
            conversionFingerprint: conversion.fingerprint,
        },
    };
}

/** Dedicated two-file path: each item is written and read back independently; never rolls back. */
export async function executeDecompositionSave(
    host: ExportProviderHost,
    shown: CommitPreparation,
    files: PreparedDecompositionFile[],
    ticketId: string,
    signal?: AbortSignal,
    cancelled: () => boolean = () => false
): Promise<CommitReceipt> {
    const entries: CommitReceipt['entries'] = shown.writeSet.map((e) => ({ path: e.path, kind: e.kind, state: 'not_written' }));
    let error: CommitReceipt['error'];
    const folders = shown.writeSet.filter((e) => e.kind === 'folder').map((e) => e.path);
    for (const file of files) {
        const entry = entries.find((e) => e.kind === 'file' && e.path === file.path)!;
        const expected = shown.writeSet.find((e) => e.kind === 'file' && e.path === file.path)!;
        let attempted = false;
        try {
            signal?.throwIfAborted();
            if (cancelled()) throw new DeriveProviderError('CANCELLED', 'Save cancelled.');
            await assertDecompositionPathsFree(host, [file.path]);
            signal?.throwIfAborted();
            if (cancelled()) throw new DeriveProviderError('CANCELLED', 'Save cancelled.');
            attempted = true;
            await host.writeNew(file.path, Uint8Array.from(file.bytes), folders);
        } catch (cause) {
            error = {
                code: cause instanceof DeriveProviderError ? cause.code : signal?.aborted ? 'CANCELLED' : 'WRITE_FAILED',
                message: String(cause).slice(0, 1000),
            };
        }
        if (!attempted) break;
        try {
            const after = await host.readBytes(file.path);
            if (after) {
                const hash = byteDigest(after);
                entry.sha256After = hash;
                entry.state = expected.kind === 'file' && hash === expected.sha256Expected ? 'written' : 'unknown';
            }
        } catch (cause) {
            entry.state = 'unknown';
            error ??= { code: 'READBACK_FAILED', message: String(cause).slice(0, 1000) };
        }
        if (error || entry.state !== 'written') break;
    }
    for (const entry of entries.filter((e) => e.kind === 'folder')) {
        try {
            entry.state = host.missingFolders(`${entry.path}/_`).includes(entry.path) ? 'not_written' : 'written';
        } catch {
            entry.state = 'unknown';
        }
    }
    const states = entries.map((e) => e.state);
    return {
        preparationId: shown.preparationId,
        ticketId,
        preparationDigest: shown.preparationDigest,
        state: states.includes('unknown')
            ? 'unknown'
            : states.every((s) => s === 'written')
              ? 'written'
              : states.includes('written')
                ? 'partial'
                : 'not_written',
        entries,
        warnings: [],
        ...(error ? { error } : {}),
    };
}
