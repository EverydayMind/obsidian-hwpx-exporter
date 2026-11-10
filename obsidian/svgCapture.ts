import { App, Component, loadMermaid, MarkdownRenderer } from 'obsidian';
import type { RenderableBlock } from '../src/renderableBlocks';
import { scanRenderableBlocks, spliceBlocks } from '../src/renderableBlocks';
import { readImagePixelSize } from '../src/imageDimensions';
import { prepareMermaidSource, prepareRenderSource } from './renderSource';
import type { LayerBox, LayerCandidate } from './captureLayers';
import { isTransparentColor, selectLayerStack } from './captureLayers';

export interface SvgBinaryAsset {
    vaultPath: string;
    bytes: ArrayBuffer;
}

export interface CapturedAsset {
    bytes: Buffer;
    ext: 'png';
    displayWidthPx: number;
    displayHeightPx: number;
    sourceKind: 'svg' | 'canvas' | 'img';
}

export interface SvgCaptureOptions {
    app: App;
    sourcePath: string;
    captureRenderedBlocks: boolean;
    captureSvgFiles: boolean;
    captureMermaid: boolean;
    captureThirdPartyRenderers: boolean;
    thirdPartyLanguages: string[];
    rasterScale: number;
    captureWidthPx: number;
    captureTimeoutMs: number;
    captureTotalTimeoutMs: number;
    maxCaptureBlocks: number;
    forceLightThemeOnCapture: boolean;
    forceLightThemeAggressive: boolean;
    allowForeignObject: boolean;
    mermaidDisableHtmlLabels: boolean;
    resolveSvgAsset(linkPath: string, basePath?: string): Promise<SvgBinaryAsset | null>;
}

export interface SvgCaptureResult {
    markdown: string;
    assets: Map<string, CapturedAsset>;
    inserted: { syntheticPath: string; insertOffset: number }[];
    failures: { hint: string; message: string }[];
    contractViolation: boolean;
}

type RenderFn = (markdown: string, element: HTMLElement, sourcePath: string, component: Component) => Promise<void>;
type Snapshot = {
    kind: 'svg' | 'canvas' | 'img';
    displayWidthPx: number;
    displayHeightPx: number;
    svgText?: string;
    source?: CanvasImageSource;
};

const MAX_BLOCK_PIXELS = 8_000_000;
const TOTAL_PIXEL_BUDGET = 40_000_000;
const TOTAL_BYTE_BUDGET = 64 * 1024 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_STYLE_PROPERTIES = [
    'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'marker-start', 'marker-mid', 'marker-end', 'paint-order', 'vector-effect',
    'clip-path', 'clip-rule', 'mask', 'filter', 'shape-rendering', 'text-rendering',
    'color', 'opacity', 'display',
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'text-anchor', 'dominant-baseline', 'letter-spacing', 'white-space', 'text-decoration',
];

let mutexTail: Promise<void> = Promise.resolve();

