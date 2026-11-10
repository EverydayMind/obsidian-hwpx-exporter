/**
 * XML text helpers: escaping, invalid characters, template <hp:t> text with its child elements, object/paragraph scanning.
 * Split out of markdownToHwpx.ts (plan 2.1).
 */

// ============================================================
// XML Namespaces
// ============================================================

export const NS = {
    hh: 'http://www.hancom.co.kr/hwpml/2011/head',
    hp: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
    hc: 'http://www.hancom.co.kr/hwpml/2011/core',
    hs: 'http://www.hancom.co.kr/hwpml/2011/section',
};


export const TEMPLATE_WRAPPER_START = '[[[';

export const TEMPLATE_WRAPPER_END = ']]]';


// ============================================================
// Utility helpers
// ============================================================

// Characters XML 1.0 forbids (C0 controls other than tab/LF/CR, U+FFFE/U+FFFF,
// unpaired surrogates). Pasted text can carry them (form feeds, ANSI escapes),
// and any of them makes section0.xml unreadable. Tab and LF are kept here;
// textRun turns them into <hp:tab/> / <hp:lineBreak/>.
// eslint-disable-next-line no-control-regex -- the pattern lists the control characters XML 1.0 forbids
export const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;


export function stripInvalidXmlChars(text: string): string {
    return text.replace(INVALID_XML_CHARS, '');
}


export function escapeXml(text: string): string {
    return stripInvalidXmlChars(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}


export function unescapeXml(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&amp;/g, '&');
}


// Template <hp:t> text can contain child elements (<hp:tab/>, <hp:lineBreak/>,
// …). They are not text: plain-text views map tab/lineBreak to \t/\n, and
// round-trip edits swap each element for a sentinel code point so the original
// element XML (e.g. a tab's width/leader) is restored on output.
// `<hp:t[^>]*>` must not be used here: it also matches <hp:tbl>, <hp:tc>, <hp:tab>.
export const HP_TEXT_PATTERN = /<hp:t((?:\s[^>]*)?)>([\s\S]*?)<\/hp:t>/g;

export const HP_TEXT_OR_TAB_PATTERN = /<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<hp:tab\b[^>]*\/>/g;

export const TEMPLATE_RUN_TOKEN_PATTERN = /<hp:t((?:\s[^>]*)?)\/>|<hp:t((?:\s[^>]*)?)>([\s\S]*?)<\/hp:t>|<hp:[A-Za-z]+\b[^>]*\/>/g;

const ELEMENT_SENTINEL_BASE = 0x100000;

function elementSentinel(index: number): string {
    return `\u0001${String.fromCodePoint(ELEMENT_SENTINEL_BASE + index)}\u0002`;
}

// eslint-disable-next-line no-control-regex -- U+0001/U+0002 delimit the internal element sentinels
const ELEMENT_SENTINEL_PATTERN = /\u0001([\u{100000}-\u{10FFFD}])\u0002/gu;


export function templateTextContent(innerXml: string): string {
    return unescapeXml(innerXml
        .replace(/<hp:tab\b[^>]*\/>|<hp:tab\b[^>]*>[\s\S]*?<\/hp:tab>/g, '\t')
        .replace(/<hp:lineBreak\b[^>]*\/>/g, '\n')
        .replace(/<[^>]+>/g, ''));
}


/** Visible text of every <hp:t> (and run-level <hp:tab/>) in a template fragment. */
export function templatePlainText(xml: string): string {
    return [...xml.matchAll(HP_TEXT_OR_TAB_PATTERN)]
        .map((match) => match[1] === undefined ? '\t' : templateTextContent(match[1]))
        .join('');
}


export function decodeTemplateElements(innerXml: string, elements: string[]): string {
    return innerXml.split(/(<[^>]+>)/).map((part, index) => {
        if (index % 2 === 0) return unescapeXml(part);
        elements.push(part);
        return elementSentinel(elements.length - 1);
    }).join('');
}


