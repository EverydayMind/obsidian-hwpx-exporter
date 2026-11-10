import type { PandocAST, PandocBlock, PandocInline } from './types';

/** Formatting containers only: notes, images, math and code are opaque. */
function children(inline: PandocInline): PandocInline[] | null {
    switch (inline.t) {
        case 'Strong': case 'Emph': case 'Strikeout': case 'Underline':
        case 'Superscript': case 'Subscript': case 'SmallCaps': return inline.c;
        case 'Link': case 'Span': case 'Quoted': return inline.c[1];
        default: return null;
    }
}

function withChildren(inline: PandocInline, content: PandocInline[]): PandocInline {
    switch (inline.t) {
        case 'Strong': case 'Emph': case 'Strikeout': case 'Underline':
        case 'Superscript': case 'Subscript': case 'SmallCaps': return { ...inline, c: content };
        case 'Link': return { ...inline, c: [inline.c[0], content, inline.c[2]] };
        case 'Span': return { ...inline, c: [inline.c[0], content] };
        case 'Quoted': return { ...inline, c: [inline.c[0], content] };
        default: return inline;
    }
}

type Leaf = { inline: PandocInline; parents: PandocInline[] };

/** Rebuild a fragment with each crossed wrapper cloned, retaining its attributes. */
function fragment(leaves: Leaf[]): PandocInline[] {
    const result: PandocInline[] = [];
    let previous: PandocInline[] = [];
    const outputs: PandocInline[][] = [result];
    for (const { inline, parents } of leaves) {
        let common = 0;
        while (common < previous.length && common < parents.length && previous[common] === parents[common]) common++;
        outputs.length = common + 1;
        for (let depth = common; depth < parents.length; depth++) {
            const content: PandocInline[] = [];
            outputs[depth].push(withChildren(parents[depth], content));
            outputs.push(content);
        }
        outputs[parents.length].push(inline);
        previous = parents;
    }
    return result;
}

function splitInlines(content: PandocInline[], markers: readonly string[]): PandocInline[][] {
    const leaves: Leaf[] = [];
    const visit = (inlines: PandocInline[], parents: PandocInline[]): void => {
        for (const inline of inlines) {
            const nested = children(inline);
            if (nested?.length) visit(nested, [...parents, inline]);
            else leaves.push({ inline, parents });
        }
    };
    visit(content, []);
    const cuts: number[] = [];
    const maxLength = Math.max(...markers.map(marker => marker.length));
    for (let i = 0; i < leaves.length; i++) {
        if (leaves[i].inline.t !== 'SoftBreak' && leaves[i].inline.t !== 'LineBreak') continue;
        let prefix = '';
        for (let next = i + 1; next < leaves.length && prefix.length < maxLength; next++) {
            const inline = leaves[next].inline;
            if (inline.t === 'Str') prefix += inline.c;
            else if (inline.t === 'Space') prefix += ' ';
            else break;
        }
        if (markers.some(marker => prefix.startsWith(marker))) cuts.push(i);
    }
    if (!cuts.length) return [content];
    const parts: PandocInline[][] = [];
    let start = 0;
    for (const cut of cuts) {
        parts.push(fragment(leaves.slice(start, cut)));
        start = cut + 1;
    }
    parts.push(fragment(leaves.slice(start)));
    return parts;
}

/**
 * Split role-led lines in body paragraphs and their list items. `markers` are
 * literal prefix tokens (e.g. ['□', 'ㅇ', '※']), not {{marker}} expressions.
 * Markdown bullet tokens are excluded, including the deliberately unsupported
 * escaped \\- line. Other containers are left intact. Pure and idempotent;
 * unchanged nodes may be shared with the input AST.
 */
export function splitRoleMarkerLines(ast: PandocAST, markers: readonly string[]): PandocAST {
    const tokens = [...new Set(markers)].filter(marker => marker.length > 0 && !['-', '*', '+'].includes(marker));
    if (!tokens.length) return ast;
    const walk = (blocks: PandocBlock[]): PandocBlock[] => blocks.flatMap((block): PandocBlock[] => {
        if (block.t === 'Para' || block.t === 'Plain') {
            const parts = splitInlines(block.c, tokens);
            return parts.length === 1 ? [block] : parts.map((c, i) => i === 0 ? { ...block, c } : { t: 'Para', c });
        }
        if (block.t === 'BulletList') return [{ ...block, c: block.c.map(walk) }];
        if (block.t === 'OrderedList') return [{ ...block, c: [block.c[0], block.c[1].map(walk)] }];
        return [block];
    });
    return { ...ast, blocks: walk(ast.blocks) };
}