export async function captureRenderableBlocks(
    markdown: string,
    options: SvgCaptureOptions
): Promise<SvgCaptureResult> {
    if (!options.captureRenderedBlocks) {
        return { markdown, assets: new Map(), inserted: [], failures: [], contractViolation: false };
    }

    const languages = new Set<string>();
    if (options.captureMermaid) languages.add('mermaid');
    if (options.captureThirdPartyRenderers) {
        for (const language of options.thirdPartyLanguages) {
            if (language.trim()) languages.add(language.trim().toLowerCase());
        }
    }

    const blocks = scanRenderableBlocks(markdown, {
        languages,
        includeSvgFiles: options.captureSvgFiles,
    });
    const limited = blocks.slice(0, Math.max(0, options.maxCaptureBlocks));
    const assets = new Map<string, CapturedAsset>();
    const replacements: { block: RenderableBlock; syntheticPath: string | null }[] = [];
    const failures: { hint: string; message: string }[] = [];
    for (const block of blocks.slice(limited.length)) {
        failures.push({ hint: block.hint, message: 'capture block limit reached' });
    }
    const nonce = createNonce();
    const budget: CaptureBudget = {
        pixels: 0,
        bytes: 0,
        startedAt: 0,
    };
    const renderer = pickRenderer(options.app);
    let sequence = 0;

    return runExclusive(async () => {
        budget.startedAt = performance.now();
        const themeGuard = options.forceLightThemeAggressive ? installBodyThemeGuard() : null;
        try {
            for (let index = 0; index < limited.length; index++) {
                const block = limited[index];
                if (performance.now() - budget.startedAt >= options.captureTotalTimeoutMs) {
                    for (const skipped of limited.slice(index)) failures.push({ hint: skipped.hint, message: 'capture total timeout reached' });
                    break;
                }
                const syntheticPath = `hwpx-render-${nonce}-${String(sequence + 1).padStart(3, '0')}.png`;
                try {
                    if (block.kind === 'code-block') {
                        if (!renderer) throw new CaptureFailure('MarkdownRenderer API is unavailable');
                        if (!options.captureMermaid && block.hint === 'mermaid') {
                            throw new CaptureFailure('mermaid capture is disabled');
                        }
                        const captured = await captureRenderedBlock(block, renderer, options, budget);
                        assets.set(syntheticPath, captured);
                    } else {
                        const captured = await captureStaticSvg(block, options, budget);
                        assets.set(syntheticPath, captured);
                    }
                    replacements.push({ block, syntheticPath });
                    sequence += 1;
                } catch (error) {
                    const message = toErrorMessage(error);
                    failures.push({ hint: block.hint, message });
                    console.warn(`[HWPX Exporter] SVG capture skipped (${block.hint}):`, error);
                    replacements.push({ block, syntheticPath: null });
                }
                await yieldToEventLoop();
            }

            const spliced = spliceBlocks(markdown, replacements);
            const insertedSet = new Set(spliced.inserted.map((item) => item.syntheticPath));
            const assetSet = new Set(assets.keys());
            const unknownSynthetic = new RegExp(`hwpx-render-${nonce}-\\d{3}\\.png`, 'g');
            const recordedOccurrences = [...spliced.markdown.matchAll(unknownSynthetic)].length;
            const complete = insertedSet.size === assetSet.size
                && [...insertedSet].every((key) => assetSet.has(key))
                && recordedOccurrences === insertedSet.size;
            if (!complete) {
                return {
                    markdown,
                    assets: new Map(),
                    inserted: [],
                    failures,
                    contractViolation: true,
                };
            }
            return {
                markdown: spliced.markdown,
                assets,
                inserted: spliced.inserted,
                failures,
                contractViolation: false,
            };
        } finally {
            themeGuard?.restore();
        }
    });
}

interface CaptureBudget {
    pixels: number;
    bytes: number;
    startedAt: number;
}

