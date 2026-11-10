/**
 * HWPX package: reading the template, building section0.xml around the rendered body, manifest, preview and the ZIP itself.
 * Split out of markdownToHwpx.ts (plan 2.1).
 */

import JSZip from 'jszip';
import * as fs from 'fs';
import * as path from 'path';
import { TemplateError } from '../exceptions';
import type { ImageMeta } from '../types';
import { NS, TEMPLATE_WRAPPER_END, TEMPLATE_WRAPPER_START, escapeRegex, escapeXml, findMaxAttrValue, removeOutermostElements, templateTextContent } from './xmlText';
import { checkZipDirectoryIdentity } from './zipConsistency';
import { verifyEmptyDirectory, verifyInflatedBudget, ZipBudgetError } from './zipBudget';

export const PREVIEW_TEXT_MAX_CHARS = 1024;

async function loadTemplateZip(input: Buffer, signal?: AbortSignal): Promise<JSZip> {
    // JSZip retains the input bytes while asynchronous work runs.
    const bytes = Buffer.from(input);
    try {
        const compressedDirectories = checkZipDirectoryIdentity(bytes);
        for (const compressed of compressedDirectories) {
            signal?.throwIfAborted();
            await verifyEmptyDirectory(compressed, signal);
        }
        signal?.throwIfAborted();
        const zip = await JSZip.loadAsync(bytes);
        await verifyInflatedBudget(zip, undefined, signal);
        return zip;
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ZipBudgetError) throw new TemplateError('HWPX template exceeds the inflated size limit.');
        throw new TemplateError('Corrupted or unsupported HWPX template ZIP.');
    }
}


/**
 * Preview/PrvText.txt in the format Hangul writes: one line (CRLF) per
 * top-level paragraph, table cells wrapped in `<…>` with one line per row.
 */
export function buildPreviewText(sectionXml: string): string {
    const token = /<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<hp:tab\b[^>]*\/>|<hp:tc\b[^>]*>|<\/hp:tc>|<\/hp:tr>|<\/hp:p>/g;
    let out = '';
    let cellDepth = 0;
    for (const match of sectionXml.matchAll(token)) {
        const tag = match[0];
        if (match[1] !== undefined) {
            out += templateTextContent(match[1]).replace(/\n/g, '\r\n');
        } else if (tag.startsWith('<hp:tab')) {
            out += '\t';
        } else if (tag.startsWith('<hp:tc')) {
            cellDepth++;
            out += '<';
        } else if (tag === '</hp:tc>') {
            cellDepth = Math.max(0, cellDepth - 1);
            out += '>';
        } else if (tag === '</hp:tr>') {
            out += '\r\n';
        } else if (cellDepth === 0) {
            out += '\r\n';
        }
        if (out.length > PREVIEW_TEXT_MAX_CHARS * 2) break;
    }
    return [...out.replace(/(\r\n){3,}/g, '\r\n\r\n').replace(/^(\r\n)+/, '')]
        .slice(0, PREVIEW_TEXT_MAX_CHARS)
        .join('');
}


// ============================================================
// Template reading
// ============================================================

export async function readTemplate(referencePath: string): Promise<{
    headerXml: string;
    sectionXml: string;
    refDocBytes: Buffer;
}> {
    const refDocBytes = fs.readFileSync(referencePath);
    const zip = await loadTemplateZip(refDocBytes);

    const headerFile = zip.file('Contents/header.xml');
    const sectionFile = zip.file('Contents/section0.xml');

    if (!headerFile) throw new TemplateError(`Missing Contents/header.xml in ${referencePath}`);
    if (!sectionFile) throw new TemplateError(`Missing Contents/section0.xml in ${referencePath}`);

    const headerXml = await headerFile.async('string');
    const sectionXml = await sectionFile.async('string');


    return { headerXml, sectionXml, refDocBytes };
}


// ============================================================
// Output writing
// ============================================================

