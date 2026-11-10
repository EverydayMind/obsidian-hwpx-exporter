import type { ObservedBlock, ObservedBlockIndex } from '../src/observedBlockIndex';
import { canonicalDigest } from '../src/template-derive/digest';
import { preflightIdentity } from './preflightIdentity';
import type { InputDependency } from './deriveProvider';

/** Provisional host-read contract, not the finished E3 schema. */
const LEGACY_VERSION = 'observed-block-page/0.3';
const SCRIPT_VERSION = 'observed-block-page/0.4';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_NODES = 20000;

function measure(value: unknown): { bytes: number; nodes: number } {
    const stack: unknown[] = [value];
    let nodes = 0;
    while (stack.length) {
        const item = stack.pop();
        if (++nodes > MAX_PAGE_NODES) return { bytes: MAX_PAGE_BYTES + 1, nodes };
        if (item && typeof item === 'object') stack.push(...Object.values(item as Record<string, unknown>));
    }
    return { bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'), nodes };
}

export function observedBlockPage(input: {
    pluginId: string; pluginVersion: string; notePath: string; noteSha256: string;
    templatePath: string; templateSha256: string; artifactId: string | null;
    configDigest: string; inputDependencies: InputDependency[] | null;
    index: ObservedBlockIndex; offset: number; limit: number; expectedDigest?: string; version?: typeof SCRIPT_VERSION;
}) {
    const VERSION = input.version ?? LEGACY_VERSION;
    const identity = preflightIdentity(input);
    if (!identity.usedInputs || !identity.conversionFingerprint || !identity.conversionFingerprint.artifactId)
        return { version: VERSION, state: 'unavailable' as const, reason: 'unbound_identity' as const, blocks: [] };
    const conversionIdentity = { ...identity.conversionFingerprint, blockContractVersion: VERSION };
    const inputDependencies = input.inputDependencies!.map(({ path, sha256 }) => ({ path, sha256 }));
    const inputsDigest = canonicalDigest({ version: VERSION, inputDependencies, conversionIdentity });
    if (input.expectedDigest && input.expectedDigest !== inputsDigest)
        return { version: VERSION, state: 'input_changed' as const, inputsDigest, blocks: [] };
    if (input.index.state !== 'complete_for_supported_input')
        return { version: VERSION, state: 'unavailable' as const, reason: input.index.reason,
            inputsDigest, conversionIdentity, inputDependencies, blocks: [] };

    const blocks: ObservedBlock[] = [];
    let bytes = 0, nodes = 0;
    for (const original of input.index.blocks.slice(input.offset, input.offset + input.limit)) {
        // Older hosts reject extra fields; keep their previous result shape.
        const block = VERSION === LEGACY_VERSION
            ? JSON.parse(JSON.stringify(original), (key: string, value: unknown) => key === 'scripts' ? undefined : value) as ObservedBlock
            : original;
        const size = measure(block);
        if (bytes + size.bytes > MAX_PAGE_BYTES || nodes + size.nodes > MAX_PAGE_NODES) break;
        blocks.push(block);
        bytes += size.bytes;
        nodes += size.nodes;
    }
    if (!blocks.length && input.offset < input.index.blocks.length)
        return { version: VERSION, state: 'unavailable' as const, reason: 'block_too_large' as const,
            inputsDigest, conversionIdentity, inputDependencies, blocks: [] };
    const next = input.offset + blocks.length;
    return { version: VERSION, state: 'available' as const, coverage: input.index.coverage,
        inputsDigest, conversionIdentity, inputDependencies,
        totalBlocks: input.index.blocks.length, offset: input.offset,
        nextOffset: next < input.index.blocks.length ? next : null, blocks };
}