async function captureRenderedBlock(
    block: RenderableBlock,
    render: RenderFn,
    options: SvgCaptureOptions,
    budget: CaptureBudget
): Promise<CapturedAsset> {
    const container = createDiv();
    container.className = `hwpx-export-offscreen${options.forceLightThemeOnCapture ? ' theme-light' : ''}`;
    if (options.forceLightThemeOnCapture) container.classList.remove('theme-dark');
    container.style.width = `${options.captureWidthPx}px`;
    container.style.maxWidth = `${options.captureWidthPx}px`;
    document.body.appendChild(container);
    const component = new Component();
    component.load();
    const tracker = new MutationTracker(container);
    tracker.observe();
    let abandoned = false;

    try {
        const operation = (async () => {
            let renderedByMermaidApi = false;
            if (block.hint === 'mermaid') {
                try {
                    renderedByMermaidApi = await renderMermaidApi(block, container, options);
                } catch (error) {
                    console.warn('[HWPX Exporter] Direct Mermaid rendering failed; retrying MarkdownRenderer:', error);
                }
            }
            if (!renderedByMermaidApi) {
                await render(prepareRenderSource(block, options), container, options.sourcePath, component);
            }
            if (abandoned) return;
            await tracker.waitForQuiet(250);
            if (abandoned) return;
            await waitForFonts();
            if (abandoned) return;
            await nextFrame();
            await nextFrame();
            if (abandoned) return;
            await decodeAllImages(container, options.captureTimeoutMs);
            if (abandoned) return;
            await tracker.waitForQuiet(250);
        })();
        let timer: number | undefined;
        let timedOut = false;
        let snapshot: Snapshot | null = null;
        const timeoutPromise = new Promise<void>((resolve, reject) => {
            timer = window.setTimeout(() => {
                timedOut = true;
                try {
                    // The snapshot must precede cleanup: unload() may remove the
                    // renderer's DOM before the source can be copied.
                    snapshot = snapshotSources(container, options);
                    resolve();
                } catch (error) {
                    reject(error instanceof Error ? error : new CaptureFailure(String(error)));
                }
            }, Math.max(1, options.captureTimeoutMs));
        });
        await Promise.race([operation.then(() => undefined), timeoutPromise]);
        if (timer) window.clearTimeout(timer);
        void operation.catch(() => undefined);

        if (!timedOut) {
            snapshot = snapshotSources(container, options);
        }
        if (!snapshot) throw new CaptureFailure('No renderable SVG/canvas/image found');
        abandoned = timedOut;
        tracker.disconnect();
        component.unload();
        container.remove();
        return await rasterizeSnapshot(snapshot, options, budget);
    } catch (error) {
        // A renderer can still settle after the timeout. Its late rejection is
        // intentionally detached from the export result after the synchronous
        // snapshot/cleanup boundary above.
        abandoned = true;
        tracker.disconnect();
        try { component.unload(); } catch { /* cleanup is best effort */ }
        container.remove();
        throw error;
    }
}

interface MermaidRenderResult {
    svg?: string;
}

interface MermaidApi {
    render?: (id: string, definition: string) => Promise<MermaidRenderResult | string> | MermaidRenderResult | string;
}

async function renderMermaidApi(
    block: RenderableBlock,
    container: HTMLElement,
    options: SvgCaptureOptions
): Promise<boolean> {
    if (typeof loadMermaid !== 'function') return false;
    const mermaid = await loadMermaid() as MermaidApi | null | undefined;
    if (!mermaid || typeof mermaid.render !== 'function') return false;

    const rendered = await mermaid.render(
        `hwpx-mermaid-${createNonce()}`,
        prepareMermaidSource(block, options)
    );
    const svgText = typeof rendered === 'string' ? rendered : rendered?.svg;
    if (!svgText?.trim()) throw new CaptureFailure('Mermaid API returned no SVG');

    // Parsed as HTML, like Mermaid's own insertion, in a detached document that runs no script.
    const svg = new DOMParser().parseFromString(svgText, 'text/html').body.querySelector('svg');
    if (!svg) throw new CaptureFailure('Mermaid API returned invalid SVG');
    container.appendChild(svg);
    return true;
}

async function captureStaticSvg(
    block: RenderableBlock,
    options: SvgCaptureOptions,
    budget: CaptureBudget
): Promise<CapturedAsset> {
    const asset = await options.resolveSvgAsset(block.source, options.sourcePath);
    if (!asset) throw new CaptureFailure(`SVG not found: ${block.source}`);
    const parsed = new DOMParser().parseFromString(
        new TextDecoder().decode(asset.bytes),
        'image/svg+xml'
    );
    if (parsed.querySelector('parsererror')) throw new CaptureFailure('Invalid SVG XML');
    const svg = parsed.documentElement as unknown as SVGElement;
    const size = measureSvg(svg, block.sizeHint);
    await sanitizeSvg(svg, asset.vaultPath, options, true);
    const image = await loadImage(svgToDataUri(svg));
    return rasterizeSource(image, size.width, size.height, 'svg', options, budget);
}

