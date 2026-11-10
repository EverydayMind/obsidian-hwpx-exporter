/** Run-level observation kept separate from immutable v1 character styles. */
export type ScriptState = 'normal' | 'superscript' | 'subscript' | 'unknown'
export type ScriptRuns = Map<string, ScriptState[]>

/** Each script span must lie entirely in contiguous runs with the same state. */
export function scriptSpanBound(
  runs: readonly { start: number; length: number }[],
  states: readonly ScriptState[],
  span: { start: number; length: number; shape: string },
): boolean {
  if (states.length !== runs.length) return false
  let cursor = span.start
  const end = span.start + span.length
  for (let index = 0; index < runs.length && cursor < end; index++) {
    const run = runs[index],
      runEnd = run.start + run.length
    if (runEnd <= cursor) continue
    if (run.start > cursor || states[index] !== span.shape) return false
    cursor = Math.min(end, runEnd)
  }
  return cursor === end
}
