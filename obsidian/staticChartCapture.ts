import { randomUUID } from 'crypto';
import { scanRenderableBlocks, spliceBlocks } from '../src/renderableBlocks';
import type { CapturedAsset } from './svgCapture';

export const STATIC_CHART_API = Symbol.for('dev.chart-hands.static-chart-v1');
type Renderer = { protocol: string; version: number; render(source: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; width: number; height: number }> };

/** Only the explicit data-only fence is handled; arbitrary plotly blocks stay on the guarded path. */
export async function captureStaticCharts(markdown: string, renderer: Renderer | undefined, signal?: AbortSignal): Promise<{ markdown: string; assets: Map<string, CapturedAsset> }> {
    const blocks = scanRenderableBlocks(markdown, { languages: ['chart-hands-static'], includeSvgFiles: false });
    const assets = new Map<string, CapturedAsset>();
    if (!blocks.length) return { markdown, assets };
    if (!renderer || renderer.protocol !== 'chart-hands-static' || renderer.version !== 1 || typeof renderer.render !== 'function') throw new Error('Chart Hands static chart renderer is unavailable.');
    if (blocks.length > 10) throw new Error('Too many static charts (maximum 10).');
    const replacements: Parameters<typeof spliceBlocks>[1] = [];
    for (const [index, block] of blocks.entries()) {
        signal?.throwIfAborted();
        const result = await renderer.render(block.source, signal);
        signal?.throwIfAborted();
        const bytes = result?.bytes;
        if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 8 * 1024 * 1024 ||
            [137, 80, 78, 71, 13, 10, 26, 10].some((value, i) => bytes[i] !== value) ||
            result.width !== 1000 || result.height !== 600) throw new Error('Invalid static chart image.');
        const syntheticPath = `hwpx-static-chart-${randomUUID()}-${index}.png`;
        assets.set(syntheticPath, { bytes: Buffer.from(bytes), ext: 'png', displayWidthPx: result.width, displayHeightPx: result.height, sourceKind: 'img' });
        replacements.push({ block, syntheticPath });
    }
    const spliced = spliceBlocks(markdown, replacements);
    if (spliced.inserted.length !== assets.size || spliced.inserted.some(item => !assets.has(item.syntheticPath))) throw new Error('Static chart image mapping failed.');
    return { markdown: spliced.markdown, assets };
}