function pickRenderer(app: App): RenderFn | null {
    const renderer = MarkdownRenderer as unknown as {
        render?: (app: App, markdown: string, element: HTMLElement, sourcePath: string, component: Component) => Promise<void>;
        renderMarkdown?: (markdown: string, element: HTMLElement, sourcePath: string, component: Component) => Promise<void>;
    };
    if (typeof renderer.render === 'function') {
        return (markdown, element, sourcePath, component) =>
            renderer.render!(app, markdown, element, sourcePath, component);
    }
    if (typeof renderer.renderMarkdown === 'function') {
        return (markdown, element, sourcePath, component) =>
            renderer.renderMarkdown!(markdown, element, sourcePath, component);
    }
    return null;
}

function snapshotSources(container: HTMLElement, options: SvgCaptureOptions): Snapshot | null {
    const svg = container.querySelector('svg');
    if (svg) {
        const layers = collectLayerStack(svg);
        if (layers) return snapshotLayerStack(layers, options);
        const clone = cloneRenderedSvg(svg, options);
        const rect = svg.getBoundingClientRect();
        const size = measureSvg(svg, rect.width > 0 && rect.height > 0
            ? { widthPx: rect.width, heightPx: rect.height }
            : undefined);
        return { kind: 'svg', displayWidthPx: size.width, displayHeightPx: size.height, svgText: svgToDataUri(clone) };
    }

    const canvas = container.querySelector('canvas');
    if (canvas && canvas.width > 0 && canvas.height > 0) {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width > 0 ? rect.width : canvas.width;
        const height = rect.height > 0 ? rect.height : canvas.height;
        return { kind: 'canvas', displayWidthPx: width, displayHeightPx: height, source: copyCanvas(canvas) };
    }

    const image = container.querySelector('img');
    if (image && (image.complete ? image.naturalWidth > 0 : image.src.length > 0)) {
        const rect = image.getBoundingClientRect();
        return {
            kind: 'img',
            displayWidthPx: rect.width > 0 ? rect.width : image.naturalWidth,
            displayHeightPx: rect.height > 0 ? rect.height : image.naturalHeight,
            source: image.cloneNode(true) as HTMLImageElement,
        };
    }
    return null;
}

function cloneRenderedSvg(svg: SVGElement, options: SvgCaptureOptions): SVGElement {
    const clone = svg.cloneNode(true) as SVGElement;
    if (!options.allowForeignObject && clone.querySelector('foreignObject')) {
        throw new CaptureFailure('foreignObject is not allowed');
    }
    sanitizeRenderedSvg(clone, svg);
    return clone;
}

function copyCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
    const copy = createEl('canvas');
    const factor = Math.min(1, Math.sqrt(MAX_BLOCK_PIXELS / (canvas.width * canvas.height)));
    copy.width = Math.max(1, Math.floor(canvas.width * factor));
    copy.height = Math.max(1, Math.floor(canvas.height * factor));
    const ctx = copy.getContext('2d');
    if (!ctx) throw new CaptureFailure('2d context unavailable');
    ctx.drawImage(canvas, 0, 0, copy.width, copy.height);
    return copy;
}

type StackedLayer = { element: SVGElement | HTMLCanvasElement; box: LayerBox };

/**
 * Returns the layers stacked with the first SVG (its sibling SVGs and the
 * canvases in its sibling elements, see captureLayers.ts), or null when the
 * SVG stands alone. Sibling elements contribute only canvases, so SVG icons in
 * toolbars such as Plotly's modebar never join the stack.
 */
