import { stripObsidianComments } from '../src/obsidianComments';
import { scanRenderableBlocks } from '../src/renderableBlocks';

/** Third-party renderers may read inputs the agent preparation cannot bind. */
export function hasUnboundThirdPartyCapture(
    markdown: string,
    options: { captureRenderedBlocks: boolean; captureThirdPartyRenderers: boolean; thirdPartyLanguages: string[] }
): boolean {
    if (!options.captureRenderedBlocks || !options.captureThirdPartyRenderers) return false;
    const languages = options.thirdPartyLanguages.map((language) => language.trim().toLowerCase()).filter(Boolean);
    return scanRenderableBlocks(stripObsidianComments(markdown), {
        languages,
        includeSvgFiles: false,
    }).length > 0;
}
