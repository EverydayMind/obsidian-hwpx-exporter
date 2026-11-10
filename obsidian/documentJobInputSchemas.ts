// Public agentinterop schemas use the host's closed, single-type subset.
// Exact version/form validation stays in parseDeriveBundleV3 and provider handlers.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };
const string = (maxLength: number): Schema => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, properties });
const hash = { type: 'string', minLength: 64, maxLength: 64 };
const replacement = object({ paragraphRef: string(512), metaKey: string(128), format: string(64) });
const region = object({
    from_ref: string(512),
    to_ref: string(512),
    position: { type: 'string', enum: ['before_content', 'after_content'] },
    replacements: { type: 'array', maxItems: 128, items: replacement }
});
const binding = object({ key: string(256), marker: string(512), representativeRef: string(512), prefix: { type: 'string', maxLength: 4096 }, leadingSpacerRef: string(256) });
const bundleProperties = {
    schema: { type: 'string', enum: ['derive-bundle/3'] },
    sample_path: string(8192),
    expected_sample_sha256: hash,
    structure_sha256: hash,
    bindings: { type: 'array', maxItems: 24, items: binding },
    fixed_regions: { type: 'array', maxItems: 8, items: region },
    derivation_sha256: hash
};
export const deriveBundleInputSchema = object({ ...bundleProperties, schema: { type: 'string', enum: ['derive-bundle/3'] }, dialect: { type: 'string', const: 'hwpx-exporter-md/2' }, rulesVersion: string(4096), catalogVersion: string(4096) });
export const decompositionBundleInputSchema = object({ ...bundleProperties, schema: { type: 'string', enum: ['derive-bundle/3'] }, dialect: { type: 'string', const: 'hwpx-exporter-md/2' }, rulesVersion: string(4096), catalogVersion: string(4096) });