export async function writeHwpxOutput(
    outputPath: string,
    refDocBytes: Buffer,
    xmlBody: string,
    newHeaderXml: string | null,
    images: ImageMeta[],
    title: string | null,
    inputPath: string | null,
    templateSectionXml: string | null = null,
    keepFirstParagraph = false,
    signal?: AbortSignal,
    observeSection?: (xml: string) => void,
    observeArchive?: (bytes: Uint8Array) => void,
    observeFirstMerge?: (original: string, merged: string) => void
): Promise<void> {
    signal?.throwIfAborted();
    const refZip = await loadTemplateZip(refDocBytes, signal);
    const outZip = new JSZip();

    // OCF: `mimetype` must be the first entry and stored uncompressed.
    const mimetypeFile = refZip.file('mimetype');
    outZip.file(
        'mimetype',
        mimetypeFile ? await mimetypeFile.async('nodebuffer') : Buffer.from('application/hwp+zip'),
        { compression: 'STORE' }
    );

    const templateSection = refZip.file('Contents/section0.xml');
    const sectionXml = templateSection
        ? buildSection0(
            templateSectionXml ?? await templateSection.async('string'),
            xmlBody,
            { keepFirstParagraph, observeFirstMerge }
        )
        : null;
    if (sectionXml !== null) observeSection?.(sectionXml);

    // Copy all files from reference template
    for (const [name, file] of Object.entries(refZip.files)) {
        signal?.throwIfAborted();
        if (file.dir || name === 'mimetype') continue;
        // The template's thumbnail would show the template, not this document.
        if (name === 'Preview/PrvImage.png') continue;
        const data = await file.async('nodebuffer');

        // Encode whole strings before JSZip chunks them, so supplementary
        // Unicode characters cannot be split into unpaired surrogates.
        if (name === 'Contents/section0.xml' && sectionXml !== null) {
            outZip.file(name, Buffer.from(sectionXml, 'utf8'));
        } else if (name === 'Preview/PrvText.txt' && sectionXml !== null) {
            outZip.file(name, Buffer.from(buildPreviewText(sectionXml), 'utf8'));
        } else if (name === 'Contents/header.xml' && newHeaderXml) {
            outZip.file(name, Buffer.from(newHeaderXml, 'utf8'));
        } else if (name === 'Contents/content.hpf') {
            outZip.file(name, Buffer.from(buildManifest(
                await file.async('string'), images, title
            ), 'utf8'));
        } else {
            outZip.file(name, /^Contents\/section[^/]*\.xml$/.test(name) ? Buffer.from(omitTextParagraphLineSegments(data.toString('utf8')), 'utf8') : data);
        }
    }

    // Embed images
    for (const img of images) {
        signal?.throwIfAborted();
        const binName = `BinData/${img.id}.${img.ext}`;
        if (img.bytes) {
            outZip.file(binName, img.bytes);
            continue;
        }
        const candidates: string[] = img.resolvedPath ? [img.resolvedPath] : [img.path];
        if (inputPath) {
            const inputDir = path.dirname(path.resolve(inputPath));
            candidates.push(path.join(inputDir, img.path));
        }
        let embedded = false;
        for (const cand of candidates) {
            if (fs.existsSync(cand)) {
                outZip.file(binName, fs.readFileSync(cand));
                embedded = true;
                break;
            }
        }
        if (!embedded) {
            console.warn(`[md2hwpx] Image not found: ${img.path}`);
        }
    }

    const outBuffer = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    signal?.throwIfAborted();
    fs.writeFileSync(outputPath, outBuffer);
    observeArchive?.(outBuffer);
}


