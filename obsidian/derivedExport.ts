import { parseMarkdownStringWithFrontmatter } from '../src/frontmatterParser';
import { validateTemplateDialect } from '../src/template-derive/templateMetadata';
import { parseDeriveBundleV3, type DeriveBundleV3 } from '../src/template-derive/deriveBundleV3';
import type { ExportProviderHost } from './agentProvider';
import { DeriveProviderError, dependenciesCurrent, mergeDependencies, userPath } from './deriveProvider';
import { deriveFromBindings } from '../src/template-derive/derive';
import { byteDigest } from '../src/template-derive/digest';
import { StyleError } from '../src/template-derive/limits';
import { conversionFingerprint } from '../src/conversionFingerprint';
import { appliedOutputMarker } from '../src/outputParagraphAnchors';
import { isRecordedObservedBlockIndex, type ObservedBlockIndex } from '../src/observedBlockIndex';
import type { SelectionFact } from '../src/selectionObservation';
import { previewTemplateExport } from './templatePreview';
import { previewDecomposition } from './decompositionPreview';

export { deriveBundleInputSchema } from './documentJobInputSchemas';

export function validatedBundle(value: unknown): DeriveBundleV3 {
  try {
    const bundle = parseDeriveBundleV3(value);
    if (!/\.hwpx$/i.test(bundle.sample_path)) throw new Error('Sample must be an HWPX file.');
    return bundle;
  }
  catch (error) { throw new DeriveProviderError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid derive bundle.'); }
}
/** A bundle is the authority before a paired record has been saved. */
export function validateBundleDialect(bundle: { schema: string; dialect?: string }, markdown: string): void {
  if (bundle.schema === 'derive-bundle/3') validateTemplateDialect(bundle.dialect!, parseMarkdownStringWithFrontmatter(markdown).metadata['hwpx-dialect']);
}
export async function readBoundBytes(host: ExportProviderHost, path: string, expected: string): Promise<Uint8Array> {
  const canonicalPath = userPath(path);
  const bytes = await (host.readBytesBounded ? host.readBytesBounded(canonicalPath, 32 * 1024 * 1024) : host.readBytes(canonicalPath)).catch(() => null);
  if (!bytes || bytes.byteLength > 32 * 1024 * 1024 || byteDigest(bytes) !== expected) throw new DeriveProviderError('SOURCE_CHANGED', `Input missing, too large or changed: ${path}`);
  return Uint8Array.from(bytes);
}
export async function deriveBundleBytes(host: ExportProviderHost, bundle: DeriveBundleV3, signal?: AbortSignal) {
  const sample = await readBoundBytes(host, bundle.sample_path, bundle.expected_sample_sha256);
  try { return await deriveFromBindings({ sampleBytes: sample, bundle, signal }); }
  catch (error) {
    if (!(error instanceof StyleError)) throw new DeriveProviderError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid bundle references.');
    throw error;
  }
}

function marker(value: SelectionFact['requested']): string | null {
  if (!value.marker || value.markerState !== 'observed' || value.variantState === 'redacted') return null;
  const base = value.marker.slice(2, -2);
  return value.variantState === 'observed' && value.variant ? `${base}:${value.variant}` : base;
}
export function summarizeDerivedBlocks(index: ObservedBlockIndex, bundle: { bindings: { marker: string }[] }) {
  if (!isRecordedObservedBlockIndex(index)) throw new Error('Complete supported block observations unavailable.');
  if (index.state === 'unavailable') throw new Error(`Block observations unavailable: ${index.reason}`);
  const byMarker: Record<string, { requested: number; applied: number }> = Object.create(null) as Record<string, { requested: number; applied: number }>;
  const firstBlockByMarker: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const binding of bundle.bindings) byMarker[binding.marker] = { requested: 0, applied: 0 };
  const substitutions = new Map<string, number>();
  for (const block of index.blocks) {
    const applied = appliedOutputMarker(block.selection);
    const requested = block.selection.prefix ? applied : marker(block.selection.requested);
    if (requested && Object.prototype.hasOwnProperty.call(byMarker, requested)) byMarker[requested].requested++;
    if (applied && Object.prototype.hasOwnProperty.call(byMarker, applied)) {
      byMarker[applied].applied++;
      if (block.container === 'body' && block.parentIndex === null && !Object.prototype.hasOwnProperty.call(firstBlockByMarker, applied)) firstBlockByMarker[applied] = block.index;
    }
    for (const reason of block.selection.fallbacks) substitutions.set(reason, (substitutions.get(reason) ?? 0) + 1);
  }
  return { blocks: { total: index.blocks.length, topLevel: index.blocks.filter(block => block.parentIndex === null).length, byMarker,
    substituted: [...substitutions].map(([reason, count]) => ({ reason, count })) }, firstBlockByMarker };
}

