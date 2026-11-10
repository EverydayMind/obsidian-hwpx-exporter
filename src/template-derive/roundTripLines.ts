import type { Block, RoundTrip } from './roundTrip';

type R1 = Extract<RoundTrip, { state: 'measured' }>['R1'];
type Line = Block['lines'][number];
type Lcs = (a: string[], b: string[], signal?: AbortSignal) => Array<[number, number]>;

/** Block pairs are immutable anchors. Residual lines may only meet inside
 * the same open interval, including the document's leading/trailing intervals. */
export function measureLineCorrespondence(
    source: Block[], output: Block[], blockPairs: Array<[number, number]>, lcs: Lcs, signal?: AbortSignal,
): Pick<R1, 'matched' | 'residualMatched' | 'missing' | 'added' | 'pairs' | 'missingLines' | 'addedLines'> {
    const result = { matched: 0, residualMatched: 0, missing: 0, added: 0,
        pairs: [] as R1['pairs'], missingLines: [] as R1['missingLines'], addedLines: [] as R1['addedLines'] };
    function compare(a: Line[], b: Line[], residual: boolean) {
        signal?.throwIfAborted();
        const pairs = lcs(a.map(l => l.key), b.map(l => l.key), signal);
        const seenA = new Set(pairs.map(p => p[0])), seenB = new Set(pairs.map(p => p[1]));
        result.matched += pairs.length;
        if (residual) result.residualMatched += pairs.length;
        result.pairs.push(...pairs.map(([i, j]) => ({ sourceRef: a[i].ref, outputRef: b[j].ref, sourceLine: a[i].line, outputLine: b[j].line })));
        result.missingLines.push(...a.filter((_, i) => !seenA.has(i)).map(({ ref, line }) => ({ ref, line })));
        result.addedLines.push(...b.filter((_, i) => !seenB.has(i)).map(({ ref, line }) => ({ ref, line })));
    }
    let startA = 0, startB = 0;
    for (let index = 0; index <= blockPairs.length; index++) {
        const [endA, endB] = blockPairs[index] ?? [source.length, output.length];
        compare(source.slice(startA, endA).flatMap(b => b.lines), output.slice(startB, endB).flatMap(b => b.lines), true);
        if (index < blockPairs.length) compare(source[endA].lines, output[endB].lines, false);
        startA = endA + 1; startB = endB + 1;
    }
    result.missing = result.missingLines.length; result.added = result.addedLines.length;
    return result;
}
