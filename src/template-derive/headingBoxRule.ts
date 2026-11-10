import { descendants, NS, type Element } from './xml';

/** An unnumbered 1x1 heading table is real template content inside a
 * transparent rule table; multi-cell numbered headings stay top level. */
export function wrapHeadingBoxRule(content: Element, sourceTable: Element, marker: string, hasCounters: boolean, makeRule: () => Element): Element {
    const rows = Number(sourceTable.getAttribute('rowCnt') ?? sourceTable.getAttribute('rowCount'));
    const cols = Number(sourceTable.getAttribute('colCnt') ?? sourceTable.getAttribute('colCount'));
    if (!/^H[1-9]$/.test(marker) || hasCounters || rows !== 1 || cols !== 1) return content;
    const rule = makeRule(), subList = descendants(rule, 'subList', NS.para)[0];
    // Keep the wrapper's leading spacers; replace just its marker paragraph.
    subList.replaceChild(content, subList.lastChild!);
    return rule;
}
