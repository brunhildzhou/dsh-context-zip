/**
 * The manual compaction entry: one human-triggered compaction on demand.
 *
 * Two things make this more than a thin wrapper over `ctx.compaction.compactNow`:
 *
 * - **The count is measured, not guessed.** A manual compaction is destructive
 *   enough that the confirmation has to say what it will replace, and the number
 *   has to be the one the backend will really use. Reproducing the backend's own
 *   range selection over the same public inputs — the session surface, the token
 *   meter's measurement, and `toolPairingBalancedBefore` — is what keeps the
 *   confirmation and the execution in agreement. {@link selectManualRange} is a
 *   deliberate port of `selectCompactableRange` in
 *   `@deepseek-ai/dsh-compaction-basic`; that function is module-private, so it
 *   cannot be called and must be mirrored. A drift between the two shows up as a
 *   confirmation that names a different number than the result reports, which is
 *   why both numbers travel back to the caller.
 * - **The failure text carries the retry decision.** `failureStreaks` in the
 *   engine counts consecutive failed summarization attempts per session, and the
 *   mechanical fallback fires once that count passes `fallbackAfterFailures`. A
 *   bare "compaction failed" leaves the reader unable to tell "retry now" from
 *   "the fallback is about to take over", so the count and the threshold are part
 *   of every failure message.
 *
 * @module dsh-context-zip/manual
 */

import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';

import { failureCount, isRangeTooSmallFailure } from 'dsh-context-zip-engine';

/** Why a manual compaction could not even be planned. */
export type ManualTargetCode = 'session-not-live' | 'no-live-session' | 'session-required';

/** A planning failure the caller reports verbatim rather than as a crash. */
export class ManualTargetError extends Error {
  /** Stable reason code, so the browser half can localize it. */
  readonly code: ManualTargetCode;

  /**
   * @param code - stable reason code.
   * @param message - human-readable diagnostic.
   */
  constructor(code: ManualTargetCode, message: string) {
    super(message);
    this.name = 'ManualTargetError';
    this.code = code;
  }
}

/** One measured manual-compaction plan: what a confirmation must state. */
type ManualPlan = {
  /** Session the compaction would run on. */
  sessionId: string;
  /** Surface nodes the backend would replace, counted on the live surface. */
  events: number;
  /** Fixed-heuristic tokens those nodes carry; the figure the result reports. */
  tokens: number;
  /** Route-priced tokens of the same nodes, for the pressure comparison. */
  routeTokens: number;
  /** First surface seq of the span, or null when nothing is compactable. */
  start: number | null;
  /** Last surface seq of the span, or null when nothing is compactable. */
  end: number | null;
};

/** What a completed manual compaction reports back. */
type ManualOutcome = {
  /** Session that was compacted. */
  sessionId: string;
  /** Surface nodes the backend actually replaced. */
  events: number;
  /** Their fixed-heuristic token count. */
  tokens: number;
  /** Seq of the replacement summary event, when the backend reported one. */
  summarySeq: number | null;
};

/** The consecutive-failure bookkeeping a retry decision needs. */
type ManualFailureState = {
  /** Consecutive failed attempts recorded for this session. */
  failures: number;
  /** Attempt count after which the mechanical fallback takes over. */
  fallbackAfter: number;
  /** Whether the mechanical fallback is switched on. */
  fallbackEnabled: boolean;
};

/**
 * Reproduce the shipped backend's own manual range selection.
 *
 * `compactNow` calls the module-private `selectCompactableRange(session,
 * tokenMeter.measure(session), 0)`. The port is line-for-line on purpose: the
 * confirmation is a promise about what will be replaced, and any divergence here
 * would make that promise wrong in exactly the case where it matters.
 *
 * `retainTokens` stays a parameter rather than a constant because the automatic
 * path passes the configured retained tail; the manual path passes 0, which
 * keeps the whole compactable surface except the cut itself.
 *
 * @param session - session whose live surface is being planned against.
 * @param measurement - `ctx.tokenMeter.measure(session)`, the same call the engine makes.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the inclusive positional index range, or null when nothing is safe to compact.
 */