function collectLayerStack(svg: SVGElement): { layers: StackedLayer[]; bounds: LayerBox } | null {
    const parent = svg.parentElement;
    if (!parent) return null;
    const elements: (SVGElement | HTMLCanvasElement)[] = [];
    for (const child of Array.from(parent.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'svg' || tag === 'canvas') {
            elements.push(child as SVGElement | HTMLCanvasElement);
        } else {
            elements.push(...Array.from(child.querySelectorAll('canvas')));
        }
    }
    if (elements.length < 2) return null;
    const candidates: LayerCandidate[] = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible = style.display !== 'none'
            && Number.parseFloat(style.opacity || '1') > 0
            && (element.tagName.toLowerCase() !== 'canvas'
                || ((element as HTMLCanvasElement).width > 0 && (element as HTMLCanvasElement).height > 0));
        return {
            kind: element.tagName.toLowerCase() === 'canvas' ? 'canvas' : 'svg',
            visible,
            visibility: style.visibility,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
    });
    const stack = selectLayerStack(candidates, elements.indexOf(svg));
    if (stack.indices.length < 2) return null;
    return {
        layers: stack.indices.map((index) => ({ element: elements[index], box: candidates[index] })),
        bounds: stack.bounds,
    };
}

/**
 * Draws each layer at its on-screen offset into one SVG: SVG layers as nested
 * <svg> elements (vector, scaled by rasterScale like a single SVG) and canvas
 * layers as PNG <image> elements.
 */
function snapshotLayerStack(
    stack: { layers: StackedLayer[]; bounds: LayerBox },
    options: SvgCaptureOptions
): Snapshot {
    const { bounds } = stack;
    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('xmlns', SVG_NS);
    root.setAttribute('width', String(bounds.width));
    root.setAttribute('height', String(bounds.height));
    root.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    for (const { element, box } of stack.layers) {
        const placement: Record<string, string> = {
            x: String(box.left - bounds.left),
            y: String(box.top - bounds.top),
            width: String(box.width),
            height: String(box.height),
        };
        if (element.tagName.toLowerCase() === 'canvas') {
            const image = document.createElementNS(SVG_NS, 'image');
            let href: string;
            try {
                href = copyCanvas(element as HTMLCanvasElement).toDataURL('image/png');
            } catch (error) {
                throw new CaptureFailure(`Canvas layer is not readable: ${String(error)}`);
            }
            image.setAttribute('href', href);
            image.setAttribute('preserveAspectRatio', 'none');
            for (const [name, value] of Object.entries(placement)) image.setAttribute(name, value);
            root.appendChild(image);
            continue;
        }
        // A nested <svg> is not a CSS box, so a background colour set on the
        // layer (Plotly's paper_bgcolor) has to become a shape.
        const background = getComputedStyle(element).backgroundColor;
        if (!isTransparentColor(background)) {
            const rect = document.createElementNS(SVG_NS, 'rect');
            for (const [name, value] of Object.entries(placement)) rect.setAttribute(name, value);
            rect.setAttribute('fill', background);
            root.appendChild(rect);
        }
        const clone = cloneRenderedSvg(element as SVGElement, options);
        for (const [name, value] of Object.entries(placement)) clone.setAttribute(name, value);
        root.appendChild(clone);
    }
    return { kind: 'svg', displayWidthPx: bounds.width, displayHeightPx: bounds.height, svgText: svgToDataUri(root) };
}

async function rasterizeSnapshot(
    snapshot: Snapshot,
    options: SvgCaptureOptions,
    budget: CaptureBudget
): Promise<CapturedAsset> {
    let source = snapshot.source;
    if (snapshot.svgText) source = await loadImage(snapshot.svgText);
    if (!source) throw new CaptureFailure('Snapshot has no source');
    return rasterizeSource(
        source,
        snapshot.displayWidthPx,
        snapshot.displayHeightPx,
        snapshot.kind,
        options,
        budget
    );
}