export function buildSection0(
    originalXml: string,
    xmlBody: string,
    options: { keepFirstParagraph?: boolean; observeFirstMerge?: (original: string, merged: string) => void } = {}
): string {
    // Find the opening <hs:sec ...> tag
    const secStart = originalXml.indexOf('<hs:sec');
    const tagClose = originalXml.indexOf('>', secStart);
    let openTag = originalXml.slice(secStart, tagClose + 1);

    // Ensure required namespaces are present
    if (!openTag.includes('xmlns:hc=')) {
        openTag = openTag.slice(0, -1) + ` xmlns:hc="${NS.hc}">`;
    }

    // Extract XML declaration if present
    const xmlDecl = originalXml.startsWith('<?xml') ? originalXml.slice(0, originalXml.indexOf('?>') + 2) + '\n' : '';

    let firstPara = extractFirstParagraphXml(originalXml) ?? '';
    if (firstPara && !options.keepFirstParagraph) {
        firstPara = sanitizeFirstParagraph(firstPara);
    }
    firstPara = firstPara.split('{{CONTENT}}').join('');
    // A kept cover paragraph has its own text; the body starts after it.
    const merged = options.keepFirstParagraph
        ? { firstParagraphXml: firstPara, remainingBodyXml: xmlBody }
        : mergeFirstBodyParagraphIntoFirstParagraph(firstPara, xmlBody);
    const didMerge = merged.firstParagraphXml !== firstPara;
    // Copied page controls carry nested paragraphs. Their IDs (and their owner)
    // must not collide with the body's independent paragraph counter. Leave
    // header/footer-free templates byte-identical, including their IDs.
    if (/<hp:(?:header|footer)\b/.test(merged.firstParagraphXml)) {
        const ids = new Set([...merged.remainingBodyXml.matchAll(/<hp:p\b[^>]*\bid="([^"]*)"/g)].map(match => match[1]));
        let nextId = findMaxAttrValue(merged.firstParagraphXml + merged.remainingBodyXml, /<hp:p\b[^>]*\bid="(\d+)"/g) + 1;
        merged.firstParagraphXml = merged.firstParagraphXml.replace(/<hp:p\b[^>]*\bid="([^"]*)"[^>]*>/g, (tag, id: string) => {
            const fresh = ids.has(id) ? String(nextId++) : id;
            ids.add(fresh);
            return fresh === id ? tag : tag.replace(/\bid="[^"]*"/, `id="${fresh}"`);
        });
    }
    if (options.observeFirstMerge && didMerge) {
        const firstBody = extractFirstParagraphXml(xmlBody.trimStart());
        if (firstBody) options.observeFirstMerge(firstBody, merged.firstParagraphXml);
    }
    const sectionParts = [xmlDecl + openTag, merged.firstParagraphXml];
    if (merged.remainingBodyXml.trim()) {
        sectionParts.push(merged.remainingBodyXml.trim());
    }

    return omitTextParagraphLineSegments(sectionParts.join('\n') + '\n</hs:sec>');
}


/** Remove stale layout only from outer, text-only paragraphs after the first. */
export function omitTextParagraphLineSegments(xml: string): string {
    let result = '';
    let cursor = 0;
    let first = true;
    const pattern = /<hp:p\b[^>]*>/g;
    for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
        const para = extractParagraphAt(xml, match.index);
        if (!para) break;
        let value = para.paraXml;
        if (!first) {
            const own = removeOutermostElements(value, 'hp:subList');
            const names = [...own.matchAll(/<\/?([\w:.-]+)\b[^>]*>/g)].map(item => item[1]);
            if (names.every(name => ['hp:p', 'hp:run', 'hp:t', 'hp:lineBreak', 'hp:tab', 'hp:linesegarray', 'hp:lineseg'].includes(name))) {
                // Protect nested lists while editing the enclosing paragraph.
                const parts: string[] = [];
                removeOutermostElements(value, 'hp:subList', item => { parts.push(item); return true; });
                for (let i = 0; i < parts.length; i++) value = value.replace(parts[i], `<!--HWPX_SUBLIST_${i}-->`);
                value = removeOutermostElements(value, 'hp:linesegarray');
                for (let i = 0; i < parts.length; i++) value = value.replace(`<!--HWPX_SUBLIST_${i}-->`, parts[i]);
            }
        }
        first = false;
        result += xml.slice(cursor, para.paraStart) + value;
        cursor = para.paraEnd;
        pattern.lastIndex = cursor;
    }
    return result + xml.slice(cursor);
}

export function extractFirstParagraphXml(xml: string): string | null {
    const firstParaStart = xml.indexOf('<hp:p');
    if (firstParaStart === -1) return null;

    return extractParagraphAt(xml, firstParaStart)?.paraXml ?? null;
}


export function extractParagraphAt(
    xml: string,
    paraStart: number
): { paraXml: string; paraStart: number; paraEnd: number } | null {
    if (paraStart === -1) {
        return null;
    }

    const tagPattern = /<hp:p\b[^>]*>|<\/hp:p>/g;
    tagPattern.lastIndex = paraStart;

    let depth = 0;
    for (let match = tagPattern.exec(xml); match; match = tagPattern.exec(xml)) {
        if (match[0].startsWith('<hp:p')) {
            depth += 1;
        } else {
            depth -= 1;
            if (depth === 0) {
                return {
                    paraXml: xml.slice(paraStart, match.index + match[0].length),
                    paraStart,
                    paraEnd: match.index + match[0].length,
                };
            }
        }
    }

    return null;
}