export function selectManualRange(session, measurement, retainTokens = 0) {
  const pricedNodes = measurement?.nodes ?? [];
  if (pricedNodes.length === 0) return null;
  const surfaceNodes = session.surface.nodes;
  if (
    surfaceNodes.length !== pricedNodes.length ||
    surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)
  ) {
    throw new Error('compaction: token-meter surface does not match the current session surface');
  }
  // A `system/message` at surface node 0 is never inside the range; without one
  // the range starts at node 0.
  const head = surfaceNodes[0] === undefined ? undefined : session.eventAt(surfaceNodes[0]);
  const firstIdx = head?.type === 'system/message' ? 1 : 0;
  let accumulated = 0;
  let keepFromIdx = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;
  // Walk back until the cut does not split a tool-call/result pair: the backend
  // does the same before it will price the span.
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;
  return { startIdx: firstIdx, endIdx: keepFromIdx - 1 };
}

/**
 * Measure what a manual compaction of one session would replace.
 *
 * @param sessionId - session the plan names.
 * @param session - that session, as the engine would see it.
 * @param measurement - `ctx.tokenMeter.measure(session)`.
 * @returns the counts a confirmation shows; every count is 0 when nothing is compactable.
 */
export function planManualCompaction(sessionId: string, session, measurement): ManualPlan {
  const range = selectManualRange(session, measurement, 0);
  if (range === null) {
    return { sessionId, events: 0, tokens: 0, routeTokens: 0, start: null, end: null };
  }
  const nodes = measurement.nodes.slice(range.startIdx, range.endIdx + 1);
  const surfaceNodes = session.surface.nodes;
  return {
    sessionId,
    events: nodes.length,
    // `heuristicTokens` is what the backend reports as `shadowedTokenCount`, so
    // the confirmation and the completion line quote the same number.
    tokens: nodes.reduce((total, node) => total + node.heuristicTokens, 0),
    routeTokens: nodes.reduce((total, node) => total + node.tokens, 0),
    start: surfaceNodes[range.startIdx] ?? null,
    end: surfaceNodes[range.endIdx] ?? null,
  };
}

/** The settings a failure line needs, resolved fresh at report time. */
export type ManualSettings = {
  /** Consecutive failed attempts recorded for this session. */
  failures?: number;
  /** Attempt count after which the mechanical fallback takes over. */
  fallbackAfter?: number;
  /** Whether the mechanical fallback is switched on. */
  fallbackEnabled?: boolean;
};

/**
 * One English sentence naming what went wrong, for the command channel.
 *
 * The `ManualCompactionError` codes are a closed set, and each one means a
 * different next action: `busy` is "wait", `changed`/`summary` are "retry", and
 * `commit` is "inspect before retrying".
 *
 * @param code - error code, when the error carried one.
 * @param message - the backend diagnostic.
 * @returns the reason, with the diagnostic kept when it adds anything.
 */
export function failureReason(code?: string, message?: string): string {
  const detail = String(message ?? '').trim();
  switch (code) {
    case 'busy':
      return 'the session is busy (an active compaction, an open turn, or a non-idle agent)';
    case 'cancelled':
      return 'the compaction was cancelled';
    case 'changed':
      return `the history selected for compaction changed before it could be replaced${detail.length > 0 ? `: ${detail}` : ''}`;
    case 'summary':
      return `the summarizer could not produce a usable handoff summary${detail.length > 0 ? `: ${detail}` : ''}`;
    case 'commit':
      return `the commit stage failed, so some history may have changed; inspect the session before retrying${detail.length > 0 ? `: ${detail}` : ''}`;
    case 'persistence':
      return `the summary landed but the session could not be saved${detail.length > 0 ? `: ${detail}` : ''}`;
    default:
      return detail.length > 0 ? detail : 'unknown failure';
  }
}