async function rasterizeSource(
    source: CanvasImageSource,
    displayWidthPx: number,
    displayHeightPx: number,
    sourceKind: 'svg' | 'canvas' | 'img',
    options: SvgCaptureOptions,
    budget: CaptureBudget
): Promise<CapturedAsset> {
    if (!isPositiveFinite(displayWidthPx) || !isPositiveFinite(displayHeightPx)) {
        throw new CaptureFailure('Invalid display size');
    }
    const requestedScale = clamp(options.rasterScale, 1, 4);
    const requestedPixels = displayWidthPx * requestedScale * displayHeightPx * requestedScale;
    const fitScale = Math.min(requestedScale, Math.sqrt(MAX_BLOCK_PIXELS / requestedPixels) * requestedScale);
    if (!isPositiveFinite(fitScale) || fitScale < 1) throw new CaptureFailure('Pixel budget exceeded');
    const width = Math.max(1, Math.round(displayWidthPx * fitScale));
    const height = Math.max(1, Math.round(displayHeightPx * fitScale));
    const pixels = width * height;
    if (budget.pixels + pixels > TOTAL_PIXEL_BUDGET) throw new CaptureFailure('Total pixel budget exceeded');

    const canvas = createEl('canvas');
    try {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new CaptureFailure('2d context unavailable');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height);
        const inspection = inspectCanvas(context, width, height);
        if (!inspection.ok) throw new CaptureFailure(inspection.reason);
        let dataUri: string;
        try {
            dataUri = canvas.toDataURL('image/png');
        } catch (error) {
            throw new CaptureFailure(`toDataURL failed: ${String(error)}`);
        }
        const comma = dataUri.indexOf(',');
        if (comma < 0 || !/^data:image\/png;base64,/i.test(dataUri)) {
            throw new CaptureFailure('Invalid PNG data URI');
        }
        const bytes = Buffer.from(dataUri.slice(comma + 1), 'base64');
        const size = readImagePixelSize(bytes);
        if (!size || size.width !== width || size.height !== height) {
            throw new CaptureFailure('PNG dimensions do not match canvas');
        }
        if (budget.bytes + bytes.length > TOTAL_BYTE_BUDGET) {
            throw new CaptureFailure('Total byte budget exceeded');
        }
        budget.pixels += pixels;
        budget.bytes += bytes.length;
        return { bytes, ext: 'png', displayWidthPx, displayHeightPx, sourceKind };
    } finally {
        canvas.width = 0;
        canvas.height = 0;
        releaseSource(source);
    }
}

function inspectCanvas(
    context: CanvasRenderingContext2D,
    width: number,
    height: number
): { ok: true } | { ok: false; reason: string } {
    if (width < 8 || height < 8) return { ok: false, reason: 'Canvas is too small' };
    const threshold = Math.max(1, Math.ceil(Math.min(0.0002 * width * height, 64)));
    let count = 0;
    for (let y = 0; y < height; y += 512) {
        for (let x = 0; x < width; x += 512) {
            const tile = context.getImageData(x, y, Math.min(512, width - x), Math.min(512, height - y));
            for (let i = 0; i < tile.data.length; i += 4) {
                const alpha = tile.data[i + 3];
                if (alpha < 250) continue;
                if (tile.data[i] !== 255 || tile.data[i + 1] !== 255 || tile.data[i + 2] !== 255) {
                    count += 1;
                    if (count >= threshold) return { ok: true };
                }
            }
        }
    }
    return { ok: false, reason: count === 0 ? 'Canvas is blank' : 'Too few non-background pixels' };
}

async function sanitizeSvg(
    svg: SVGElement,
    basePath: string,
    options: SvgCaptureOptions,
    staticFile: boolean
): Promise<void> {
    if (!options.allowForeignObject && svg.querySelector('foreignObject')) {
        throw new CaptureFailure('foreignObject is not allowed');
    }
    for (const script of Array.from(svg.querySelectorAll('script'))) script.remove();
    for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
        for (const attribute of Array.from(element.attributes)) {
            if (/^on/i.test(attribute.name)) {
                element.removeAttribute(attribute.name);
                continue;
            }
            if (attribute.name === 'href' || attribute.name === 'xlink:href') {
                const value = await sanitizeReference(attribute.value, basePath, options, staticFile);
                if (value === null) element.removeAttribute(attribute.name);
                else element.setAttribute(attribute.name, value);
            } else if (attribute.name === 'style') {
                element.setAttribute('style', await sanitizeCssUrls(attribute.value, basePath, options, staticFile));
            } else if (/url\s*\(/i.test(attribute.value)) {
                // SVG presentation attributes such as fill, stroke, mask and
                // clip-path can carry CSS url() references too.
                element.setAttribute(
                    attribute.name,
                    await sanitizeCssUrls(attribute.value, basePath, options, staticFile)
                );
            }
        }
    }
    for (const style of Array.from(svg.querySelectorAll('style'))) {
        style.textContent = await sanitizeCssUrls(style.textContent ?? '', basePath, options, staticFile);
    }
}