export function stripTemplateWrapperMarkers(xml: string): string {
    if (!xml.includes(TEMPLATE_WRAPPER_START) && !xml.includes(TEMPLATE_WRAPPER_END)) {
        return xml;
    }

    return xml
        .split(TEMPLATE_WRAPPER_START).join('')
        .split(TEMPLATE_WRAPPER_END).join('');
}


export function mergeFirstBodyParagraphIntoFirstParagraph(
    firstPara: string,
    xmlBody: string
): { firstParagraphXml: string; remainingBodyXml: string } {
    if (!firstPara || !xmlBody.trim()) {
        return { firstParagraphXml: firstPara, remainingBodyXml: xmlBody };
    }

    const trimmedBody = xmlBody.trimStart();
    const firstBodyPara = extractFirstParagraphXml(trimmedBody);
    if (!firstBodyPara) {
        return { firstParagraphXml: firstPara, remainingBodyXml: xmlBody };
    }

    const firstBodyStartTag = extractParagraphStartTag(firstBodyPara);
    const firstParaStartTag = extractParagraphStartTag(firstPara);
    if (!firstBodyStartTag || !firstParaStartTag) {
        return { firstParagraphXml: firstPara, remainingBodyXml: xmlBody };
    }

    if (paragraphStartsWithDirectTable(firstBodyPara)) {
        console.warn(
            '[md2hwpx] First body block is a table; keeping it outside the section-property paragraph.'
        );
        return { firstParagraphXml: firstPara, remainingBodyXml: trimmedBody };
    }

    let secPrRun = extractFirstParagraphSecPrRun(firstPara);
    // Section controls (colPr, page number) come from the secPr run; the body's own
    // text controls (links, footnotes) stay, or the first paragraph loses them.
    let pageControls = '';
    const firstBodyInner = removeOutermostElements(
        extractParagraphInnerXml(firstBodyPara).replace(/<hp:secPr[\s\S]*?<\/hp:secPr>/g, ''),
        'hp:ctrl',
        (ctrl) => {
            if (/^<hp:ctrl\b[^>]*>\s*<hp:(?:pageNum|pageNumCtrl|pageHiding|newNum)\b/.test(ctrl)) pageControls += ctrl;
            return TEXT_CONTROL.test(ctrl);
        }
    );
    if (pageControls && secPrRun.endsWith('</hp:run>')) secPrRun = secPrRun.slice(0, -'</hp:run>'.length) + pageControls + '</hp:run>';

    const originalId = extractParagraphAttr(firstParaStartTag, 'id');
    const mergedStartTag = replaceParagraphAttr(
        firstBodyStartTag,
        'id',
        originalId
    );
    const mergedFirstPara = `${mergedStartTag}${secPrRun}${firstBodyInner}</hp:p>`;
    const remainingBodyXml = trimmedBody.slice(firstBodyPara.length).trimStart();

    return {
        firstParagraphXml: mergedFirstPara,
        remainingBodyXml,
    };
}


export function sanitizeFirstParagraph(firstPara: string): string {
    const startTag = firstPara.match(/^<hp:p\b[^>]*>/)?.[0];
    if (!startTag) {
        return firstPara;
    }

    let secPrRun = extractFirstParagraphSecPrRun(firstPara);
    const linesegArray = removeOutermostElements(firstPara, 'hp:run').match(/<hp:linesegarray[\s\S]*?<\/hp:linesegarray>/)?.[0] ?? '';
    const emptyCharPrId = extractFirstParagraphEmptyCharPrId(firstPara);
    // Page-level controls in a later run (kordoc puts the page number next to its title
    // table) join the secPr run; the empty run is replaced when the first block merges in.
    let pageControls = '';
    removeOutermostElements(firstPara.replace(secPrRun, ''), 'hp:ctrl', ctrl => {
        // Header/footer paragraphs contain their own runs and controls. Capture
        // the complete outer control, never a nested closing run/control tag.
        if (/^<hp:ctrl\b[^>]*>\s*<hp:(?:header|footer)\b/.test(ctrl)
            || /^<hp:ctrl>\s*<hp:(?:pageNum|pageNumCtrl|pageHiding|newNum)\b[^>]*\/>\s*<\/hp:ctrl>$/.test(ctrl)) pageControls += ctrl;
        return true;
    });
    if (pageControls && secPrRun.endsWith('</hp:run>')) secPrRun = secPrRun.slice(0, -'</hp:run>'.length) + pageControls + '</hp:run>';
    const emptyRun = `<hp:run charPrIDRef="${emptyCharPrId}"><hp:t/></hp:run>`;

    return `${startTag}${secPrRun}${emptyRun}${linesegArray}</hp:p>`;
}