/**
 * One English sentence carrying the failure count and what it decides.
 *
 * @param settings - the session's failure bookkeeping.
 * @param inapplicable - true when this failure class cannot be rescued by the
 *   mechanical fallback (see `isRangeTooSmallFailure`): the count is then not
 *   evidence about the session, and saying "0, so it was not counted" would send
 *   the reader looking for a counting bug that is not there.
 * @returns the count, the threshold, and which of the two branches is next.
 */
export function failureCountText(settings: ManualSettings = {}, inapplicable = false): string {
  const failures = Number.isFinite(Number(settings.failures)) ? Math.max(0, Math.trunc(Number(settings.failures))) : 0;
  const after = Number.isFinite(Number(settings.fallbackAfter)) ? Math.max(0, Math.trunc(Number(settings.fallbackAfter))) : 0;
  if (inapplicable) {
    return `this failure class is not counted towards the mechanical fallback: the span was too small for the framed summary to replace it, and a mechanical summary is longer than a model one, so no summarizer can make this attempt succeed (the recorded count stays ${failures}; the fallback threshold ${after} is not the thing to wait for here)`;
  }
  if (failures === 0) {
    return 'the consecutive-failure count for this session is still 0, so the attempt that just failed was either not counted or the session summarises through the shipped backend, which this plugin does not count';
  }
  if (settings.fallbackEnabled === true) {
    return `${failures} consecutive attempt(s) have now failed; from attempt ${after + 1} the mechanical fallback writes the summary instead`;
  }
  return `${failures} consecutive attempt(s) have now failed; the mechanical fallback is off, so the next failure is reported the same way (turn it on to let attempt ${after + 1} fall back)`;
}

/**
 * The confirmation line a bare `/zip-compact` prints.
 *
 * @param plan - measured plan.
 * @returns what will happen, in numbers, plus how to go ahead.
 */
export function manualPlanText(plan: ManualPlan): string {
  if (plan.events === 0) {
    return `Nothing to compact in ${plan.sessionId}: no safe, useful history span was found (an empty or single-node surface has no range the backend would accept).`;
  }
  // The go-ahead comes first on purpose (user decision, 2026.09.19): the host
  // renders a command result as ONE line with `text-overflow: ellipsis`, so
  // everything past the container's width is unreachable. With the instruction
  // last, a user who ran the bare command saw a line that looked like a finished
  // report and never learned that `--yes` was missing.
  return (
    `Add "--yes" and run /zip-compact again to go ahead: it will replace ${plan.events} event(s) (~${plan.tokens} tokens) of ${plan.sessionId} with one handoff summary. ` +
    'The replaced events leave the model-visible surface but stay readable with the history tools.'
  );
}

/**
 * The completion line.
 *
 * @param outcome - what the backend reported.
 * @returns the actual replacement counts, which may differ from the plan when the
 *   session changed between the confirmation and the run.
 */
export function manualDoneText(outcome: ManualOutcome): string {
  const summary = outcome.summarySeq === null ? '' : `, summary event #${outcome.summarySeq}`;
  return `Compacted ${outcome.events} event(s) (~${outcome.tokens} tokens) of ${outcome.sessionId}${summary}.`;
}

/**
 * The failure line, with the reason and the retry-relevant count.
 *
 * @param sessionId - session the attempt targeted.
 * @param error - whatever the backend threw.
 * @param settings - the session's failure bookkeeping.
 * @returns one line naming the reason, the count, and the next branch.
 */
export function manualFailureText(sessionId: string, error, settings: ManualSettings = {}): string {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = String(error?.message ?? error ?? '');
  return `Compaction failed for ${sessionId}: ${failureReason(code, message)}. ${failureCountText(settings, isRangeTooSmallFailure(error))}`;
}

/** The three things the command and the browser route both need. */
export type ManualActions = {
  /** Measure what a compaction of this session would replace. */
  plan: (sessionId?: string | null) => Promise<ManualPlan>;
  /** Run one compaction. */
  run: (sessionId?: string | null, signal?: AbortSignal, commandId?: string) => Promise<ManualOutcome>;
  /** Read the consecutive-failure bookkeeping for one session. */
  failure: (sessionId: string) => ManualSettings;
};