function sanitizeRenderedSvg(svg: SVGElement, computedSource: SVGElement = svg): void {
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const elements = [svg, ...Array.from(svg.querySelectorAll('*'))];
    const sourceElements = [computedSource, ...Array.from(computedSource.querySelectorAll('*'))];
    for (const [index, element] of elements.entries()) {
        const computed = getComputedStyle(sourceElements[index] ?? element);
        for (const property of SVG_STYLE_PROPERTIES) {
            const value = computed.getPropertyValue(property);
            if (value) element.setAttribute(property, value);
        }
        for (const attribute of Array.from(element.attributes)) {
            if (/^on/i.test(attribute.name) || /^javascript:/i.test(attribute.value.trim())) {
                element.removeAttribute(attribute.name);
            } else if (attribute.name === 'href' || attribute.name === 'xlink:href') {
                const value = sanitizeRenderedReference(attribute.value);
                if (value === null) element.removeAttribute(attribute.name);
                else element.setAttribute(attribute.name, value);
            } else if (/url\s*\(/i.test(attribute.value)) {
                element.setAttribute(attribute.name, sanitizeRenderedCssUrls(attribute.value));
            }
        }
    }
    for (const style of Array.from(svg.querySelectorAll('style'))) {
        style.textContent = sanitizeRenderedCssUrls(style.textContent ?? '');
    }
    for (const script of Array.from(svg.querySelectorAll('script'))) script.remove();
}

function sanitizeRenderedReference(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.startsWith('#')) return trimmed;
    if (/^data:image\/(?:png|jpe?g|gif|webp)(?:;|,)/i.test(trimmed)) return trimmed;
    return null;
}

function sanitizeRenderedCssUrls(css: string): string {
    return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, value: string) => {
        const safe = sanitizeRenderedReference(value);
        return safe ? `url("${safe.replace(/"/g, '\\"')}")` : 'none';
    });
}

async function sanitizeReference(
    value: string,
    basePath: string,
    options: SvgCaptureOptions,
    staticFile: boolean
): Promise<string | null> {
    const trimmed = value.trim();
    if (trimmed.startsWith('#')) return trimmed;
    if (/^data:/i.test(trimmed)) {
        return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;|,)/i.test(trimmed) ? trimmed : null;
    }
    if (/^(?:https?:|file:|ftp:|blob:|app:|\/\/|javascript:)/i.test(trimmed)) return null;
    if (!staticFile) return null;
    const hash = trimmed.indexOf('#');
    const target = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
    const fragment = hash >= 0 ? trimmed.slice(hash) : '';
    if (!target) return fragment || null;
    const resolved = await options.resolveSvgAsset(target, basePath);
    if (!resolved) return null;
    const ext = resolved.vaultPath.split('.').pop()?.toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png';
    const encoded = Buffer.from(resolved.bytes).toString('base64');
    return `data:${mime};base64,${encoded}${fragment}`;
}

async function sanitizeCssUrls(
    css: string,
    basePath: string,
    options: SvgCaptureOptions,
    staticFile: boolean
): Promise<string> {
    const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let result = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(css))) {
        result += css.slice(cursor, match.index);
        const value = await sanitizeReference(match[2], basePath, options, staticFile);
        result += value ? `url("${value.replace(/"/g, '\\"')}")` : 'none';
        cursor = match.index + match[0].length;
    }
    return result + css.slice(cursor);
}

