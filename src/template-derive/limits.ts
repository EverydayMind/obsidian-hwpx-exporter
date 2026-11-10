export const LIMITS = { input: 32 * 1024 * 1024, inflated: 64 * 1024 * 1024, stream: 8 * 1024 * 1024, entries: 4096, depth: 64, nodes: 200000, paragraphs: 10000, runs: 50000, tables: 1000, cells: 50000, styles: 4096, snapshot: 4 * 1024 * 1024, deadline: 30000 } as const;
export type FailureCode = 'prefix_mismatch' | 'not_found' | 'unsupported' | 'encrypted' | 'drm' | 'corrupted' | 'too_large' | 'bomb' | 'source_changed' | 'cancelled' | 'timeout' | 'busy' | 'extractor_unavailable';
export class StyleError extends Error { constructor(readonly code: FailureCode, message: string, readonly refs: string[] = []) { super(message); this.name = 'StyleError'; } }
export class Guard {
  private deadline = Date.now() + LIMITS.deadline;
  private lastYield = Date.now();
  private steps = 0;
  private xmlNodes = 0;
  constructor(private signal?: AbortSignal) {}
  check() { if (this.signal?.aborted) throw new StyleError('cancelled', 'Style measurement cancelled.'); if (Date.now() > this.deadline) throw new StyleError('timeout', 'Style measurement deadline exceeded.'); }
  async tick() { this.check(); if (++this.steps % 256 === 0 || Date.now() - this.lastYield >= 16) { await new Promise<void>(resolve => (typeof window === 'undefined' ? setImmediate(resolve) : window.setTimeout(resolve, 0))); this.lastYield = Date.now(); this.check(); } }
  xmlNode(depth: number) { if (++this.xmlNodes > LIMITS.nodes || depth > LIMITS.depth) throw new StyleError('too_large', 'XML depth/node limit.'); }
}
