import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExportProviderHost } from './agentProvider';
import { DeriveProviderError, dependenciesCurrent } from './deriveProvider';
import { validatedBundle, validateBundleDialect, readBoundBytes, summarizeDerivedBlocks } from './derivedExport';
import { deriveFromBindings } from '../src/template-derive/derive';
import { byteDigest } from '../src/template-derive/digest';
import { measureRoundTrip } from '../src/template-derive/roundTrip';
import { comparisonEvidence } from '../src/template-derive/roundTripV2';
import { readStructureSource } from '../src/template-derive/structure';
import { resolveFixedRanges } from '../src/template-derive/bundleValidation';
import { convertString } from '../src/converterApi';
import { DEFAULT_CONFIG, type ConversionConfig } from '../src/config';
import { ObservedBlockRecorder } from '../src/observedBlockIndex';
import { conversionFingerprint } from '../src/conversionFingerprint';
import { StyleError } from '../src/template-derive/limits';

export async function previewDecomposition(host: ExportProviderHost, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  if (Object.keys(input).some(k => !['derive_from', 'markdown', 'expected_markdown_sha256', 'allowed'].includes(k)) || typeof input.markdown !== 'string' || Buffer.byteLength(input.markdown, 'utf8') > 512 * 1024 || typeof input.expected_markdown_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_markdown_sha256)) throw new DeriveProviderError('INVALID_ARGUMENT', 'Bound Markdown UTF-8 <=512 KiB required.');
  const bundle = validatedBundle(input.derive_from);
  const allowed = input.allowed as { omitted_refs?: unknown } | undefined;
  if (!allowed || Object.keys(allowed).length !== 1 || !Array.isArray(allowed.omitted_refs) || allowed.omitted_refs.length > 2000 || allowed.omitted_refs.some(r => typeof r !== 'string' || r.length > 256 || !/^s[0-9]+(?:\/(?:p[0-9]+|t[0-9]+|c[0-9]+\.[0-9]+|h[0-9]+|f[0-9]+))*$/.test(r)) || new Set(allowed.omitted_refs).size !== allowed.omitted_refs.length) throw new DeriveProviderError('INVALID_ARGUMENT', 'allowed.omitted_refs must be a unique bounded ref list.');
  const omissions = [...(allowed.omitted_refs as string[])], markdown = input.markdown;
  if (byteDigest(Buffer.from(markdown, 'utf8')) !== input.expected_markdown_sha256) throw new DeriveProviderError('SOURCE_CHANGED', 'Markdown hash mismatch.');
  validateBundleDialect(bundle, markdown);
  const sample = await readBoundBytes(host, bundle.sample_path, bundle.expected_sample_sha256);
  const source = await readStructureSource(sample, signal);
  if (omissions.some(r => !source.indexed.elements.has(r))) throw new DeriveProviderError('INVALID_ARGUMENT', 'Unknown omitted ref.');
  let derived: Awaited<ReturnType<typeof deriveFromBindings>>;
  try { derived = await deriveFromBindings({ sampleBytes: sample, bundle, signal }); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (!(error instanceof StyleError) || error.code !== 'unsupported') throw new DeriveProviderError(error instanceof StyleError ? error.code.toUpperCase() : 'INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid derivation.');
    return { derivable: false, ...(bundle.schema === 'derive-bundle/3' ? { dialect: bundle.dialect } : {}), derivation_sha256: bundle.derivation_sha256, rejections: [{ marker: '*', ref: error.refs[0] ?? 's0', reason: error.message.slice(0, 1000) }] };
  }
  const base = { derivable: true, ...(bundle.schema === 'derive-bundle/3' ? { dialect: bundle.dialect } : {}), rejections: [], markers: bundle.bindings.map(b => b.marker), derivedTemplateSha256: byteDigest(derived.bytes), derivation_sha256: bundle.derivation_sha256 };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-decomposition-preview-'));
  try {
    signal?.throwIfAborted();
    const template = path.join(work, 'template.hwpx'), output = path.join(work, 'output.hwpx'); fs.writeFileSync(template, derived.bytes);
    const recorder = new ObservedBlockRecorder();
    const report = await convertString(markdown, output, { referenceDoc: template, config: { ...DEFAULT_CONFIG, PAGE_BREAK_BEFORE_H1: host.options().pageBreakBeforeH1 } as ConversionConfig, splitRoleMarkerLines: true, strictImageAssetResolver: true, signal, selectionObserver: recorder });
    signal?.throwIfAborted();
    const bytes = new Uint8Array(fs.readFileSync(output));
    let comparison: Record<string, unknown> = {};
    const roundTrip = await measureRoundTrip(sample, bytes, { omitted_refs: omissions }, resolveFixedRanges(bundle, source.indexed.nodes).map(r => r.ref), signal, bundle.schema === 'derive-bundle/3' ? async measured => { comparison = await comparisonEvidence(measured, sample, bytes, signal, omissions); } : undefined);
    if (!await dependenciesCurrent(host, [{ path: bundle.sample_path, sha256: bundle.expected_sample_sha256 }])) throw new DeriveProviderError('SOURCE_CHANGED', 'Sample changed during decomposition preview.');
    const result = { ...base, converts: true, ...summarizeDerivedBlocks(recorder.index(), bundle), warnings: report.warnings, conversionFingerprint: await conversionFingerprint(bytes, signal), roundTrip: { ...roundTrip, ...comparison } };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) throw new DeriveProviderError('PREVIEW_RESULT_TOO_LARGE', 'Preview result exceeds 256 KiB.');
    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof DeriveProviderError) throw error;
    return { ...base, converts: false, failure: { code: 'CONVERSION_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) || 'Conversion failed.' } };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
