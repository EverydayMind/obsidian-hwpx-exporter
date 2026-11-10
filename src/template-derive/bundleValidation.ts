import { canonicalDigest } from './digest';
import type { NodeRef } from './types';
export type BundleBinding = { key: string; marker: string; representativeRef: string };
export type RangeReplacement = { paragraphRef: string; metaKey: string; format?: string };
export type FixedRange = { position: 'before_content' | 'after_content'; from_ref: string; to_ref: string; replacements: RangeReplacement[] };
export type RangeBundle = { structure_sha256: string; bindings: BundleBinding[]; fixed_regions: FixedRange[] };
const ref = /^s[0-9]+(?:\/(?:p[0-9]+|t[0-9]+|c[0-9]+\.[0-9]+|h[0-9]+|f[0-9]+))*$/;
const text = (v: unknown, max: number, pattern?: RegExp): v is string => typeof v === 'string' && [...v].length > 0 && [...v].length <= max && (!pattern || pattern.test(v));
export function fields(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.prototype.hasOwnProperty.call(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new Error('Invalid derive bundle object.');
}
function unique(v: string[]) { if (new Set(v).size !== v.length) throw new Error('Duplicate bundle field.'); }
export function validateBundleFields(v: Record<string, unknown>, v3 = false) {
  // eslint-disable-next-line no-control-regex -- Control bytes must be rejected in untrusted Vault paths.
  if (!text(v.sample_path, 4096) || /^(?:[A-Za-z]:|\/)/.test(v.sample_path) || /[\\\x00-\x1f\x7f]/.test(v.sample_path) || v.sample_path.split('/').some(p => !p || p.startsWith('.'))) throw new Error('Invalid Vault path.');
  for (const k of ['expected_sample_sha256', 'structure_sha256', 'derivation_sha256']) if (!text(v[k], 64, /^[0-9a-f]{64}$/)) throw new Error('Invalid hash.');
  if (!Array.isArray(v.bindings) || v.bindings.length > 24 || !Array.isArray(v.fixed_regions) || v.fixed_regions.length > 4) throw new Error('Bundle list limit.');
  for (const b of v.bindings) {
    fields(b, ['key', 'marker', 'representativeRef'], v3 ? ['prefix', 'leadingSpacerRef'] : []);
    if (v3 && (typeof b.prefix !== 'string' || [...b.prefix].length > 4096 || ('leadingSpacerRef' in b && !text(b.leadingSpacerRef, 256, ref)))) throw new Error('Invalid derive bundle v3 binding prefix.');
    if (!text(b.key, 64) || !text(b.marker, 128) || !text(b.representativeRef, 256, ref)) throw new Error('Invalid binding.');
  }
  let replacements = 0;
  for (const r of v.fixed_regions) {
    fields(r, ['position', 'from_ref', 'to_ref', 'replacements']);
    if (!['before_content', 'after_content'].includes(String(r.position)) || !text(r.from_ref, 256, ref) || !text(r.to_ref, 256, ref) || !Array.isArray(r.replacements)) throw new Error('Invalid fixed range.');
    replacements += r.replacements.length;
    for (const m of r.replacements) {
      fields(m, ['paragraphRef', 'metaKey'], ['format']);
      if (!text(m.paragraphRef, 256, ref) || !text(m.metaKey, 64, /^[A-Za-z][A-Za-z0-9_]*$/) || (m.format !== undefined && !text(m.format, 32, /^(?:YYYY|YY|MM|M|DD|D|[ .\-/년월일])+$/))) throw new Error('Invalid fixed replacement.');
    }
    unique(r.replacements.map(m => (m as RangeReplacement).paragraphRef));
  }
  if (replacements > 16) throw new Error('Bundle replacement limit.');
  const bundle = v as unknown as RangeBundle;
  unique(bundle.bindings.map(b => b.key)); unique(bundle.bindings.map(b => b.marker));
}
/** Resolve ranges only against the freshly indexed sample. */
export function resolveFixedRanges(bundle: RangeBundle, nodes: NodeRef[]) {
  if (canonicalDigest(nodes) !== bundle.structure_sha256) throw new Error('Sample structure digest mismatch.');
  const byRef = new Map(nodes.map(n => [n.ref, n]));
  const top = nodes.filter(n => n.topLevelOrder !== null).sort((a, b) => a.topLevelOrder! - b.topLevelOrder!);
  const owner = (ref: string): NodeRef | undefined => {
    let node = byRef.get(ref);
    while (node && node.topLevelOrder === null) node = byRef.get(node.parentRef ?? '');
    return node;
  };
  for (const b of bundle.bindings) if (byRef.get(b.representativeRef)?.kind !== 'paragraph') throw new Error('Invalid representative ref.');
  const result: Array<{ ref: string; position: FixedRange['position']; replacements: RangeReplacement[] }> = [];
  let previous = -1;
  for (const range of bundle.fixed_regions) {
    const from = top.findIndex(n => n.ref === range.from_ref), to = top.findIndex(n => n.ref === range.to_ref);
    if (from <= 0 || to < from || from <= previous) throw new Error('Fixed ranges must be ordered, non-overlapping and exclude the section first paragraph.');
    previous = to;
    const refs = new Set(top.slice(from, to + 1).map(n => n.ref));
    if (bundle.bindings.some(b => refs.has(owner(b.representativeRef)?.ref ?? ''))) throw new Error('Fixed range overlaps binding.');
    for (const m of range.replacements) if (byRef.get(m.paragraphRef)?.kind !== 'paragraph' || !refs.has(owner(m.paragraphRef)?.ref ?? '')) throw new Error('Invalid replacement ref outside range.');
    for (const node of top.slice(from, to + 1)) result.push({ ref: node.ref, position: range.position, replacements: range.replacements.filter(m => owner(m.paragraphRef)?.ref === node.ref) });
  }
  return result;
}