function measureSvg(svg: SVGElement, hint?: { widthPx: number; heightPx?: number }): { width: number; height: number } {
    const width = parseSvgLength(svg.getAttribute('width'));
    const height = parseSvgLength(svg.getAttribute('height'));
    const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const viewWidth = viewBox.length === 4 && isPositiveFinite(viewBox[2]) ? viewBox[2] : undefined;
    const viewHeight = viewBox.length === 4 && isPositiveFinite(viewBox[3]) ? viewBox[3] : undefined;
    const baseWidth = width ?? viewWidth ?? 300;
    const baseHeight = height ?? viewHeight ?? 150;
    if (!hint) return { width: baseWidth, height: baseHeight };
    return {
        width: hint.widthPx,
        height: hint.heightPx ?? hint.widthPx * (baseHeight / baseWidth),
    };
}

function parseSvgLength(value: string | null): number | undefined {
    if (!value || /%$/.test(value.trim())) return undefined;
    const parsed = Number.parseFloat(value);
    return isPositiveFinite(parsed) ? parsed : undefined;
}

function svgToDataUri(svg: SVGElement): string {
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

function loadImage(source: string): Promise<HTMLImageElement> {
    const image = createEl('img');
    return new Promise((resolve, reject) => {
        const fail = () => reject(new CaptureFailure('Image decode failed'));
        image.addEventListener('error', fail, { once: true });
        image.addEventListener('load', () => resolve(image), { once: true });
        image.src = source;
        if (image.complete && image.naturalWidth > 0) resolve(image);
    });
}

async function decodeAllImages(container: HTMLElement, timeoutMs: number): Promise<void> {
    const images = Array.from(container.querySelectorAll('img'));
    await Promise.all(images.map(async (image) => {
        if (typeof image.decode === 'function') {
            await Promise.race([image.decode(), delay(timeoutMs)]);
            return;
        }
        if (image.complete && image.naturalWidth > 0) return;
        await new Promise<void>((resolve, reject) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => reject(new CaptureFailure('Image load failed')), { once: true });
        });
    }));
}

async function waitForFonts(): Promise<void> {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) await fonts.ready;
}

function nextFrame(): Promise<void> {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

class MutationTracker {
    private observer: MutationObserver | null = null;
    private version = 0;

    constructor(private readonly element: HTMLElement) {}

    observe(): void {
        this.observer = new MutationObserver(() => { this.version += 1; });
        this.observer.observe(this.element, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });
    }

    disconnect(): void {
        this.observer?.disconnect();
        this.observer = null;
    }

    async waitForQuiet(quietMs: number): Promise<void> {
        let observed = this.version;
        while (true) {
            await delay(quietMs);
            if (observed === this.version) return;
            observed = this.version;
        }
    }
}

function releaseSource(source: CanvasImageSource): void {
    if (source instanceof HTMLImageElement) source.removeAttribute('src');
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function installBodyThemeGuard(): { restore(): void } {
    const body = document.body;
    const snapshot = body.className;
    const applied = snapshot
        .replace(/\btheme-dark\b/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .concat('theme-light')
        .join(' ');
    let externalChange = false;
    let expectedInitialMutation = true;
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (expectedInitialMutation && record.oldValue === snapshot) {
                expectedInitialMutation = false;
            } else {
                externalChange = true;
            }
        }
    });
    observer.observe(body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    body.className = applied;
    return {
        restore: () => {
            for (const record of observer.takeRecords()) {
                if (expectedInitialMutation && record.oldValue === snapshot) expectedInitialMutation = false;
                else externalChange = true;
            }
            observer.disconnect();
            if (!externalChange && body.className === applied) body.className = snapshot;
        },
    };
}

function isPositiveFinite(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function createNonce(): string {
    const cryptoObject = window.crypto;
    if (cryptoObject?.getRandomValues) {
        const values = new Uint32Array(2);
        cryptoObject.getRandomValues(values);
        return `${values[0].toString(16).padStart(8, '0')}${values[1].toString(16).padStart(8, '0')}`;
    }
    return `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutexTail;
    let release!: () => void;
    mutexTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
}

class CaptureFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CaptureFailure';
    }
}
