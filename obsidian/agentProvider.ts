import { inspectDecompositionTemplate } from './decompositionInspection';
import { RetiredRecordError } from '../src/template-derive/decompositionRecord';
import { DialectError } from '../src/template-derive/templateMetadata';
import { DERIVE_TOOL_DEFINITIONS, markerCatalog, DeriveProviderError, resolveDerivation, prepareDerivation, derivationReport, dependenciesCurrent, mergeDependencies, type InputDependency } from './deriveProvider';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { parseMarkdownStringWithFrontmatter } from '../src/frontmatterParser';
import { MarkoToPandocAdapter } from '../src/markoAdapter';
import { rewriteObsidianImageEmbeds } from '../src/obsidianImageEmbeds';
import { stripObsidianComments } from '../src/obsidianComments';
import { scanRenderableBlocks } from '../src/renderableBlocks';
import { ConversionReportCollector, type ConversionReport } from '../src/conversionReport';
import type { TemplateInspection } from '../src/templateInspector';
import { hasUnboundThirdPartyCapture } from './agentCaptureGuard';
import { captureReport } from './captureReport';
import { preflightIdentity } from './preflightIdentity';
import { safeSelectionSummary, type SelectionSummary } from '../src/selectionObservation';
import { isRecordedObservedBlockIndex } from '../src/observedBlockIndex';
import { observedBlockPage } from './observedBlockPage';
import { copyOutputAnchorEvidence, type SavedOutputAnchorEvidence } from './outputAnchorEvidence';
import type { ObservedBlockIndex } from '../src/observedBlockIndex';
import { deriveBundleBytes, deriveBundleInputSchema, previewDerivedExport, readBoundBytes, validatedBundle, validateBundleDialect } from './derivedExport';
import { conversionFingerprint } from '../src/conversionFingerprint';
import { loadNoteTemplate, trialTemplate, templateOverrideWarnings } from './templateLoader';
import { resolveDecompositionSave, prepareDecompositionSave, assertDecompositionPathsFree, executeDecompositionSave, type PreparedDecompositionFile } from './decompositionSave';
import { inspectDeriveStructure } from '../src/template-derive/structure';

/**
 * Agent facade (agentinterop v1). An agent host discovers this object on the
 * plugin instance under AGENT_CAPABILITY_PROVIDER and calls describe()/callTool().
 * It knows nothing about any particular host. get_export_options and check_export
 * only report. export_note creates a new .hwpx in the Vault, so it is a commit-effect
 * tool: the host fixes the target (resolveTarget), lets this provider prepare the exact
 * bytes in memory (commit.prepare), asks a person, checkpoints, and only then lets it
 * write (commit.execute). It never replaces an existing file and never writes under a
 * hidden folder (.obsidian, .trash, ...).
 */
export const AGENT_CAPABILITY_PROVIDER = Symbol.for('dev.agentinterop.capability-provider');
export const PROVIDERS_CHANGED_EVENT = 'agentinterop:providers-changed';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface AgentToolResult {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: JsonObject;
    isError?: boolean;
    _meta?: JsonObject;
}

export interface AgentCapabilityProvider {
    readonly protocol: 'agentinterop';
    readonly protocolVersion: 1;
    describe(): Promise<JsonObject>;
    callTool(name: string, args: JsonObject, ctx?: { signal?: AbortSignal }): Promise<AgentToolResult>;
    /** Fixes the file a commit tool would create, without changing anything. */
    resolveTarget(name: string, args: JsonObject, ctx?: CommitContext): Promise<ExportTarget>;
    readonly commit: {
        prepare(request: { tool: string; args: JsonObject; target: unknown; captureOutputAnchors?: boolean }, ctx?: CommitContext): Promise<CommitPreparation>;
        execute(ticket: CommitTicket, ctx?: CommitContext): Promise<CommitReceipt>;
        status(preparationId: string, ctx?: CommitContext): Promise<CommitReceipt | { state: 'unknown_preparation' }>;
        outputAnchors?(request: { preparationId: string; preparationDigest: string; archiveSha256: string; offset?: number; limit?: number }, ctx?: CommitContext): Promise<JsonObject>;
    };
    dispose(): void;
}

// agentinterop v1 commit effect (the host's commitProtocol.ts is the reference).
export interface Caller { pluginId?: string; conversationId?: string; runId?: string; turnId?: string }
export interface CommitContext { caller?: Caller; signal?: AbortSignal }
export interface ExportTarget { kind: 'new'; destination: string; template: { path: string; sha256: string } }
type FileEntry = {
    kind: 'file'; path: string; op: 'create'; role: 'primary' | 'derived';
    sha256Before: null; sha256Expected: string; sizeBytes: number;
};
type FolderEntry = { kind: 'folder'; path: string; op: 'create'; role: 'folder'; existedBefore: false };
type WriteEntry = FileEntry | FolderEntry;
export interface CommitPreparation {
    preparationId: string;
    mode: 'create';
    template: { path: string; sha256: string };
    destination: string;
    format: string;
    saveOptions: JsonObject;
    writeSet: WriteEntry[];
    preparationDigest: string;
    providerInternalWrites: string[];
    report: JsonObject;
    expiresAt: string;
}
export interface CommitTicket {
    ticketId: string;
    preparationId: string;
    preparationDigest: string;
    caller?: Caller;
    destination: string;
    writeSet: WriteEntry[];
    expiresAt: string;
}
export interface CommitReceipt {
    preparationId: string;
    ticketId: string;
    preparationDigest: string;
    state: 'written' | 'not_written' | 'partial' | 'unknown';
    entries: Array<{ path: string; kind: 'file' | 'folder'; state: 'written' | 'unchanged' | 'not_written' | 'unknown'; sha256After?: string }>;
    warnings: string[];
    error?: { code: string; message: string };
}

export interface ExportOptionsSnapshot {
    templateFolderPath: string;
    outputMode: 'same_as_source' | 'fixed_folder';
    fixedOutputFolder: string;
    namingPattern: string;
    appendSequenceOnConflict: boolean;
    pageBreakBeforeH1: boolean;
    captureRenderedBlocks: boolean;
    captureMermaid: boolean;
    captureSvgFiles: boolean;
    captureThirdPartyRenderers: boolean;
    thirdPartyLanguages: string[];
}

