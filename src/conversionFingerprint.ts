import JSZip from 'jszip';
import { checkZipDirectoryIdentity } from './hwpx/zipConsistency';
import { verifyEmptyDirectory, verifyInflatedBudget } from './hwpx/zipBudget';
import { byteDigest, canonicalDigest } from './template-derive/digest';

/** Fingerprint a package just rendered by this process, independent of ZIP timestamps. */
export async function conversionFingerprint(output: Uint8Array, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    for (const directory of checkZipDirectoryIdentity(output)) await verifyEmptyDirectory(directory, signal);
    const zip = await JSZip.loadAsync(output);
    await verifyInflatedBudget(zip, undefined, signal);
    const paths = Object.keys(zip.files).filter(path => !zip.files[path].dir).sort();
    const members: Array<{ path: string; sha256: string }> = [];
    for (const path of paths) {
        signal?.throwIfAborted();
        const entry = zip.files[path];
        if (entry.unsafeOriginalName && entry.unsafeOriginalName !== path) throw new Error('Unsafe rendered package path.');
        members.push({ path, sha256: byteDigest(await entry.async('uint8array')) });
    }
    signal?.throwIfAborted();
    return canonicalDigest({ schema: 'hwpx-conversion/1', members });
}
