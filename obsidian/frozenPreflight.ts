import { readTemplateMode } from '../src/template-derive/templateMetadata';
import { createHash } from 'crypto';
import * as path from 'path';
import { ConversionConfig } from '../src/config';
import { convertString } from '../src/converterApi';
import { rewriteObsidianImageEmbeds } from '../src/obsidianImageEmbeds';
import { inspectTemplate } from '../src/templateInspector';
import type { ResolvedImageAsset } from '../src/types';
import { artifactId } from './artifactIdentity';
import { SelectionRecorder } from '../src/selectionObservation';
import { ObservedBlockRecorder } from '../src/observedBlockIndex';
import { PREFLIGHT_MAX_FILE_BYTES, readBoundedPreflightInput, withPreflightTemplate } from './preflightTemplate';

const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_INPUTS = 32;
const digest = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

/** Sorted-key JSON for the finite JSON values used by ConversionConfig. */
function canonicalJson(value: unknown): string {
    const normalize = (item: unknown): unknown => {
        if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid conversion configuration.');
        if (item === null || ['string', 'boolean', 'number'].includes(typeof item)) return item;
        if (Array.isArray(item)) return item.map(normalize);
        if (typeof item !== 'object') throw new Error('Invalid conversion configuration.');
        return Object.fromEntries(Object.entries(item as Record<string, unknown>)
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, entry]) => [key, normalize(entry)]));
    };
    return JSON.stringify(normalize(value));
}

function vaultPath(root: string, absolute: string): string {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (!relative || path.isAbsolute(relative) || relative.split('/').some(part => !part || part.startsWith('.'))) {
        throw new Error('Preflight input path outside the user Vault.');
    }
    return relative;
}

/** Trial conversion using one read per included image and reporting their used hashes. */
export async function frozenPreflight(input: {
    markdown: string;
    noteAbsolutePath: string;
    templateAbsolutePath: string;
    outputAbsolutePath: string;
    vaultRoot: string;
    config: ConversionConfig;
    signal?: AbortSignal;
    noteIdentity?: { sha256: string; sizeBytes: number };
    /** Internal only; never include this index in check_export's model result. */
    captureBlockIndex?: boolean;
    resolveImage(source: string): string | null;
}) {
    input.signal?.throwIfAborted();
    const root = path.resolve(input.vaultRoot);
    const template = path.resolve(input.templateAbsolutePath);
    const templatePath = vaultPath(root, template);
    const notePath = vaultPath(root, path.resolve(input.noteAbsolutePath));
    const textBytes = Buffer.byteLength(input.markdown, 'utf8');
    const noteSize = input.noteIdentity?.sizeBytes ?? textBytes + 3;
    if (!Number.isSafeInteger(noteSize) || noteSize < 0 || noteSize > PREFLIGHT_MAX_FILE_BYTES)
        throw new Error('Preflight note exceeds byte budget.');
    if (input.noteIdentity) {
        const hasBom = noteSize === textBytes + 3;
        if (!/^[a-f0-9]{64}$/.test(input.noteIdentity.sha256) || (!hasBom && noteSize !== textBytes))
            throw new Error('Preflight note identity is invalid.');
        const hasher = createHash('sha256');
        if (hasBom) hasher.update(Buffer.from([0xef, 0xbb, 0xbf]));
        if (hasher.update(input.markdown, 'utf8').digest('hex') !== input.noteIdentity.sha256)
            throw new Error('Preflight note bytes do not match identity.');
    }
    const values = JSON.parse(canonicalJson(input.config)) as Partial<ConversionConfig>;
    const config = Object.assign(new ConversionConfig(), values);
    const configDigest = digest(canonicalJson(config));
    if (input.captureBlockIndex && !input.noteIdentity) throw new Error('Block indexing requires the bound note identity.');
    const selectionRecorder = input.captureBlockIndex ? new ObservedBlockRecorder() : new SelectionRecorder();
    const byPath = new Map<string, ResolvedImageAsset>();
    const bySource = new Map<string, ResolvedImageAsset | null>();
    const dependencies: Array<{ path: string; sha256: string }> = [];
    let total = noteSize;
    const record = (absolute: string, bytes: Buffer) => {
        const relative = vaultPath(root, absolute);
        total += bytes.byteLength;
        if (bytes.byteLength > PREFLIGHT_MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || dependencies.length >= MAX_INPUTS - 1)
            throw new Error('Preflight input byte or count budget exceeded.');
        dependencies.push({ path: relative, sha256: digest(bytes) });
    };
    const asset = (source: string): ResolvedImageAsset | null => {
        input.signal?.throwIfAborted();
        if (bySource.has(source)) return bySource.get(source) ?? null;
        const candidate = input.resolveImage(source);
        input.signal?.throwIfAborted();
        if (!candidate) { bySource.set(source, null); return null; }
        const absolute = path.resolve(candidate);
        vaultPath(root, absolute);
        let existing = byPath.get(absolute);
        if (!existing) {
            const ext = path.extname(absolute).slice(1).toLowerCase();
            if (!['png', 'jpg', 'jpeg', 'gif'].includes(ext)) throw new Error('Unsupported bound image type.');
            const bytes = readBoundedPreflightInput(absolute, PREFLIGHT_MAX_FILE_BYTES);
            record(absolute, bytes);
            existing = { bytes, ext: ext === 'jpeg' ? 'jpg' : ext as 'png' | 'jpg' | 'gif' };
            byPath.set(absolute, existing);
        }
        bySource.set(source, existing);
        return existing;
    };
    const result = await withPreflightTemplate(template, input.outputAbsolutePath, async (frozenTemplate) => {
        const bytes = readBoundedPreflightInput(frozenTemplate, PREFLIGHT_MAX_FILE_BYTES);
        record(template, bytes);
        const mode = await readTemplateMode(bytes, input.signal);
        return convertString(rewriteObsidianImageEmbeds(input.markdown), input.outputAbsolutePath, {
            referenceDoc: frozenTemplate,
            config,
            inputPath: input.noteAbsolutePath,
            imageAssetResolver: asset,
            strictImageAssetResolver: true,
            signal: input.signal,
            selectionObserver: selectionRecorder,
            splitRoleMarkerLines: mode.derived,
        });
    }, inspectTemplate, PREFLIGHT_MAX_FILE_BYTES, input.signal);
    if (dependencies[0]?.path !== templatePath || dependencies[0]?.sha256 !== result.templateSha256)
        throw new Error('Frozen template identity changed.');
    const blockIndex = selectionRecorder instanceof ObservedBlockRecorder ? selectionRecorder.index() : null;
    return { ...result, artifactId: artifactId(), configDigest, selectionSummary: selectionRecorder.summary(),
        ...(selectionRecorder instanceof ObservedBlockRecorder && blockIndex ? {
            blockIndex, trialOutputAnchors: selectionRecorder.outputAnchors(blockIndex),
        } : {}), templateAndImageDependencies: dependencies,
        inputDependencies: input.noteIdentity ? [{ path: notePath, sha256: input.noteIdentity.sha256 }, ...dependencies] : null };
}