export function encodeTemplateText(text: string, elements: string[]): string {
    let cursor = 0;
    let xml = '';
    const literal = (value: string): string => escapeXml(value).replace(/\t/g, '<hp:tab/>').replace(/\n/g, '<hp:lineBreak/>');
    for (const match of text.matchAll(ELEMENT_SENTINEL_PATTERN)) {
        xml += literal(text.slice(cursor, match.index)) + (elements[match[1].codePointAt(0)! - ELEMENT_SENTINEL_BASE] ?? '');
        cursor = match.index + match[0].length;
    }
    return xml + literal(text.slice(cursor));
}


/**
 * Decode a template run made only of text pieces (<hp:t>, <hp:t/>, and
 * self-closing inline elements such as <hp:tab/>). Returns null for runs that
 * carry anything else (tables, controls, pictures) so callers leave them alone.
 */
export function decodeTemplateTextRun(
    runInner: string
): { text: string; textAttrs: string; elements: string[] } | null {
    const elements: string[] = [];
    let text = '';
    let textAttrs: string | null = null;
    let cursor = 0;
    for (const match of runInner.matchAll(TEMPLATE_RUN_TOKEN_PATTERN)) {
        const index = match.index ?? 0;
        if (runInner.slice(cursor, index).trim()) return null;
        cursor = index + match[0].length;
        if (match[3] !== undefined) {
            textAttrs ??= match[2] ?? '';
            text += decodeTemplateElements(match[3], elements);
        } else if (match[1] !== undefined) {
            textAttrs ??= match[1] ?? '';
        } else {
            elements.push(match[0]);
            text += elementSentinel(elements.length - 1);
        }
    }
    if (runInner.slice(cursor).trim() || textAttrs === null) return null;
    return { text, textAttrs, elements };
}


// Start tag of an object element that can carry a document-wide id: anything in
// the hp namespace except paragraphs (own counter) and fields (own counter).
export const OBJECT_START_TAG_PATTERN = /<hp:(?!p\b|fieldBegin\b|fieldEnd\b)[A-Za-z]+\b[^>]*>/g;


// Elements that make a paragraph non-blank even without text.
export const OBJECT_ELEMENT_PATTERN = /<hp:(?:tbl|pic|rect|ellipse|arc|polygon|curve|line|connectLine|container|ole|equation|textart|video|chart)\b/;


/** Top-level <hp:p> elements of a section, nested paragraphs included in their owner. */
export function splitTopLevelParagraphs(sectionXml: string): string[] {
    const paragraphs: string[] = [];
    let depth = 0;
    let start = 0;
    for (const match of sectionXml.matchAll(/<hp:p\b[^>]*>|<\/hp:p>/g)) {
        const index = match.index ?? 0;
        if (match[0] === '</hp:p>') {
            depth--;
            if (depth === 0) paragraphs.push(sectionXml.slice(start, index + match[0].length));
        } else {
            if (depth === 0) start = index;
            depth++;
        }
    }
    return paragraphs;
}


/**
 * Remove every outermost `<name>` element (its nested ones go with it), pairing
 * start and end tags by depth. A lazy regex stops at a nested element's end tag
 * (a footnote's inner autoNum control) and leaves the rest of the element behind.
 * `keep` sees each outermost element and returns true to leave it in place.
 */
export function removeOutermostElements(xml: string, name: string, keep?: (elementXml: string) => boolean): string {
    const tag = escapeRegex(name);
    let result = '';
    let cursor = 0;
    let depth = 0;
    let start = 0;
    const take = (from: number, to: number): void => {
        const element = xml.slice(from, to);
        result += xml.slice(cursor, from) + (keep?.(element) ? element : '');
        cursor = to;
    };
    for (const match of xml.matchAll(new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, 'g'))) {
        const index = match.index ?? 0;
        const end = index + match[0].length;
        if (match[0].startsWith('</')) {
            if (depth === 0) continue;
            depth--;
            if (depth === 0) take(start, end);
        } else if (match[1] === '/') {
            if (depth === 0) take(index, end);
        } else {
            if (depth === 0) start = index;
            depth++;
        }
    }
    return result + xml.slice(cursor);
}


export function findMaxAttrValue(xml: string, pattern: RegExp): number {
    let max = 0;
    for (const match of xml.matchAll(pattern)) {
        const value = parseInt(match[1], 10);
        if (Number.isFinite(value) && value > max) max = value;
    }
    return max;
}


export function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
