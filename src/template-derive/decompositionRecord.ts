import type { Document, Element } from '@xmldom/xmldom';
import { canonicalPrefixes } from './dom';
import { children, descendants, is, NS } from './xml';
import { payloadDigest } from './provenance';
import type { Asset } from './sanitizePackage';

export const RECORD_MARKER = '{{DECOMPOSITION}}';
export const BODY_START_MARKER = '{{BODY_START}}';
export type DecompositionRecord = import('./dialectV2').DecompositionRecordV2;
export type DecompositionRecordInput = Omit<DecompositionRecord, 'schema' | 'templatePayloadSha256'>;
export type RetiredRecord = { retired: true; schema: 'hwpx-decomposition-record/1'; decompositionId?: string; sourcePath?: string };
export class RetiredRecordError extends Error {
  readonly details = { reason: 'record_version_retired' };
  constructor() { super('Decomposition record version retired.'); }
}
const text = (p: Element) => descendants(p, 't', NS.para).map(n => n.textContent ?? '').join('');
export function recordParagraph(section: Document): Element | undefined {
  return children(section.documentElement!).find(p => is(p, 'p', NS.para) && text(p).startsWith(RECORD_MARKER));
}
export function readDecompositionRecord(section: Document, inspection = false): { derivedMode: boolean; record: DecompositionRecord | null; dialect: string | null; recordRetired?: RetiredRecord } {
  const p = recordParagraph(section);
  if (!p) return { derivedMode: false, record: null, dialect: null };
  const encoded = text(p).slice(RECORD_MARKER.length).trim();
  if (!encoded) return { derivedMode: true, record: null, dialect: null };
  let v: Record<string, unknown>;
  try { v = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw new Error('Malformed decomposition record.'); }
  if (v?.schema === 'hwpx-decomposition-record/1') {
    if (!inspection) throw new RetiredRecordError();
    const recordRetired: RetiredRecord = { retired: true, schema: 'hwpx-decomposition-record/1' };
    if (typeof v.decompositionId === 'string' && /^[a-f0-9]{64}$/.test(v.decompositionId)) recordRetired.decompositionId = v.decompositionId;
    if (typeof v.sourcePath === 'string' && v.sourcePath.length > 0 && v.sourcePath.length <= 4096) recordRetired.sourcePath = v.sourcePath;
    return { derivedMode: true, record: null, dialect: null, recordRetired };
  }
  const keys = ['schema', 'decompositionId', 'dialect', 'sourcePath', 'sourceSha256', 'textFile', 'textSha256', 'templatePayloadSha256'];
  const v2 = v?.schema === 'hwpx-decomposition-record/2';
  if (v2) keys.push('rulesVersion', 'catalogVersion');
  if (!v || typeof v !== 'object' || !v2 || Object.keys(v).length !== keys.length || keys.some(k => typeof v[k] !== 'string' || (v[k]).length > 4096) || v.dialect !== 'hwpx-exporter-md/2' || !v.rulesVersion || !v.catalogVersion || !v.sourcePath || !v.textFile || ['decompositionId', 'sourceSha256', 'textSha256', 'templatePayloadSha256'].some(k => !/^[a-f0-9]{64}$/.test(v[k] as string))) throw new Error('Invalid decomposition record.');
  return { derivedMode: true, record: v as DecompositionRecord, dialect: v.dialect };
}
export function templatePayloadSha256(header: Document, section: Document, manifest: Document, assets: Asset[]): string {
  const clean = canonicalPrefixes(section), p = recordParagraph(clean);
  if (p) p.parentNode!.removeChild(p);
  return payloadDigest(header, clean, manifest, assets);
}
export function writeDecompositionRecord(p: Element, value: DecompositionRecord): void {
  const t = descendants(p, 't', NS.para)[0];
  while (t.firstChild) t.removeChild(t.firstChild);
  t.appendChild(p.ownerDocument!.createTextNode(RECORD_MARKER + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')));
  readDecompositionRecord(p.ownerDocument!);
}
/** Only the explicit fixed regions around the rule/content boundaries allow floating objects. */
export function fixedRegionRoots(section: Document): Element[] {
  const top = children(section.documentElement!), start = top.indexOf(recordParagraph(section)!);
  const content = top.findIndex(p => text(p) === '{{CONTENT}}');
  return start < 0 || content <= start ? [] : [...top.slice(1, start), ...top.slice(content + 1)];
}