/** What the provider needs from the plugin. Kept free of Obsidian types so it runs in tests. */
export interface ExportProviderHost {
    id: string;
    name: string;
    version: string;
    options(): ExportOptionsSnapshot;
    /** Vault paths of the .hwpx templates offered during export. */
    templates(): string[];
    /** The Markdown note at this Vault path, or null when there is none. */
    readNote(notePath: string): Promise<{ markdown: string; sha256?: string; sizeBytes?: number } | null>;
    resolveTemplateLink?(link: string, notePath: string): string | null;
    assertTemplatePath?(vaultPath: string): void;
    hasPathCollision?(vaultPath: string): boolean | Promise<boolean>;
    /** Where exporting this note would write, by the current settings. */
    outputPath(notePath: string): string;
    /** Whether an image link of the note resolves to an embeddable Vault file. */
    resolvesImage(source: string, notePath: string): boolean;
    /** Runs the converter with the export settings, without rendered-block capture, writing to an absolute path. */
    convert(markdown: string, notePath: string, templatePath: string, outputAbsolutePath: string, signal?: AbortSignal, noteIdentity?: { sha256: string; sizeBytes: number }, captureBlockIndex?: boolean): Promise<ConversionReport | { report: ConversionReport; templateSha256: string; inspection?: TemplateInspection; artifactId?: string | null; configDigest?: string; inputDependencies?: InputDependency[] | null; templateAndImageDependencies?: InputDependency[]; selectionSummary?: SelectionSummary; blockIndex?: unknown } | void>;
    /** Markers the template defines or mistypes (src/templateInspector.ts). */
    inspectTemplate?(templatePath: string): Promise<TemplateInspection>;
    /** Whether a file or folder already exists at this Vault path. */
    exists(vaultPath: string): boolean;
    /** Exports a markdown note to a real .hwpx file in the Vault and returns its relative path. */
    /** sha256 (hex) of the template file: binds the approved template to the one converted. */
    templateHash(templatePath: string): Promise<string>;
    /** The full export (render capture + conversion) into memory. Writes no Vault file. */
    render(notePath: string, templatePath: string, signal?: AbortSignal, captureOutputAnchors?: boolean, captureBlockIndex?: boolean): Promise<{ bytes: Uint8Array; report: ConversionReport; inputDependencies?: InputDependency[]; providerInternalWrites?: string[]; outputAnchors?: unknown; blockIndex?: ObservedBlockIndex }>;
    /** Full conversion using a transient, already validated template; never creates a Vault file. */
    renderDerived?(notePath: string, samplePath: string, templateBytes: Uint8Array, signal?: AbortSignal, captureOutputAnchors?: boolean): Promise<{ bytes: Uint8Array; report: ConversionReport; inputDependencies: InputDependency[]; providerInternalWrites: string[]; outputAnchors?: unknown; blockIndex: ObservedBlockIndex }>;
    /** Ancestor folders of a Vault path that do not exist yet, outermost first. */
    missingFolders(vaultPath: string): string[];
    /** Creates the folders, then the new file. Fails rather than overwriting. */
    writeNew(vaultPath: string, bytes: Uint8Array, folders: string[]): Promise<void>;
    /** Current bytes of a Vault file, or null when there is none. */
    readBytes(vaultPath: string): Promise<Uint8Array | null>;
    /** Optional bounded read, required for saved-anchor queries. */
    readBytesBounded?(vaultPath: string, maxBytes: number): Promise<Uint8Array | null>;
    /** Whether the data-only chart renderer is currently available. */
    staticChartAvailable?(): boolean;
}

class ToolError extends Error {
    constructor(readonly code: string, message: string, readonly retryable = false) {
        super(message);
    }
}

const MAX_RESULT_CHARS = 8000;
const COMMIT_TTL_MS = 10 * 60_000;
const MAX_PREPARED = 16;
const MAX_LISTED = 20;
const RESOURCE_TYPES = ['.md'];
// Notes are .md, like most of a Vault, so neither tool is in the core group:
// a host shows them only when the request mentions one of these.
const KEYWORDS = ['hwpx', 'hwp', '한글', '내보내', '내보낼', 'export', '템플릿'];
const meta = (): JsonObject => ({
    'dev.agentinterop/effect': 'read',
    'dev.agentinterop/group': 'export',
    'dev.agentinterop/resourceTypes': RESOURCE_TYPES,
    'dev.agentinterop/keywords': KEYWORDS,
    'dev.agentinterop/maxResultChars': MAX_RESULT_CHARS,
});

const TOOLS: JsonObject[] = [
    ...DERIVE_TOOL_DEFINITIONS,
    {
        name: 'inspect_decomposition_template', title: 'Inspect decomposition template',
        description: 'Host-only read of derived-mode marker, pair record and current record-excluded payload digest.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'expected_sha256'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, expected_sha256: { type: 'string', minLength: 64, maxLength: 64 } } },
        annotations: { readOnlyHint: true }, _meta: { ...meta(), 'dev.agentinterop/keywords': [], 'dev.agentinterop/resourceTypes': [] },
    },
    {
        name: 'inspect_derive_structure', title: 'Inspect derivation structure',
        description: 'Host-only read of sample structure facts without source prose.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['sample_path', 'expected_sample_sha256'], properties: { sample_path: { type: 'string', minLength: 1, maxLength: 4096 }, expected_sample_sha256: { type: 'string', minLength: 64, maxLength: 64 } } },
        annotations: { readOnlyHint: true }, _meta: { ...meta(), 'dev.agentinterop/keywords': [], 'dev.agentinterop/resourceTypes': [] },
    },
    {
        name: 'preview_derived_export', title: 'Preview derived export',
        description: 'Host validation of a derived bundle or a bound note with its current frontmatter template; never writes a Vault file.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {
            derive_from: deriveBundleInputSchema, note_path: { type: 'string', minLength: 1, maxLength: 4096 },
            expected_template_sha256: { type: 'string', minLength: 64, maxLength: 64 },
            expected_note_sha256: { type: 'string', minLength: 64, maxLength: 64 },
            markdown: { type: 'string', maxLength: 524288 }, expected_markdown_sha256: { type: 'string', minLength: 64, maxLength: 64 },
            allowed: { type: 'object', additionalProperties: false, required: ['omitted_refs'], properties: { omitted_refs: { type: 'array', maxItems: 2000, items: { type: 'string', minLength: 1, maxLength: 256 } } } },
        } }, annotations: { readOnlyHint: true },
        _meta: { ...meta(), 'dev.agentinterop/keywords': [], 'dev.agentinterop/resourceTypes': [] },
    },
    {
        name: 'get_export_options',
        title: 'HWPX 내보내기 설정',
        description: 'HWPX Exporter의 현재 설정을 돌려준다: 쓸 수 있는 한글 템플릿(.hwpx) 목록, 결과를 저장할 위치와 파일 이름 규칙, 그림 캡처 설정.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true },
        _meta: meta(),
    },
    {
        name: 'inspect_export_blocks',
        title: 'Inspect export blocks',
        description: 'Host validation read of a bound trial conversion; returns partial observed structure without block text.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            template: { type: 'string', minLength: 1, maxLength: 4096 },
            offset: { type: 'integer', minimum: 0, maximum: 50000 },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            expected_inputs_digest: { type: 'string', minLength: 64, maxLength: 64 },
            block_contract_version: { type: 'string', enum: ['observed-block-page/0.4'] },
        } },
        annotations: { readOnlyHint: true },
        _meta: { ...meta(), 'dev.agentinterop/keywords': [], 'dev.agentinterop/resourceTypes': [] },
    },
    {
        name: 'check_export',
        title: 'HWPX 내보내기 점검',
        description: 'Markdown 노트를 한글(HWPX)로 내보내면 어떻게 되는지 미리 점검한다. 변환을 시험 실행해 성공 여부를 확인하고, 저장될 경로, 노트 구성(제목·표·목록·코드·그림 수), 찾지 못해 글자로 대체될 그림, 그림으로 캡처될 코드 블록을 알려 준다. Vault에는 파일을 만들지 않는다.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: {
                path: { type: 'string', minLength: 1, maxLength: 4096, description: '점검할 Markdown 노트의 Vault 기준 상대 경로.' },
                template: { type: 'string', minLength: 1, maxLength: 4096, description: 'get_export_options가 준 템플릿 경로 중 하나. 생략하면 노트의 hwpx-template, 없으면 목록의 첫 템플릿으로 시험한다.' },
            },
        },
        annotations: { readOnlyHint: true },
        _meta: meta(),
    },
    {
        name: 'export_note',
        title: 'HWPX 내보내기 실행',
        description: 'Markdown 노트를 한글(HWPX) 문서로 내보내어 Vault에 새 .hwpx 파일을 생성한다. 템플릿(template)을 지정하면 해당 서식으로 작성되며, 생략 시 노트의 hwpx-template, 없으면 템플릿 폴더의 첫 번째 템플릿을 적용한다. outputPath로 저장 위치를 지정할 수 있다.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: {
                path: { type: 'string', minLength: 1, maxLength: 4096, description: '내보낼 Markdown 노트의 Vault 기준 상대 경로 (예: "노트.md", "100.내용/보고서.md").' },
                template: { type: 'string', minLength: 1, maxLength: 4096, description: 'get_export_options로 확인한 템플릿 경로 중 하나. 생략하면 노트의 hwpx-template, 없으면 목록의 첫 번째 템플릿을 사용한다.' },
                expected_note_sha256: { type: 'string', minLength: 64, maxLength: 64 },
                expected_template_sha256: { type: 'string', minLength: 64, maxLength: 64 },
                derive_from: deriveBundleInputSchema,
                outputPath: { type: 'string', minLength: 1, maxLength: 4096, description: '결과 .hwpx 파일의 Vault 기준 상대 경로. 생략하면 플러그인 설정의 위치/이름 규칙을 따른다.' },
            },
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        // Creates a Vault file: the host asks a person about every export and checkpoints it.
        _meta: { ...meta(), 'dev.agentinterop/effect': 'commit' },
    },
];

