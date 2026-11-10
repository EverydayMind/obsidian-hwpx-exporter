import { canonicalDigest } from './digest';
import { fields, validateBundleFields } from './bundleValidation';
import { copyJson } from './jsonData';
import type { DeriveBundleV3 } from './dialectV2';
export type { DeriveBundleV3 } from './dialectV2';

export function bundleV3Digest(b: DeriveBundleV3): string {
  return canonicalDigest({ schema: b.schema, expectedSampleSha256: b.expected_sample_sha256, structureSha256: b.structure_sha256, bindings: b.bindings, fixedRegions: b.fixed_regions, dialect: b.dialect, rulesVersion: b.rulesVersion, catalogVersion: b.catalogVersion });
}
export function parseDeriveBundleV3(input: unknown): DeriveBundleV3 {
  const v = copyJson(input, { maxDepth: 16, maxNodes: 10000, maxBytes: 256 * 1024 });
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > 64 * 1024) throw new Error('Derive bundle exceeds 64 KiB.');
  fields(v, ['schema', 'sample_path', 'expected_sample_sha256', 'structure_sha256', 'bindings', 'fixed_regions', 'derivation_sha256', 'dialect', 'rulesVersion', 'catalogVersion']);
  if (v.schema !== 'derive-bundle/3' || v.dialect !== 'hwpx-exporter-md/2' || typeof v.rulesVersion !== 'string' || !v.rulesVersion || typeof v.catalogVersion !== 'string' || !v.catalogVersion) throw new Error('Invalid derive bundle v3 versions.');
  validateBundleFields(v, true);
  const bundle = v as unknown as DeriveBundleV3;
  if (bundleV3Digest(bundle) !== bundle.derivation_sha256) throw new Error('Derive bundle v3 digest mismatch.');
  return bundle;
}
