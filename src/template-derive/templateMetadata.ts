import { readBoundedZip } from './boundedZip';
import { Guard } from './limits';
import { parseXml } from './xml';
import { readDecompositionRecord } from './decompositionRecord';
export type TemplateMode = { derived: boolean; dialect: string | null };
export class DialectError extends Error {
  readonly details: { reason: string };
  constructor(readonly code: 'dialect_mismatch' | 'dialect_unsupported' | 'dialect_retired', message: string) { super(`${code}: ${message}`); this.details = { reason: code }; }
}
export async function readTemplateMode(bytes: Uint8Array, signal?: AbortSignal): Promise<TemplateMode> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { derived: false, dialect: null };
  const guard = new Guard(signal), zip = await readBoundedZip(bytes, guard), section = zip.get('Contents/section0.xml');
  if (!section) throw new Error('Template section missing.');
  const result = readDecompositionRecord(await parseXml(section, guard));
  return { derived: result.derivedMode, dialect: result.dialect };
}
export function validateTemplateDialect(authority: string | null, markdown: unknown): void {
  if (markdown === 'hwpx-exporter-md/1') throw new DialectError('dialect_retired', markdown);
  const known = (value: string) => value === 'hwpx-exporter-md/2';
  if (authority !== null && !known(authority)) throw new DialectError('dialect_unsupported', authority);
  if (markdown !== undefined && (typeof markdown !== 'string' || !known(markdown))) throw new DialectError('dialect_unsupported', typeof markdown === 'string' ? markdown : JSON.stringify(markdown));
  if (authority !== null && markdown !== undefined && markdown !== authority) throw new DialectError('dialect_mismatch', 'frontmatter의 hwpx-dialect를 지우거나 짝 템플릿을 고르세요.');
}
