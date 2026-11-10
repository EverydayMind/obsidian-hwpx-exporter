import { readTemplateMode, validateTemplateDialect } from './template-derive/templateMetadata';
/**
 * High-level convenience API for the shared HWPX converter.
 */

import * as path from 'path';
import * as fs from 'fs';
import { MarkoToPandocAdapter } from './markoAdapter';
import { parseMarkdownStringWithFrontmatter, convertMetadataToPandocMeta } from './frontmatterParser';
import { MarkdownToHwpx } from './markdownToHwpx';
import { ConversionConfig, DEFAULT_CONFIG } from './config';
import { rewriteLatexSymbols } from './latexSymbols';
import { stripObsidianComments } from './obsidianComments';
import type { ImageAssetResolver, ImagePathResolver } from './types';
import { SecurityError } from './exceptions';
import { ConversionReportCollector, type ConversionReport } from './conversionReport';
import { mapOutsideCode } from './markdownCode';
import type { SelectionObserver } from './selectionObservation';

export interface ConvertOptions {
    referenceDoc?: string;
    config?: ConversionConfig;
    inputPath?: string | null;
    imagePathResolver?: ImagePathResolver;
    imageAssetResolver?: ImageAssetResolver;
    /** Require supplied bytes; do not fall back to unrecorded filesystem reads. */
    strictImageAssetResolver?: boolean;
    signal?: AbortSignal;
    /** Trusted in-process observation hook; target identities must not be serialized. */
    selectionObserver?: SelectionObserver;
    /** Internal derived-render opt-in: split role lines, then classify META paragraphs. */
    splitRoleMarkerLines?: boolean;
}

/**
 * Replace literal `{{title}}` placeholders in the note body with the
 * source file's basename (extension stripped), mirroring Obsidian's
 * Templates plugin convention. No-op when the input path is unknown.
 */
function applyTitlePlaceholder(mdContent: string, inputPath: string | null | undefined): string {
    if (!inputPath || !mdContent.includes('{{title}}')) {
        return mdContent;
    }
    const title = path.basename(inputPath).replace(/\.[^./\\]+$/, '');
    // Code keeps a literal {{title}} (e.g. a template snippet in a code block).
    return mapOutsideCode(mdContent, (text) => text.split('{{title}}').join(title));
}

/** Obsidian syntax the converter does not render yet, reported because it stays as literal text. */
function findLiteralSyntax(markdown: string, report: ConversionReportCollector): void {
    const message = '지원하지 않는 Obsidian 문법이 글자 그대로 남음';
    mapOutsideCode(maskHtmlCommentsForLiteralSyntax(markdown), (text) => {
        // Wikilinks have no target in an exported document (embeds ![[…]] are images).
        for (const match of text.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]/g)) report.add('literal_syntax', message, match[0].slice(0, 80));
        return text;
    });
}

