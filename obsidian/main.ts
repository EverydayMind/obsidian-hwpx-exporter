import { readTemplateMode } from '../src/template-derive/templateMetadata';
import { loadNoteTemplate, preferredTemplatePaths, assertVaultRealPath, hasNormalizedDiskPath, templateDerivedMode, TEMPLATE_MAX_BYTES, type TemplateLoaderHost } from './templateLoader';
import type { InputDependency } from './deriveProvider';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { frozenPreflight } from './frozenPreflight';
import { PREFLIGHT_MAX_FILE_BYTES, readBoundedPreflightInput } from './preflightTemplate';
import {
    App,
    FileView,
    FuzzySuggestModal,
    Menu,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    type SettingDefinitionItem,
    TAbstractFile,
    TFile,
    TFolder,
    type WorkspaceLeaf,
    normalizePath,
    FileSystemAdapter,
} from 'obsidian';
import { convertString } from '../src/converterApi';
import { ObservedBlockRecorder } from '../src/observedBlockIndex';
import { ConversionConfig } from '../src/config';
import { ConversionReportCollector, summarizeReport, type ConversionReport } from '../src/conversionReport';
import { captureReport } from './captureReport';
import { inspectTemplate, type TemplateInspection } from '../src/templateInspector';
import { stripObsidianComments } from '../src/obsidianComments';
import {
    isSupportedEmbeddedImagePath,
    rewriteObsidianImageEmbeds,
} from '../src/obsidianImageEmbeds';
import { findAvailableOutputPath } from './outputPath';
import { captureRenderableBlocks } from './svgCapture';
import { hasUnboundThirdPartyCapture } from './agentCaptureGuard';
import { captureStaticCharts, STATIC_CHART_API } from './staticChartCapture';
import {
    AGENT_CAPABILITY_PROVIDER,
    PROVIDERS_CHANGED_EVENT,
    createAgentProvider,
    type AgentCapabilityProvider,
} from './agentProvider';
import bundledTemplates, { guide } from 'virtual:bundled-templates';

// Where "Install bundled templates" writes when no template folder has been chosen.
const DEFAULT_TEMPLATE_FOLDER = 'HWPX templates';
// When this plugin is enabled, a single-note export opens in its editor instead of the OS default app.
const HWP_HANDS_PLUGIN_ID = 'hwp-hands';

type OutputMode = 'same_as_source' | 'fixed_folder';
type NamingPattern = '{basename}.hwpx' | '{basename}-{yyyyMMdd}.hwpx';

interface HWPXExporterSettings {
    templateFolderPath: string;
    outputMode: OutputMode;
    fixedOutputFolder: string;
    namingPattern: NamingPattern;
    appendSequenceOnConflict: boolean;
    pageBreakBeforeH1: boolean;
    maxInputFileSizeMb: number;
    maxTemplateFileSizeMb: number;
    maxNestingDepth: number;
    maxImageCount: number;
    captureRenderedBlocks: boolean;
    captureSvgFiles: boolean;
    captureMermaid: boolean;
    captureThirdPartyRenderers: boolean;
    thirdPartyLanguages: string[];
    captureExcalidraw: boolean;
    rasterScale: number;
    captureWidthPx: number;
    captureTimeoutMs: number;
    captureTotalTimeoutMs: number;
    maxCaptureBlocks: number;
    forceLightThemeOnCapture: boolean;
    forceLightThemeAggressive: boolean;
    mermaidDisableHtmlLabels: boolean;
    allowForeignObject: boolean;
    useNativeImageSize: boolean;
}

const DEFAULT_SETTINGS: HWPXExporterSettings = {
    templateFolderPath: '',
    outputMode: 'same_as_source',
    fixedOutputFolder: 'exports/hwpx',
    namingPattern: '{basename}.hwpx',
    appendSequenceOnConflict: true,
    pageBreakBeforeH1: true,
    maxInputFileSizeMb: 50,
    maxTemplateFileSizeMb: 50,
    maxNestingDepth: 20,
    maxImageCount: 500,
    captureRenderedBlocks: true,
    captureSvgFiles: true,
    captureMermaid: true,
    captureThirdPartyRenderers: false,
    thirdPartyLanguages: ['chart', 'plantuml', 'graphviz', 'timeline', 'plotly'],
    captureExcalidraw: false,
    rasterScale: 2,
    captureWidthPx: 0,
    captureTimeoutMs: 8000,
    captureTotalTimeoutMs: 60000,
    maxCaptureBlocks: 50,
    forceLightThemeOnCapture: true,
    forceLightThemeAggressive: false,
    mermaidDisableHtmlLabels: true,
    allowForeignObject: false,
    useNativeImageSize: true,
};

abstract class AwaitableFuzzyModal<T> extends FuzzySuggestModal<T> {
    private resolver: ((value: T | null) => void) | null = null;
    private settled = false;

    openAndGetValue(): Promise<T | null> {
        this.settled = false;
        return new Promise<T | null>((resolve) => {
            this.resolver = resolve;
            this.open();
        });
    }

    protected resolveWith(value: T | null): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.resolver?.(value);
        this.resolver = null;
    }

    onClose(): void {
        super.onClose();
        window.setTimeout(() => this.resolveWith(null), 0);
    }
}

class FolderSuggestModal extends AwaitableFuzzyModal<TFolder> {
    constructor(app: App, private readonly folders: TFolder[]) {
        super(app);
        this.setPlaceholder('Select folder to export');
    }

    getItems(): TFolder[] {
        return this.folders;
    }

    getItemText(item: TFolder): string {
        return item.path.length > 0 ? item.path : '/ (Vault root)';
    }

    onChooseItem(item: TFolder): void {
        this.resolveWith(item);
        this.close();
    }
}

class TemplateSuggestModal extends AwaitableFuzzyModal<TFile> {
    constructor(app: App, private readonly files: TFile[]) {
        super(app);
        this.setPlaceholder('Select .hwpx template');
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.resolveWith(item);
        this.close();
    }
}

/** Shows what a template defines and what will fall back (src/templateInspector.ts). */
class TemplateInspectionModal extends Modal {
    constructor(app: App, private readonly templatePath: string, private readonly inspection: TemplateInspection) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        const { markers, unknownMarkers, fallbacks, warnings } = this.inspection;
        contentEl.createEl('h2', { text: `템플릿 검사: ${this.templatePath}` });

        contentEl.createEl('h3', { text: `오타로 보이거나 읽지 않는 marker (${unknownMarkers.length})` });
        if (unknownMarkers.length === 0) {
            contentEl.createEl('p', { text: '없음' });
        } else {
            const list = contentEl.createEl('ul');
            for (const item of unknownMarkers) {
                list.createEl('li', {
                    text: item.suggestion
                        ? `${item.marker} → ${item.suggestion}?`
                        : `${item.marker}: 변환기가 읽지 않는 글자다${item.marker === '{{title}}' ? '({{title}}은 노트 본문에서만 바뀐다)' : ''}`,
                });
            }
        }

