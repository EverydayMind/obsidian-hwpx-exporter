import { readTemplateMode } from '../src/template-derive/templateMetadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMarkdownStringWithFrontmatter } from '../src/frontmatterParser';
import { byteDigest } from '../src/template-derive/digest';
import { DeriveProviderError, userPath } from './deriveProvider';

export const TEMPLATE_MAX_BYTES = 32 * 1024 * 1024;
export interface TemplateLoaderHost {
    templates(): string[];
    readNote(notePath: string): Promise<{ markdown: string } | null>;
    readBytes(vaultPath: string): Promise<Uint8Array | null>;
    readBytesBounded?(vaultPath: string, maxBytes: number): Promise<Uint8Array | null>;
    resolveTemplateLink?(link: string, notePath: string): string | null;
    assertTemplatePath?(vaultPath: string): void;
}
export interface LoadedTemplate {
    path: string;
    bytes: Uint8Array;
    sha256: string;
    derivedMode: boolean;
    dialect: string | null;
    source: 'explicit' | 'frontmatter' | 'default';
}

/** Desktop containment includes junctions and symlinks, not just lexical paths. */
export function assertVaultRealPath(root: string, vaultPath: string): void {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(path.join(root, userPath(vaultPath))));
    if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).some((p) => p.startsWith('.'))
    )
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Template resolves outside the Vault.');
}

export async function templateDerivedMode(bytes: Uint8Array, signal?: AbortSignal): Promise<boolean> {
    return (await readTemplateMode(bytes, signal)).derived;
}

export async function resolveNoteTemplate(
    host: TemplateLoaderHost,
    notePath: string,
    explicit?: unknown,
    signal?: AbortSignal
): Promise<Pick<LoadedTemplate, 'path' | 'source'>> {
    signal?.throwIfAborted();
    let chosen: string, source: LoadedTemplate['source'];
    if (explicit !== undefined) {
        if (typeof explicit !== 'string' || !host.templates().includes(explicit))
            throw new DeriveProviderError('INVALID_ARGUMENT', 'template must be in the configured template list.');
        chosen = explicit;
        source = 'explicit';
    } else {
        const note = await host.readNote(notePath);
        if (!note) throw new DeriveProviderError('NOT_FOUND', `Note not found: ${notePath}`);
        const { metadata } = parseMarkdownStringWithFrontmatter(note.markdown);
        const value: unknown = metadata['hwpx-template'];
        if (value !== undefined) {
            if (typeof value !== 'string' || !value.trim())
                throw new DeriveProviderError('INVALID_ARGUMENT', 'hwpx-template must be a nonempty path or wikilink.');
            const link = /^\[\[([^[\]]+)\]\]$/.exec(value.trim());
            if (link) {
                userPath(link[1]);
                const resolved = host.resolveTemplateLink?.(link[1], notePath);
                if (!resolved) throw new DeriveProviderError('NOT_FOUND', 'hwpx-template wikilink cannot be resolved.');
                chosen = userPath(resolved);
            } else {
                const relative = userPath(value.trim());
                chosen = userPath([notePath.split('/').slice(0, -1).join('/'), relative].filter(Boolean).join('/'));
            }
            if (!/\.hwpx$/i.test(chosen)) throw new DeriveProviderError('INVALID_ARGUMENT', 'hwpx-template must reference an .hwpx file.');
            host.assertTemplatePath?.(chosen);
            source = 'frontmatter';
        } else {
            chosen = host.templates()[0];
            source = 'default';
            if (!chosen) throw new DeriveProviderError('NO_TEMPLATE', 'No configured HWPX template.');
        }
    }
    signal?.throwIfAborted();
    return { path: chosen, source };
}

export async function readSelectedTemplate(
    host: TemplateLoaderHost,
    selection: Pick<LoadedTemplate, 'path' | 'source'>,
    expectedSha256?: unknown,
    signal?: AbortSignal
): Promise<LoadedTemplate> {
    const { path: chosen, source } = selection;
    signal?.throwIfAborted();
    const bytes = await (host.readBytesBounded ? host.readBytesBounded(chosen, TEMPLATE_MAX_BYTES) : host.readBytes(chosen));
    signal?.throwIfAborted();
    if (!bytes) throw new DeriveProviderError('NOT_FOUND', `Template not found: ${chosen}`);
    if (bytes.byteLength > TEMPLATE_MAX_BYTES) throw new DeriveProviderError('INVALID_ARGUMENT', 'Template exceeds 32 MiB.');
    const frozen = Uint8Array.from(bytes),
        sha256 = byteDigest(frozen);
    if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)))
        throw new DeriveProviderError('INVALID_ARGUMENT', 'Expected template SHA-256 must be 64 hex digits.');
    if (expectedSha256 !== undefined && expectedSha256 !== sha256)
        throw new DeriveProviderError('SOURCE_CHANGED', 'Template hash mismatch.');
    const mode = await readTemplateMode(frozen, signal);
    return { path: chosen, bytes: frozen, sha256, derivedMode: mode.derived, dialect: mode.dialect, source };
}

export async function loadNoteTemplate(
    host: TemplateLoaderHost,
    notePath: string,
    explicit?: unknown,
    expectedSha256?: unknown,
    signal?: AbortSignal
): Promise<LoadedTemplate> {
    return readSelectedTemplate(host, await resolveNoteTemplate(host, notePath, explicit, signal), expectedSha256, signal);
}

/** Ordinary trials keep their existing single frozen read in the converter. */
export async function trialTemplate(host: TemplateLoaderHost, notePath: string, explicit?: unknown, signal?: AbortSignal) {
    const selection = await resolveNoteTemplate(host, notePath, explicit, signal);
    return selection.source === 'frontmatter' ? readSelectedTemplate(host, selection, undefined, signal) : selection;
}

/** Put the frontmatter choice first so Enter selects it, including outside the folder list. */
export function preferredTemplatePaths(paths: string[], loaded?: LoadedTemplate): string[] {
    return loaded?.source === 'frontmatter' ? [loaded.path, ...paths.filter((p) => p !== loaded.path)] : paths;
}

/** Check every component against actual directory entries, including NFC/case aliases. */
export function hasNormalizedDiskPath(root: string, vaultPath: string): boolean {
    const parts = userPath(vaultPath).split('/');
    const visit = (parent: string, i: number): boolean => {
        const matches = fs
            .readdirSync(parent)
            .filter((name) => name.normalize('NFC').toLowerCase() === parts[i].normalize('NFC').toLowerCase());
        return matches.some((name) => {
            const next = path.join(parent, name);
            return i === parts.length - 1 || !fs.statSync(next).isDirectory() || visit(next, i + 1);
        });
    };
    return visit(root, 0);
}

/** An explicit choice still wins; an unreadable declaration adds no warning. */
export async function templateOverrideWarnings(
    host: TemplateLoaderHost, notePath: string, explicit?: unknown, signal?: AbortSignal
): Promise<{ code: string; message: string; count: number; examples: string[] }[]> {
    if (typeof explicit !== 'string') return [];
    try {
        const declared = await resolveNoteTemplate(host, notePath, undefined, signal);
        if (declared.source !== 'frontmatter' || declared.path === explicit) return [];
        return [{
            code: 'template_overrides_frontmatter',
            message: '노트의 hwpx-template(' + declared.path + ') 대신 지정한 템플릿(' + explicit + ')으로 만든다. 노트가 선언한 서식을 쓰려면 template을 생략한다.',
            count: 1, examples: [],
        }];
    } catch {
        signal?.throwIfAborted();
        return [];
    }
}