/**
 * Register the `/zip-compact` human command.
 *
 * The command is deliberately two-step. The panel entry can open a dialog that
 * states the measured count, and a slash command has no such place to put it, so
 * the bare command prints the same measurement and asks for `--yes`. A command
 * that compacted on a bare keystroke would be the one manual path that never
 * said what it was about to do.
 *
 * `input` is declared for the reason `/zip-export` declares it: without the
 * descriptor a browser client treats `/zip-compact <id> --yes` as an ordinary
 * message and only the bare token reaches the handler.
 *
 * This command is deliberately NOT gated by the plugin's `enabled` switch (the
 * caller registers it unconditionally). A user-typed, explicitly confirmed
 * compaction is the manual way out when the plugin itself is misbehaving, and
 * the settings-panel button is the entry that switch hides. Do not wrap the
 * registration in an `enabled` check without asking: the split is a decision,
 * and the help text below says so on purpose.
 *
 * @param ctx - context carrying the command registry.
 * @param actions - the planning and execution implementation.
 * @returns the disposer, or null when no command registry is composed.
 */
export function registerManualCompactCommand(ctx, actions: ManualActions) {
  const commands = ctx.get('commands');
  if (commands === undefined) return null;
  return commands.register({
    name: 'zip-compact',
    // The confirmation flag leads the description (user decision, 2026.09.19).
    // The discovery menu clips this string to one line, so anything after the
    // first few words is invisible; with `--yes` in the middle the user read the
    // command as "compact now" and reported it as not working.
    description:
      'Add "--yes" to confirm: compact this session\'s older history now. Without it the command only reports how many events it would replace. Not gated by the plugin switch: it also works while the switch is off',
    // The session id is optional and defaults to the calling session, so the
    // flag comes first here too: leading with `session id` made readers think an
    // id was required before the command could run at all.
    input: { hint: '--yes to confirm; optional session id (bare invocation only reports the plan)' },
    recordInput: false,
    async handler(invocation) {
      const tokens = invocation.rawInput.trim().split(/\s+/u).filter((token) => token.length > 0);
      const confirmed = tokens.includes('--yes');
      const unknown = tokens.find((token) => token.startsWith('--') && token !== '--yes');
      if (unknown !== undefined) {
        return { kind: 'error', text: `zip-compact: unknown option ${unknown}. Usage: /zip-compact [session id] [--yes]` };
      }
      const named = tokens.find((token) => !token.startsWith('--')) ?? '';
      const fallbackId = String(invocation.agent?.session?.id ?? '');
      try {
        if (!confirmed) {
          const plan = await actions.plan(named.length > 0 ? named : fallbackId);
          return { kind: 'success', text: manualPlanText(plan) };
        }
        const outcome = await actions.run(named.length > 0 ? named : fallbackId, invocation.signal, invocation.commandId);
        return { kind: 'success', text: manualDoneText(outcome) };
      } catch (error) {
        // The count is read AFTER the attempt: the engine increments it while the
        // attempt unwinds, so reading it first would always report one less.
        const sessionId = named.length > 0 ? named : fallbackId;
        let settings: ManualSettings = {};
        try {
          settings = actions.failure(sessionId) ?? {};
        } catch {
          // An unreadable count must not replace the real failure with its own.
        }
        return { kind: 'error', text: manualFailureText(sessionId, error, settings) };
      }
    },
  });
}

/**
 * The consecutive-failure count for one session, read from the engine.
 *
 * Exported here as well as from the engine package so the plugin half has one
 * place to ask, and a missing engine build degrades to 0 rather than throwing
 * inside an error path.
 *
 * @param sessionId - session to read.
 * @returns the recorded count, or 0.
 */
export function readFailureCount(sessionId: string): number {
  try {
    return failureCount(sessionId);
  } catch {
    return 0;
  }
}

export default {
  ManualTargetError,
  selectManualRange,
  planManualCompaction,
  failureReason,
  failureCountText,
  manualPlanText,
  manualDoneText,
  manualFailureText,
  registerManualCompactCommand,
  readFailureCount,
};