const INSTRUCTIONS = 'Markdown 노트를 한글(HWPX) 문서로 내보내는 HWPX Exporter 도구다. get_export_options로 사용 가능한 템플릿 목록과 설정을 확인하고, 필요 시 check_export로 사전 점검을 수행하며, export_note로 Markdown 노트를 .hwpx 파일로 실제 내보내기/생성한다. export_note는 사람이 승인해야 새 파일을 만들고, 이미 있는 파일은 덮어쓰지 않는다.';

/** Sorted-key JSON: equal to RFC 8785 for the strings, integers and arrays used here, so the host recomputes the same digest. */
function canonicalJson(value: unknown): string {
    const normalize = (item: unknown): unknown => Array.isArray(item)
        ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.entries(item)
                .filter(([, entry]) => entry !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, normalize(entry)]))
            : item;
    return JSON.stringify(normalize(value));
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const ownerOf = (caller: Caller): string => JSON.stringify([caller.pluginId ?? '', caller.conversationId ?? '', caller.runId ?? '']);

interface NoteShape {
    headings: number[];
    paragraphs: number;
    tables: number;
    lists: number;
    quotes: number;
    rawHtml: number;
    codeLanguages: Map<string, number>;
    images: string[];
}

/** Counts what the converter will see. Walks the Pandoc-like AST without depending on each node's layout. */
function shapeOf(ast: unknown): NoteShape {
    const shape: NoteShape = {
        headings: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        paragraphs: 0,
        tables: 0,
        lists: 0,
        quotes: 0,
        rawHtml: 0,
        codeLanguages: new Map(),
        images: [],
    };
    const visit = (node: unknown, depth: number): void => {
        if (!node || typeof node !== 'object' || depth > 200) return;
        if (Array.isArray(node)) {
            for (const item of node) visit(item, depth + 1);
            return;
        }
        const { t, c } = node as { t?: unknown; c?: unknown };
        switch (t) {
            case 'Header': {
                const level = Array.isArray(c) && typeof c[0] === 'number' ? c[0] : 1;
                shape.headings[Math.min(9, Math.max(1, level)) - 1] += 1;
                break;
            }
            case 'Para': shape.paragraphs += 1; break;
            case 'Table': shape.tables += 1; break;
            case 'BulletList':
            case 'OrderedList': shape.lists += 1; break;
            case 'BlockQuote': shape.quotes += 1; break;
            case 'Div': {
                // Obsidian callouts arrive as Div.callout; report them as quotes.
                const classes = Array.isArray(c) && Array.isArray(c[0]) && Array.isArray(c[0][1]) ? c[0][1] : [];
                if (classes.includes('callout')) shape.quotes += 1;
                break;
            }
            case 'RawBlock': shape.rawHtml += 1; break;
            case 'CodeBlock': {
                const classes = Array.isArray(c) && Array.isArray(c[0]) && Array.isArray(c[0][1]) ? c[0][1] : [];
                const language = typeof classes[0] === 'string' && classes[0] ? classes[0].toLowerCase() : '';
                shape.codeLanguages.set(language, (shape.codeLanguages.get(language) ?? 0) + 1);
                return;
            }
            case 'Image': {
                const target: unknown = Array.isArray(c) && Array.isArray(c[2]) ? c[2][0] : undefined;
                if (typeof target === 'string') shape.images.push(target);
                return;
            }
            default: break;
        }
        for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(ast, 0);
    return shape;
}

/** Conversion warnings as pure JSON (DECISIONS 6: no undefined, no class instances). */
const warningsJson = (report: ConversionReport | undefined): Json[] =>
    (report?.warnings ?? []).map((warning) => ({
        code: warning.code,
        message: warning.message,
        count: warning.count,
        examples: [...warning.examples],
    }));

const warningLines = (report: ConversionReport | undefined, skip: string[] = []): string[] =>
    (report?.warnings ?? [])
        .filter((warning) => !skip.includes(warning.code))
        .map((warning) => `- ${warning.message}${warning.count > 1 ? ` ${warning.count}건` : ''}${warning.examples.length ? `: ${listed(warning.examples)}` : ''}`);

/** Image links arrive percent-encoded from the Markdown parser; show them as written in the note. */
const readable = (source: string): string => {
    try {
        return decodeURIComponent(source);
    } catch {
        return source;
    }
};

const listed = (items: string[]): string =>
    items.slice(0, MAX_LISTED).map(readable).join(', ') + (items.length > MAX_LISTED ? ` 외 ${items.length - MAX_LISTED}개` : '');

function normalizeNotePath(value: unknown): string {
    if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', 'path는 문자열이어야 한다.', true);
    const raw = value.trim().replace(/\\/g, '/');
    const parts = raw.split('/');
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this check rejects
    if (!raw || /^(?:[A-Za-z]:|\/)/.test(raw) || /[\u0000-\u001F]/.test(raw) || parts.includes('..')) {
        throw new ToolError('INVALID_ARGUMENT', 'path는 Vault 기준 상대 경로여야 한다.', true);
    }
    return parts.filter((part) => part && part !== '.').join('/');
}

export function createAgentProvider(host: ExportProviderHost): AgentCapabilityProvider {
    const descriptor: JsonObject = {
        provider: { id: host.id, name: host.name, version: host.version, description: 'Markdown 노트의 HWPX 내보내기 설정과 사전 점검' },
        instructions: INSTRUCTIONS,
        tools: TOOLS,
    };
    let disposed = false;

    /** Validates export_note arguments; the destination checked here is the one written. */
    const resolveExport = async (args: JsonObject): Promise<{ notePath: string; template: string; destination: string; bundle?: ReturnType<typeof validatedBundle> }> => {
        const notePath = normalizeNotePath(args.path);
        if (!/\.md$/i.test(notePath)) throw new ToolError('UNSUPPORTED_FORMAT', 'Markdown 노트(.md)만 내보낼 수 있다.');
        const note = await host.readNote(notePath);
        if (!note) throw new ToolError('NOT_FOUND', `Vault에 이 노트가 없다: ${notePath}`, true);
        const bundle = args.derive_from === undefined ? undefined : validatedBundle(args.derive_from);
        if (bundle && (args.template !== undefined || args.expected_template_sha256 !== undefined))
            throw new ToolError('INVALID_ARGUMENT', 'derive_from와 template은 함께 지정할 수 없다.');
        const template = bundle ? bundle.sample_path : (await loadNoteTemplate(host, notePath, args.template, args.expected_template_sha256)).path;

        let customOutputPath: string | undefined;
        if (args.outputPath !== undefined) {
            if (typeof args.outputPath !== 'string' || !args.outputPath.trim()) {
                throw new ToolError('INVALID_ARGUMENT', 'outputPath는 비어있지 않은 문자열이어야 한다.', true);
            }
            customOutputPath = normalizeNotePath(args.outputPath);
            if (!/\.hwpx$/i.test(customOutputPath)) {
                customOutputPath += '.hwpx';
            }
        }

        // The path checked here is the path written, so settings cannot move the write elsewhere.
        const target = customOutputPath ?? host.outputPath(notePath);
        if (target.split('/').some((part) => part.startsWith('.'))) {
            throw new ToolError('INVALID_ARGUMENT', `숨김 폴더나 숨김 파일에는 내보낼 수 없다: ${target}`, true);
        }
        if (host.exists(target)) {
            throw new ToolError('ALREADY_EXISTS', `이미 있는 파일은 덮어쓰지 않는다: ${target}. 다른 outputPath를 지정하라.`, true);
        }

        if (bundle) await readBoundBytes(host, bundle.sample_path, bundle.expected_sample_sha256);
        return { notePath, template, destination: target, ...(bundle ? { bundle } : {}) };
    };

    const prepared = new Map<string, {
        shown: CommitPreparation;
        bytes: Uint8Array;
        owner: string;
        state: 'open' | 'executed' | 'dropped';
        receipt?: CommitReceipt;
        outputAnchors?: SavedOutputAnchorEvidence;
        decompositionFiles?: PreparedDecompositionFile[];
    }>();

    const resolveTarget = async (name: string, args: JsonObject, ctx?: CommitContext): Promise<ExportTarget> => {
        if (disposed) throw new ToolError('DISPOSED', '플러그인이 종료됐다.');
        if (ctx?.signal?.aborted) throw new ToolError('CANCELLED', '대상 확인이 취소됐다.');
        if (name === 'derive_template') return 'derive_from' in args ? (await resolveDecompositionSave(host, args)).target : resolveDerivation(host, args);
        if (name !== 'export_note') throw new ToolError('UNKNOWN_TOOL', `저장 도구가 아니다: ${name}`);
        const { template, destination, bundle } = await resolveExport(args ?? {});
        return { kind: 'new', destination, template: { path: template, sha256: bundle?.expected_sample_sha256 ?? await host.templateHash(template) } };
    };

    const notWritten = (record: { shown: CommitPreparation }, ticketId: string, code: string, message: string): CommitReceipt => ({
        preparationId: record.shown.preparationId,
        ticketId,
        preparationDigest: record.shown.preparationDigest,
        state: 'not_written',
        entries: record.shown.writeSet.map((entry) => ({ path: entry.path, kind: entry.kind, state: 'not_written' as const })),
        warnings: [],
        error: { code, message: message.slice(0, 1000) },
    });

    const commit: AgentCapabilityProvider['commit'] = {
        /** Fixes the exact bytes of the new file in memory. Writes no Vault file. */
        async prepare(request, ctx) {
            if (disposed) throw new ToolError('DISPOSED', '플러그인이 종료됐다.');
            if (!['export_note', 'derive_template'].includes(request?.tool)) throw new ToolError('UNKNOWN_TOOL', `저장 도구가 아니다: ${String(request?.tool)}`);
            if (!ctx?.caller) throw new ToolError('INVALID_ARGUMENT', '저장을 요청한 호출을 확인할 수 없다.');
            if (request.captureOutputAnchors !== undefined && typeof request.captureOutputAnchors !== 'boolean') throw new ToolError('INVALID_ARGUMENT', 'Invalid output anchor request.');
            const captureOutputAnchors = request.captureOutputAnchors === true;
            const target = await resolveTarget(request.tool, request.args, ctx);
            if (canonicalJson(target) !== canonicalJson(request.target)) {
                throw new ToolError('TARGET_MISMATCH', '확정한 노트·템플릿·저장 경로가 지금과 다르다. 다시 준비하라.', true);
            }
            let bytes: Uint8Array, notePath: string, template: string;
            let report: ConversionReport | undefined, derivation: Record<string, unknown> | undefined, conversionHash: string | undefined, derivationHash: string | undefined;
            let inputDependencies: InputDependency[], providerInternalWrites: string[] = [];
            let outputAnchors: SavedOutputAnchorEvidence | null = null;
            let decomposition: Awaited<ReturnType<typeof prepareDecompositionSave>> | undefined;
            if (request.tool === 'derive_template' && 'derive_from' in request.args) {
                decomposition = await prepareDecompositionSave(host, request.args, ctx.signal);
                bytes = decomposition.files[0].bytes; notePath = decomposition.notePath; template = target.template.path; inputDependencies = decomposition.inputDependencies;
                providerInternalWrites = decomposition.providerInternalWrites;
            } else if (request.tool === 'derive_template') {
                const prepared = await prepareDerivation(host, request.args, ctx.signal);
                bytes = prepared.bytes; derivation = prepared.report; notePath = prepared.notePath; template = target.template.path; inputDependencies = prepared.inputDependencies;
            } else if (request.args.derive_from !== undefined) {
                const resolved = await resolveExport(request.args); notePath = resolved.notePath; template = resolved.template;
                const bundle = resolved.bundle; if (!bundle || !host.renderDerived) throw new ToolError('INVALID_ARGUMENT', 'Derived rendering unavailable.');
                const noteHash = request.args.expected_note_sha256;
                if (typeof noteHash !== 'string' || !/^[a-f0-9]{64}$/.test(noteHash)) throw new ToolError('INVALID_ARGUMENT', 'Bound note SHA-256 required.');
                const noteBytes = await readBoundBytes(host, notePath, noteHash);
                validateBundleDialect(bundle, new TextDecoder('utf-8', { fatal: true }).decode(noteBytes));
                const derived = await deriveBundleBytes(host, bundle, ctx.signal);
                const rendered = await host.renderDerived(notePath, template, derived.bytes, ctx.signal, captureOutputAnchors);
                bytes = rendered.bytes; report = rendered.report; derivationHash = bundle.derivation_sha256;
                conversionHash = await conversionFingerprint(bytes, ctx.signal);
                inputDependencies = mergeDependencies([{ path: notePath, sha256: noteHash }, { path: template, sha256: bundle.expected_sample_sha256 }, ...rendered.inputDependencies]);
                providerInternalWrites = rendered.providerInternalWrites;
                if (captureOutputAnchors) { try { outputAnchors = copyOutputAnchorEvidence(rendered.outputAnchors, sha256(bytes)); } catch { outputAnchors = null; } }
            } else {
                const resolved = await resolveExport(request.args ?? {}); notePath = resolved.notePath; template = resolved.template;
                const noteBytes = await host.readBytes(notePath), templateBytes = await (host.readBytesBounded ? host.readBytesBounded(template, 32 * 1024 * 1024) : host.readBytes(template));
                if (!noteBytes || !templateBytes || templateBytes.byteLength > 32 * 1024 * 1024) throw new ToolError('SOURCE_CHANGED', 'Export inputs are missing or template exceeds byte budget.');
                inputDependencies = [{ path: notePath, sha256: sha256(noteBytes) }, { path: template, sha256: sha256(templateBytes) }];
                if (inputDependencies[1].sha256 !== target.template.sha256 || request.args.expected_note_sha256 !== undefined && request.args.expected_note_sha256 !== inputDependencies[0].sha256 || request.args.expected_template_sha256 !== undefined && request.args.expected_template_sha256 !== inputDependencies[1].sha256) throw new ToolError('SOURCE_CHANGED', 'Export input hash changed.');
                const rendered = captureOutputAnchors ? await host.render(notePath, template, ctx.signal, true) : await host.render(notePath, template, ctx.signal); bytes = rendered.bytes; report = rendered.report;
                if (captureOutputAnchors) {
                    // Anchor evidence is optional: a malformed observation must not
                    // prevent the otherwise valid export from being prepared.
                    try { outputAnchors = copyOutputAnchorEvidence(rendered.outputAnchors, sha256(bytes)); }
                    catch { outputAnchors = null; }
                }
                // Preserve legacy hosts that return opaque, non-ZIP export bytes.
                // Real template conversions return HWPX packages and always carry this digest.
                if (bytes[0] === 0x50 && bytes[1] === 0x4b) conversionHash = await conversionFingerprint(bytes, ctx.signal);
                inputDependencies.push(...(rendered.inputDependencies ?? [])); providerInternalWrites = rendered.providerInternalWrites ?? [];
            }
            const templateWarnings = request.tool === 'export_note'
                ? await templateOverrideWarnings(host, notePath, request.args.template, ctx.signal) : [];
            if (!await dependenciesCurrent(host, inputDependencies)) throw new ToolError('SOURCE_CHANGED', 'Input changed during preparation.');
            if (ctx.signal?.aborted) throw new ToolError('CANCELLED', '저장 준비가 취소됐다.');
            const owner = ownerOf(ctx.caller);
            for (const record of prepared.values()) {
                if (record.state === 'open' && record.owner === owner && record.shown.destination === target.destination) {
                    record.state = 'dropped';
                }
            }
            const folders: FolderEntry[] = host.missingFolders(target.destination)
                .map((folder) => ({ kind: 'folder', path: folder, op: 'create', role: 'folder', existedBefore: false }));
            const body: Omit<CommitPreparation, 'preparationDigest'> = {
                preparationId: `hwpx-${randomUUID()}`,
                mode: 'create',
                template: target.template,
                destination: target.destination,
                format: 'hwpx',
                saveOptions: { note: notePath, inputDependencies: inputDependencies.map(item => ({ path: item.path, sha256: item.sha256 })) },
                writeSet: decomposition?.writeSet ?? [
                    ...folders,
                    {
                        kind: 'file', path: target.destination, op: 'create', role: 'primary',
                        sha256Before: null, sha256Expected: sha256(bytes), sizeBytes: bytes.byteLength,
                    },
                ],
                providerInternalWrites,
                report: {
                    summary: decomposition ? ['샘플 분해 저장: 텍스트 MD 1개 + 템플릿 HWPX 1개.'] : [`노트 ${notePath}을(를) 템플릿 ${template}로 변환한 새 파일을 만든다.`],
                    warnings: [...templateWarnings.map((warning) => '- ' + warning.message), ...warningLines(report).slice(0, 20).map((line) => line.slice(0, 300))],
                    ...(derivation ? { derivation: derivation as JsonObject } : {}),
                    ...(derivationHash ? { derivation_sha256: derivationHash } : {}),
                    ...(conversionHash ? { conversionFingerprint: conversionHash } : {}),
                    ...(decomposition ? decomposition.report : {}),
                },
                expiresAt: new Date(Date.now() + COMMIT_TTL_MS).toISOString(),
            };
            const shown: CommitPreparation = { ...body, preparationDigest: sha256(canonicalJson(body)) };
            prepared.set(shown.preparationId, { shown, bytes, owner, state: 'open', ...(decomposition ? { decompositionFiles: decomposition.files } : {}), ...(outputAnchors ? { outputAnchors } : {}) });
            while (prepared.size > MAX_PREPARED) prepared.delete(prepared.keys().next().value as string);
            return JSON.parse(JSON.stringify(shown)) as CommitPreparation;
        },

        /**
         * Writes exactly the prepared bytes. The host has checkpointed the write set
         * before this call; this side re-checks the binding and never writes twice.
         */
        async execute(ticket, ctx) {
            const record = prepared.get(ticket?.preparationId);
            if (!record) throw new ToolError('NOT_FOUND', '저장 준비를 찾을 수 없다. 다시 실행하지 말고 host의 체크포인트로 확인하라.');
            const ticketId = String(ticket.ticketId);
            if (record.receipt) return JSON.parse(JSON.stringify(record.receipt)) as CommitReceipt;
            if (!ctx?.caller || !ticket.caller || ownerOf(ctx.caller) !== record.owner || ownerOf(ticket.caller) !== record.owner) {
                return notWritten(record, ticketId, 'TARGET_MISMATCH', '저장을 준비한 대화·실행과 다른 호출이다. 저장하지 않았다.');
            }
            if (record.state !== 'open') {
                return notWritten(record, ticketId, 'REVISION_CONFLICT', '이 저장 준비는 새 준비로 대체됐다. 저장하지 않았다.');
            }
            if (ticket.preparationDigest !== record.shown.preparationDigest
                || ticket.destination !== record.shown.destination
                || canonicalJson(ticket.writeSet) !== canonicalJson(record.shown.writeSet)) {
                return notWritten(record, ticketId, 'INVALID_ARGUMENT', '저장 ticket이 승인한 준비와 다르다. 저장하지 않았다.');
            }
            if (Date.parse(record.shown.expiresAt) <= Date.now()) {
                return notWritten(record, ticketId, 'EXPIRED', '저장 준비가 만료됐다. 저장하지 않았다.');
            }
            if (disposed || ctx.signal?.aborted) {
                return notWritten(record, ticketId, 'CANCELLED', '저장이 취소됐다. 저장하지 않았다.');
            }
            if (record.decompositionFiles) {
                try { await assertDecompositionPathsFree(host, record.decompositionFiles.map(f => f.path)); }
                catch (cause) { return notWritten(record, ticketId, cause instanceof DeriveProviderError ? cause.code : 'READBACK_FAILED', String(cause)); }
                const dependencies = record.shown.saveOptions.inputDependencies as Array<{ path: string; sha256: string }>;
                if (!await dependenciesCurrent(host, dependencies).catch(() => false)) { record.state = 'dropped'; return notWritten(record, ticketId, 'SOURCE_CHANGED', 'Input changed after preparation.'); }
                if (disposed || ctx.signal?.aborted) return notWritten(record, ticketId, 'CANCELLED', 'Save cancelled before first write.');
                record.state = 'executed';
                record.receipt = await executeDecompositionSave(host, record.shown, record.decompositionFiles, ticketId, ctx.signal, () => disposed);
                return JSON.parse(JSON.stringify(record.receipt)) as CommitReceipt;
            }
            const { destination } = record.shown;
            if (await host.readBytes(destination)) {
                return notWritten(record, ticketId, 'ALREADY_EXISTS', `이미 있는 파일은 덮어쓰지 않는다: ${destination}`);
            }

            const dependencies = record.shown.saveOptions.inputDependencies as Array<{ path: string; sha256: string }>;
            if (!await dependenciesCurrent(host, dependencies).catch(() => false)) { record.state = 'dropped'; return notWritten(record, ticketId, 'SOURCE_CHANGED', 'Input changed after preparation; nothing was written.'); }
            if (disposed || ctx.signal?.aborted) return notWritten(record, ticketId, 'CANCELLED', 'Save cancelled before first write.');
            record.state = 'executed';
            const folders = record.shown.writeSet.filter((entry): entry is FolderEntry => entry.kind === 'folder').map((entry) => entry.path);
            let error: CommitReceipt['error'];
            try {
                await host.writeNew(destination, record.bytes, folders);
            } catch (cause) {
                error = { code: 'WRITE_FAILED', message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) };
            }
            // Report only what can be read back.
            let foldersUnverified = false, fileUnverified = false;
            let stillMissing = new Set<string>();
            try { stillMissing = new Set(host.missingFolders(destination)); }
            catch (cause) { foldersUnverified = true; error ??= { code: 'READBACK_FAILED', message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) }; }
            const after = await host.readBytes(destination).catch((cause: unknown) => {
                fileUnverified = true;
                error ??= { code: 'READBACK_FAILED', message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) };
                return null;
            });
            const fileHash = after ? sha256(after) : undefined;
            const expected = (record.shown.writeSet.find((entry) => entry.kind === 'file') as FileEntry).sha256Expected;
            const entries: CommitReceipt['entries'] = record.shown.writeSet.map((entry) => entry.kind === 'folder'
                ? { path: entry.path, kind: 'folder' as const, state: foldersUnverified ? 'unknown' as const : stillMissing.has(entry.path) ? 'not_written' as const : 'written' as const }
                : {
                    path: entry.path,
                    kind: 'file' as const,
                    state: fileUnverified ? 'unknown' as const : !fileHash ? 'not_written' as const : fileHash === expected ? 'written' as const : 'unknown' as const,
                    ...(fileHash ? { sha256After: fileHash } : {}),
                });
            const states = entries.map((entry) => entry.state);
            const state: CommitReceipt['state'] = states.includes('unknown') ? 'unknown'
                : states.every((item) => item === 'written') ? 'written'
                    : states.includes('written') ? 'partial' : 'not_written';
            record.receipt = {
                preparationId: record.shown.preparationId,
                ticketId,
                preparationDigest: record.shown.preparationDigest,
                state,
                entries,
                warnings: [],
                ...(error ? { error } : {}),
            };
            return JSON.parse(JSON.stringify(record.receipt)) as CommitReceipt;
        },

        /** Optional local read; never changes the v1 preparation or receipt. */
        async outputAnchors(request, ctx) {
            if (disposed || ctx?.signal?.aborted) throw new ToolError('CANCELLED', 'Output anchor read cancelled.');
            const record = prepared.get(request?.preparationId);
            const offset = request?.offset ?? 0, limit = request?.limit ?? 100;
            if (!record || !ctx?.caller || ownerOf(ctx.caller) !== record.owner ||
                request.preparationDigest !== record.shown.preparationDigest ||
                record.receipt?.state !== 'written' || record.state !== 'executed' ||
                !record.outputAnchors || request.archiveSha256 !== record.outputAnchors.archiveSha256 ||
                Date.parse(record.shown.expiresAt) <= Date.now() ||
                !Number.isSafeInteger(offset) || offset < 0 || offset > record.outputAnchors.anchors.length ||
                !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
                throw new ToolError('INVALID_ARGUMENT', 'Bound saved output anchors unavailable.');
            const entry = record.shown.writeSet.find((item): item is FileEntry => item.kind === 'file' && item.path === record.shown.destination);
            if (!entry || !host.readBytesBounded) throw new ToolError('INVALID_ARGUMENT', 'Bounded output read unavailable.');
            const current = await host.readBytesBounded(record.shown.destination, entry.sizeBytes).catch(() => {
                throw new ToolError('READBACK_FAILED', 'Saved output changed or cannot be read within its approved size.');
            });
            if (ctx.signal?.aborted) throw new ToolError('CANCELLED', 'Output anchor read cancelled.');
            if (disposed || prepared.get(record.shown.preparationId) !== record || Date.parse(record.shown.expiresAt) <= Date.now())
                throw new ToolError('EXPIRED', 'Saved output anchors are no longer available.');
            if (!current || current.byteLength !== entry.sizeBytes || sha256(current) !== record.outputAnchors.archiveSha256)
                throw new ToolError('SOURCE_CHANGED', 'Saved output changed; anchors are no longer available.');
            const evidence = record.outputAnchors, anchors = evidence.anchors.slice(offset, offset + limit).map(anchor => ({ ...anchor }));
            const next = offset + anchors.length;
            return { version: `saved-output-anchors/${evidence.anchorVersion}`, state: 'partial', scope: 'rendered_export',
                preparationId: record.shown.preparationId, preparationDigest: record.shown.preparationDigest,
                destination: record.shown.destination, archiveSha256: evidence.archiveSha256, sectionSha256: evidence.sectionSha256,
                total: evidence.anchors.length, offset, nextOffset: next < evidence.anchors.length ? next : null, anchors };
        },

        /** Result of an execution. Never writes. */
        async status(preparationId) {
            const record = prepared.get(preparationId);
            if (!record) return { state: 'unknown_preparation' };
            return JSON.parse(JSON.stringify(record.receipt ?? notWritten(record, 'none', 'NOT_EXECUTED', '저장을 실행하지 않았다.'))) as CommitReceipt;
        },
    };

    const handlers: Record<string, (args: JsonObject, signal?: AbortSignal) => Promise<AgentToolResult>> = {
        async inspect_decomposition_template(args, signal) {
            const result = await inspectDecompositionTemplate(host, args, signal);
            return { content: [{ type: 'text', text: 'Decomposition template integrity facts.' }], structuredContent: JSON.parse(JSON.stringify(result)) as JsonObject };
        },
        async inspect_derive_structure(args, signal) {
            if (Object.keys(args).some(k => !['sample_path', 'expected_sample_sha256'].includes(k)) || typeof args.sample_path !== 'string' || !/\.hwpx$/i.test(args.sample_path) || typeof args.expected_sample_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expected_sample_sha256)) throw new ToolError('INVALID_ARGUMENT', 'Bound HWPX sample required.');
            signal?.throwIfAborted();
            const bytes = await readBoundBytes(host, args.sample_path, args.expected_sample_sha256);
            const result = await inspectDeriveStructure(bytes, signal);
            if (!await dependenciesCurrent(host, [{ path: args.sample_path, sha256: args.expected_sample_sha256 }])) throw new ToolError('SOURCE_CHANGED', 'Sample changed during structure inspection.');
            return { content: [{ type: 'text', text: 'Derivation structure facts.' }], structuredContent: JSON.parse(JSON.stringify(result)) as JsonObject };
        },
        async preview_derived_export(args, signal) {
            const result = await previewDerivedExport(host, args, signal);
            return { content: [{ type: 'text', text: 'Derived export preview.' }], structuredContent: JSON.parse(JSON.stringify(result)) as JsonObject };
        },
        async get_derivation_report(args, signal) {
            const report = await derivationReport(host, args, signal);
            return { content: [{ type: 'text', text: 'Current derivation report; layout not measured.' }], structuredContent: report, _meta: { 'dev.agentinterop/evidencePaths': [typeof args.path === 'string' ? args.path : ''] } };
        },
        async derive_template() { throw new ToolError('INVALID_ARGUMENT', 'derive_template requires the host commit approval pipeline.'); },
        async inspect_export_blocks(args, signal) {
            signal?.throwIfAborted();
            if (Object.keys(args).some(key => !['path', 'template', 'offset', 'limit', 'expected_inputs_digest', 'block_contract_version'].includes(key)))
                throw new ToolError('INVALID_ARGUMENT', 'Unexpected block inspection argument.');
            const notePath = normalizeNotePath(args.path);
            if (!/\.md$/i.test(notePath)) throw new ToolError('UNSUPPORTED_FORMAT', 'Markdown note required.');
            const offset = args.offset === undefined ? 0 : args.offset;
            const limit = args.limit === undefined ? 100 : args.limit;
            const expected = args.expected_inputs_digest;
            if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 50000 ||
                typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
                (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) ||
                (offset > 0 && expected === undefined) ||
                (args.block_contract_version !== undefined && args.block_contract_version !== 'observed-block-page/0.4'))
                throw new ToolError('INVALID_ARGUMENT', 'Invalid page or missing expected inputs digest.');
            const template = (await trialTemplate(host, notePath, args.template, signal)).path;
            const note = await host.readNote(notePath);
            signal?.throwIfAborted();
            if (!note) throw new ToolError('NOT_FOUND', 'Note not found.');
            if (!note.sha256 || note.sizeBytes === undefined)
                throw new ToolError('INVALID_ARGUMENT', 'A bound note identity is required.');
            const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-export-blocks-'));
            try {
                const conversion = await host.convert(note.markdown, notePath, template, path.join(workDir, 'check.hwpx'),
                    signal, { sha256: note.sha256, sizeBytes: note.sizeBytes }, true);
                signal?.throwIfAborted();
                if (!conversion || !('templateSha256' in conversion) || !isRecordedObservedBlockIndex(conversion.blockIndex))
                    throw new ToolError('INVALID_ARGUMENT', 'Bound block observations unavailable.');
                const page = observedBlockPage({ pluginId: host.id, pluginVersion: host.version, notePath,
                    noteSha256: note.sha256, templatePath: template, templateSha256: conversion.templateSha256,
                    artifactId: conversion.artifactId ?? null, configDigest: conversion.configDigest ?? '',
                    inputDependencies: conversion.inputDependencies ?? null, index: conversion.blockIndex,
                    offset, limit, expectedDigest: expected,
                    version: args.block_contract_version });
                return { content: [{ type: 'text', text: 'Bound trial conversion block observations.' }],
                    structuredContent: page as unknown as JsonObject };
            } finally {
                fs.rmSync(workDir, { recursive: true, force: true });
            }
        },
        async get_export_options(): Promise<AgentToolResult> {
            const options = host.options();
            const templates = host.templates();
            const capture = !options.captureRenderedBlocks
                ? '끔'
                : [
                    options.captureMermaid ? 'Mermaid' : '',
                    options.captureSvgFiles ? 'SVG 파일' : '',
                    options.captureThirdPartyRenderers ? `서드파티(${options.thirdPartyLanguages.join(', ')})` : '',
                ].filter(Boolean).join(', ') || '대상 없음';
            const lines = [
                `템플릿 폴더: ${options.templateFolderPath || '/ (Vault 최상위)'} · 템플릿 ${templates.length}개${templates.length ? '' : ' (이 폴더 바로 아래에 .hwpx가 없어 내보낼 수 없다)'}`,
                ...templates.slice(0, MAX_LISTED).map((template) => `- ${template}`),
                ...(templates.length > MAX_LISTED ? [`… 템플릿 ${templates.length - MAX_LISTED}개 더 있음`] : []),
                `저장 위치: ${options.outputMode === 'fixed_folder' ? `고정 폴더 ${options.fixedOutputFolder}` : '노트와 같은 폴더'} · 파일 이름: ${options.namingPattern} · 같은 이름이 있으면 ${options.appendSequenceOnConflict ? '-1, -2를 붙인다' : '덮어쓴다'}`,
                `H1 앞 쪽 나눔: ${options.pageBreakBeforeH1 ? '켬' : '끔'} · 그림 캡처: ${capture}`,
            ];
            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                structuredContent: {
                    templates: templates.length,
                    templatePaths: templates, templateFolderPath: options.templateFolderPath, markerCatalog, prefixMarkerSupport: 1, variantMarkerSupport: 1, captionFootnoteVariantSupport: 1, contextSpacerSupport: 1, decompositionSupport: 1, ...(host.renderDerived ? { deriveBundleSupport: 1 } : {}),
                    outputMode: options.outputMode,
                    overwritesExisting: !options.appendSequenceOnConflict,
                },
            };
        },
        async check_export(args, signal): Promise<AgentToolResult> {
            signal?.throwIfAborted();
            const notePath = normalizeNotePath(args.path);
            if (!/\.md$/i.test(notePath)) throw new ToolError('UNSUPPORTED_FORMAT', 'Markdown 노트(.md)만 내보낼 수 있다.');
            const note = await host.readNote(notePath);
            signal?.throwIfAborted();
            if (!note) throw new ToolError('NOT_FOUND', `Vault에 이 노트가 없다: ${notePath}`, true);
            const loadedTemplate = await trialTemplate(host, notePath, args.template, signal);
            const template = loadedTemplate.path, templates = host.templates();
            const templateWarnings = await templateOverrideWarnings(host, notePath, args.template, signal);

            const options = host.options();
            const staticCount = scanRenderableBlocks(stripObsidianComments(note.markdown), { languages: ['chart-hands-static'], includeSvgFiles: false }).length;
            const staticAvailable = host.staticChartAvailable?.() ?? null;
            const unboundCapture = hasUnboundThirdPartyCapture(note.markdown, options);
            const agentExportBlocked = unboundCapture || staticCount > 10 || (staticCount > 0 && staticAvailable === false);
            const { content } = parseMarkdownStringWithFrontmatter(note.markdown);
            const shape = shapeOf(new MarkoToPandocAdapter().parse(rewriteObsidianImageEmbeds(content)));
            const remote = shape.images.filter((source) => /^[a-z][a-z0-9+.-]*:/i.test(source));
            const local = shape.images.filter((source) => !remote.includes(source));
            const missing = local.filter((source) => !source || !host.resolvesImage(source, notePath));
            const captured: string[] = [];
            const kept: string[] = [];
            const thirdParty = new Set(options.thirdPartyLanguages.map((language) => language.trim().toLowerCase()).filter(Boolean));
            const renderCounts = new Map<string, number>();
            for (const block of scanRenderableBlocks(stripObsidianComments(note.markdown), { languages: new Set(['mermaid', ...thirdParty]), includeSvgFiles: false })) {
                renderCounts.set(block.hint, (renderCounts.get(block.hint) ?? 0) + 1);
            }
            for (const [language, count] of renderCounts) {
                const capturable = language === 'mermaid'
                    ? options.captureMermaid
                    : thirdParty.has(language) && options.captureThirdPartyRenderers;
                if (language === 'mermaid' || thirdParty.has(language)) {
                    (options.captureRenderedBlocks && capturable ? captured : kept).push(`${language} ${count}개`);
                }
            }

            // The converter only writes files, so the trial output goes to the OS temp folder and is removed.
            signal?.throwIfAborted();
            const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-export-check-'));
            let bytes = 0;
            let failure = '';
            let report: ConversionReport | undefined;
            let usedTemplateSha256: string | null = null;
            let inspection: TemplateInspection | undefined;
            let inspectedFrozenTemplate = false;
            let identity: ReturnType<typeof preflightIdentity> | null = null;
            let selectionSummary: SelectionSummary | null = null;
            try {
                const outputFile = path.join(workDir, 'check.hwpx');
                const noteIdentity = note.sha256 !== undefined && note.sizeBytes !== undefined
                    ? { sha256: note.sha256, sizeBytes: note.sizeBytes } : undefined;
                const conversion = await host.convert(note.markdown, notePath, template, outputFile, signal, noteIdentity);
                if (conversion && 'templateSha256' in conversion) {
                    report = conversion.report;
                    usedTemplateSha256 = conversion.templateSha256;
                    inspection = conversion.inspection;
                    inspectedFrozenTemplate = true;
                    identity = preflightIdentity({ pluginId: host.id, pluginVersion: host.version, notePath,
                        noteSha256: note.sha256, templatePath: template, templateSha256: usedTemplateSha256,
                        artifactId: conversion.artifactId, configDigest: conversion.configDigest,
                        inputDependencies: conversion.inputDependencies });
                    selectionSummary = safeSelectionSummary(conversion.selectionSummary);
                } else {
                    report = conversion ?? undefined;
                }
                bytes = fs.statSync(outputFile).size;
            } catch (error) {
                signal?.throwIfAborted();
                failure = error instanceof Error ? error.message : String(error);
            } finally {
                fs.rmSync(workDir, { recursive: true, force: true });
            }
            const preflightReport = new ConversionReportCollector();
            preflightReport.merge(captureReport(note.markdown, options, { failures: [], contractViolation: false }));
            if (unboundCapture) preflightReport.add('render_capture_unbound', '타사 렌더 입력을 결속할 수 없어 에이전트 저장 준비가 차단됩니다');
            if (report) preflightReport.merge(report);
            report = preflightReport.toJSON();

            // Template typos silently fall back, so they are worth an agent's attention.
            if (!inspectedFrozenTemplate) {
                try {
                    inspection = await host.inspectTemplate?.(template);
                } catch {
                    inspection = undefined;
                }
            }
            const typos = (inspection?.unknownMarkers ?? []).filter((item) => item.suggestion);

            const headings = shape.headings.map((count, index) => (count ? `H${index + 1} ${count}` : '')).filter(Boolean).join(', ');
            const codeBlocks = [...shape.codeLanguages.values()].reduce((sum, count) => sum + count, 0);
            const outputPath = host.outputPath(notePath);
            const notes = [
                ...templateWarnings.map((warning) => '- ' + warning.message),
                ...(missing.length ? [`- 그림 ${missing.length}개를 찾지 못했거나 넣을 수 없는 형식이라 글자로 대체된다: ${listed(missing.map((source) => source || '(경로 없음)'))}`] : []),
                ...(remote.length ? [`- 원격 그림 ${remote.length}개는 넣지 않고 글자로 대체된다: ${listed(remote)}`] : []),
                ...(captured.length ? [`- 일반 내보내기에서 그림 캡처를 시도한다(이 점검에서는 캡처와 성공 여부를 확인하지 않았다): ${captured.join(', ')}`] : []),
                ...(staticCount ? [`- 데이터 전용 차트 ${staticCount}개: 이 점검에서는 렌더링하지 않았다. ${staticAvailable === false ? 'Chart Hands 정적 렌더러가 없어 저장 준비가 차단된다.' : staticCount > 10 ? '10개 제한을 넘어 저장 준비가 차단된다.' : '저장 준비에서 Chart Hands 렌더링과 입력 검증이 필요하다.'}`] : []),
                ...(kept.length ? [`- 캡처 설정이 꺼져 있어 코드 글자 그대로 들어간다: ${kept.join(', ')}`] : []),
                ...(shape.rawHtml ? [`- HTML 블록 ${shape.rawHtml}개: 표(<table>) 외의 HTML은 그대로 변환되지 않을 수 있다`] : []),
                ...(!options.appendSequenceOnConflict ? ['- 같은 이름의 파일이 있으면 덮어쓰는 설정이다'] : []),
                // Image problems are already listed above from the note itself.
                ...warningLines(report, ['image_missing', 'image_remote', ...(kept.length ? ['render_capture_disabled'] : [])]),
                ...(typos.length
                    ? [`- 템플릿에 오타로 보이는 marker가 있어 그 서식이 적용되지 않는다: ${listed(typos.map((item) => `${item.marker}→${item.suggestion}`))}`]
                    : []),
            ];
            const lines = [
                `노트 ${notePath} → 내보내면 ${outputPath} (템플릿 ${template}${loadedTemplate.source === 'default' && templates.length > 1 ? `, 템플릿 ${templates.length}개 중 첫 번째로 시험` : ''})`,
                failure
                    ? `변환 시험: 실패 — ${failure}`
                    : `변환 시험: 성공 · HWPX ${bytes.toLocaleString('en-US')}바이트 (Vault에는 아무것도 만들지 않았다)`,
                `구성: 제목 ${shape.headings.reduce((sum, count) => sum + count, 0)}${headings ? `(${headings})` : ''} · 문단 ${shape.paragraphs} · 표 ${shape.tables} · 목록 ${shape.lists} · 인용 ${shape.quotes} · 코드 블록 ${codeBlocks} · 그림 ${shape.images.length}`,
                ...(notes.length ? ['주의:', ...notes] : ['주의할 점을 찾지 못했다.']),
            ];
            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                structuredContent: {
                    converts: !failure,
                    agentExportBlocked,
                    staticCharts: { count: staticCount, rendererAvailable: staticAvailable },
                    noteSha256: note.sha256 ?? null,
                    templateSha256: usedTemplateSha256,
                    conversionFingerprint: identity?.conversionFingerprint ?? null,
                    usedInputs: identity?.usedInputs ?? null,
                    selectionSummary,
                    outputPath,
                    template,
                    tables: shape.tables,
                    images: shape.images.length,
                    missingImages: missing.length,
                    remoteImages: remote.length,
                    warnings: [...templateWarnings, ...warningsJson(report)],
                    templateTypos: typos.map((item) => ({ marker: item.marker, suggestion: item.suggestion ?? '' })),
                },
                _meta: { 'dev.agentinterop/resource': { path: notePath } },
            };
        },
        async export_note(): Promise<AgentToolResult> {
            throw new ToolError('INVALID_ARGUMENT', 'export_note는 host의 저장 승인 절차(commit)로만 실행된다.');
        },
    };

    return {
        protocol: 'agentinterop',
        protocolVersion: 1,
        async describe() {
            return descriptor;
        },
        resolveTarget,
        commit,
        async callTool(name, args, ctx) {
            try {
                if (disposed) throw new ToolError('DISPOSED', '플러그인이 종료됐다.');
                const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
                if (!handler) throw new ToolError('UNKNOWN_TOOL', `알 수 없는 도구다: ${name}`);
                const result = await handler(args ?? {}, ctx?.signal);
                if (ctx?.signal?.aborted) throw new ToolError('CANCELLED', '호출이 취소됐다.');
                return result;
            } catch (error) {
                const actual = ctx?.signal?.aborted ? new ToolError('CANCELLED', '호출이 취소됐다.') : error instanceof RetiredRecordError || error instanceof DialectError ? new DeriveProviderError('INVALID_ARGUMENT', error.message, error.details) : error;
                const known = actual instanceof ToolError || actual instanceof DeriveProviderError;
                const code = known ? actual.code : 'INTERNAL';
                const retryable = actual instanceof ToolError && actual.retryable;
                return {
                    isError: true,
                    content: [{ type: 'text', text: known ? actual.message : `도구 실행 중 오류: ${actual instanceof Error ? actual.message : String(actual)}` }],
                    structuredContent: { code, retryable, ...(actual instanceof DeriveProviderError && actual.details ? { details: actual.details } : {}) },
                    _meta: { 'dev.agentinterop/error': { code, retryable, ...(actual instanceof DeriveProviderError && actual.details ? { details: actual.details } : {}) } },
                };
            }
        },
        dispose() {
            disposed = true;
            prepared.clear();
        },
    };
}
