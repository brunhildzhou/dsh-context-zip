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
/** Why a manual compaction could not even be planned. */
export type ManualTargetCode = 'session-not-live' | 'no-live-session' | 'session-required';
/** A planning failure the caller reports verbatim rather than as a crash. */
export declare class ManualTargetError extends Error {
    /** Stable reason code, so the browser half can localize it. */
    readonly code: ManualTargetCode;
    /**
     * @param code - stable reason code.
     * @param message - human-readable diagnostic.
     */
    constructor(code: ManualTargetCode, message: string);
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
export declare function selectManualRange(session: any, measurement: any, retainTokens?: number): {
    startIdx: number;
    endIdx: number;
};
/**
 * Measure what a manual compaction of one session would replace.
 *
 * @param sessionId - session the plan names.
 * @param session - that session, as the engine would see it.
 * @param measurement - `ctx.tokenMeter.measure(session)`.
 * @returns the counts a confirmation shows; every count is 0 when nothing is compactable.
 */
export declare function planManualCompaction(sessionId: string, session: any, measurement: any): ManualPlan;
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
export declare function failureReason(code?: string, message?: string): string;
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
export declare function failureCountText(settings?: ManualSettings, inapplicable?: boolean): string;
/**
 * The confirmation line a bare `/zip-compact` prints.
 *
 * @param plan - measured plan.
 * @returns what will happen, in numbers, plus how to go ahead.
 */
export declare function manualPlanText(plan: ManualPlan): string;
/**
 * The completion line.
 *
 * @param outcome - what the backend reported.
 * @returns the actual replacement counts, which may differ from the plan when the
 *   session changed between the confirmation and the run.
 */
export declare function manualDoneText(outcome: ManualOutcome): string;
/**
 * The failure line, with the reason and the retry-relevant count.
 *
 * @param sessionId - session the attempt targeted.
 * @param error - whatever the backend threw.
 * @param settings - the session's failure bookkeeping.
 * @returns one line naming the reason, the count, and the next branch.
 */
export declare function manualFailureText(sessionId: string, error: any, settings?: ManualSettings): string;
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
export declare function registerManualCompactCommand(ctx: any, actions: ManualActions): any;
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
export declare function readFailureCount(sessionId: string): number;
declare const _default: {
    ManualTargetError: typeof ManualTargetError;
    selectManualRange: typeof selectManualRange;
    planManualCompaction: typeof planManualCompaction;
    failureReason: typeof failureReason;
    failureCountText: typeof failureCountText;
    manualPlanText: typeof manualPlanText;
    manualDoneText: typeof manualDoneText;
    manualFailureText: typeof manualFailureText;
    registerManualCompactCommand: typeof registerManualCompactCommand;
    readFailureCount: typeof readFailureCount;
};
export default _default;
