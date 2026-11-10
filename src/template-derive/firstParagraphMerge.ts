import { canonicalDigest } from './digest';
import type { Block, Difference } from './roundTrip';

/** One output paragraph may represent a pure section paragraph plus the first
 * body block. Never exempt a source title table/picture or a changed body key. */
export function splitFirstParagraphMerge(source: Block[], output: Block[]): { blocks: Block[]; allowed: Difference[] } {
    const section = source[0], merged = output[0];
    const body = source.find((block, index) => index > 0 && !block.spacer);
    const unchanged = { blocks: output, allowed: [] };
    if (!section || !merged || !body || section.lines.length || !section.key.startsWith('controls:') ||
        !section.controls.some(c => c.kind === 'secPr') || body.spacer || merged.key !== body.key ||
        merged.key.startsWith('controls:')) return unchanged;
    const remaining = [...merged.controls], controls = [];
    for (const control of section.controls) {
        const index = remaining.findIndex(c => c.kind === control.kind && canonicalDigest(c.attributes) === canonicalDigest(control.attributes));
        if (index < 0) return unchanged;
        controls.push(...remaining.splice(index, 1));
    }
    return {
        blocks: [{ ...merged, key: section.key, spacer: false, lines: [], controls }, { ...merged, controls: remaining }, ...output.slice(1)],
        allowed: [{ kind: 'normalization', sourceRef: section.ref, outputRef: merged.ref, reason: 'first_paragraph_merge' }],
    };
}
