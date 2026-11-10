import type JSZip from 'jszip';
import { createInflateRaw } from 'node:zlib';

/** Bound actual inflation, including parts that the editor does not parse but
 * JSZip may re-compress during a later save. Header sizes are not trusted. */
export const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

export class ZipBudgetError extends Error {}

/** Directories must inflate to nothing and consume the full declared stream. */
export async function verifyEmptyDirectory(compressed: Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const inflater = createInflateRaw({ chunkSize: 64 });
  const abort = () => inflater.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    inflater.end(compressed);
    for await (const chunk of inflater) {
      signal?.throwIfAborted();
      if ((chunk as Uint8Array).byteLength) throw new Error('invalid ZIP directory data');
    }
    signal?.throwIfAborted();
    if (inflater.bytesWritten !== compressed.length) throw new Error('invalid ZIP directory data');
  } catch {
    signal?.throwIfAborted();
    throw new Error('invalid ZIP directory data');
  } finally {
    signal?.removeEventListener('abort', abort);
    inflater.destroy();
  }
}

export async function verifyInflatedBudget(zip: JSZip, limit = MAX_INFLATED_BYTES, signal?: AbortSignal): Promise<void> {
  const files: JSZip.JSZipObject[] = [];
  zip.forEach((_path, file) => { if (!file.dir) files.push(file); });
  let total = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    // A declared size is only an early upper bound, never an allocation budget.
    const declared = (file as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
    const knownSize = typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0 ? declared : undefined;
    let partBytes = 0;
    const data = (file as unknown as { _data?: { compressedContent?: unknown; compression?: { magic?: unknown } } })._data;
    if (knownSize !== undefined && knownSize > limit - total) throw new ZipBudgetError('워크북의 압축 해제 크기가 너무 큽니다.');
    if (data?.compressedContent instanceof Uint8Array && data.compression?.magic === '\x08\x00') {
      if (knownSize === undefined) throw new Error('Invalid ZIP entry size');
      const inflater = createInflateRaw();
      const abort = () => inflater.destroy();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        inflater.end(data.compressedContent);
        for await (const chunk of inflater) {
          signal?.throwIfAborted();
          const length = (chunk as Uint8Array).byteLength;
          total += length; partBytes += length;
          if (total > limit) throw new ZipBudgetError('워크북의 압축 해제 크기가 너무 큽니다.');
          if (partBytes > knownSize) throw new Error('ZIP entry size mismatch');
        }
        signal?.throwIfAborted();
        if (partBytes !== knownSize) throw new Error('ZIP entry size mismatch');
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        inflater.destroy();
      }
      continue;
    }
    type ByteStream = {
      on(event: 'data', callback: (chunk: Uint8Array) => void): ByteStream;
      on(event: 'end', callback: () => void): ByteStream;
      on(event: 'error', callback: (error: Error) => void): ByteStream;
      pause(): ByteStream;
      resume(): ByteStream;
    };
    const stream = (file as JSZip.JSZipObject & { internalStream(type: 'uint8array'): ByteStream }).internalStream('uint8array');
    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      stream.on('data', chunk => {
        if (stopped) return;
        if (signal?.aborted) {
          stopped = true;
          stream.pause();
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagate the caller's abort reason unchanged
          reject(signal.reason);
          return;
        }
        total += chunk.byteLength;
        partBytes += chunk.byteLength;
        if (total > limit) {
          stopped = true;
          stream.pause();
          reject(new ZipBudgetError('워크북의 압축 해제 크기가 너무 큽니다.'));
        } else if (knownSize !== undefined && partBytes > knownSize) {
          stopped = true;
          stream.pause();
          reject(new Error('ZIP entry size mismatch'));
        }
      }).on('error', error => { if (!stopped) { stopped = true; reject(error); } })
        .on('end', () => { if (!stopped) { stopped = true; resolve(); } })
        .resume();
    });
  }
  signal?.throwIfAborted();
}