        if (warnings.length > 0) {
            contentEl.createEl('h3', { text: '불러오면서 생긴 문제' });
            const list = contentEl.createEl('ul');
            for (const warning of warnings) {
                list.createEl('li', { text: `${warning.message}: ${warning.examples.join(', ')}` });
            }
        }

        contentEl.createEl('h3', { text: `없어서 기본 모양으로 그리는 요소 (${fallbacks.length})` });
        const fallbackList = contentEl.createEl('ul');
        for (const item of fallbacks) {
            fallbackList.createEl('li', { text: `${item.marker}: ${item.behavior}` });
        }

        contentEl.createEl('h3', { text: `인식한 marker (${markers.length})` });
        const table = contentEl.createEl('table');
        const head = table.createEl('tr');
        for (const label of ['marker', '종류', '문단 모양', '글자 모양']) head.createEl('th', { text: label });
        for (const marker of markers) {
            const row = table.createEl('tr');
            row.createEl('td', { text: marker.marker });
            row.createEl('td', { text: marker.mode ? `${marker.kind} (${marker.mode})` : marker.kind });
            row.createEl('td', { text: marker.paraPrIDRef });
            row.createEl('td', { text: marker.charPrIDRef });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export default class HWPXExporterPlugin extends Plugin {
    settings: HWPXExporterSettings = { ...DEFAULT_SETTINGS };
    private agentProvider?: AgentCapabilityProvider;

    async onload(): Promise<void> {
        // No saved settings means a fresh install: put the templates and the guide in the vault
        // once, so the first export has something to choose from.
        const firstRun = (await this.loadData()) === null;
        await this.loadSettings();
        if (firstRun) this.app.workspace.onLayoutReady(() => void this.installBundledTemplates());
        this.exposeAgentProvider();

        this.addCommand({
            id: 'export-current-note-to-hwpx',
            name: 'Export current note to HWPX',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension.toLowerCase() !== 'md') {
                    return false;
                }
                if (!checking) {
                    void this.exportCurrentNote();
                }
                return true;
            },
        });

        this.addCommand({
            id: 'export-current-note-with-template',
            name: 'Export current note to HWPX (choose template)',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension.toLowerCase() !== 'md') {
                    return false;
                }
                if (!checking) {
                    void this.exportCurrentNoteWithTemplate();
                }
                return true;
            },
        });

        this.addCommand({
            id: 'inspect-hwpx-template',
            name: 'Inspect HWPX template',
            callback: () => {
                void this.inspectTemplateFromPrompt();
            },
        });

        this.addCommand({
            id: 'install-bundled-templates',
            name: 'Install bundled templates',
            callback: () => {
                void this.installBundledTemplates();
            },
        });

        this.addCommand({
            id: 'export-folder-to-hwpx',
            name: 'Export folder to HWPX',
            callback: () => {
                void this.exportFolderFromPrompt();
            },
        });

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
                    menu.addItem((item) => {
                        item.setTitle('Export to HWPX')
                            .setIcon('file-output')
                            .onClick(() => void this.exportFileAfterTemplatePrompt(file));
                    });
                }

                if (file instanceof TFolder) {
                    menu.addItem((item) => {
                        item.setTitle('Export folder to HWPX')
                            .setIcon('folder-output')
                            .onClick(() => void this.exportFolderAfterTemplatePrompt(file));
                    });
                }
            })
        );

        this.addSettingTab(new HWPXExporterSettingTab(this.app, this));
    }

    onunload(): void {
        this.agentProvider?.dispose();
        this.agentProvider = undefined;
        delete (this as unknown as Record<symbol, unknown>)[AGENT_CAPABILITY_PROVIDER];
        this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT);
    }

    /**
     * Self-exposed report tools (agentinterop v1). An agent host finds the provider under the
     * Symbol. Nothing here exports: the trial conversion writes only to the path it is given.
     */
    private exposeAgentProvider(): void {
        const noteFile = (notePath: string): TFile | null => {
            const file = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
            return file instanceof TFile && file.extension.toLowerCase() === 'md' ? file : null;
        };
        const requireNote = (notePath: string): TFile => {
            const file = noteFile(notePath);
            if (!file) throw new Error(`Note not found: ${notePath}`);
            return file;
        };
        this.agentProvider = createAgentProvider({
            id: this.manifest.id,
            name: this.manifest.name,
            version: this.manifest.version,
            options: () => ({
                templateFolderPath: this.settings.templateFolderPath,
                outputMode: this.settings.outputMode,
                fixedOutputFolder: this.settings.fixedOutputFolder,
                namingPattern: this.settings.namingPattern,
                appendSequenceOnConflict: this.settings.appendSequenceOnConflict,
                pageBreakBeforeH1: this.settings.pageBreakBeforeH1,
                captureRenderedBlocks: this.settings.captureRenderedBlocks,
                captureMermaid: this.settings.captureMermaid,
                captureSvgFiles: this.settings.captureSvgFiles,
                captureThirdPartyRenderers: this.settings.captureThirdPartyRenderers,
                thirdPartyLanguages: [...this.settings.thirdPartyLanguages],
            }),
            templates: () => this.getTemplateFilesInSelectedFolder().map((file) => file.path),
            resolveTemplateLink: (link, notePath) => this.app.metadataCache.getFirstLinkpathDest(link, notePath)?.path ?? null,
            assertTemplatePath: p => assertVaultRealPath(this.getFileSystemAdapter().getBasePath(), p),
            hasPathCollision: p => hasNormalizedDiskPath(this.getFileSystemAdapter().getBasePath(), p),
            staticChartAvailable: () => {
                const plugins = (this.app as unknown as { plugins?: { getPlugin?(id: string): unknown } }).plugins;
                const plugin = plugins?.getPlugin?.('chart-hands') as { [STATIC_CHART_API]?: { protocol?: string; version?: number; render?: unknown } } | null | undefined;
                const renderer = plugin?.[STATIC_CHART_API];
                return renderer?.protocol === 'chart-hands-static' && renderer.version === 1 && typeof renderer.render === 'function';
            },
            readNote: async (notePath) => {
                const file = noteFile(notePath);
                if (!file) return null;
                const absolute = path.join(this.getFileSystemAdapter().getBasePath(), file.path);
                const bytes = readBoundedPreflightInput(absolute, PREFLIGHT_MAX_FILE_BYTES);
                return { markdown: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
            },
            outputPath: (notePath) => this.buildOutputVaultPath(requireNote(notePath)),
            exists: (vaultPath) => fs.existsSync(path.join(this.getFileSystemAdapter().getBasePath(), normalizePath(vaultPath))),
            resolvesImage: (source, notePath) => {
                const file = noteFile(notePath);
                return file !== null && this.resolveVaultImageAbsolutePath(source, file) !== null;
            },
            convert: async (markdown, notePath, templatePath, outputAbsolutePath, signal, noteIdentity, captureBlockIndex) => {
                const file = requireNote(notePath);
                const templateAbsolutePath = this.resolveTemplateAbsolutePath(templatePath);
                if (!fs.existsSync(templateAbsolutePath)) {
                    throw new Error(`Template not found: ${templatePath}`);
                }
                const vaultRoot = this.getFileSystemAdapter().getBasePath();
                return frozenPreflight({ markdown, noteAbsolutePath: path.join(vaultRoot, file.path),
                    templateAbsolutePath, outputAbsolutePath, vaultRoot, config: this.buildConversionConfig(), signal, noteIdentity, captureBlockIndex,
                    resolveImage: (source) => this.resolveVaultImageAbsolutePath(source, file) });
            },
            inspectTemplate: (templatePath) => inspectTemplate(this.resolveTemplateAbsolutePath(templatePath)),
            // export_note (commit effect): template identity, in-memory render, and the Vault write.
            templateHash: async (templatePath) => {
                const absolute = this.resolveTemplateAbsolutePath(templatePath);
                if (!fs.existsSync(absolute)) throw new Error(`Template not found: ${templatePath}`);
                if (!this.isListedTemplatePath(templatePath)) assertVaultRealPath(this.getFileSystemAdapter().getBasePath(), templatePath);
                return createHash('sha256').update(readBoundedPreflightInput(absolute, TEMPLATE_MAX_BYTES)).digest('hex');
            },
            render: (notePath, templatePath, signal, captureOutputAnchors, captureBlockIndex) => this.renderNoteBytes(requireNote(notePath), templatePath, signal, captureOutputAnchors, undefined, captureBlockIndex),
            renderDerived: async (notePath, samplePath, templateBytes, signal, captureOutputAnchors) => {
                const result = await this.renderNoteBytes(requireNote(notePath), samplePath, signal, captureOutputAnchors, templateBytes, true, true);
                if (!result.blockIndex) throw new Error('Derived output observations unavailable.');
                return { ...result, blockIndex: result.blockIndex };
            },
            missingFolders: (vaultPath) => {
                const parts = normalizePath(vaultPath).split('/').slice(0, -1);
                return parts
                    .map((_part, index) => parts.slice(0, index + 1).join('/'))
                    .filter((folder) => !this.app.vault.getAbstractFileByPath(folder));
            },
            writeNew: async (vaultPath, bytes, folders) => {
                for (const folder of folders) {
                    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
                }
                // createBinary refuses an existing file, so a race cannot overwrite.
                await this.app.vault.createBinary(
                    normalizePath(vaultPath),
                    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
                );
            },
            readBytes: async (vaultPath) => {
                const target = normalizePath(vaultPath);
                if (!(await this.app.vault.adapter.exists(target))) return null;
                return new Uint8Array(await this.app.vault.adapter.readBinary(target));
            },
            readBytesBounded: async (vaultPath, maxBytes) => {
                const target = normalizePath(vaultPath);
                if (!(await this.app.vault.adapter.exists(target))) return null;
                return readBoundedPreflightInput(path.join(this.getFileSystemAdapter().getBasePath(), target), maxBytes);
            },
        });
        Object.defineProperty(this, AGENT_CAPABILITY_PROVIDER, {
            value: this.agentProvider,
            configurable: true,
            enumerable: false,
            writable: false,
        });
        this.app.workspace.onLayoutReady(() => this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT));
    }

    async loadSettings(): Promise<void> {
        const stored = (await this.loadData()) as Partial<HWPXExporterSettings> & {
            defaultTemplatePath?: string;
        } | null;
        const { defaultTemplatePath, ...currentSettings } = stored ?? {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, currentSettings);

        const configuredThirdPartyLanguages = Array.isArray(this.settings.thirdPartyLanguages)
            ? this.settings.thirdPartyLanguages
            : [];
        const normalizedThirdPartyLanguages = new Set(
            configuredThirdPartyLanguages
                .map((language) => language.trim().toLowerCase())
                .filter(Boolean)
        );
        let settingsChanged = false;
        for (const language of DEFAULT_SETTINGS.thirdPartyLanguages) {
            if (!normalizedThirdPartyLanguages.has(language)) {
                normalizedThirdPartyLanguages.add(language);
                settingsChanged = true;
            }
        }
        if (settingsChanged || configuredThirdPartyLanguages.length !== normalizedThirdPartyLanguages.size) {
            this.settings.thirdPartyLanguages = [...normalizedThirdPartyLanguages];
            await this.saveSettings();
        }

        if (stored?.templateFolderPath === undefined && defaultTemplatePath) {
            const legacyPath = normalizePath(defaultTemplatePath.trim().replace(/^[/\\]+/, ''));
            const lastSlash = legacyPath.lastIndexOf('/');
            this.settings.templateFolderPath = lastSlash >= 0 ? legacyPath.slice(0, lastSlash) : '';
            await this.saveSettings();
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    private getFileSystemAdapter(): FileSystemAdapter {
        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            throw new Error('HWPX Exporter currently supports desktop filesystem vaults only.');
        }
        return adapter;
    }

    private templateLoaderHost(): TemplateLoaderHost {
        const root = this.getFileSystemAdapter().getBasePath();
        return {
            templates: () => this.getTemplateFilesInSelectedFolder().map(f => f.path),
            readNote: async p => ({ markdown: new TextDecoder('utf-8', { fatal: true }).decode(readBoundedPreflightInput(path.join(root, p), TEMPLATE_MAX_BYTES)) }),
            readBytes: async p => new Uint8Array(await this.app.vault.adapter.readBinary(p)),
            readBytesBounded: async (p, max) => readBoundedPreflightInput(path.join(root, p), max),
            resolveTemplateLink: (link, note) => this.app.metadataCache.getFirstLinkpathDest(link, note)?.path ?? null,
            assertTemplatePath: p => assertVaultRealPath(root, p),
        };
    }

    private resolveTemplateAbsolutePath(templatePath: string): string {
        const adapter = this.getFileSystemAdapter();
        const vaultRelativePath = normalizePath(templatePath.trim().replace(/^[/\\]+/, ''));
        return path.join(adapter.getBasePath(), vaultRelativePath);
    }

    private isListedTemplatePath(templatePath: string): boolean {
        const file = this.app.vault.getAbstractFileByPath(templatePath);
        return file instanceof TFile && this.getTemplateFilesInSelectedFolder().some(candidate => candidate.path === templatePath);
    }

    private buildOutputFilename(baseName: string): string {
        const safeBaseName = sanitizeFilename(baseName);
        if (this.settings.namingPattern === '{basename}-{yyyyMMdd}.hwpx') {
            return `${safeBaseName}-${formatDateYYYYMMDD(new Date())}.hwpx`;
        }
        return `${safeBaseName}.hwpx`;
    }

    private getOutputFolderPath(file: TFile): string {
        if (this.settings.outputMode === 'fixed_folder') {
            return normalizePath(this.settings.fixedOutputFolder.trim().replace(/^[/\\]+/, ''));
        }
        return file.parent ? file.parent.path : '';
    }

    private buildOutputVaultPath(file: TFile): string {
        const outputFolder = this.getOutputFolderPath(file);
        const outputName = this.buildOutputFilename(file.basename);
        const outputVaultPath = normalizePath(
            outputFolder.length > 0 ? `${outputFolder}/${outputName}` : outputName
        );
        if (!this.settings.appendSequenceOnConflict) {
            return outputVaultPath;
        }

        const adapter = this.getFileSystemAdapter();
        return findAvailableOutputPath(
            outputVaultPath,
            (candidatePath) => fs.existsSync(path.join(adapter.getBasePath(), candidatePath))
        );
    }

    private buildConversionConfig(): ConversionConfig {
        const overrides: Record<string, number | boolean> = {
            PAGE_BREAK_BEFORE_H1: this.settings.pageBreakBeforeH1,
            MAX_INPUT_FILE_SIZE: Math.max(1, this.settings.maxInputFileSizeMb) * 1024 * 1024,
            MAX_TEMPLATE_FILE_SIZE: Math.max(1, this.settings.maxTemplateFileSizeMb) * 1024 * 1024,
            MAX_NESTING_DEPTH: Math.max(1, this.settings.maxNestingDepth),
            MAX_IMAGE_COUNT: Math.max(1, this.settings.maxImageCount),
            USE_NATIVE_IMAGE_SIZE: this.settings.useNativeImageSize,
        };
        return Object.assign(new ConversionConfig(), overrides);
    }

    private resolveVaultImageAbsolutePath(source: string, sourceFile: TFile): string | null {
        let linkPath = source.split(/[?#]/, 1)[0];
        try {
            linkPath = decodeURIComponent(linkPath);
        } catch {
            // Keep the original link when it contains a malformed escape sequence.
        }
        if (!isSupportedEmbeddedImagePath(linkPath)) {
            return null;
        }

        const imageFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
        if (!imageFile || !isSupportedEmbeddedImagePath(imageFile.path)) {
            return null;
        }

        const adapter = this.getFileSystemAdapter();
        return path.join(adapter.getBasePath(), imageFile.path);
    }

    private async resolveVaultBinaryAsset(
        source: string,
        basePath: string,
        fallbackFile: TFile
    ): Promise<{ vaultPath: string; bytes: ArrayBuffer } | null> {
        let linkPath = source.split(/[?#]/, 1)[0].trim();
        try {
            linkPath = decodeURIComponent(linkPath);
        } catch {
            return null;
        }
        if (!linkPath || path.isAbsolute(linkPath) || linkPath.split(/[\\/]/).includes('..')) {
            return null;
        }
        const origin = basePath || fallbackFile.path;
        const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, origin);
        if (!file) return null;
        const extension = file.extension.toLowerCase();
        if (!['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return null;
        return { vaultPath: file.path, bytes: await this.app.vault.readBinary(file) };
    }

    private async exportSingleFile(
        file: TFile,
        templatePath: string | undefined,
        customOutputPath?: string
    ): Promise<{ outputPath: string; report: ConversionReport }> {
        if (templatePath === undefined) templatePath = (await loadNoteTemplate(this.templateLoaderHost(), file.path)).path;
        const outputVaultPath = customOutputPath ? normalizePath(customOutputPath) : this.buildOutputVaultPath(file);
        const outputAbsolutePath = path.join(this.getFileSystemAdapter().getBasePath(), outputVaultPath);
        fs.mkdirSync(path.dirname(outputAbsolutePath), { recursive: true });
        const report = await this.convertNote(file, templatePath, outputAbsolutePath);
        return { outputPath: outputVaultPath, report };
    }

    /** Render capture + conversion of one note into an absolute output path. */
    private async convertNote(file: TFile, templatePath: string, outputAbsolutePath: string, frozen?: { signal?: AbortSignal; markdown: string; templateAbsolutePath: string; record(path: string, bytes: Uint8Array): void; selectionObserver?: ObservedBlockRecorder; splitRoleMarkerLines?: boolean }): Promise<ConversionReport> {
        const adapter = this.getFileSystemAdapter();
        const templateAbsolutePath = frozen?.templateAbsolutePath ?? this.resolveTemplateAbsolutePath(templatePath);
        if (!fs.existsSync(templateAbsolutePath)) {
            throw new Error(`Template not found: ${templateAbsolutePath}`);
        }

        frozen?.signal?.throwIfAborted();
        const sourceMarkdown = frozen?.markdown ?? await this.app.vault.cachedRead(file);
        if (frozen && hasUnboundThirdPartyCapture(sourceMarkdown, this.settings)) throw new Error('Third-party rendered-block inputs cannot yet be completely bound for agent export.');
        const plugins = (this.app as unknown as { plugins?: { getPlugin?(id: string): unknown } }).plugins;
        const chartHands = plugins?.getPlugin?.('chart-hands') as { [STATIC_CHART_API]?: Parameters<typeof captureStaticCharts>[1] } | null | undefined;
        const staticCharts = await captureStaticCharts(stripObsidianComments(sourceMarkdown), chartHands?.[STATIC_CHART_API], frozen?.signal);
        const captureWidthPx = this.settings.captureWidthPx > 0
            ? this.settings.captureWidthPx
            : Math.floor(new ConversionConfig().IMAGE_MAX_WIDTH_MM * 96 / 25.4);
        // Commented-out blocks are not rendered by Obsidian and would only spend the capture budget.
        const capture = await captureRenderableBlocks(staticCharts.markdown, {
            app: this.app,
            sourcePath: file.path,
            captureRenderedBlocks: this.settings.captureRenderedBlocks,
            captureSvgFiles: this.settings.captureSvgFiles,
            captureMermaid: this.settings.captureMermaid,
            captureThirdPartyRenderers: this.settings.captureThirdPartyRenderers,
            thirdPartyLanguages: this.settings.thirdPartyLanguages,
            rasterScale: this.settings.rasterScale,
            captureWidthPx,
            captureTimeoutMs: this.settings.captureTimeoutMs,
            captureTotalTimeoutMs: this.settings.captureTotalTimeoutMs,
            maxCaptureBlocks: this.settings.maxCaptureBlocks,
            forceLightThemeOnCapture: this.settings.forceLightThemeOnCapture,
            forceLightThemeAggressive: this.settings.forceLightThemeAggressive,
            allowForeignObject: this.settings.allowForeignObject,
            mermaidDisableHtmlLabels: this.settings.mermaidDisableHtmlLabels,
            resolveSvgAsset: async (linkPath, basePath) => {
                const asset = await this.resolveVaultBinaryAsset(linkPath, basePath ?? file.path, file);
                if (asset) frozen?.record(asset.vaultPath, new Uint8Array(asset.bytes));
                return asset;
            },
        });
        frozen?.signal?.throwIfAborted();
        if (capture.contractViolation) {
            new Notice('SVG 캡처 결과를 원문에 대응시키지 못해 원래 Markdown을 유지했습니다.', 8000);
        }
        if (capture.failures.length > 0) {
            const mermaidFailures = capture.failures.filter((failure) => failure.hint === 'mermaid').length;
            const label = mermaidFailures > 0 ? `Mermaid ${mermaidFailures}건` : `${capture.failures.length}건`;
            new Notice(`${label} 캡처 실패; 원문을 유지했습니다. 콘솔을 확인하세요.`, 8000);
        }
        const markdown = rewriteObsidianImageEmbeds(capture.markdown);
        const inputAbsolutePath = path.join(adapter.getBasePath(), file.path);
        const report = await convertString(markdown, outputAbsolutePath, {
            referenceDoc: templateAbsolutePath,
            config: this.buildConversionConfig(),
            inputPath: inputAbsolutePath,
            strictImageAssetResolver: !!frozen,
            signal: frozen?.signal,
            selectionObserver: frozen?.selectionObserver,
            splitRoleMarkerLines: frozen?.splitRoleMarkerLines ?? await templateDerivedMode(readBoundedPreflightInput(templateAbsolutePath, TEMPLATE_MAX_BYTES)),
            imagePathResolver: (source) => this.resolveVaultImageAbsolutePath(source, file),
            imageAssetResolver: (source) => {
                const asset = staticCharts.assets.get(source) ?? capture.assets.get(source);
                if (asset) return { bytes: asset.bytes, ext: asset.ext, displayWidthPx: asset.displayWidthPx, displayHeightPx: asset.displayHeightPx };
                if (!frozen) return null;
                const absolute = this.resolveVaultImageAbsolutePath(source, file);
                if (!absolute) return null;
                const bytes = fs.readFileSync(absolute);
                const vaultPath = normalizePath(path.relative(adapter.getBasePath(), absolute));
                frozen.record(vaultPath, bytes);
                const ext = path.extname(absolute).slice(1).toLowerCase();
                if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif') return { bytes, ext: ext === 'jpeg' ? 'jpg' : ext };
                throw new Error('Agent export currently requires PNG/JPEG/GIF or captured image bytes.');
            },
        });
        const combined = new ConversionReportCollector();
        combined.merge(captureReport(sourceMarkdown, this.settings, capture));
        combined.merge(report);
        const combinedReport = combined.toJSON();
        if (combinedReport.warnings.length > 0) {
            console.debug(`[HWPX Exporter] Conversion report for ${file.path}`, combinedReport);
        }
        return combinedReport;
    }

    /** Converts into memory (OS temp folder), for the agent commit: no Vault file is written. */
    private async renderNoteBytes(
        file: TFile,
        templatePath: string,
        signal?: AbortSignal,
        captureOutputAnchors = false,
        templateOverride?: Uint8Array,
        captureBlockIndex = false,
        splitRoleMarkerLines = false
    ): Promise<{ bytes: Uint8Array; report: ConversionReport; inputDependencies: InputDependency[]; providerInternalWrites: string[]; outputAnchors?: ReturnType<ObservedBlockRecorder['outputAnchors']>; blockIndex?: ReturnType<ObservedBlockRecorder['index']> }> {
        signal?.throwIfAborted();
        const dependencies = new Map<string, string>(); let total = 0;
        const record = (vaultPath: string, bytes: Uint8Array) => {
            if (vaultPath.split('/').some(part => !part || part.startsWith('.')) || bytes.length > 32 * 1024 * 1024 || (total += bytes.length) > 128 * 1024 * 1024) throw new Error('Export input path/byte budget exceeded.');
            const hash = createHash('sha256').update(bytes).digest('hex'), previous = dependencies.get(vaultPath);
            if (previous && previous !== hash) throw new Error('Export input changed while being read.');
            dependencies.set(vaultPath, hash); if (dependencies.size > 32) throw new Error('Export dependency count exceeded.');
        };
        const noteBytes = new Uint8Array(await this.app.vault.adapter.readBinary(file.path));
        if (!templateOverride && !this.isListedTemplatePath(templatePath)) assertVaultRealPath(this.getFileSystemAdapter().getBasePath(), templatePath);
        const templateBytes = templateOverride ? Uint8Array.from(templateOverride) : readBoundedPreflightInput(this.resolveTemplateAbsolutePath(templatePath), TEMPLATE_MAX_BYTES);
        const templateMode = await readTemplateMode(templateBytes, signal);
        splitRoleMarkerLines = splitRoleMarkerLines || templateMode.derived;
        record(file.path, noteBytes); if (!templateOverride) record(templatePath, templateBytes);
        signal?.throwIfAborted();
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-export-commit-'));
        try {
            const output = path.join(workDir, 'export.hwpx');
            const frozenTemplate = path.join(workDir, 'template.hwpx'); fs.writeFileSync(frozenTemplate, templateBytes);
            const selectionObserver = captureOutputAnchors || captureBlockIndex ? new ObservedBlockRecorder() : undefined;
            const report = await this.convertNote(file, templatePath, output, { signal, markdown: new TextDecoder('utf-8', { fatal: true }).decode(noteBytes), templateAbsolutePath: frozenTemplate, record, selectionObserver, splitRoleMarkerLines });
            signal?.throwIfAborted();
            const blockIndex = selectionObserver?.index();
            return { bytes: new Uint8Array(fs.readFileSync(output)), report, inputDependencies: [...dependencies].map(([path, sha256]) => ({ path, sha256 })), providerInternalWrites: [workDir, frozenTemplate, output],
                ...(selectionObserver && blockIndex && captureOutputAnchors ? { outputAnchors: selectionObserver.outputAnchors(blockIndex) } : {}),
                ...(blockIndex && captureBlockIndex ? { blockIndex } : {}) };
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    }

    /** Opens the export in HWP Hands when that plugin is enabled, otherwise in the OS default app. Returns where it opened. */
    private async openExportedFile(outputVaultPath: string): Promise<string> {
        if (await this.openInHwpHands(outputVaultPath)) return 'HWP Hands';
        await this.openWithDefaultApp(outputVaultPath);
        return 'the default app';
    }

    /** False means "fall back to the default app": HWP Hands is not enabled, the Vault never indexed the file, or opening failed. */
    private async openInHwpHands(outputVaultPath: string): Promise<boolean> {
        // HWP Hands' own API package finds the plugin the same way (app.plugins); its API v1 has no UI call, so this uses the file-menu action.
        const plugins = (this.app as unknown as { plugins?: { getPlugin?(id: string): unknown } }).plugins;
        const hwpHands = plugins?.getPlugin?.(HWP_HANDS_PLUGIN_ID) as { openInEditor?(file: TFile): Promise<void> } | null | undefined;
        if (typeof hwpHands?.openInEditor !== 'function') return false;

        const file = await this.waitForVaultFile(normalizePath(outputVaultPath));
        if (!file) return false;
        try {
            // Re-exporting the same note: show the tab that already has it; HWP Hands reloads it on the Vault modify event.
            const openLeaves: WorkspaceLeaf[] = [];
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view instanceof FileView && leaf.view.file?.path === file.path) openLeaves.push(leaf);
            });
            const openLeaf = openLeaves[0];
            if (openLeaf) {
                // revealLeaf() exists from Obsidian 1.7.2 (it also expands a collapsed sidebar);
                // older versions only activate the tab.
                const workspace = this.app.workspace as { revealLeaf?: (leaf: WorkspaceLeaf) => Promise<void> };
                if (typeof workspace.revealLeaf === 'function') await workspace.revealLeaf(openLeaf);
                else this.app.workspace.setActiveLeaf(openLeaf, { focus: true });
            } else {
                await hwpHands.openInEditor.call(hwpHands, file);
            }
            return true;
        } catch (error) {
            console.warn('[HWPX Exporter] Opening in HWP Hands failed; using the default app', error);
            return false;
        }
    }

    /** The converter writes with fs, so the Vault learns about a new file a moment later through its watcher. */
    private waitForVaultFile(vaultPath: string, timeoutMs = 3000): Promise<TFile | null> {
        const existing = this.app.vault.getAbstractFileByPath(vaultPath);
        if (existing instanceof TFile) return Promise.resolve(existing);
        return new Promise((resolve) => {
            const finish = (file: TFile | null) => {
                window.clearTimeout(timer);
                this.app.vault.offref(ref);
                resolve(file);
            };
            const ref = this.app.vault.on('create', (created) => {
                if (created instanceof TFile && created.path === vaultPath) finish(created);
            });
            const timer = window.setTimeout(() => finish(null), timeoutMs);
        });
    }

    private async openWithDefaultApp(outputVaultPath: string): Promise<void> {
        const adapter = this.getFileSystemAdapter();
        const outputAbsolutePath = path.join(adapter.getBasePath(), outputVaultPath);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Obsidian desktop provides electron at runtime; it has no import or type package here
        const electron = require('electron') as {
            shell?: { openPath(filePath: string): Promise<string> };
        };
        if (!electron.shell) {
            throw new Error('The desktop shell API is unavailable.');
        }

        const errorMessage = await electron.shell.openPath(outputAbsolutePath);
        if (errorMessage) {
            throw new Error(errorMessage);
        }
    }

    private async exportFileWithNotice(file: TFile, templatePath: string): Promise<void> {
        // duration=0 keeps the notice on screen until we hide() it ourselves,
        // right before the completion/failure notice replaces it.
        const startNotice = new Notice(`HWPX 내보내기 진행 중입니다: ${file.basename}`, 0);

        let outputPath: string;
        let report: ConversionReport;
        try {
            ({ outputPath, report } = await this.exportSingleFile(file, templatePath));
        } catch (error) {
            console.error('[HWPX Exporter] Export failed', error);
            startNotice.hide();
            new Notice(`HWPX 내보내기 실패: ${toErrorMessage(error)}`, 10000);
            return;
        }

        try {
            const openedWith = await this.openExportedFile(outputPath);
            startNotice.hide();
            new Notice(`HWPX로 내보내고 ${openedWith}에서 열었습니다: ${outputPath}`, 6000);
            this.showConversionWarnings(report);
        } catch (error) {
            console.error('[HWPX Exporter] Opening exported file failed', error);
            startNotice.hide();
            new Notice(
                `HWPX로 내보냈지만 파일을 열지 못했습니다: ${outputPath}. ${toErrorMessage(error)}`,
                10000
            );
        }
    }

    /** Tell the user what the converter could not express as written (details go to the console). */
    private showConversionWarnings(report: ConversionReport): void {
        if (report.warnings.length === 0) return;
        new Notice(`HWPX 변환 경고: ${summarizeReport(report)}. 자세한 내용은 개발자 콘솔을 보세요.`, 10000);
    }

    private async exportCurrentNote(): Promise<void> {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== 'md') {
            new Notice('내보낼 Markdown 노트를 먼저 여세요.');
            return;
        }
        try { await this.exportFileWithNotice(file, (await loadNoteTemplate(this.templateLoaderHost(), file.path)).path); }
        catch (error) { new Notice(`템플릿 선택 실패: ${toErrorMessage(error)}`, 10000); }
    }

    private async exportCurrentNoteWithTemplate(): Promise<void> {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== 'md') {
            new Notice('내보낼 Markdown 노트를 먼저 여세요.');
            return;
        }

        await this.exportFileAfterTemplatePrompt(file);
    }

    private async exportFileAfterTemplatePrompt(file: TFile): Promise<void> {
        try {
            const preferred = await loadNoteTemplate(this.templateLoaderHost(), file.path);
            const templatePath = await this.promptTemplatePath(preferred);
            if (templatePath) await this.exportFileWithNotice(file, templatePath);
        } catch (error) { new Notice(`템플릿 선택 실패: ${toErrorMessage(error)}`, 10000); }
    }

    private getMarkdownFilesInFolder(folder: TFolder): TFile[] {
        const folderPath = folder.path;
        const prefix = folderPath.length > 0 ? `${folderPath}/` : '';

        return this.app.vault.getMarkdownFiles()
            .filter((file) => prefix.length === 0 || file.path.startsWith(prefix))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    private async exportFolderWithNotice(folder: TFolder, templatePath?: string): Promise<void> {
        const files = this.getMarkdownFilesInFolder(folder);
        if (files.length === 0) {
            new Notice('선택한 폴더에 Markdown 파일이 없습니다.');
            return;
        }

        // duration=0 keeps the notice on screen until we hide() it ourselves,
        // right before the completion/failure notice replaces it. Progress
        // updates this one notice instead of stacking a new one per step.
        const startNotice = new Notice(`HWPX 내보내기 진행 중입니다: ${files.length}개 파일`, 0);

        let successCount = 0;
        const failures: string[] = [];
        let filesWithWarnings = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            startNotice.setMessage(`HWPX 내보내기 진행 중입니다: ${i + 1}/${files.length} · ${file.basename}`);
            try {
                const { report } = await this.exportSingleFile(file, templatePath);
                successCount += 1;
                if (report.warnings.length > 0) filesWithWarnings += 1;
            } catch (error) {
                const message = `${file.path}: ${toErrorMessage(error)}`;
                failures.push(message);
                console.error('[HWPX Exporter] Batch export item failed', message);
            }
        }

        startNotice.hide();

        const warningNote = filesWithWarnings > 0
            ? ` 변환 경고가 있는 파일 ${filesWithWarnings}개(개발자 콘솔 참고).`
            : '';
        if (failures.length === 0) {
            new Notice(`HWPX 내보내기 완료: ${files.length}개 중 ${successCount}개 성공.${warningNote}`, warningNote ? 8000 : 5000);
            return;
        }

        const preview = failures.slice(0, 3).join(' | ');
        new Notice(
            `HWPX 내보내기 완료: ${files.length}개 중 ${successCount}개 성공, ${failures.length}개 실패. ${preview}${warningNote}`,
            15000
        );
    }

    private async exportFolderFromPrompt(): Promise<void> {
        const folder = await this.promptFolder();
        if (!folder) {
            return;
        }
        await this.exportFolderAfterTemplatePrompt(folder);
    }

    private async exportFolderAfterTemplatePrompt(folder: TFolder): Promise<void> {
        await this.exportFolderWithNotice(folder);
    }

    private async promptFolder(): Promise<TFolder | null> {
        const folders = this.app.vault.getAllLoadedFiles()
            .filter((file): file is TFolder => file instanceof TFolder)
            .sort((a, b) => a.path.localeCompare(b.path));

        if (folders.length === 0) {
            new Notice('이 Vault에 선택할 수 있는 폴더가 없습니다.');
            return null;
        }

        const modal = new FolderSuggestModal(this.app, folders);
        return await modal.openAndGetValue();
    }

    getVaultFolders(): TFolder[] {
        const root = this.app.vault.getRoot();
        const folders = this.app.vault.getAllLoadedFiles()
            .filter((file): file is TFolder => file instanceof TFolder)
            .filter((folder) => folder.path !== root.path);
        return [root, ...folders].sort((a, b) => a.path.localeCompare(b.path));
    }

    getTemplateFilesInSelectedFolder(): TFile[] {
        const folderPath = normalizePath(this.settings.templateFolderPath.trim().replace(/^[/\\]+/, ''));
        return this.app.vault.getFiles()
            .filter((file) =>
                file.extension.toLowerCase() === 'hwpx'
                && (file.parent?.path ?? '') === folderPath
            )
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    /**
     * Writes the templates and the template-writing guide embedded in main.js into the template
     * folder. Existing files are kept, so templates the user edited in Hangul are never replaced.
     */
    async installBundledTemplates(): Promise<void> {
        try {
            const configured = normalizePath(this.settings.templateFolderPath.trim().replace(/^[/\\]+/, ''));
            const folder = configured && configured !== '/' ? configured : DEFAULT_TEMPLATE_FOLDER;
            const adapter = this.app.vault.adapter;
            if (!(await adapter.exists(folder))) await this.app.vault.createFolder(folder);
            let installed = 0;
            for (const template of bundledTemplates) {
                const target = normalizePath(`${folder}/${template.name}`);
                if (await adapter.exists(target)) continue;
                const bytes = Uint8Array.from(atob(template.base64), (char) => char.charCodeAt(0));
                await this.app.vault.createBinary(target, bytes.buffer);
                installed += 1;
            }
            const guidePath = normalizePath(`${folder}/${guide.name}`);
            const guideInstalled = !(await adapter.exists(guidePath));
            if (guideInstalled) await this.app.vault.create(guidePath, guide.text);
            if (this.settings.templateFolderPath !== folder) {
                this.settings.templateFolderPath = folder;
                await this.saveSettings();
            }
            const kept = bundledTemplates.length - installed + (guideInstalled ? 0 : 1);
            new Notice(`${folder}에 템플릿 ${installed}개${guideInstalled ? '와 작성 가이드' : ''}를 넣었습니다.${kept > 0 ? ` 이미 있던 파일 ${kept}개는 그대로 두었습니다.` : ''}`, 6000);
        } catch (error) {
            console.error('[HWPX Exporter] Template installation failed', error);
            new Notice(`템플릿 설치 실패: ${toErrorMessage(error)}`, 10000);
        }
    }

    async inspectTemplateFromPrompt(): Promise<void> {
        const templatePath = await this.promptTemplatePath();
        if (!templatePath) return;
        try {
            const inspection = await inspectTemplate(this.resolveTemplateAbsolutePath(templatePath));
            new TemplateInspectionModal(this.app, templatePath, inspection).open();
        } catch (error) {
            console.error('[HWPX Exporter] Template inspection failed', error);
            new Notice(`템플릿 검사 실패: ${toErrorMessage(error)}`, 8000);
        }
    }

    async promptTemplatePath(preferred?: Awaited<ReturnType<typeof loadNoteTemplate>>): Promise<string | null> {
        const templateFiles = preferredTemplatePaths(this.getTemplateFilesInSelectedFolder().map(f => f.path), preferred)
            .map(p => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile);

        if (templateFiles.length === 0) {
            const folderLabel = this.settings.templateFolderPath || '/ (Vault root)';
            new Notice(`템플릿 폴더(${folderLabel}) 바로 아래에 .hwpx 템플릿이 없습니다. 명령 팔레트의 "Install bundled templates"로 동봉 템플릿을 넣으세요.`, 10000);
            return null;
        }

        const modal = new TemplateSuggestModal(this.app, templateFiles);
        const selected = await modal.openAndGetValue();
        return selected ? selected.path : null;
    }
}

/** One settings row: rendered by Obsidian 1.13+ from getSettingDefinitions(), by display() before. */
interface SettingRow {
    name: string;
    desc?: string;
    visible?: () => boolean;
    render: (setting: Setting) => void;
}

interface SettingSection {
    heading?: string;
    rows: SettingRow[];
}

/** One settings row: rendered by Obsidian 1.13+ from getSettingDefinitions(), by display() before. */
interface SettingRow {
    name: string;
    desc?: string;
    visible?: () => boolean;
    render: (setting: Setting) => void;
}

interface SettingSection {
    heading?: string;
    rows: SettingRow[];
}

class HWPXExporterSettingTab extends PluginSettingTab {
    constructor(app: App, private readonly plugin: HWPXExporterPlugin) {
        super(app, plugin);
    }

    /** Obsidian 1.13+: rendered declaratively and indexed for settings search. */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return this.sections().map((section) => ({
            type: 'group' as const,
            heading: section.heading,
            items: section.rows.map((row) => ({ name: row.name, desc: row.desc, visible: row.visible, render: row.render })),
        }));
    }

    /** Obsidian before 1.13 (minAppVersion is lower), which never calls getSettingDefinitions(). */
    display(): void {
        this.renderRows();
    }

    private renderRows(): void {
        const { containerEl } = this;
        containerEl.empty();
        for (const section of this.sections()) {
            if (section.heading) new Setting(containerEl).setName(section.heading).setHeading();
            for (const row of section.rows) {
                if (row.visible && !row.visible()) continue;
                const setting = new Setting(containerEl).setName(row.name);
                if (row.desc) setting.setDesc(row.desc);
                row.render(setting);
            }
        }
    }

    /** Re-renders after a change that alters other rows (descriptions, visibility). */
    private refresh(): void {
        // update() exists from Obsidian 1.13 (it re-reads the definitions and re-renders);
        // older versions render the rows directly.
        const tab = this as { update?: () => void };
        if (typeof tab.update === 'function') tab.update();
        else this.renderRows();
    }

    private sections(): SettingSection[] {
        const settings = this.plugin.settings;
        const save = (): Promise<void> => this.plugin.saveSettings();
        const toggle = (name: string, desc: string, key: BooleanSettingKey, after?: (value: boolean) => void): SettingRow => ({
            name,
            desc,
            render: (setting) => { setting.addToggle((component) => component.setValue(settings[key]).onChange(async (value) => {
                settings[key] = value;
                await save();
                after?.(value);
            })); },
        });
        const positiveInt = (name: string, key: PositiveIntSettingKey): SettingRow => ({
            name,
            render: (setting) => { setting.addText((text) => text.setValue(String(settings[key])).onChange(async (value) => {
                settings[key] = parsePositiveInt(value, DEFAULT_SETTINGS[key]);
                await save();
            })); },
        });

        return [
            {
                rows: [
                    {
                        name: 'Template folder',
                        desc: `Choose the vault folder containing the HWPX templates offered during export. ${this.plugin.getTemplateFilesInSelectedFolder().length} HWPX template(s) available in this folder.`,
                        render: (setting) => { setting.addDropdown((dropdown) => {
                            for (const folder of this.plugin.getVaultFolders()) {
                                dropdown.addOption(folder.path, folder.path || '/ (Vault root)');
                            }
                            dropdown.setValue(settings.templateFolderPath);
                            dropdown.onChange(async (value) => {
                                settings.templateFolderPath = value;
                                await save();
                                this.refresh();
                            });
                        }); },
                    },
                    {
                        name: 'Bundled templates',
                        desc: `Copy the ${bundledTemplates.length} bundled templates and the template guide (${guide.name}) into the template folder (${DEFAULT_TEMPLATE_FOLDER} when the vault root is selected). Existing files are kept.`,
                        render: (setting) => { setting.addButton((button) => button
                            .setButtonText('Install')
                            .onClick(async () => {
                                await this.plugin.installBundledTemplates();
                                this.refresh();
                            })); },
                    },
                    {
                        name: '템플릿 검사',
                        desc: '템플릿이 정의한 marker, 오타로 보이는 marker, marker가 없어 기본 모양으로 그릴 요소를 보여 준다.',
                        render: (setting) => { setting.addButton((button) => button
                            .setButtonText('검사')
                            .onClick(() => {
                                void this.plugin.inspectTemplateFromPrompt();
                            })); },
                    },
                    {
                        name: 'Output mode',
                        desc: 'Choose where exported .hwpx files will be written.',
                        render: (setting) => { setting.addDropdown((dropdown) => {
                            dropdown.addOption('same_as_source', 'Same folder as source note');
                            dropdown.addOption('fixed_folder', 'Fixed output folder');
                            dropdown.setValue(settings.outputMode);
                            dropdown.onChange(async (value) => {
                                settings.outputMode = value as OutputMode;
                                await save();
                                this.refresh();
                            });
                        }); },
                    },
                    {
                        name: 'Fixed output folder',
                        desc: 'Vault-relative folder path for generated .hwpx files.',
                        visible: () => settings.outputMode === 'fixed_folder',
                        render: (setting) => { setting.addText((text) => {
                            text.setPlaceholder('exports/hwpx')
                                .setValue(settings.fixedOutputFolder)
                                .onChange(async (value) => {
                                    settings.fixedOutputFolder = normalizePath(value.trim().replace(/^[/\\]+/, ''));
                                    await save();
                                });
                        }); },
                    },
                    {
                        name: 'Naming pattern',
                        desc: 'Output filename pattern.',
                        render: (setting) => { setting.addDropdown((dropdown) => {
                            dropdown.addOption('{basename}.hwpx', '{basename}.hwpx');
                            dropdown.addOption('{basename}-{yyyyMMdd}.hwpx', '{basename}-{yyyyMMdd}.hwpx');
                            dropdown.setValue(settings.namingPattern);
                            dropdown.onChange(async (value) => {
                                settings.namingPattern = value as NamingPattern;
                                await save();
                            });
                        }); },
                    },
                    toggle('Append sequence on filename conflict',
                        'If the output file exists, append -1, -2, ... instead of overwriting it.',
                        'appendSequenceOnConflict'),
                ],
            },
            {
                heading: 'Conversion',
                rows: [
                    toggle('Page break before H1', 'Insert page break before H1 when H1 is not the first block.', 'pageBreakBeforeH1'),
                ],
            },
            {
                heading: 'Rendered block capture',
                rows: [
                    toggle('Capture rendered blocks', 'Master switch. Turning this off never calls MarkdownRenderer.', 'captureRenderedBlocks'),
                    toggle('Capture Mermaid', 'Capture Mermaid code blocks as PNG.', 'captureMermaid'),
                    toggle('Capture static SVG files', 'Read SVG bytes directly from the vault and rasterize them.', 'captureSvgFiles'),
                    toggle('Capture third-party renderers',
                        'Runs registered code-block processors, including Plotly. Enable only for trusted notes.',
                        'captureThirdPartyRenderers',
                        (value) => {
                            if (value) new Notice('외부 렌더러는 내보내는 동안 노트 속 코드를 실행합니다. 믿을 수 있는 노트에만 쓰세요.', 10000);
                        }),
                    toggle('Force light theme', 'Apply a light theme class to the offscreen container.', 'forceLightThemeOnCapture'),
                    toggle('Aggressive light theme fallback',
                        'Temporarily toggles body classes during capture and may visibly flash the workspace.',
                        'forceLightThemeAggressive'),
                    toggle('Disable Mermaid HTML labels', 'Avoid foreignObject output where Mermaid supports this setting.', 'mermaidDisableHtmlLabels'),
                    toggle('Use native image size', 'Use captured/intrinsic image dimensions before clamping.', 'useNativeImageSize'),
                    {
                        name: 'Raster scale',
                        desc: 'Requested raster scale from 1 to 4; pixel budgets may reduce it.',
                        render: (setting) => { setting.addText((text) => text.setValue(String(settings.rasterScale)).onChange(async (value) => {
                            settings.rasterScale = Math.min(4, Math.max(1, Number.parseFloat(value) || DEFAULT_SETTINGS.rasterScale));
                            await save();
                        })); },
                    },
                    {
                        name: 'Capture width (CSS px)',
                        desc: 'Use 0 for the 150 mm output-width estimate.',
                        render: (setting) => { setting.addText((text) => text.setValue(String(settings.captureWidthPx)).onChange(async (value) => {
                            settings.captureWidthPx = Math.max(0, Number.parseInt(value, 10) || 0);
                            await save();
                        })); },
                    },
                ],
            },
            {
                heading: 'Security limits',
                rows: [
                    positiveInt('Max input file size (MB)', 'maxInputFileSizeMb'),
                    positiveInt('Max template file size (MB)', 'maxTemplateFileSizeMb'),
                    positiveInt('Max nesting depth', 'maxNestingDepth'),
                    positiveInt('Max image count', 'maxImageCount'),
                ],
            },
        ];
    }
}

type BooleanSettingKey = {
    [K in keyof HWPXExporterSettings]: HWPXExporterSettings[K] extends boolean ? K : never
}[keyof HWPXExporterSettings];
type PositiveIntSettingKey = 'maxInputFileSizeMb' | 'maxTemplateFileSizeMb' | 'maxNestingDepth' | 'maxImageCount';

function parsePositiveInt(value: string, fallback: number): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function sanitizeFilename(name: string): string {
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
    const sanitized = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
    return sanitized.length > 0 ? sanitized : 'untitled';
}

function formatDateYYYYMMDD(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
