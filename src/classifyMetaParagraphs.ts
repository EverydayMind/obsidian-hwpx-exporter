import type { PandocAST, PandocBlock, PandocInline } from './types';

function isMetaLine(line: PandocInline[]): boolean {
    const first = line[0];
    if (first?.t !== 'Strong' || first.c.some(inline => inline.t !== 'Str' && inline.t !== 'Space')) return false;
    const text = first.c.map(inline => inline.t === 'Str' ? inline.c : ' ').join('');
    const inside = /[:：]$/.test(text);
    if (!inside && !(line[1]?.t === 'Str' && /^[:：]/.test(line[1].c))) return false;
    const label = (inside ? text.slice(0, -1) : text).replace(/\s/gu, '');
    const length = [...label].length;
    return length >= 1 && length <= 20;
}

function isMetaParagraph(content: PandocInline[]): boolean {
    let line: PandocInline[] = [];
    for (const inline of content) {
        if (inline.t === 'SoftBreak' || inline.t === 'LineBreak') {
            if (!isMetaLine(line)) return false;
            line = [];
        } else line.push(inline);
    }
    return isMetaLine(line);
}

/** Pure, idempotent classification of top-level body paragraphs only.
 * Containers (including explicit style Divs and footnotes) remain opaque.
 * Unchanged nodes may be shared with the input AST.
 */
export function classifyMetaParagraphs(ast: PandocAST): PandocAST {
    return { ...ast, blocks: ast.blocks.map((block): PandocBlock =>
        (block.t === 'Para' || block.t === 'Plain') && isMetaParagraph(block.c)
            ? { t: 'Div', c: [['', ['hwpx-style'], [['style', 'META'], ['auto', 'meta']]], [block]] }
            : block) };
}