/** Controls that belong to the paragraph text (hyperlink fields, footnotes, endnotes). */
const TEXT_CONTROL = /^<hp:ctrl\b[^>]*>\s*<hp:(?:fieldBegin|fieldEnd|footNote|endNote)\b/;


export function extractParagraphStartTag(paraXml: string): string | null {
    return paraXml.match(/^<hp:p\b[^>]*>/)?.[0] ?? null;
}


export function extractParagraphInnerXml(paraXml: string): string {
    const startTag = extractParagraphStartTag(paraXml);
    if (!startTag || !paraXml.endsWith('</hp:p>')) {
        return paraXml;
    }

    return paraXml.slice(startTag.length, -'</hp:p>'.length);
}


export function paragraphStartsWithDirectTable(paraXml: string): boolean {
    return extractParagraphInnerXml(paraXml).trimStart().startsWith('<hp:tbl');
}


export function extractParagraphAttr(startTag: string, attrName: string): string {
    return startTag.match(new RegExp(`\\b${escapeRegex(attrName)}="([^"]*)"`))?.[1] ?? '';
}


export function replaceParagraphAttr(startTag: string, attrName: string, value: string): string {
    if (!value) {
        return startTag;
    }

    const attrPattern = new RegExp(`\\b${escapeRegex(attrName)}="[^"]*"`);
    if (attrPattern.test(startTag)) {
        return startTag.replace(attrPattern, `${attrName}="${value}"`);
    }

    return startTag.replace(/^<hp:p\b/, `<hp:p ${attrName}="${value}"`);
}


export function extractFirstParagraphSecPrRun(firstPara: string): string {
    const runs: string[] = [];
    removeOutermostElements(firstPara, 'hp:run', run => { runs.push(run); return true; });
    for (const runXml of runs) {
        if (runXml.includes('<hp:secPr') || runXml.includes('<hp:ctrl')) {
            return runXml;
        }
    }

    return runs[0] ?? '';
}


export function extractFirstParagraphEmptyCharPrId(firstPara: string): string {
    const textRunMatch = firstPara.match(/<hp:run\b[^>]*charPrIDRef="([^"]+)"[^>]*>[\s\S]*?<hp:t(?:\s*\/>|>[\s\S]*?<\/hp:t>)/);
    if (textRunMatch?.[1]) {
        return textRunMatch[1];
    }

    return firstPara.match(/<hp:run\b[^>]*charPrIDRef="([^"]+)"/)?.[1] ?? '0';
}


export function buildManifest(
    hpfXml: string,
    images: ImageMeta[],
    title: string | null
): string {
    // The template thumbnail is dropped from the package (see writeHwpxOutput).
    let xml = hpfXml.replace(/<opf:item\b[^>]*href="Preview\/PrvImage\.[^"]*"[^>]*\/>\s*/g, '');
    if (title) {
        xml = xml.replace(/<opf:title>.*?<\/opf:title>/, `<opf:title>${escapeXml(title)}</opf:title>`);
    }
    if (images.length > 0) {
        const items = images.map((img) => {
            const mime = img.ext === 'jpg' ? 'image/jpg'
                : img.ext === 'gif' ? 'image/gif' : 'image/png';
            return `<opf:item id="${img.id}" href="BinData/${img.id}.${img.ext}" media-type="${mime}" isEmbeded="1"/>`;
        });
        const pos = xml.indexOf('</opf:manifest>');
        if (pos !== -1) {
            xml = xml.slice(0, pos) + items.join('\n') + '\n' + xml.slice(pos);
        }
    }
    return xml;
}