/** Linear diagnostic scan; fences/spans stay opaque, without reparsing Markdown prefixes. */
function maskHtmlCommentsForLiteralSyntax(markdown: string): string {
    // Find each backtick run's next equal-length run on its line once. Failed
    // inline-code searches must not repeatedly scan the rest of a long line.
    const inlineCodeEnds = new Map<number, number>();
    let lineOffset = 0;
    for (const line of markdown.split('\n')) {
        const next = new Map<number, number>();
        const runs = [...line.matchAll(/`+/g)];
        for (let index = runs.length - 1; index >= 0; index--) {
            const run = runs[index], start = lineOffset + run.index;
            const end = next.get(run[0].length);
            if (end !== undefined) inlineCodeEnds.set(start, end);
            next.set(run[0].length, start + run[0].length);
        }
        lineOffset += line.length + 1;
    }
    const parts: string[] = [];
    const lastClose = markdown.lastIndexOf('-->');
    let offset = 0, copyStart = 0, blockPrefix = true;
    let fence: { marker: string; length: number } | null = null;
    while (offset < markdown.length) {
        if (offset === 0 || markdown[offset - 1] === '\n') {
            const end = markdown.indexOf('\n', offset);
            const lineEnd = end < 0 ? markdown.length : end + 1;
            const line = markdown.slice(offset, lineEnd);
            const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
            if (fence || match) {
                if (match) {
                    if (!fence) fence = { marker: match[1][0], length: match[1].length };
                    else if (fence.marker === match[1][0] && match[1].length >= fence.length) fence = null;
                }
                offset = lineEnd;
                blockPrefix = true;
                continue;
            }
        }
        const codeEnd = inlineCodeEnds.get(offset);
        if (codeEnd !== undefined) {
            offset = codeEnd;
            blockPrefix = false;
            continue;
        }
        if (markdown.startsWith('<!--', offset)) {
            let escapeStart = offset;
            while (escapeStart > 0 && markdown[escapeStart - 1] === '\\') escapeStart--;
            if ((offset - escapeStart) % 2 === 1) {
                blockPrefix = false;
                offset++;
                continue;
            }
            // A failed search past the final closer is constant-time, even for
            // thousands of unfinished inline openers on the same line.
            const close = offset + 4 > lastClose ? -1 : markdown.indexOf('-->', offset + 4);
            if (close >= 0 || blockPrefix) {
                const end = close < 0 ? markdown.length : close + 3;
                parts.push(markdown.slice(copyStart, offset), markdown.slice(offset, end).replace(/[^\r\n]/g, ' '));
                offset = end;
                copyStart = end;
                continue;
            }
        }
        if (blockPrefix && /[-+*0-9]/.test(markdown[offset])) {
            const list = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(markdown.slice(offset));
            if (list) { offset += list[0].length; continue; }
        }
        const char = markdown[offset++];
        if (char === '\n') blockPrefix = true;
        else if (!/[ \t\r>]/.test(char)) blockPrefix = false;
    }
    parts.push(markdown.slice(copyStart));
    return parts.join('');
}

/**
 * Return path to the bundled blank.hwpx template.
 */
export function getDefaultReferenceDoc(): string {
    const projectRootDefault = path.join(__dirname, '..', '적용템플릿.hwpx');
    if (fs.existsSync(projectRootDefault)) {
        return projectRootDefault;
    }

    const assetDefault = path.join(__dirname, '..', 'obsidian', 'assets', 'templates', '한글 템플릿.hwpx');
    if (fs.existsSync(assetDefault)) {
        return assetDefault;
    }

    return path.join(__dirname, '..', 'obsidian', 'assets', 'templates', 'blank.hwpx');
}

/**
 * Convert a Markdown string to an HWPX file.
 *
 * @param markdownString - Markdown text (may include YAML frontmatter)
 * @param outputPath - Output .hwpx file path
 * @param referenceDoc - Path to reference HWPX template (optional)
 * @param config - Conversion configuration (optional)
 * @param inputPath - Source note path, used for resolving relative images (optional)
 * @param imagePathResolver - Trusted integration callback for resolving image links (optional)
 * @returns What the conversion could not express as written (see conversionReport.ts).
 */
export function convertString(
    markdownString: string,
    outputPath: string,
    options?: ConvertOptions
): Promise<ConversionReport>;

/** @deprecated Positional overload retained for existing integrations. */
export function convertString(
    markdownString: string,
    outputPath: string,
    referenceDoc?: string,
    config?: ConversionConfig,
    inputPath?: string | null,
    imagePathResolver?: ImagePathResolver
): Promise<ConversionReport>;

export async function convertString(
    markdownString: string,
    outputPath: string,
    referenceDocOrOptions?: string | ConvertOptions,
    config?: ConversionConfig,
    inputPath?: string | null,
    imagePathResolver?: ImagePathResolver
): Promise<ConversionReport> {
    const options: ConvertOptions = typeof referenceDocOrOptions === 'object'
        ? referenceDocOrOptions
        : {
            referenceDoc: referenceDocOrOptions,
            config,
            inputPath,
            imagePathResolver,
        };
    const refDoc = options.referenceDoc ?? getDefaultReferenceDoc();
    const cfg = options.config ?? DEFAULT_CONFIG;
    options.signal?.throwIfAborted();

    // The note path only names the note; the size limit applies to the text itself.
    const inputBytes = Buffer.byteLength(markdownString, 'utf8');
    if (inputBytes > cfg.MAX_INPUT_FILE_SIZE) {
        throw new SecurityError(`Input markdown too large: ${inputBytes} bytes`);
    }

    const { metadata, content: rawContent } = parseMarkdownStringWithFrontmatter(markdownString);
    validateTemplateDialect(null, metadata['hwpx-dialect']);
    // Inspect the selected template, regardless of the caller's mode options.
    if (fs.statSync(refDoc).size > 32 * 1024 * 1024) throw new SecurityError('Template exceeds 32 MiB.');
    const templateMode = await readTemplateMode(fs.readFileSync(refDoc), options.signal);
    // Parse frontmatter and markdown content
    validateTemplateDialect(templateMode.dialect, metadata['hwpx-dialect']);
    const mdContent = rewriteLatexSymbols(applyTitlePlaceholder(stripObsidianComments(rawContent), options.inputPath), { preserveMath: true });
    const report = new ConversionReportCollector();
    findLiteralSyntax(mdContent, report);

    // Convert to Pandoc-like AST
    const adapter = new MarkoToPandocAdapter();
    const ast = adapter.parse(mdContent);
    ast.meta = convertMetadataToPandocMeta(metadata);
    report.merge(adapter.report.toJSON());
    options.signal?.throwIfAborted();

    // Convert AST to HWPX file
    const converterReport = await MarkdownToHwpx.convertToHwpx(
        options.inputPath ?? null,
        outputPath,
        refDoc,
        ast,
        cfg,
        options.imagePathResolver,
        options.imageAssetResolver,
        options.strictImageAssetResolver,
        true,
        options.signal,
        options.selectionObserver,
        templateMode.derived || (options.splitRoleMarkerLines ?? false)
    );
    report.merge(converterReport);
    return report.toJSON();
}

/**
 * Convert a Markdown file to an HWPX file. A thin wrapper over convertString:
 * the file path becomes `inputPath` (for `{{title}}` and relative images).
 *
 * @param inputPath - Input .md file path
 * @param outputPath - Output .hwpx file path
 * @param options - Template, config and image resolvers (optional)
 */
export function convertFile(
    inputPath: string,
    outputPath: string,
    options?: Omit<ConvertOptions, 'inputPath'>
): Promise<ConversionReport>;

/** @deprecated Positional overload retained for existing integrations. */
export function convertFile(
    inputPath: string,
    outputPath: string,
    referenceDoc?: string,
    config?: ConversionConfig
): Promise<ConversionReport>;

export async function convertFile(
    inputPath: string,
    outputPath: string,
    referenceDocOrOptions?: string | Omit<ConvertOptions, 'inputPath'>,
    config?: ConversionConfig
): Promise<ConversionReport> {
    const options: Omit<ConvertOptions, 'inputPath'> = typeof referenceDocOrOptions === 'object'
        ? referenceDocOrOptions
        : { referenceDoc: referenceDocOrOptions, config };
    const cfg = options.config ?? DEFAULT_CONFIG;
    const inputSize = fs.statSync(inputPath).size;
    if (inputSize > cfg.MAX_INPUT_FILE_SIZE) {
        throw new SecurityError(`Input file too large: ${inputSize} bytes`);
    }
    return convertString(fs.readFileSync(inputPath, 'utf-8'), outputPath, { ...options, inputPath });
}
