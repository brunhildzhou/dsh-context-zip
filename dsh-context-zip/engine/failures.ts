/**
 * The failure classes one compaction attempt can land in.
 *
 * It lives in the engine package, with no imports at all, because **all three
 * halves have to agree on the classification**:
 *
 * - the engine, which counts consecutive failed summarization attempts;
 * - the host half (the plugin package), which writes the failure line for the
 *   slash command and for the two routes;
 * - the browser half (the client bundle), which renders that line in the panel.
 *
 * This package is the only one both halves can already reach: the client bundle
 * cannot require `dsh-context-zip-engine` (that specifier is not in the client
 * loader's module table) but it can bundle a relative `.ts` file, and the host
 * package already depends on this package by name. The module stays
 * dependency-free on purpose.
 *
 * @module dsh-context-zip-engine/failures
 */

/**
 * Whether one compaction failure is the "the span is too small to replace" class.
 *
 * **Why this class has to be told apart** (2026.09.19, D3): the shipped backend
 * compares the framed checkpoint's estimate against the estimate of the span it
 * would replace and throws
 * `summary is not smaller than the shadowed content (655 >= 357)` when the
 * summary is not smaller. The model call itself **succeeded**, so the plugin's
 * consecutive-failure bookkeeping was cleared on the way out of `summarize()`
 * and stays at 0 no matter how many times a human presses Compact now.
 *
 * That is not a missing count, it is a class that must not be counted: the
 * mechanical fallback is a ledger assembled from the events, longer than any
 * model summary, so it could only make this size comparison worse. Waiting for
 * `fallbackAfterFailures` to reach this branch waits forever, which is exactly
 * what the panel showed after seven attempts.
 *
 * Recognized by message, in two shapes, because the two entrances carry
 * different layers of the same error:
 *
 * 1. the engine half of the chain throws
 *    `summary is not smaller than the shadowed content (…)`;
 * 2. the manual path wraps the whole attempt in a `ManualCompactionError` whose
 *    `message` is `manual compaction could not produce a smaller summary`, with
 *    the sentence above as `cause` — and the browser route carries only the
 *    outer message, so both spellings have to be recognized.
 *
 * @param error - anything thrown, possibly wrapping its real cause.
 * @returns true for the range-too-small class.
 */
export function isRangeTooSmallFailure(error) {
  const seen = new Set();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const message = String(current?.message ?? current);
    if (message.includes('not smaller than the shadowed content')) return true;
    if (message.includes('could not produce a smaller summary')) return true;
    current = current?.cause;
  }
  return false;
}

export default { isRangeTooSmallFailure };
