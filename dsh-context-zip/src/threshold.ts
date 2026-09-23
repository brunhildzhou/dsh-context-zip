/**
 * The one edit this plugin makes to the backend it wraps.
 *
 * `@deepseek-ai/dsh-compaction-basic` 0.1.7 added a second cap to the pressure
 * threshold:
 *
 *     Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))
 *
 * `pressureBudgetTokens` is the window minus the routed output reservation minus
 * `headroomTokens`. On a 400k window whose request header reserves 128k of
 * output and with the default 65,536 headroom, that second term is 206,464 — a
 * little over half the window — so `thresholdRatio: 0.8` stops deciding anything
 * and compaction fires far earlier than the configured ratio says. Every release
 * up to and including 0.1.6-alpha.2 used the ratio alone, and that is the form
 * this plugin writes back.
 *
 * The rewrite is one anchored string replacement, never a re-implementation: the
 * copied backend stays the shipped file except for that single expression. When
 * the expression is not there in the exact form this module knows, nothing is
 * guessed — `planThreshold` throws unless the caller asked for the stock backend
 * on purpose.
 *
 * Both wiring paths go through here: `install.mjs` on the command line and
 * `wireCompactionRow` behind the settings panel's button. Two copies of this
 * decision would drift, and the panel would quietly install an unpatched backend.
 *
 * @module dsh-context-zip/threshold
 */

/** The 0.1.7 form, verbatim as it appears in the shipped `lib/index.js`. */
export const THRESHOLD_MIN_FORM =
  'Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))';

/** The form 0.1.5 through 0.1.6-alpha.2 shipped, and the form this plugin writes. */
export const THRESHOLD_RATIO_FORM = 'Math.floor(contextWindow * policy.thresholdRatio)';

/** What was written into the redirect's `base.js`, recorded in its stamp. */
export type PatchState = 'ratio-only' | 'not-needed' | 'none';

/** What a written `base.js` actually contains, read back from the bytes. */
export type ObservedState = 'ratio-only' | 'stock' | 'unknown';

/** The decision for one backend source, plus the exact bytes to write. */
export interface ThresholdPlan {
  /** What the stamp records. */
  state: PatchState;
  /** The bytes for the redirect's `base.js`. */
  text: string;
  /** One line for the installer's output. */
  reason: string;
}

/** Occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Read back what a `base.js` carries.
 *
 * `ratio-only` and `stock` are the two forms this plugin recognises; anything
 * else — both forms, neither, or either one more than once — is `unknown`, and
 * `unknown` is never treated as good news.
 *
 * @param text - the file's contents.
 * @returns which threshold form the bytes carry.
 */
export function inspectThreshold(text: string): ObservedState {
  const min = count(text, THRESHOLD_MIN_FORM);
  const ratio = count(text, THRESHOLD_RATIO_FORM);
  if (min === 0 && ratio === 1) return 'ratio-only';
  if (min === 1 && ratio === 0) return 'stock';
  return 'unknown';
}

/**
 * Decide what to write as the redirect's `base.js`.
 *
 * Three outcomes, and the third one is why this is a function instead of an
 * inline replace: a backend that carries neither form (or an ambiguous mix) is
 * refused, so a future release that renames or restructures the expression stops
 * the wiring loudly instead of silently installing a backend nobody checked.
 *
 * @param source - the shipped backend entry, decoded as UTF-8.
 * @param options - `allowStock` wires the backend unpatched on purpose.
 * @returns the state to stamp, the bytes to write, and a line explaining it.
 * @throws when the backend carries neither recognised form and `allowStock` is
 *   not set.
 */
export function planThreshold(source: string, options: { allowStock?: boolean } = {}): ThresholdPlan {
  const observed = inspectThreshold(source);
  if (observed === 'stock') {
    return {
      state: 'ratio-only',
      text: source.replace(THRESHOLD_MIN_FORM, THRESHOLD_RATIO_FORM),
      reason: 'second cap removed: the threshold is the ratio alone, as 0.1.5 through 0.1.6-alpha.2 had it',
    };
  }
  if (observed === 'ratio-only') {
    return {
      state: 'not-needed',
      text: source,
      reason: 'this backend already caps by the ratio alone; nothing to change',
    };
  }
  if (options.allowStock === true) {
    return {
      state: 'none',
      text: source,
      reason: 'backend wired unpatched (--stock-backend)',
    };
  }
  throw new Error(
    'the shipped backend does not carry the threshold expression this plugin patches ' +
      `(0.1.7 form ×${count(source, THRESHOLD_MIN_FORM)}, ratio-only form ×${count(source, THRESHOLD_RATIO_FORM)}): ` +
      'refusing to wire a redirect whose backend cannot be verified. Re-run install.mjs with ' +
      '--stock-backend to wire it unpatched, then update this plugin.',
  );
}

/**
 * Whether a written `base.js` is exactly what the plan asked for.
 *
 * Checked after the write rather than assumed: the file is what the harness
 * loads, so the stamp must not claim a state the bytes do not have.
 *
 * @param text - the file as read back.
 * @param plan - the plan that produced it.
 * @returns true when the bytes are the planned ones and carry the planned form.
 */
export function thresholdWriteMatches(text: string, plan: ThresholdPlan): boolean {
  if (text !== plan.text) return false;
  return plan.state === 'none' || inspectThreshold(text) === 'ratio-only';
}

/**
 * Whether a wired redirect drifted away from the state its stamp records.
 *
 * A stamp of `none` is the explicit stock fallback: whatever the backend looks
 * like there is what was asked for, so it never counts as drift.
 *
 * @param stamped - the stamp's `patch` value, unvalidated.
 * @param text - the redirect's `base.js` as read now.
 * @returns true when the stamp promises the ratio-only form and the file lacks it.
 */
export function thresholdDrift(stamped: unknown, text: string): boolean {
  const observed = inspectThreshold(text);
  if (stamped === 'ratio-only' || stamped === 'not-needed') return observed !== 'ratio-only';
  if (stamped === 'none') return false;
  // Unrecorded: a redirect written before this plugin patched anything. The stock
  // form is the state this version exists to replace, so it counts as drift; the
  // ratio-only form is already what would be written.
  return observed === 'stock';
}
