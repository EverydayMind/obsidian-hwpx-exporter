import type { ExportProviderHost } from './agentProvider';
import { DeriveProviderError, dependenciesCurrent, userPath } from './deriveProvider';
import { readBoundBytes } from './derivedExport';
import { readDecompositionRecord, templatePayloadSha256 } from '../src/template-derive/decompositionRecord';
import { allElements, ancestor } from '../src/template-derive/dom';
import { descendants, is, NS } from '../src/template-derive/xml';
import { parseMarkerOptions } from '../src/templateMarkers';
import { collectAssets } from '../src/template-derive/sanitizePackage';
import { readStructureSource } from '../src/template-derive/structure';

/** Host-only inspection. Pair metadata is integrity data, never authorization. */
export async function inspectDecompositionTemplate(host: ExportProviderHost, args: Record<string, unknown>, signal?: AbortSignal) {
    if (
        Object.keys(args).length !== 2 ||
        !('path' in args) ||
        !('expected_sha256' in args) ||
        typeof args.expected_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(args.expected_sha256)
    )
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Exact path and expected_sha256 required.');
    const path = userPath(args.path),
        expected = args.expected_sha256;
    if (!/\.hwpx$/i.test(path)) throw new DeriveProviderError('INVALID_ARGUMENT', 'HWPX template required.');
    signal?.throwIfAborted();
    const bytes = await readBoundBytes(host, path, expected);
    const source = await readStructureSource(bytes, signal);
    if (source.sectionCount !== 1) throw new DeriveProviderError('UNSUPPORTED_FORMAT', 'Single-section template required.');
    const pair = readDecompositionRecord(source.section, true);
    const payloadSha256 = templatePayloadSha256(
        source.header,
        source.section,
        source.manifest,
        collectAssets(source.section, source.manifest, source.zip)
    );
    signal?.throwIfAborted();
    if (!(await dependenciesCurrent(host, [{ path, sha256: expected }])))
        throw new DeriveProviderError('SOURCE_CHANGED', 'Template changed during inspection.');
    signal?.throwIfAborted();
    const inventory = new Map<string, { marker: string; count: number; prefix: string }>();
    for (const paragraph of descendants(source.section, 'p', NS.para)) {
        const text = allElements(paragraph).filter(n => is(n, 't', NS.para) && ancestor(n, 'p') === paragraph)
            .map(n => Array.from(n.childNodes).map(c => c.nodeType === 1 && is(c as import('@xmldom/xmldom').Element, 'tab', NS.para) ? '\t' : c.textContent ?? '').join('')).join('');
        for (const match of text.matchAll(/\{\{([^{}\r\n]+)\}\}/g)) {
            const marker = (parseMarkerOptions(match[1])?.canonical ?? match[0]).slice(2, -2);
            const current = inventory.get(marker);
            if (current) current.count++;
            else inventory.set(marker, { marker, count: 1, prefix: text.slice(0, match.index) });
        }
    }
    return { markerInventory: [...inventory.values()], derivedMode: pair.derivedMode, record: pair.record, ...(pair.recordRetired ? { recordRetired: pair.recordRetired } : {}), ...(pair.record ? { dialect: pair.dialect } : {}), payloadSha256 };
}
