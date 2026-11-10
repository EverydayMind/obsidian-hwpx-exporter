import { canonicalDigest } from '../src/template-derive/digest';
import type { InputDependency } from './deriveProvider';

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const vaultPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !value.includes('\\') && !value.split('/').some(part => !part || part.startsWith('.')) && !/^[A-Za-z]:/.test(value);

/** Bounded facts from the actual uncaptured conversion; old hosts return null. */
export function preflightIdentity(input: {
    pluginId: string; pluginVersion: string; notePath: string; noteSha256?: string;
    templatePath: string; templateSha256: string | null;
    artifactId?: string | null; configDigest?: string; inputDependencies?: InputDependency[] | null;
}) {
    const fingerprint = hash(input.configDigest) && (input.artifactId == null || hash(input.artifactId))
        ? { pluginId: input.pluginId, pluginVersion: input.pluginVersion, artifactId: input.artifactId ?? null,
            configDigest: input.configDigest, captureMode: 'none' as const }
        : null;
    const deps = input.inputDependencies;
    const complete = Array.isArray(deps) && deps.length >= 2 && deps.length <= 32 &&
        deps.every(item => item && vaultPath(item.path) && hash(item.sha256)) &&
        new Set(deps.map(item => item.path)).size === deps.length &&
        deps[0].path === input.notePath && deps[0].sha256 === input.noteSha256 &&
        deps[1].path === input.templatePath && deps[1].sha256 === input.templateSha256;
    const usedInputs = complete
        ? { algorithm: 'sha256-canonical-json/1' as const, sha256: canonicalDigest(deps.map(item => ({ path: item.path, sha256: item.sha256 }))), count: deps.length }
        : null;
    return { conversionFingerprint: fingerprint, usedInputs };
}
