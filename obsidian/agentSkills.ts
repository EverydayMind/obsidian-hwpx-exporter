import type { AssetsDescriptor, ReadAssetResult } from '../contracts/agentinterop/host-capabilities-v1/protocol';
import generated from './agent-assets.generated.json';

/** Host-only members (host-capabilities-v1). They are not model tools and never touch the descriptor. */
const bodies: Readonly<Record<string, string>> = generated.bodies;

export function describeAgentAssets(): AssetsDescriptor {
    return JSON.parse(JSON.stringify(generated.assets)) as AssetsDescriptor;
}

export function readAgentAsset(request: unknown): ReadAssetResult {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid asset request');
    const keys = Object.keys(request).sort();
    if (keys.join(',') !== 'id,kind,locale') throw new Error('Invalid asset request');
    const { kind, id, locale } = request as Record<string, unknown>;
    if (kind !== 'skill' || typeof id !== 'string' || (locale !== 'ko' && locale !== 'en')) throw new Error('Unknown asset');
    const key = `${id}/${locale}`;
    if (!Object.prototype.hasOwnProperty.call(bodies, key)) throw new Error('Unknown asset');
    return { body: bodies[key] };
}

export const HOST_ADVERTISEMENT = Symbol.for('dev.agentinterop.host');
export type HostSkillSupport = 'supported' | 'not_found' | 'unknown';

/** Status line only: feature-detects the host advertisement without running any host code. */
export function hostSkillSupport(app: unknown): HostSkillSupport {
    const plugins = (app as { plugins?: { plugins?: unknown } })?.plugins?.plugins;
    if (!plugins || typeof plugins !== 'object') return 'unknown';
    for (const instance of Object.values(plugins as Record<string, unknown>)) {
        if (!instance || typeof instance !== 'object') continue;
        const d = Object.getOwnPropertyDescriptor(instance, HOST_ADVERTISEMENT);
        if (!d || !('value' in d)) continue;
        const ad = d.value as { protocol?: unknown; contracts?: unknown };
        if (ad?.protocol === 'agentinterop' && Array.isArray(ad.contracts) && ad.contracts.includes('host-capabilities-v1')) return 'supported';
    }
    return 'not_found';
}

/** Names of the shipped Skills in one UI language; empty when none exist in it. */
export function agentSkillNames(locale: 'ko' | 'en'): string[] {
    return generated.assets.skills.filter((skill) => skill.locale === locale).map((skill) => skill.frontmatter.name);
}