export async function previewDerivedExport(host: ExportProviderHost, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!('derive_from' in input)) return previewTemplateExport(host, input, signal);
  if ('markdown' in input || 'expected_markdown_sha256' in input || 'allowed' in input) return previewDecomposition(host, input, signal);
  const allowed = new Set(['derive_from', 'note_path', 'expected_note_sha256']);
  if (Object.keys(input).some(key => !allowed.has(key)) || !('derive_from' in input) || (input.note_path === undefined) !== (input.expected_note_sha256 === undefined))
    throw new DeriveProviderError('INVALID_ARGUMENT', 'Derive bundle and optional bound note pair required.');
  const bundle = validatedBundle(input.derive_from);
  let derived: Awaited<ReturnType<typeof deriveBundleBytes>>;
  try { derived = await deriveBundleBytes(host, bundle, signal); }
  catch (error) {
    if (!(error instanceof StyleError)) throw error;
    if (error.code !== 'unsupported') throw new DeriveProviderError(error.code.toUpperCase(), error.message);
    if (!await dependenciesCurrent(host, [{ path: bundle.sample_path, sha256: bundle.expected_sample_sha256 }]))
      throw new DeriveProviderError('SOURCE_CHANGED', 'Sample changed during derivation.');
    const rejected = bundle.bindings.filter(binding => error.refs.includes(binding.representativeRef));
    const rejections = rejected.length ? rejected.map(binding => ({ marker: binding.marker, ref: binding.representativeRef, reason: error.message.slice(0, 1000) }))
      : [{ marker: '*', ref: error.refs[0] ?? 's0', reason: error.message.slice(0, 1000) }];
    return { derivable: false, dialect: bundle.dialect, derivation_sha256: bundle.derivation_sha256, rejections };
  }
  if (!await dependenciesCurrent(host, [{ path: bundle.sample_path, sha256: bundle.expected_sample_sha256 }]))
    throw new DeriveProviderError('SOURCE_CHANGED', 'Sample changed during derivation.');
  const base = { derivable: true, ...(bundle.schema === 'derive-bundle/3' ? { dialect: bundle.dialect } : {}), rejections: [], markers: bundle.bindings.map(binding => binding.marker), derivedTemplateSha256: byteDigest(derived.bytes), derivation_sha256: bundle.derivation_sha256 };
  if (input.note_path === undefined) return base;
  const notePath = userPath(input.note_path), expected = input.expected_note_sha256;
  if (!/\.md$/i.test(notePath) || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new DeriveProviderError('INVALID_ARGUMENT', 'Bound Markdown note and SHA-256 required.');
  const noteBytes = await readBoundBytes(host, notePath, expected);
  validateBundleDialect(bundle, new TextDecoder('utf-8', { fatal: true }).decode(noteBytes));
  try {
    if (!host.renderDerived) throw new Error('Derived render unavailable.');
    const rendered = await host.renderDerived(notePath, bundle.sample_path, derived.bytes, signal, false);
    if (!await dependenciesCurrent(host, mergeDependencies([{ path: bundle.sample_path, sha256: bundle.expected_sample_sha256 }, { path: notePath, sha256: expected }, ...rendered.inputDependencies]))) throw new DeriveProviderError('SOURCE_CHANGED', 'Inputs changed during trial conversion.');
    const result = { ...base, converts: true, ...summarizeDerivedBlocks(rendered.blockIndex, bundle), warnings: rendered.report.warnings, conversionFingerprint: await conversionFingerprint(rendered.bytes, signal) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 256 * 1024) throw new DeriveProviderError('PREVIEW_RESULT_TOO_LARGE', 'Preview result exceeds 256 KiB.');
    return result;
  } catch (error) {
    if (error instanceof DeriveProviderError || signal?.aborted) throw error;
    return { ...base, converts: false, failure: { code: 'CONVERSION_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) || 'Conversion failed.' } };
  }
}
