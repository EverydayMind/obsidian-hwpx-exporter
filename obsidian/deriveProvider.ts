import { decompositionBundleInputSchema } from './documentJobInputSchemas';
import type { ExportProviderHost, ExportTarget } from './agentProvider';
import { deriveTemplate, getDerivationReport, DERIVATION_MARKERS } from '../src/template-derive/derive';
import { byteDigest } from '../src/template-derive/digest';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
export type InputDependency = { path: string; sha256: string };
export class DeriveProviderError extends Error { constructor(readonly code: string, message: string, readonly details?: JsonObject) { super(message); } }
const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 }, hashSchema = { type: 'string', minLength: 64, maxLength: 64 };
const metadata = (effect: string): JsonObject => ({ 'dev.agentinterop/effect': effect, 'dev.agentinterop/group': 'export', 'dev.agentinterop/resourceTypes': ['.md', '.hwpx'], 'dev.agentinterop/keywords': ['hwpx', 'hwp', '한글', '템플릿', '양식', '서식', 'profile', 'derive'], 'dev.agentinterop/maxResultChars': 40000 });
export const DERIVE_TOOL_DEFINITIONS: JsonObject[] = [
  { name: 'derive_template', title: 'Derive report template', description: 'Create a new HWPX template from an exact sample and verified style-profile note, or save a bundle-v3 decomposition as a new HWPX/Markdown pair. Preserves selected fixed content; requires per-call host approval and checkpoint.', inputSchema: { type: 'object', additionalProperties: false, properties: { sample_path: pathSchema, expected_sample_sha256: hashSchema, profile_path: pathSchema, expected_profile_sha256: hashSchema, output_path: pathSchema, derive_from: decompositionBundleInputSchema, markdown: { type: 'string', maxLength: 524288 }, expected_markdown_sha256: hashSchema, template_output_path: pathSchema, text_output_path: pathSchema, record: { type: 'object', additionalProperties: false, properties: { decompositionId: hashSchema, dialect: { type: 'string', enum: ['hwpx-exporter-md/2'] }, rulesVersion: pathSchema, catalogVersion: pathSchema, sourcePath: pathSchema, sourceSha256: hashSchema, textFile: pathSchema } } } }, _meta: { ...metadata('commit'), 'dev.agentinterop/keywords': [], 'dev.agentinterop/resourceTypes': [] } },
  { name: 'get_derivation_report', title: 'Inspect derived report template', description: 'Recheck current bytes, XML, marker inventory and provenance after restart or resave. Layout is not measured; metadata is not authenticity evidence.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'expected_sha256'], properties: { path: pathSchema, expected_sha256: hashSchema } }, _meta: metadata('read') },
];
export const markerCatalog = [...DERIVATION_MARKERS, 'TABLE_CAPTION'];
export function userPath(value: unknown): string {
// eslint-disable-next-line no-control-regex -- Control bytes must be rejected in untrusted Vault/archive paths.
  if (typeof value !== 'string' || !value || [...value].length > 4096 || /^(?:[A-Za-z]:|\/)/.test(value) || /[\\\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part.startsWith('.'))) throw new DeriveProviderError('INVALID_ARGUMENT', 'Canonical user Vault relative path required.');
  return value;
}
const sha = (value: unknown): string => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new DeriveProviderError('INVALID_ARGUMENT', 'Exact 64-hex SHA-256 required: copy the value a tool reported for this file (for derivation, read_style_profile nextStep); do not guess or ask the user.'); return value; };
async function read(host: ExportProviderHost, path: string, expected: string, max = 32 * 1024 * 1024): Promise<Uint8Array> {
  const bytes = host.readBytesBounded ? await host.readBytesBounded(path, max) : await host.readBytes(path);
  // Name the failing input: a model that invents sample_path (2026-11-03,
  // the profile's name with .hwpx) cannot tell a missing file from a stale hash.
  if (!bytes) throw new DeriveProviderError('SOURCE_CHANGED', `Input not found: "${path}". Use the exact Vault paths a tool reported (sample_path is the profile's sourcePath, profile_path the saved profile note; read_style_profile nextStep lists both); do not guess.`);
  if (bytes.byteLength > max) throw new DeriveProviderError('SOURCE_CHANGED', `Input too large: "${path}" exceeds ${max} bytes.`);
  if (byteDigest(bytes) !== expected) throw new DeriveProviderError('SOURCE_CHANGED', `Input changed: "${path}" does not match the expected SHA-256. Use the value a tool reported for the current file (for derivation, read_style_profile nextStep); do not guess.`);
  return bytes;
}
export async function dependenciesCurrent(host: ExportProviderHost, dependencies: readonly InputDependency[]): Promise<boolean> {
  if (dependencies.length > 32) return false;
  let total = 0; const paths = new Map<string, string>();
  for (const dependency of dependencies) {
    const path = userPath(dependency.path), expected = sha(dependency.sha256);
    if (paths.has(path) && paths.get(path) !== expected) return false;
    if (paths.has(path)) continue; paths.set(path, expected);
    const bytes = host.readBytesBounded ? await host.readBytesBounded(path, 32 * 1024 * 1024) : await host.readBytes(path);
    if (!bytes || (total += bytes.length) > 128 * 1024 * 1024 || byteDigest(bytes) !== expected) return false;
  }
  return true;
}
/** Preserve input order, reject inconsistent duplicate paths, and bound unique dependencies. */
export function mergeDependencies(dependencies: readonly InputDependency[]): InputDependency[] {
  const byPath = new Map<string, string>();
  for (const item of dependencies) {
    const path = userPath(item.path), expected = sha(item.sha256), old = byPath.get(path);
    if (old && old !== expected) throw new DeriveProviderError('SOURCE_CHANGED', `Input changed during conversion: ${path}`);
    byPath.set(path, expected);
    if (byPath.size > 32) throw new DeriveProviderError('SOURCE_CHANGED', 'Too many input dependencies.');
  }
  return [...byPath].map(([path, sha256]) => ({ path, sha256 }));
}
export async function resolveDerivation(host: ExportProviderHost, args: JsonObject): Promise<ExportTarget> {
  const required = ['sample_path', 'expected_sample_sha256', 'profile_path', 'expected_profile_sha256', 'output_path'];
  if (Object.keys(args).length !== required.length || required.some(key => !(key in args))) throw new DeriveProviderError('INVALID_ARGUMENT', 'Exact derivation arguments required.');
  const sample = userPath(args.sample_path), profile = userPath(args.profile_path), output = userPath(args.output_path);
  if (!sample.endsWith('.hwpx') || !profile.endsWith('.md') || !output.endsWith('.hwpx')) throw new DeriveProviderError('UNSUPPORTED_FORMAT', 'sample_path must be the .hwpx sample, profile_path the .md style profile note saved by Verbex save_style_profile for that sample, and output_path a new .hwpx in the template folder. Measure the sample with save_style_profile first, then follow read_style_profile nextStep.');
  const folder = host.options().templateFolderPath.replace(/\/$/, '');
  if (output.split('/').slice(0, -1).join('/') !== folder) throw new DeriveProviderError('INVALID_ARGUMENT', `Template output must be directly under the configured template folder "${folder}", for example "${folder}/<new name>.hwpx".`);
  if (host.exists(output)) throw new DeriveProviderError('ALREADY_EXISTS', 'Template overwrite forbidden.');
  await read(host, sample, sha(args.expected_sample_sha256)); await read(host, profile, sha(args.expected_profile_sha256), 6 * 1024 * 1024);
  return { kind: 'new', destination: output, template: { path: sample, sha256: sha(args.expected_sample_sha256) } };
}
export async function prepareDerivation(host: ExportProviderHost, args: JsonObject, signal?: AbortSignal) {
  const target = await resolveDerivation(host, args);
  const sample = await read(host, target.template.path, target.template.sha256), profile = await read(host, userPath(args.profile_path), sha(args.expected_profile_sha256), 6 * 1024 * 1024);
  const result = await deriveTemplate({ sampleBytes: sample, profileBytes: profile, expectedSampleSha256: target.template.sha256, expectedProfileSha256: sha(args.expected_profile_sha256), signal });
  const inputDependencies = [{ path: target.template.path, sha256: target.template.sha256 }, { path: userPath(args.profile_path), sha256: sha(args.expected_profile_sha256) }];
  if (!await dependenciesCurrent(host, inputDependencies)) throw new DeriveProviderError('SOURCE_CHANGED', 'Input changed during preparation.');
  return { ...result, target, inputDependencies, notePath: userPath(args.profile_path) };
}
export async function derivationReport(host: ExportProviderHost, args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  if (Object.keys(args).length !== 2) throw new DeriveProviderError('INVALID_ARGUMENT', 'Exact report arguments required.');
  const path = userPath(args.path), expected = sha(args.expected_sha256), bytes = await read(host, path, expected);
  const report = await getDerivationReport(bytes, expected, signal);
  if (!await dependenciesCurrent(host, [{ path, sha256: expected }])) throw new DeriveProviderError('SOURCE_CHANGED', 'Template changed during inspection.');
  return report as JsonObject;
}
