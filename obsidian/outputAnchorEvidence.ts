import { parseVariantMarker } from '../src/template-derive/variantMarkers';
export type SavedOutputAnchorEvidence = {
    state: 'partial'; archiveSha256: string; sectionSha256: string;
    anchorVersion: '0.3';
    anchors: Array<{ blockIndex: number; section: 0; paragraph: number; appliedMarker: string | null;
        requestedVariant: string | null; variantMissing: boolean }>;
};

/** Only copy bounded, text-free evidence bound to the exact prepared bytes. */
export function copyOutputAnchorEvidence(value: unknown, archiveSha256: string): SavedOutputAnchorEvidence | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Partial<SavedOutputAnchorEvidence>;
    if (item.state !== 'partial' || item.archiveSha256 !== archiveSha256 ||
        typeof item.sectionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sectionSha256) ||
        !Array.isArray(item.anchors) || item.anchors.length > 50000) return null;
    if (item.anchorVersion !== '0.3') return null;
    const blocks = new Set<number>(), positions = new Set<number>();
    const anchors: SavedOutputAnchorEvidence['anchors'] = [];
    for (const anchor of item.anchors) {
        if (!anchor || !Number.isSafeInteger(anchor.blockIndex) || anchor.blockIndex < 0 || anchor.section !== 0 ||
            !Number.isSafeInteger(anchor.paragraph) || anchor.paragraph < 0 || blocks.has(anchor.blockIndex) || positions.has(anchor.paragraph)) return null;
        if (!(anchor.appliedMarker === null || typeof anchor.appliedMarker === 'string' && [...anchor.appliedMarker].length >= 1 && [...anchor.appliedMarker].length <= 128)) return null;
        if (!(anchor.requestedVariant === null || typeof anchor.requestedVariant === 'string' && !!parseVariantMarker(`BODY:${anchor.requestedVariant}`)) ||
            typeof anchor.variantMissing !== 'boolean' || (anchor.requestedVariant === null && anchor.variantMissing)) return null;
        blocks.add(anchor.blockIndex); positions.add(anchor.paragraph);
        anchors.push({ blockIndex: anchor.blockIndex, section: 0, paragraph: anchor.paragraph, appliedMarker: anchor.appliedMarker,
            requestedVariant: anchor.requestedVariant, variantMissing: anchor.variantMissing });
    }
    return { state: 'partial', archiveSha256, sectionSha256: item.sectionSha256, anchorVersion: '0.3', anchors };
}
