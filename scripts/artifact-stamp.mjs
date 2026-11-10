import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const ARTIFACT_PLACEHOLDER = '__HWPX_EXPORTER_ARTIFACT_PENDING__';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The ID hashes the exact bundle before its single placeholder is replaced. */
export function stampArtifact(bundlePath, metadataPath) {
    const unstamped = readFileSync(bundlePath, 'utf8');
    if (unstamped.split(ARTIFACT_PLACEHOLDER).length !== 2)
        throw new Error('Expected exactly one exporter artifact placeholder.');
    const artifactId = hash(unstamped);
    const stamped = unstamped.replace(ARTIFACT_PLACEHOLDER, artifactId);
    writeFileSync(bundlePath, stamped);
    const metadata = { algorithm: 'sha256-unstamped-bundle/1', artifactId, finalSha256: hash(stamped) };
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
}

export function verifyArtifact(bundlePath, metadataPath) {
    const stamped = readFileSync(bundlePath, 'utf8');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (metadata.algorithm !== 'sha256-unstamped-bundle/1' || !/^[a-f0-9]{64}$/.test(metadata.artifactId) ||
        stamped.split(metadata.artifactId).length !== 2 || hash(stamped) !== metadata.finalSha256 ||
        hash(stamped.replace(metadata.artifactId, ARTIFACT_PLACEHOLDER)) !== metadata.artifactId)
        throw new Error('Exporter artifact stamp verification failed.');
    return metadata;
}
