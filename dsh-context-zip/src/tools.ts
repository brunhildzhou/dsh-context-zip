/**
 * The model-facing tools.
 *
 * Three review tools answer questions about this session's own history, and one
 * notes tool records intent for the next compaction. Every tool reads or writes
 * only through the context the calling agent already holds: the session is the
 * agent's own, so a subagent can review itself and nothing else.
 *
 * Tool output is rendered by a pure `render` function, which is also where the
 * "extremely short acknowledgment" contract for `notes_write` lives: the model
 * never sees note text echoed back.
 *
 * @module dsh-context-zip/tools
 */

import { appendFileSync } from 'node:fs';

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  HISTORY_FIND_BUDGET_DESCRIPTION,
  HISTORY_FIND_DEFAULT_BUDGET_CHARS,
  HISTORY_FIND_DESCRIPTION,
  HISTORY_FIND_EXTRACT_DESCRIPTION,
  HISTORY_FIND_MAX_BUDGET_CHARS,
  HISTORY_FIND_MAX_QUERIES,
  HISTORY_FIND_QUERIES_DESCRIPTION,
  HISTORY_READ_CONTEXT_EVENTS,
  HISTORY_READ_DEFAULT_CHARS,
  HISTORY_READ_MAX_CHARS,
  HISTORY_SEARCH_DEFAULT_LIMIT,
  HISTORY_SEARCH_MAX_LIMIT,
  HISTORY_SEARCH_SNIPPET_CHARS,
  NOTES_MAX_CHARS,
  NOTES_READ_DESCRIPTION,
  NOTES_SEARCH_DESCRIPTION,
  NOTES_WRITE_ACK,
  NOTES_WRITE_DESCRIPTION,
  HISTORY_SEARCH_PAGE_BUDGET_CHARS,
  RETRIEVAL_RECEIPT_NOTE,
  TOOL_RESULT_STORE_CEILING_CHARS,
  TOOL_RESULT_STORE_CEILING_BYTES,
  clampToStoreCeiling,
  utf8Bytes,
} from 'dsh-context-zip/engine/prompt';
import {
  deriveSegments,
  deriveTurnStart,
  describeSegment,
  loadSegments,
  loadSegmentsAndTurn,
  readSessionEvents,
  segmentForSeq,
} from './segments.ts';
import {
  eventBody,
  excerptAround,
  locateAround,
  renderWindow,
  scoreText,
  snapWindow,
  windowWasTruncated,
} from './transcript.ts';

/**
 * Text-valued tool output: the model sees exactly the rendered string.
 *
 * `as const` matters: without it the literal widens to `{ type: string }`, which
 * is not a `ValueSchemaSpec`, and every tool that uses it fails to type-check.
 */
const TEXT_OUTPUT = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
};

/**
 * One turn's retrieval ledger.
 *
 * A model cannot tell whether a search returned anything it did not already have, and
 * left to guess it searches again. The guess is measurable. Over the dense matrix,
 * 37.3% of adjacent retrieval pairs returned the *identical* event set, and 51.1% of
 * all retrievals happened after the turn had already accumulated every event it would
 * ever see. Both are properties of what this plugin handed back, so both are facts it
 * can state rather than thresholds it has to invent.
 */
/**
 * What this turn's reads have already handed back for one event.
 *
 * A set of event numbers was not enough. `history_read {seq: 8, offset: 0, maxChars: 6000}`
 * on a 132,920-character event returned 4.5% of it, and recording "event 8 is served" then
 * hid that event from every later search for the rest of the turn. The searches were the
 * one instrument that could still say "the term you want is near offset 107000".
 */
interface HeldEvent {
  /** Character ranges already sent, as `[start, end)`. */
  ranges: Array<[number, number]>;
  /** The event's full length, known only once a read has reported it. */
  total: number | null;
  /** Set once a read returned the event without an offset, which settles it. */
  whole: boolean;
}

interface TurnLedger {
  /** Per-event coverage this turn's reads have already returned. */
  served: Map<number, HeldEvent>;
  /** Retrievals recorded this turn, across the history tools. */
  retrievals: number;
  /** Discovery retrievals in a row that added nothing the turn had not already seen. */
  zeroStreak: number;
  /**
   * True while the sweep tools are withheld and only `history_read` is offered.
   *
   * Set when {@link NARROW_AFTER_ZERO_STREAK} consecutive discovery retrievals add
   * nothing. Cleared the moment a search adds something, so narrowing undoes itself
   * as soon as sweeping works again rather than lasting the whole turn.
   */
  narrowed: boolean;
  /**
   * Searches the model has earned back by reading.
   *
   * A read is an explicit address, so it is evidence of a lead rather than a guess;
   * one read buys one search. This is what keeps narrowing from being a dead end for
   * the measured 21% of cells whose first hit lands after the streak trips.
   */
  searchCredits: number;
  narrowedReads: number;
}

/**
 * Consecutive zero-novelty discovery retrievals before the sweep tools are withheld.
 *
 * Two, from the measured streak lengths. Three was the first candidate, but it fires in
 * 77 of 78 cells, which is late enough to be pointless: by then the turn has already
 * spent the retrievals this is meant to save.
 */
const NARROW_AFTER_ZERO_STREAK = 2;

/**
 * Searches a read can bank while narrowed.
 *
 * One. Without a cap the credit ledger is an unlimited accumulator: the model reads
 * nineteen times in a row, banks nineteen searches, and then sweeps nineteen more, which
 * is the loop narrowing exists to stop. Measured live, `A2-A2` had a run of 19
 * consecutive reads, so the hole was reachable rather than theoretical.
 */
const MAX_SEARCH_CREDITS = 1;

/**
 * Event numbers an all-held page names before it stops listing them.
 *
 * The notice exists to be shorter than the content it replaces, so it cannot grow without
 * bound. Twelve covers a page the size these tools actually return, and the remainder is
 * reported as a count rather than silently dropped.
 */
const HELD_SEQ_LIST_LIMIT = 12;

/**
 * Query terms whose offsets are named on one `history_find` result line.
 *
 * The line shares a character budget with the excerpt under it, and a caller may pass up
 * to `HISTORY_FIND_MAX_QUERIES` terms. Naming every one would let the address crowd out
 * the text it addresses. What is listed is cut; what was found is always counted.
 */
const FIND_TERM_LIST_LIMIT = 6;

/**
 * What a read may return while narrowing is in force.
 *
 * Narrowing used to withhold only the sweep tools, which left `history_read` as the one
 * way to get material and made it the expensive one: a read returns an event whole, so
 * the model answered a sweep-shaped question by loading whole events into context.
 * Measured over three cells, reads went from 11 calls / 24,159 characters to 51 calls /
 * 259,182 characters, round trips rose 27 → 50, and tokens rose 3.69×.
 *
 * The default budget is the ceiling while narrowed. That keeps the read usable for
 * checking a lead, which is what it is for, and stops it being a way to move a document
 * into context one call at a time.
 */
const NARROWED_READ_MAX_CHARS = HISTORY_READ_DEFAULT_CHARS;

/**
 * How many reads remain available once narrowing is in force.
 *
 * Capping a read's LENGTH was not enough, and the measurement says so: narrowing took the
 * sweep tools away and the bytes read back went from 24,159 to 259,182, a factor of 10.7,
 * because the model moved to the channel that was still open. Bounding each read to
 * `NARROWED_READ_MAX_CHARS` while leaving the COUNT unbounded bounds nothing.
 *
 * The number is not zero on purpose: 21% of cells that tripped the streak still found
 * their answer afterwards, and a read is how they did it. What the outside evidence adds
 * is that a retrieval loop is only broken when the loop's own channel is closed — BCAS
 * removes the search tool and the model "must answer", with nothing cheaper left to try.
 * Allowing a few reads keeps the case that works and ends the case that does not.
 *
 * The value is a placeholder until B1 measures how many reads a recovering cell actually
 * uses. It is deliberately a named constant so that number has one place to land.
 */
const NARROWED_READ_BUDGET = 3;

/**
 * Is narrowing in force for this turn?
 *
 * @param sessionId - session the retrieval belongs to.
 * @param turnStart - seq the current turn begins at, or null when it cannot be told.
 * @returns true when the sweep tools are withheld.
 */
function narrowedNow(sessionId, turnStart) {
  if (turnStart === null) return false;
  const ledger = turnLedgers.get(`${sessionId}#${turnStart}`);
  return ledger !== undefined && ledger.narrowed && ledger.searchCredits <= 0;
}

/**
 * Whether narrowing has spent its read budget for this turn.
 *
 * @param sessionId - session the read belongs to.
 * @param turnStart - seq the current turn begins at, or null when it cannot be told.
 * @returns true when reads should be refused rather than capped.
 */
function narrowedForReads(sessionId, turnStart) {
  if (turnStart === null) return false;
  const ledger = turnLedgers.get(`${sessionId}#${turnStart}`);
  return ledger !== undefined && ledger.narrowed;
}

/**
 * Whether narrowing has spent its read budget for this turn.
 *
 * Deliberately not `narrowedNow`: that helper also asks whether search credits are gone,
 * and a read EARNS a credit. Keying the read cap off it let the first read lift its own
 * limit — the cap was gone after one call, which is the same hole the budget exists to
 * close. Narrowing is the condition; credits govern searches only.
 *
 * @param sessionId - session the read belongs to.
 * @param turnStart - seq the current turn begins at, or null when it cannot be told.
 * @returns true when reads should be refused rather than capped.
 */
function narrowedReadsExhausted(sessionId, turnStart) {
  if (!narrowedForReads(sessionId, turnStart)) return false;
  const ledger = turnLedgers.get(`${sessionId}#${turnStart}`);
  return ledger !== undefined && ledger.narrowedReads >= NARROWED_READ_BUDGET;
}

/**
 * The refusal that ends the read channel.
 *
 * Says what to do instead, because a refusal without a next action is how a loop becomes a
 * stall: the caller must be able to answer from what it already has and name what it could
 * not resolve, which is the same instruction the sweep tools carry when they are paused.
 *
 * @returns the refusal text.
 */
function narrowedReadsSpent() {
  return [
    `[Reads are exhausted for this turn: ${NARROWED_READ_BUDGET} were allowed after narrowing began and`,
    `they are used up. Answer from what you already have and name the part you could not resolve.]`,
  ].join('\n');
}

/**
 * The notice that explains a capped read.
 *
 * @returns the note lines, or an empty string when nothing was capped.
 */
function narrowedReadNote() {
  return [
    `[Narrowing is in force, so this read is capped at ${NARROWED_READ_MAX_CHARS} characters: enough to check a`,
    `lead, not enough to load an event into context. Page with "offset" if you need the next slice, or`,
    `answer from what you have and name the part you could not resolve.]`,
  ].join('\n');
}

/**
 * Whether the retrieval throttle is allowed to change what the model sees.
 *
 * Off by default. The layer is kept because the mechanism works and the measurements are
 * worth re-running, but its effect was never established: over three runs of the same
 * four cells the token ratio against baseline ranged from 0.10x to 8.46x, and in-cell
 * spread across runs reached 21x. Published work on aggressive retrieval throttling
 * (HALT, arXiv 2608.02009) reports accuracy losses for this class of approach.
 *
 * When off, the ledger and the trace still run. That is deliberate: it is what makes the
 * trace able to describe an unthrottled baseline, and the novelty counters cost nothing.
 * Only the three things the model can observe are suppressed: the receipt, the
 * incremental filtering, and the read cap.
 */
let throttleEnabled = false;

/**
 * Turn the throttle on or off.
 *
 * @param on - true to let the throttle change tool behavior.
 */
export function setThrottleEnabled(on) {
  throttleEnabled = on === true;
}

/**
 * Optional JSONL trace path, set from the `tracePath` setting.
 *
 * The harness in use ships no logger exporter, so `ctx.logger` output only reaches an
 * in-memory buffer and a session's throttling behavior is invisible from outside. This
 * writes one line per retrieval instead, which is what makes the questions the design
 * still has open measurable: how often narrowing fires, whether a zero-novelty notice is
 * followed by a read or by another sweep, and how much novelty a sweep averages.
 */
let tracePath = null;

/**
 * Install the trace destination.
 *
 * @param path - file to append JSONL to, or null to turn tracing off.
 */
export function setTracePath(path) {
  tracePath = typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * Append one retrieval to the trace, if one is configured.
 *
 * Synchronous on purpose: a diagnostic that can be lost on process exit is worse than no
 * diagnostic, and one small append per retrieval costs microseconds against a model call.
 * Every failure is swallowed, because tracing must never be the reason a retrieval fails.
 *
 * @param record - the fields to serialize as one JSON line.
 */
function traceRetrieval(record) {
  if (tracePath === null) return;
  try {
    appendFileSync(tracePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // A bad path, a full disk, a read-only mount: none of them are the caller's problem.
  }
}

/**
 * Called when a session's narrowing state flips, so the mask can be re-applied.
 *
 * The mask has to be per agent (`tools.restrict` refuses a global scope) while the
 * narrowing decision is per session and turn, so the two halves live in different files
 * and this is the one wire between them.
 */
let throttleListener = null;

/**
 * Install the narrowing listener.
 *
 * @param listener - receives the session and whether its sweep tools should be hidden.
 */
export function setThrottleListener(listener) {
  throttleListener = listener;
}

/**
 * The events this turn has already handed back.
 *
 * Read BEFORE a retrieval renders, so the sweep tools can leave out what the caller
 * already has. Returns an empty set when the turn cannot be identified, which makes the
 * result identical to the pre-incremental behavior.
 *
 * @param sessionId - session the retrieval belongs to.
 * @param turnStart - seq the current turn begins at, or null when it cannot be told.
 * @returns the served event numbers.
 */
function servedInTurn(sessionId, turnStart) {
  // Off means nothing is withheld, so the caller sees every match. The ledger still
  // records what was returned, which is what keeps the trace readable either way.
  if (!throttleEnabled) return new Set();
  if (turnStart === null) return new Set();
  const served = turnLedgers.get(`${sessionId}#${turnStart}`)?.served;
  if (served === undefined) return new Set();
  const fully = new Set();
  for (const seq of served.keys()) if (isFullyHeld(served, seq)) fully.add(seq);
  return fully;
}

/**
 * Has this event been returned in full this turn?
 *
 * Only then is withholding it from a search safe. A partial read leaves the event
 * eligible, because the caller has not seen the parts it has not read, and a search hit
 * is exactly how it would learn those parts exist.
 *
 * @param served - this turn's coverage table.
 * @param seq - event number to test.
 * @returns true when the coverage provably spans the whole event.
 */
function isFullyHeld(served, seq) {
  const entry = served.get(seq);
  if (entry === undefined) return false;
  if (entry.whole) return true;
  if (entry.total === null) return false;
  let reach = 0;
  for (const [start, end] of [...entry.ranges].sort((a, b) => a[0] - b[0])) {
    // A gap before this range means some of the event was never sent.
    if (start > reach) return false;
    if (end > reach) reach = end;
  }
  return reach >= entry.total;
}

/**
 * Fold one retrieval into the coverage table.
 *
 * @param served - this turn's coverage table.
 * @param seq - event number that was returned.
 * @param partial - the exact range a partial read covered, or null for a whole event.
 */
function addHeld(served, seq, partial) {
  let entry = served.get(seq);
  if (entry === undefined) {
    entry = { ranges: [], total: null, whole: false };
    served.set(seq, entry);
  }
  if (partial === null) {
    entry.whole = true;
    return;
  }
  entry.ranges.push([partial.start, partial.end]);
  if (Number.isSafeInteger(partial.total)) entry.total = partial.total;
}

/** Tell the mask layer where this session's sweep tools should stand right now. */
function notifyThrottle(session, ledger) {
  if (throttleListener === null) return;
  try {
    throttleListener(session, ledger.narrowed && ledger.searchCredits <= 0);
  } catch {
    // Hiding a tool is presentation. A session that keeps all of them still works.
  }
}

/**
 * Ledgers keyed by `session#turnStart`. A new turn makes a new key, so the previous
 * turn's ledger ages out on its own without an invalidation hook to get wrong.
 */
const turnLedgers = new Map<string, TurnLedger>();

/** Retained ledgers. One per live session and turn is already more than is needed. */
const TURN_LEDGER_MEMORY = 64;

/**
 * Record one retrieval and return the receipt to put at the TOP of its result.
 *
 * A header rather than a footer on purpose: `clampToStoreCeiling` keeps a prefix, so a
 * long result would drop a footer first, and the receipt is the one line that has to
 * survive.
 *
 * `discovery` separates searching from reading. Only a search can come back with
 * nothing new in a way that means "these terms are not reaching it"; a read is an
 * explicit address, so it feeds `served` without counting toward the streak.
 *
 * @param sessionId - session the retrieval belongs to.
 * @param turnStart - seq the current turn begins at, or null when it cannot be told.
 * @param seqs - event numbers this retrieval actually returned.
 * @param discovery - true for `history_search` and `history_find`, false for reads.
 * @returns the receipt line(s), or an empty string when there is nothing to say.
 */
function recordRetrieval(sessionId, turnStart, seqs, discovery, heldSeqs = [], partial = null, termNote = '') {
  const omitted = heldSeqs.length;
  // The term note depends on neither the turn boundary nor the ledger, so it is answered
  // before either can suppress it. Everything below is about what this TURN has already
  // handed over; whether the caller's wording exists at all is a fact about the session.
  const termOnly = termNote === '' ? '' : `[${termNote}]`;
  if (turnStart === null || seqs.length + omitted === 0) return termOnly;
  const key = `${sessionId}#${turnStart}`;
  let ledger = turnLedgers.get(key);
  if (ledger === undefined) {
    if (turnLedgers.size >= TURN_LEDGER_MEMORY) {
      turnLedgers.delete(turnLedgers.keys().next().value);
    }
    ledger = {
      served: new Map(),
      retrievals: 0,
      zeroStreak: 0,
      narrowed: false,
      searchCredits: 0,
      narrowedReads: 0,
    };
    turnLedgers.set(key, ledger);
  }
  let fresh = 0;
  for (const seq of seqs) if (!isFullyHeld(ledger.served, seq)) fresh += 1;
  ledger.retrievals += 1;

  if (discovery) {
    if (fresh === 0) ledger.zeroStreak += 1;
    else ledger.zeroStreak = 0;
    // Sweeping works again, so the lock comes off by itself. Without this the model
    // would stay narrowed for the rest of the turn after one productive search.
    if (ledger.zeroStreak === 0) ledger.narrowed = false;
    if (ledger.zeroStreak >= NARROW_AFTER_ZERO_STREAK) ledger.narrowed = true;
    // A search spends whatever a read earned. Narrowing is what denies it, so this
    // only matters while narrowed.
    if (ledger.narrowed && ledger.searchCredits > 0) ledger.searchCredits -= 1;
  } else if (ledger.narrowed) {
    // A read made while narrowing spends the budget the read cap exists to enforce.
    ledger.narrowedReads += 1;
    // One targeted read buys one search, capped. See MAX_SEARCH_CREDITS for why the cap
    // is not optional: uncapped, the credit ledger is a way around narrowing entirely.
    ledger.searchCredits = Math.min(MAX_SEARCH_CREDITS, ledger.searchCredits + 1);
  }
  // A partial read says which range it covered. `seq: null` means the read returned the
  // event but its coverage is unknown (the renderer cut it), which must not be recorded
  // as whole: that is the defect the coverage table exists to fix. Everything else
  // returned the event in full.
  for (const seq of seqs) {
    const applies = partial !== null && (partial.seq === null || partial.seq === seq);
    addHeld(ledger.served, seq, applies ? partial : null);
  }

  traceRetrieval({
    at: new Date().toISOString(),
    session: sessionId,
    turn: turnStart,
    n: ledger.retrievals,
    kind: discovery ? 'sweep' : 'read',
    fresh,
    omitted,
    servedTotal: ledger.served.size,
    heldInFull: [...ledger.served.keys()].filter((seq) => isFullyHeld(ledger.served, seq)).length,
    zeroStreak: ledger.zeroStreak,
    narrowed: ledger.narrowed,
    credits: ledger.searchCredits,
    throttle: throttleEnabled,
  });

  const total = seqs.length;
  const noun = total === 1 ? 'event' : 'events';
  // Two shapes, because the two kinds of retrieval now say different things. A read
  // returns what was asked for whether or not it is new, so its question is "is this
  // the first time". A sweep drops what the caller already has, so its question is
  // "how much is left for you".
  const counts =
    omitted === 0
      ? fresh === total
        ? `${total} ${noun}, all new`
        : fresh === 0
          ? `${total} ${noun}, none of them new: every one was already returned earlier this turn`
          : `${total} ${noun}, ${fresh} new and ${total - fresh} already returned earlier this turn`
      : total === 0
        ? `nothing new; ${omitted} match(es) were already returned earlier this turn and are left out`
        : `${total} ${noun} shown; ${omitted} more were already returned earlier this turn and are left out`;
  // The event counts above answer "how much is left for me". They do not answer "is my
  // wording even present", and that omission is expensive: one session spent 139 sweeps
  // on 130 DISTINCT terms, nearly all rephrasings of the same two ideas. A caller told
  // `gzip absent` stops rewording `gzip`; a caller left to infer it from an empty result
  // keeps hunting for synonyms.
  const termPart = termNote === '' ? '' : `; ${termNote}`;
  const line = `[retrieval #${ledger.retrievals} this turn: ${counts}${termPart}]`;

  // The mask is one of the three model-visible effects, so it only moves when the
  // switch is on. Flipping it while off would hide the sweep tools for a feature the
  // operator turned off.
  if (throttleEnabled) notifyThrottle({ id: sessionId }, ledger);

  // Both notes can apply to the same result, so they are collected rather than
  // returned from separate branches. An all-held page that is also the second
  // zero-novelty page has to say both things: where the material is, and that the
  // sweep tools have stopped. Emitting only the first left the model with a pointer
  // and no idea why its next search was refused.
  const notes = [];
  // The switch governs the notes that tell the caller to STOP: novelty, narrowing, the
  // held-event pointer. The term note is not one of those. It says whether the caller's
  // wording exists anywhere, which is addressing, and it is the question a synonym loop
  // is actually asking — 139 sweeps over 130 distinct terms, long before any throttle
  // existed. Suppressing it with the switch would remove the one part of the receipt
  // that has nothing to do with throttling.
  if (!throttleEnabled) {
    return termNote === '' ? '' : `[retrieval #${ledger.retrievals} this turn: ${termNote}]`;
  }
  if (total === 0) {
    // The dangerous case, and the reason the receipt is not optional here. An empty
    // result reads as "this session does not contain it"; what actually happened is
    // that the caller already has everything this query reaches.
    //
    // The event numbers are named, not just asserted. "You already have them" asks the
    // caller to trust a claim about its own context; "#24, #88" hands it a call it can
    // make right now. Naming was the difference between the two sweep tools behaving
    // alike and only one of them being actionable, so both now name.
    const named = heldSeqs.slice(0, HELD_SEQ_LIST_LIMIT);
    notes.push(
      `[Nothing new was returned because every match is already in this turn's context. The`,
      `${omitted} event(s) this query reaches are ${named.map((seq) => `#${seq}`).join(', ')}${omitted > named.length ? `, and ${omitted - named.length} more` : ''}.`,
      `Read any of them in full with history_read, or answer from what you have and name the part`,
      `you could not resolve.]`,
    );
  }
  if (discovery && ledger.narrowed) {
    notes.push(
      `[Two retrievals in a row added nothing new, so history_search and history_find are paused: the`,
      `material they can reach is already in this turn's context. history_read still works — read any`,
      `event number you have already seen, and one read gives you one more search.]`,
    );
  }
  return notes.length === 0 ? line : [line, ...notes].join('\n');
}

/**
 * Register every tool this plugin contributes.
 *
 * @param ctx - plugin context carrying `tools`.
 * @param options - session-scoped notes access and the per-session mode lookup.
 * @returns the disposer for everything registered.
 */
export function registerTools(ctx, options) {
  const disposers = [
    ctx.tools.register(historySegmentsTool(ctx)),
    ctx.tools.register(historyReadTool(ctx)),
    ctx.tools.register(historySearchTool(ctx, options)),
    ctx.tools.register(historyFindTool(ctx, options)),
    ctx.tools.register(notesWriteTool(options)),
    ctx.tools.register(notesReadTool(options)),
    ctx.tools.register(notesSearchTool(options)),
  ];
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A tool already gone must not stop the rest from unloading.
      }
    }
  };
}

/** `history_segments`: the directory of this session's own compactions. */
export function historySegmentsTool(ctx) {
  return defineTool({
    name: 'history_segments',
    description: [
      "List this session's own compaction segments: one line per compaction, oldest first,",
      'with the events it replaced and the summary event number.',
      'Segment numbers count only the compactions that happened after this session was created,',
      'so a session with no compactions of its own reports an empty list.',
      'Use a listed event number with history_read to read the original text back.',
    ].join(' '),
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const session = requireSession(exec);
      const segments = await loadSegments(ctx, session);
      if (segments.length === 0) {
        return `No compaction segments in this session yet. Session ${session.id} has ${session.seq} events.`;
      }
      const lines = segments.map((segment) => describeSegment(segment));
      return [`${segments.length} compaction segment(s) in this session:`, ...lines].join('\n');
    },
  });
}

/** `history_read`: read original text by segment number or by event number. */
export function historyReadTool(ctx) {
  return defineTool({
    name: 'history_read',
    description: [
      'Read the original stored text of this conversation, including text that was compacted',
      'away and is no longer in the live context. Address it either by "segment" (a number from',
      'history_segments) or by "seq" (an event number, with optional before/after context).',
      'Compacted text is never deleted, so anything summarized away is still readable here.',
      'The result is bounded by "maxChars".',
    ].join(' '),
    parameters: {
      segment: {
        type: 'integer',
        description: 'Segment number from history_segments. Reads every event that segment replaced.',
      },
      seq: { type: 'integer', description: 'A single event number to read.' },
      before: {
        type: 'integer',
        description: `Event numbers of leading context to include with "seq" (default ${HISTORY_READ_CONTEXT_EVENTS}).`,
      },
      after: {
        type: 'integer',
        description: `Event numbers of trailing context to include with "seq" (default ${HISTORY_READ_CONTEXT_EVENTS}).`,
      },
      maxChars: {
        type: 'integer',
        description: `Character budget for the returned transcript (default ${HISTORY_READ_DEFAULT_CHARS}, hard ceiling ${HISTORY_READ_MAX_CHARS}).`,
      },
      offset: {
        type: 'integer',
        description: `Zero-based character position WITHIN event "seq" to start from. Positions are the same ones history_find reports as "matched at character N", and the same space the text is returned in, so a hit can be read back exactly. Only valid together with "seq" and without "before"/"after"/"segment": it addresses one point in one event, and mixing it with a multi-event window has no defined meaning.`,
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const sessionSegments = await loadSegmentsAndTurn(ctx, session);
      // Length first, then count. A caller that has spent the budget is refused outright,
      // because the cap below only bounds one read and the measurement showed the loop
      // simply issues more of them.
      if (throttleEnabled && narrowedReadsExhausted(session.id, sessionSegments.turnStart)) {
        return narrowedReadsSpent();
      }
      // `narrowedForReads`, not `narrowedNow`: a read earns a search credit, and keying the
      // read cap off credits let the first read remove the cap it was subject to.
      const cappedByNarrowing =
        throttleEnabled &&
        narrowedForReads(session.id, sessionSegments.turnStart) &&
        clampChars(args.maxChars) > NARROWED_READ_MAX_CHARS;
      const maxChars = cappedByNarrowing ? NARROWED_READ_MAX_CHARS : clampChars(args.maxChars);
      /**
       * Add the capping notice to a rendered read.
       *
       * It goes at the very top, above the address line. A long result is clamped to a
       * prefix, and the one thing the caller must not miss is why it got less than it
       * asked for.
       *
       * @param text - the rendered tool text.
       * @returns the same text with the notice inserted.
       */
      const withCap = (text) => {
        if (!cappedByNarrowing) return text;
        const newline = text.indexOf('\n');
        return newline === -1
          ? `${text}\n${narrowedReadNote()}`
          : `${text.slice(0, newline)}\n${narrowedReadNote()}${text.slice(newline)}`;
      };
      const query = requireQuery(ctx);
      if (typeof args.segment === 'number') {
        const { segments, turnStart } = sessionSegments;
        const segment = segments[args.segment];
        if (segment === undefined) {
          const available = segments.length === 0 ? 'none' : `0..${segments.length - 1}`;
          return `No segment ${args.segment} in this session. Available segments: ${available}.`;
        }
        const events = [];
        for (const seq of segment.shadowedSeqs) {
          try {
            const window = await query.readEvent({ sessionId: session.id, seq, before: 0, after: 0 });
            events.push(window.target);
          } catch {
            // A replacement can retire an individual node; skip it and keep the rest.
          }
        }
        const header = `segment ${segment.ordinal}: ${segment.label}\ncompactionId ${segment.compactionId}, summary event #${segment.summarySeq}, ~${segment.tokenCount} tokens replaced`;
        // A read is an explicit address, so it feeds the ledger without counting toward
        // the zero-novelty streak: re-reading a known event for its full text is the
        // intended use, not a loop.
        // A rendered window is only "the whole event" when the renderer did not cut it.
        // Truncated, the caller has seen a prefix, so nothing here is marked held and a
        // later search may still point at the part it has not read.
        const segmentSeqs = events.map((event) => event?.seq).filter((seq) => Number.isSafeInteger(seq));
        // Render once with a bare header to learn whether the budget cut anything. The
        // receipt is prepended to the header afterwards and the header is not part of the
        // renderer's budget, so this test is unaffected by the receipt being added later.
        const segmentProbe = renderWindow(events, header, maxChars);
        const segmentPartial = windowWasTruncated(segmentProbe)
          ? { seq: null, start: 0, end: 0, total: null }
          : null;
        const segmentReceipt = recordRetrieval(session.id, turnStart, segmentSeqs, false, [], segmentPartial);
        return withCap(renderWindow(events, segmentReceipt === '' ? header : `${segmentReceipt}\n${header}`, maxChars));
      }
      if (typeof args.offset === 'number') {
        // An exact slice: the caller named the coordinates, so they are honoured.
        // Snapping the start to a sentence boundary would move the window and make
        // the "continue with offset N" arithmetic wrong, which is the one thing this
        // mode exists to get right.
        if (typeof args.seq !== 'number') {
          return '"offset" needs "seq": it addresses one point in one event. Pass seq as well, or drop offset and use "segment"/"before"/"after".';
        }
        if (args.before !== undefined || args.after !== undefined) {
          return '"offset" cannot be combined with "before" or "after". A slice starts at one point in one event, while before/after widen it to neighbouring events; the two have no single meaning together.';
        }
        if (!Number.isSafeInteger(args.offset) || args.offset < 0) {
          return `"offset" must be a non-negative integer, got ${JSON.stringify(args.offset)}.`;
        }
        const window = await query.readEvent({ sessionId: session.id, seq: args.seq, before: 0, after: 0 });
        const body = eventBody(window.target);
        const total = body.length;
        if (args.offset >= total) {
          // Refusing beats clamping: an offset past the end almost always means the
          // coordinates came from somewhere else, and returning the tail silently
          // would be quoted as if it were the region that was asked for.
          return `Event #${args.seq} is ${total} characters; offset ${args.offset} is past its end. Check the event number, or drop "offset" to read the whole event.`;
        }
        const end = Math.min(total, args.offset + maxChars);
        const { segments, turnStart } = sessionSegments;
        const owner = segmentForSeq(segments, args.seq);
        const origin = owner === null ? 'not inside any compaction segment' : `segment ${owner.ordinal}, replaced by summary #${owner.summarySeq}`;
        const more =
          end < total ? `\n(${end - args.offset} shown; continue with offset ${end})` : `\n(${end - args.offset} shown; end of event)`;
        const sliceEnd = args.offset + clampToStoreCeiling(body.slice(args.offset, end), maxChars).length;
        // The line count is a second handle on the same text, offered because the
        // harness's own `read` teaches callers to think in lines. It is reported, not
        // addressable: a second coordinate system would mean converting between
        // characters and lines, and neither is something a caller does reliably.
        const lineCount = body.split('\n').length;
        // The one branch with an exactly known range, and the one that caused the
        // defect: a 6,000-character read of a 132,920-character event used to mark the
        // whole event as held.
        const receipt = recordRetrieval(session.id, turnStart, [args.seq], false, [], {
          seq: args.seq,
          start: args.offset,
          end: sliceEnd,
          total,
        });
        return withCap(clampToStoreCeiling(
          `${receipt === '' ? '' : `${receipt}\n`}#${args.seq} ${String(window.target?.type ?? '?')} characters ${args.offset}..${sliceEnd} of ${total} (${lineCount} lines) (${origin})${more}\n\n${body.slice(args.offset, sliceEnd)}`,
          TOOL_RESULT_STORE_CEILING_CHARS,
        ));
      }
      if (typeof args.seq === 'number') {
        const before = clampContext(args.before);
        const after = clampContext(args.after);
        const window = await query.readEvent({ sessionId: session.id, seq: args.seq, before, after });
        const { segments, turnStart } = sessionSegments;
        const owner = segmentForSeq(segments, args.seq);
        const header =
          owner === null ? 'not inside any compaction segment' : `inside segment ${owner.ordinal}: ${owner.label}`;
        const windowSeqs = window.events.map((event) => event?.seq).filter((seq) => Number.isSafeInteger(seq));
        const windowProbe = renderWindow(window.events, header, maxChars);
        const windowPartial = windowWasTruncated(windowProbe) ? { seq: null, start: 0, end: 0, total: null } : null;
        const windowReceipt = recordRetrieval(session.id, turnStart, windowSeqs, false, [], windowPartial);
        // `args.seq` is the whole point of this call, so the addressed entry is named and
        // `renderTranscript` will give up its neighbours rather than drop it.
        return withCap(
          renderWindow(window.events, windowReceipt === '' ? header : `${windowReceipt}\n${header}`, maxChars, args.seq),
        );
      }
      const last = Math.max(0, session.seq - 1);
      // `turnStart` is scoped to the branch above, and this one needs it too: calling
      // `history_read` with no address at all crashed with "turnStart is not defined"
      // rather than reading the tail. Found by an acceptance run, not by the suite, so
      // the suite gets a case for it below.
      const { turnStart } = sessionSegments;
      const window = await query.readEvent({ sessionId: session.id, seq: last, before: 20, after: 0 });
      const tailHeader = 'no address given, so the tail of this session was read; pass "segment" or "seq" to aim it';
      const tailSeqs = window.events.map((event) => event?.seq).filter((seq) => Number.isSafeInteger(seq));
      const tailProbe = renderWindow(window.events, tailHeader, maxChars);
      const tailPartial = windowWasTruncated(tailProbe) ? { seq: null, start: 0, end: 0, total: null } : null;
      const tailReceipt = recordRetrieval(session.id, turnStart, tailSeqs, false, [], tailPartial);
      // No address was given, so nothing is named; the tail's last entry is the one worth
      // keeping when the budget cannot hold the whole window.
      return withCap(
        renderWindow(window.events, tailReceipt === '' ? tailHeader : `${tailReceipt}\n${tailHeader}`, maxChars, last),
      );
    },
  });
}

/** `history_search`: keyword search over old events, compacted ones included. */
/**
 * The seq bound each outstanding cursor was minted under.
 *
 * A cursor is only valid for an identical request, and the bound is one below the
 * assistant message that asked for the call — so it moves on every request. Left
 * to move, page 2 becomes a different request: events that appeared since page 1
 * join the candidate list, ties in the score sort put the newest seq first, and
 * the window slides back over what page 1 already returned. Remembering the bound
 * keeps the two calls identical, which is the only thing the cursor promises.
 *
 * Keyed by the whole request the cursor came from — session, query, scope and the
 * cursor text — rather than by session alone. A session-wide slot is displaced by
 * any other search in the same session, and two searches issued in one assistant
 * step are enough to bring the slide back.
 */
const searchBounds = new Map();

/** How many outstanding cursors to remember before the oldest is forgotten. */
const SEARCH_BOUND_MEMORY = 256;

/** The identity of one paginated search, as a map key. */
function searchBoundKey(sessionId, query, scope, cursor) {
  return `${sessionId}\u0000${query}\u0000${scope}\u0000${cursor}`;
}

/**
 * Our own cursor text for the fallback pager: the offset into the scored list,
 * then the seq bound the page was produced under.
 *
 * The bound travels INSIDE the cursor instead of only in the side table above.
 * A session-wide slot is displaced by any other search, and a slot keyed by
 * cursor text is displaced by a fresh mint of the same text; both put the sliding
 * window back, one page later each time it was patched. A cursor that carries its
 * own bound is self-contained, which is what a cursor is supposed to be. An empty
 * bound after the separator means "this search had no bound", which is different
 * from a cursor that carries none of our format at all.
 *
 * @param offset - index into the scored list.
 * @param bound - inclusive seq ceiling the page was produced under, if any.
 * @returns the cursor text handed to the caller.
 */
function encodeSearchCursor(offset, bound) {
  return typeof bound === 'number' && Number.isFinite(bound) && bound >= 0 ? `${offset}~${bound}` : `${offset}~`;
}

/**
 * Read back a cursor this plugin minted.
 *
 * @param text - cursor text supplied by the caller.
 * @returns the offset and bound, or null when the text is not ours (the indexed
 *   service issues its own opaque cursor, which the side table covers).
 */
function decodeSearchCursor(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d+)~(\d*)$/u.exec(text);
  if (match === null) return null;
  return { offset: Number(match[1]), bound: match[2].length === 0 ? undefined : Number(match[2]) };
}

export function historySearchTool(ctx, options) {
  return defineTool({
    name: 'history_search',
    description: [
      "Search this session's stored events by keyword and return bounded excerpts with event",
      'numbers. Compacted-away text is included, so this finds things the live context no',
      'longer shows. Read a hit in full with history_read and its event number.',
      `Returns at most ${HISTORY_SEARCH_MAX_LIMIT} hits of about ${HISTORY_SEARCH_SNIPPET_CHARS} characters each.`,
      RETRIEVAL_RECEIPT_NOTE,
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        description: 'Words to find. All words must appear, in order, ignoring case and line breaks.',
        required: true,
      },
      limit: {
        type: 'integer',
        description: `Maximum hits (default ${HISTORY_SEARCH_DEFAULT_LIMIT}, ceiling ${HISTORY_SEARCH_MAX_LIMIT}).`,
      },
      scope: {
        type: 'string',
        enum: ['all', 'shadowed'],
        description: 'Search every stored event (default) or only text replaced by a compaction.',
      },
      cursor: {
        type: 'string',
        description: 'Continuation cursor from a previous call, to read the next page of the same search.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const query = requireQuery(ctx);
      const limit = clampLimit(args.limit);
      const scope = args.scope ?? 'all';
      const cursor = typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : undefined;
      const filters = [];
      if (scope === 'shadowed') filters.push({ kind: 'surface', values: ['shadowed'] });
      // Bound the search below the assistant message that asked for it. Without
      // this the tool matches its own invocation: the `tool/call` event carrying
      // the query is already in the log by the time the handler runs, so every
      // search returns at least itself and an invented word comes back as
      // "found". The bound also keeps the current step's reasoning out, which is
      // noise for a tool whose job is finding what the live context no longer
      // shows.
      const own = decodeSearchCursor(cursor);
      const boundKey = cursor === undefined ? undefined : searchBoundKey(session.id, args.query, scope, cursor);
      // A cursor we cannot attribute is refused rather than served as page one.
      // Answering an unreadable continuation with the FIRST page looks like a
      // valid continuation, and this tool exists to be trusted about what the
      // history does and does not contain. Reachable when a caller retypes
      // "10~27" as "10", or reuses a cursor this process never minted.
      if (cursor !== undefined && own === null && !(boundKey !== undefined && searchBounds.has(boundKey))) {
        return [
          `This cursor was not issued by this session, or it was issued by a search that is no longer pending: ${JSON.stringify(cursor)}.`,
          'Re-run the search without "cursor" and page from the start.',
        ].join(' ');
      }
      // A cursor we minted states its own bound, INCLUDING the absence of one. An
      // empty bound means "this search ran unbounded", which is not the same as
      // "no pin found": `pinned ?? live` collapsed the two, so page 2 of an
      // unbounded search silently adopted a bound that appeared in between and
      // stopped being the same request the cursor was issued for.
      const boundary =
        own !== null
          ? own.bound
          : boundKey !== undefined && searchBounds.has(boundKey)
            ? searchBounds.get(boundKey)
            : options?.historyBoundary?.(session);
      if (typeof boundary === 'number' && Number.isFinite(boundary) && boundary >= 0) {
        filters.push({ kind: 'seq', to: boundary });
      }
      // A fresh call re-reads the bound; a continuation reuses its own.
      // The indexed search ranks and pages on the server. Reading every event and
      // slicing in memory would make `limit` a display cap rather than a bound on
      // the work done, which is exactly what the spec's pagination asks to avoid.
      const request = {
        sessionId: session.id,
        query: args.query,
        limit,
        ...(filters.length === 0 ? {} : { filters }),
        ...(cursor === undefined ? {} : { cursor }),
      };
      let page;
      try {
        page = await query.searchEvents(request);
      } catch (error) {
        // A profile without the full-text index still gets literal search.
        page = await filterSearchPage(query, session, args.query, filters, limit, cursor);
        if (page === null) throw error;
      }
      if (page.items.length === 0) {
        return cursor === undefined
          ? `No event in this session matches "${args.query}".`
          : `No further match for "${args.query}".`;
      }
      // One event read serves the segment directory and the turn boundary, so a hit
      // that is the asker's own words can be labelled rather than left to look like a
      // source. The order is the service's ranking and is not second-guessed here.
      const searchEvents_ = await readSessionEvents(ctx, session);
      const segments = deriveSegments(session, searchEvents_);
      const turnStart = deriveTurnStart(searchEvents_);
      let ownTurnHits = 0;
      // A page is bounded by rows, and rows are not bounded by characters: at the
      // documented ceiling of 100 rows this returned 40,000 characters in production
      // sizes and 400,000 in the worst case. Past the store ceiling the harness keeps
      // a silent prefix, so the caller would receive fewer hits than the header
      // claims with nothing to say so. The page is therefore bounded by characters
      // too, and what did not fit is reported rather than dropped quietly.
      const lines = [];
      const shownSeqs = [];
      const held = servedInTurn(session.id, turnStart);
      const alreadyHeldSeqs = [];
      let spent = 0;
      let dropped = 0;
      for (const hit of page.items) {
        // Incremental: an event this turn already handed back is not repeated. Its
        // content is already in the caller's context, so sending it again costs the
        // whole result's worth of tokens to say nothing. The count travels in the
        // receipt instead, because "5 matches, 3 of them yours already" and "2 matches"
        // are different findings and only one of them means the query needs rewording.
        if (held.has(hit.seq)) {
          alreadyHeldSeqs.push(hit.seq);
          continue;
        }
        const owner = segmentForSeq(segments, hit.seq);
        const where = owner === null ? '' : ` [segment ${owner.ordinal}]`;
        // The snippet and the address come from the SAME computation on purpose. The
        // search service's own snippet is centred by a rule this code does not control,
        // so pairing it with an offset found here would print a number pointing at
        // characters the visible excerpt does not contain — worse than printing no
        // number, because the caller would follow it and find nothing.
        //
        // What the address buys, measured: across the whole archive the model issued
        // 239 reads with no offset and 187 at round numbers it invented (70000, 80000,
        // 88000, 100000 …), and used a supplied offset exactly zero times. A hit line
        // that says `#8 message @74871 of 132920` is the difference between a location
        // and a shrug.
        // The indexed page carries `seq` and `type` and no body, so the address is read
        // back through the layer that holds the text. Without this the branch below never
        // fires in production and the line stays a snippet with no location — which is
        // what the first run of this change actually did, and why it was caught by
        // looking for the address in a real cell rather than by the unit tests.
        const located =
          typeof hit.text === 'string' && hit.text.length > 0
            ? locateAround(hit.text, args.query, HISTORY_SEARCH_SNIPPET_CHARS)
            : await locateHit(query, session, { ...hit, term: args.query }, filters);
        const snippet = located === null
          ? typeof hit.snippet === 'string' && hit.snippet.length > 0
            ? hit.snippet.slice(0, HISTORY_SEARCH_SNIPPET_CHARS)
            : '(no excerpt available; read it with history_read and its event number)'
          : located.text;
        // `not found` is a real and measured outcome, not a failure: the index matches
        // through tokenisation, so a hit can arrive whose text does not contain the
        // query's first word at all. Saying so is the whole point — the caller learns
        // the index is guessing rather than that the material is silent.
        const address =
          located === null ? '' : located.found ? ` @${located.offset} of ${located.total}` : ` @not found of ${located.total}`;
        const own = turnStart !== null && hit.seq >= turnStart ? ' [this turn, not a source]' : '';
        if (own !== '') ownTurnHits += 1;
        const line = `#${hit.seq} ${hit.type}${where}${own}${address}: ${snippet}`;
        if (spent + line.length > HISTORY_SEARCH_PAGE_BUDGET_CHARS) {
          dropped += 1;
          continue;
        }
        spent += line.length;
        lines.push(line);
        shownSeqs.push(hit.seq);
      }
      // Pin the bound this page's cursor will need, keyed by that cursor so an
      // unrelated search in the same session cannot displace it.
      // Written for continuations too, not only for the first page: a service
      // cursor has nowhere else to keep its bound, and page 3 needs the one page 2
      // minted just as much as page 2 needed page 1's.
      if (page.nextCursor !== undefined) {
        if (searchBounds.size >= SEARCH_BOUND_MEMORY) {
          searchBounds.delete(searchBounds.keys().next().value);
        }
        searchBounds.set(searchBoundKey(session.id, args.query, scope, page.nextCursor), boundary);
      }
      const footer =
        page.nextCursor === undefined
          ? ['', 'That is the last page.']
          : ['', `More matches exist; call again with cursor=${JSON.stringify(page.nextCursor)}.`];
      const ownNote = ownTurnHits > 0 ? ` ${ownTurnHits} are this turn's own messages, marked below.` : '';
      const heldNote = alreadyHeldSeqs.length === 0 ? '' : ` ${alreadyHeldSeqs.length} were already returned this turn and are left out.`;
      const summaryLine =
        dropped === 0
          ? `${page.items.length} matching event(s), strongest first.${heldNote}${ownNote}`
          : `${page.items.length} matching event(s), strongest first; ${lines.length} shown and ${dropped} omitted for size.${heldNote}${ownNote} Raise "limit" only if you need the smaller hits, or narrow the query:`;
      // The receipt counts what this page actually returned, not what matched. A hit
      // dropped for size was never shown, so calling it "already returned" would be a
      // claim about the caller's context that is not true.
      const receipt = recordRetrieval(session.id, turnStart, shownSeqs, true, alreadyHeldSeqs);
      return clampToStoreCeiling(
        [receipt === '' ? summaryLine : `${receipt}\n${summaryLine}`, ...lines, ...footer].join('\n'),
        TOOL_RESULT_STORE_CEILING_CHARS,
      );
    },
  });
}

/**
 * `history_find`: many query terms in one call, with a stopping rule.
 *
 * Why this tool exists, in the measurement that produced it: one session answered
 * two questions by issuing 139 `history_search` calls carrying 130 DISTINCT query
 * terms, nearly all of them rephrasings of the same two ideas (`压缩`, `gzip`,
 * `zstd`, `zip`, `不再压缩`, `二次压缩`, `压一遍`, `再套一层` …). The first hit
 * arrived at the second call, and 61% of all the calls came AFTER it, across 286
 * recorded sessions. So the cost was never "the search cannot find it"; it was
 * "a hit does not look like one, and nothing says the search is finished".
 *
 * Three properties answer that directly, and none of them needs a code runtime:
 *
 * 1. Every term is tried inside ONE tool call. The extra synonyms a model would
 *    have tried on later turns cost nothing, because a term costs a query against
 *    the session index rather than a round trip through the model.
 * 2. Each hit reports the offset the term was found at and the event's real
 *    length, so "1 matching event" in a 378,430-character message reads as a
 *    location instead of a shrug.
 * 3. `extract` states the stopping rule as a regular expression, and the search
 *    halts on the first event whose body matches. The model writes the rule it
 *    would otherwise apply one round trip at a time.
 *
 * @param ctx - plugin context carrying `sessionQuery`.
 * @param options - the per-session history boundary, shared with `history_search`.
 * @returns the tool definition.
 */
export function historyFindTool(ctx, options) {
  return defineTool({
    name: 'history_find',
    description: HISTORY_FIND_DESCRIPTION,
    parameters: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: HISTORY_FIND_QUERIES_DESCRIPTION,
      },
      extract: {
        type: 'string',
        description: HISTORY_FIND_EXTRACT_DESCRIPTION,
      },
      limit: {
        type: 'integer',
        description: `Hits kept per query term (default ${HISTORY_SEARCH_DEFAULT_LIMIT}, ceiling ${HISTORY_SEARCH_MAX_LIMIT}).`,
      },
      scope: {
        type: 'string',
        enum: ['all', 'shadowed'],
        description: 'Search every stored event (default) or only text replaced by a compaction.',
      },
      budgetChars: {
        type: 'integer',
        description: HISTORY_FIND_BUDGET_DESCRIPTION,
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const query = requireQuery(ctx);
      const terms = normalizeFindQueries(args.queries);
      if (terms.length === 0) {
        return 'history_find needs at least one non-empty query term; pass "queries" with the wordings to try.';
      }
      const limit = clampLimit(args.limit);
      const budget = clampFindBudget(args.budgetChars);
      const scope = args.scope === 'shadowed' ? 'shadowed' : 'all';
      const filters = [];
      if (scope === 'shadowed') filters.push({ kind: 'surface', values: ['shadowed'] });
      const boundary = options?.historyBoundary?.(session);
      if (typeof boundary === 'number' && Number.isFinite(boundary) && boundary >= 0) {
        filters.push({ kind: 'seq', to: boundary });
      }

      const extract = compileExtract(args.extract);
      if (extract.error !== null) return extract.error;

      // ---- 1) every term, in one call -------------------------------------
      const merged = new Map();
      const unsearchable = [];
      let truncatedTerms = 0;
      for (const term of terms) {
        let page;
        try {
          // The DISPLAY limit is the caller's; the probe limit is the ceiling. Asking
          // for more than we show costs index work but no model tokens, and it is the
          // only cheap way to answer "is this all of them" — the search page carries
          // `items` and `nextCursor` and NO total, so a count can only come from how
          // many rows we were willing to look at.
          page = await query.searchEvents({
            sessionId: session.id,
            query: term,
            limit: HISTORY_SEARCH_MAX_LIMIT,
            ...(filters.length === 0 ? {} : { filters }),
          });
        } catch (error) {
          // A profile without the full-text index still gets literal search, the
          // same fallback `history_search` takes.
          page = await filterSearchPage(query, session, term, filters, limit, undefined);
          if (page === null) {
            unsearchable.push(term);
            continue;
          }
        }
        if (page.nextCursor !== undefined) truncatedTerms += 1;
        // One entry per EVENT, not per (term, event). Several terms hitting the same
        // event used to occupy several lines, each repeating the same seq, type and
        // segment marker; the terms are collected instead, and the event is rendered
        // once.
        for (const hit of page.items ?? []) {
          if (typeof hit?.seq !== 'number') continue;
          const seen = merged.get(hit.seq);
          if (seen === undefined) merged.set(hit.seq, { seq: hit.seq, type: hit.type, terms: [term] });
          else if (!seen.terms.includes(term)) seen.terms.push(term);
        }
      }
      if (merged.size === 0) {
        const tried = terms.length === 1 ? `"${terms[0]}"` : `${terms.length} terms`;
        const note = unsearchable.length > 0 ? ' (this profile has no searchable index for these terms)' : '';
        const bound = typeof boundary === 'number' ? ` Nothing at or below event #${boundary} matched.` : '';
        return `No event in this session matches ${tried}${note}.${bound}`;
      }

      // ---- 2) one body read per event, then render --------------------------
      // Reading every candidate's body just to count its hits would make a wide term
      // expensive, so the loop stops as soon as the display budget is spent: the work
      // is bounded by what is actually shown, not by how many events matched.
      // One event read serves both the segment directory and the turn boundary.
      const events = await readSessionEvents(ctx, session);
      const segments = deriveSegments(session, events);
      const turnStart = deriveTurnStart(events);
      const originOf = (seq) => {
        const owner = segmentForSeq(segments, seq);
        return owner === null
          ? ''
          : ` [segment ${owner.ordinal}, replaced by summary #${owner.summarySeq}]`;
      };
      // A hit from this turn is the asker's own words — the question, or a tool result
      // that echoed it. Real sources come first so the first thing read is material,
      // and the turn's own messages stay visible at the end rather than disappearing:
      // dropping them would turn "you already said this" into "nothing matched".
      const isOwnTurn = (seq) => turnStart !== null && seq >= turnStart;
      const ownTurnCount = merged.size === 0 ? 0 : [...merged.keys()].filter(isOwnTurn).length;
      const ordered = [
        ...[...merged.values()].filter((entry) => !isOwnTurn(entry.seq)),
        ...[...merged.values()].filter((entry) => isOwnTurn(entry.seq)),
      ];

      // Incremental, same rule as `history_search`: an event this turn already handed
      // back is counted and left out rather than repeated. The count still reaches the
      // caller, so "matched nothing" and "matched only what you already have" stay
      // distinguishable — they call for opposite next moves.
      const held = servedInTurn(session.id, turnStart);
      const alreadyHeldCandidates = ordered.filter((candidate) => held.has(candidate.seq));
      const candidates = ordered.filter((candidate) => !held.has(candidate.seq));
      // A preview, not a passage. The cap is a constant rather than a share of the
      // budget so that a larger budget buys MORE events, each still cheap, instead of
      // one long quotation.
      const excerptChars = Math.max(120, Math.min(240, Math.floor(budget / 4)));
      const lines = [];
      const shownSeqs = [];
      let spent = 0;
      let omitted = 0;
      // Term-level tallies for the receipt, accumulated across every event the sweep
      // returns. An empty result says "nothing matched"; it does not say whether the
      // caller's wording exists anywhere in the session, and that is the question a
      // synonym loop is really asking.
      const presentTerms = new Set();
      const absentTerms = new Set();
      let scanned = 0;
      let stoppedEarly = false;
      for (const candidate of candidates) {
        const body = await readEventBody(query, session.id, candidate.seq);
        if (body === null) continue;
        scanned += 1;
        const found = countTermHits(body, candidate.terms);
        let matchAt = found.firstAt;
        if (extract.pattern !== null) {
          // `exec`, not `test`: the offset it returns is what the excerpt centres on.
          const match = extract.pattern.exec(body);
          if (match === null) continue;
          matchAt = match.index;
        }
        const view = snapWindow(body, matchAt, excerptChars);
        const lead = view.start > 0 ? '…' : '';
        const trail = view.end < view.total ? '…' : '';
        // The cheap index travels with the sentence: how many places in this event
        // mention the terms, and how long it is. Both are what the caller needs to
        // decide whether to spend a read on it, and neither costs a character of
        // quoted text.
        // Two different numbers, and conflating them would mislead: how many times the
        // terms appear literally, and where the caller's own stopping rule fired. A
        // term can match through the index without appearing literally (tokenisation,
        // stemming), so a zero literal count next to a search that DID match is
        // reported as exactly that rather than as "0 hits".
        const locatedTerms = locateTermHits(body, terms);
        for (const one of locatedTerms) (one.count > 0 ? presentTerms : absentTerms).add(one.term);
        const hits = locatedTerms.filter((one) => one.count > 0);
        const missing = locatedTerms.filter((one) => one.count === 0);
        const named = hits
          .slice(0, FIND_TERM_LIST_LIMIT)
          .map((one) => `${one.term}@${one.firstAt}`);
        const extraHits = hits.length - named.length;
        const namedMissing = missing.slice(0, FIND_TERM_LIST_LIMIT).map((one) => `${one.term} absent`);
        const extraMissing = missing.length - namedMissing.length;
        const addressParts = [...named, ...namedMissing];
        if (extraHits > 0) addressParts.push(`+${extraHits} more term(s) not listed`);
        if (extraMissing > 0) addressParts.push(`+${extraMissing} more absent`);
        // `not present literally` is the case where the index matched through
        // tokenisation and the text does not contain the term at all. It is reported as
        // exactly that rather than as "0 hits", because the two mean different things
        // and only one of them says the material is silent.
        // The per-term list rides on BOTH branches. On the zero branch it is the more
        // useful half: `not present literally` said the index had matched some other way
        // without ever naming which term, so a caller holding four terms learned nothing
        // about any of them.
        const addressSuffix = addressParts.length === 0 ? '' : ` (${addressParts.join(', ')})`;
        const literal =
          found.count > 0
            ? `${found.count} literal hit(s)${addressSuffix}`
            : `not present literally (the index matched it some other way)${addressSuffix}`;
        const at = extract.pattern !== null && matchAt >= 0 ? `; extract matched at ${matchAt + 1}` : '';
        const own = isOwnTurn(candidate.seq) ? ' [this turn, not a source]' : '';
        const head = `#${candidate.seq} ${String(candidate.type)}${originOf(candidate.seq)}${own}: ${literal}, ${body.length} chars${at}`;
        const line = `${head}\n  ${lead}${view.text}${trail}`;
        if (spent + line.length > budget) {
          omitted = candidates.length - lines.length;
          break;
        }
        spent += line.length;
        lines.push(line);
        shownSeqs.push(candidate.seq);
        if (extract.pattern !== null) {
          // The stopping rule is the caller's own statement of "this is enough", so
          // the first event it accepts ends the sweep. That is what turns a loop the
          // model used to run one round trip at a time into one call.
          stoppedEarly = true;
          break;
        }
      }
      if (lines.length === 0) {
        if (alreadyHeldCandidates.length > 0) {
          // Everything this query reaches is already in context. Returning an empty
          // list here would read as "no such material", which is the one wrong
          // conclusion available; naming the events makes it a pointer instead.
          const receipt = recordRetrieval(session.id, turnStart, [], true, alreadyHeldCandidates.map((candidate) => candidate.seq));
          return [
            receipt,
            `${alreadyHeldCandidates.length} event(s) matched, and this turn already returned every one of them:`,
            ...alreadyHeldCandidates.slice(0, 12).map((candidate) => `  #${candidate.seq} ${String(candidate.type)}`),
            'Read any of them in full with history_read, or answer from what you have and name the gap.',
          ].join('\n');
        }
        return [
          `Tried ${terms.length} term(s); ${candidates.length} event(s) matched, but none matched the extract pattern.`,
          scanned > 0 ? `Read ${scanned} event body(ies) looking for it.` : '',
        ]
          .filter((line) => line.length > 0)
          .join(' ');
      }

      const heldFindNote =
        alreadyHeldCandidates.length === 0
          ? ''
          : ` ${alreadyHeldCandidates.length} more matched but were already returned this turn and are left out.`;
      const countLine =
        `${candidates.length + alreadyHeldCandidates.length} event(s) matched in this session${heldFindNote}` +
        (ownTurnCount > 0 ? `; ${ownTurnCount} of them are this turn's own messages and are listed last` : '') +
        (truncatedTerms === 0
          ? '.'
          : `; at least one term has more matches than the ${HISTORY_SEARCH_MAX_LIMIT}-row ceiling, so the true total may be higher.`);
      const header = [
        `Tried ${terms.length} term(s) in one call.`,
        countLine,
        extract.pattern === null
          ? ''
          : `${lines.length} matched the extract pattern${stoppedEarly ? ', stopped at the first' : ''}.`,
        omitted > 0 ? `${lines.length} shown within the ${budget}-character budget.` : '',
      ]
        .filter((part) => part.length > 0)
        .join(' ');
      const footer =
        omitted > 0
          ? `\n${omitted} further event(s) omitted for budget. Narrow the terms, or raise "budgetChars".`
          : '';
      // Counts the events actually rendered, for the same reason `history_search` does:
      // an event dropped for budget was not returned to the caller.
      // Only terms that never landed anywhere are worth naming: a term that is present in
      // one event but not another is not absent, it is just elsewhere.
      const neverLanded = [...absentTerms].filter((term) => !presentTerms.has(term));
      const termNote =
        terms.length <= 1
          ? ''
          : `${presentTerms.size} of ${terms.length} term(s) present${neverLanded.length === 0 ? '' : `, absent everywhere: ${neverLanded.join(', ')}`}`;
      const receipt = recordRetrieval(session.id, turnStart, shownSeqs, true, alreadyHeldCandidates.map((candidate) => candidate.seq), null, termNote);
      const head = receipt === '' ? header : `${receipt}\n${header}`;
      return clampToStoreCeiling(`${head}\n${lines.join('\n')}${footer}`, TOOL_RESULT_STORE_CEILING_CHARS);
    },
  });
}

/** Trim, drop empties, de-duplicate and cap a `queries` argument. */
function normalizeFindQueries(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const term = typeof entry === 'string' ? entry.trim() : '';
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= HISTORY_FIND_MAX_QUERIES) break;
  }
  return out;
}

/** Clamp the per-term hit count the same way `history_search` does. */
function clampFindBudget(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HISTORY_FIND_DEFAULT_BUDGET_CHARS;
  return Math.min(HISTORY_FIND_MAX_BUDGET_CHARS, Math.max(1000, Math.trunc(value)));
}

/**
 * Compile the caller's stopping rule.
 *
 * A pattern the runtime rejects comes back as text rather than an exception: the
 * caller has to be told, and returning the message lets every other term in the
 * same call stay useful. The pattern is not sandboxed, so it runs against a
 * bounded slice — a backtracking expression over 378,430 characters is the
 * caller's problem to avoid, not the session's to survive.
 *
 * @param value - the `extract` argument.
 * @returns the compiled pattern, or an error message to return verbatim.
 */
function compileExtract(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return { pattern: null, error: null };
  const source = value.trim();
  if (source.length > 500) return { pattern: null, error: 'history_find: "extract" is limited to 500 characters.' };
  try {
    return { pattern: new RegExp(source, 'u'), error: null };
  } catch (error) {
    return { pattern: null, error: `history_find: "extract" is not a valid regular expression: ${String(error)}` };
  }
}

/** Read one event's body, or null when the service cannot produce it. */
async function readEventBody(query, sessionId, seq) {
  try {
    const window = await query.readEvent({ sessionId, seq, before: 0, after: 0 });
    const target = window?.target ?? window?.events?.[0] ?? null;
    return target === null ? null : eventBody(target);
  } catch {
    return null;
  }
}

/**
 * A hit's position inside its event, read back by seq through the one layer that holds the
 * body.
 *
 * The indexed page cannot answer this: it returns `seq` and `type` and no text, so a hit
 * line rendered from it can only offer a snippet with no address. That is the shape the
 * archive measured — 239 reads with no offset, 187 at round numbers the model invented,
 * and a supplied offset used zero times.
 */
async function locateHit(query, session, hit, filters) {
  const page = await filterSearchPage(query, session, hit.term, filters, 1, undefined);
  const item = page?.items?.find((entry) => entry.seq === hit.seq) ?? page?.items?.[0];
  if (item === undefined) return null;
  return { text: item.snippet, offset: item.offset, total: item.total, found: item.found };
}

/**
 * Literal-substring fallback for a profile whose full-text index is unavailable.
 *
 * @param query - session-query service.
 * @param session - session being searched.
 * @param text - the query text.
 * @param filters - metadata filters already prepared for the indexed call.
 * @param limit - page size.
 * @param cursor - continuation cursor holding an already-consumed seq offset.
 * @returns a page in the indexed call's shape, or null when the fallback cannot run.
 */
async function filterSearchPage(query, session, text, filters, limit, cursor) {
  if (typeof query.filterEvents !== 'function') return null;
  let hits;
  try {
    hits = await query.filterEvents(session.id, [...filters, { kind: 'text', text }]);
  } catch {
    return null;
  }
  const scored = hits
    .map((hit) => ({ hit, score: scoreText(hit.text, text) }))
    .sort((left, right) => right.score - left.score || right.hit.seq - left.hit.seq);
  const decoded = decodeSearchCursor(cursor);
  const offset = decoded === null ? 0 : decoded.offset;
  const ceiling = filters.find((filter) => filter.kind === 'seq')?.to;
  const window = scored.slice(offset, offset + limit);
  return {
    // `text`, `offset`, `total` and `found` ride along because this is the only layer that
    // HOLDS the body. The indexed page carries `seq` and `type` and nothing else, so a
    // caller that renders from it cannot say where inside the event a hit sits — which is
    // exactly the address the search was supposed to hand over. Computing it here costs
    // one query against the session index and no model round trip.
    items: window.map(({ hit }) => {
      const located = locateAround(hit.text, text, HISTORY_SEARCH_SNIPPET_CHARS);
      return {
        seq: hit.seq,
        type: hit.type,
        snippet: located.text,
        text: hit.text,
        offset: located.offset,
        total: located.total,
        found: located.found,
      };
    }),
    ...(offset + window.length < scored.length
      ? { nextCursor: encodeSearchCursor(offset + window.length, ceiling) }
      : {}),
  };
}

/** `notes_write`: append durable working notes for the next compaction. */
export function notesWriteTool(options) {
  return defineTool({
    name: 'notes_write',
    description: NOTES_WRITE_DESCRIPTION,
    parameters: {
      text: { type: 'string', description: 'A few lines of notes.', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          trimmed: { type: 'boolean' },
          chars: { type: 'integer' },
          droppedOlder: { type: 'boolean' },
          entryCut: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `not recorded: ${value.reason ?? 'notes mode is off'}` }];
        // A trimmed write must not come back as a bare acknowledgement. The
        // draft is bounded and the bound drops the OLDEST entries, so a plain
        // "ok" reads as "everything I wrote is there" when it is not. The
        // logger warning is not enough: this build prints no logger output at
        // all, so the tool result is the only channel the model actually sees.
        if (value.trimmed === true) {
          const parts = [];
          // The bound is NOTES_MAX_CHARS, never `value.chars`. `chars` is the
          // length left AFTER trimming, and trimming drops the oldest entries in
          // whole, so it lands well below the bound (4065 in the observed case).
          // Printing it as "its N-character limit" told the caller the draft's
          // ceiling was 4065 and understated the room left by a third.
          if (value.droppedOlder === true) {
            parts.push(
              `The draft holds at most ${NOTES_MAX_CHARS} characters, so the oldest entries were dropped to fit this one; it now holds ${value.chars ?? '?'}.`,
            );
          }
          // Said separately, because the two losses coexist: this entry can be
          // dropped-from and cut at the same time, and the older-loss sentence
          // alone would imply the new entry survived whole.
          if (value.entryCut === true) {
            parts.push(
              value.droppedOlder === true
                ? 'This entry was larger than the remaining room as well, so only its opening was kept.'
                : `This entry alone is larger than the ${NOTES_MAX_CHARS}-character draft, so only its opening was kept.`,
            );
          }
          if (parts.length === 0) {
            parts.push(`The draft is at its ${NOTES_MAX_CHARS}-character limit.`);
          }
          return [{ type: 'text', text: `${NOTES_WRITE_ACK} ${parts.join(' ')}` }];
        }
        return [{ type: 'text', text: NOTES_WRITE_ACK }];
      },
    },
    async execute(args, exec) {
      const session = requireSession(exec);
      // `modeFor` answers with the whole snapshot, so the gate reads one field
      // off it. Notes exist only to be merged into this plugin's summary, so the
      // gate is the compaction mode itself.
      if (options.modeFor(session)?.compaction !== 'plugin') {
        return { ok: false, reason: 'this session compacts with the shipped backend, so notes are off for it' };
      }
      try {
        const outcome = await options.noteStore.append(session.id, args.text);
        // The draft is bounded, and the bound drops the oldest entries. Saying so
        // is the difference between a deliberate policy and silent loss.
        if (outcome.trimmed === true) {
          options.warn?.(
            `the notes draft reached its ${NOTES_MAX_CHARS}-character limit; the oldest entries were dropped, leaving ${outcome.chars} characters`,
          );
          return {
            ok: true,
            trimmed: true,
            chars: outcome.chars,
            droppedOlder: outcome.droppedOlder,
            entryCut: outcome.entryCut,
          };
        }
        return { ok: true };
      } catch (error) {
        options.warn?.(`notes write failed: ${String(error)}`);
        return { ok: false, reason: 'write failed' };
      }
    },
  });
}

/** `notes_read`: read the live draft, or the notes archived under one segment. */
export function notesReadTool(options) {
  return defineTool({
    name: 'notes_read',
    description: NOTES_READ_DESCRIPTION,
    parameters: {
      segment: {
        type: 'integer',
        description: 'Read the notes archived under this segment number instead of the live draft.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const ordinal = args.segment;
      if (ordinal === undefined) {
        const draft = await options.noteStore.read(session.id);
        return draft.trim().length === 0
          ? 'No working notes have been written for this session.'
          : `Live notes draft for this session:\n\n${draft}`;
      }
      if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error('segment must be a non-negative integer');
      const archived = await options.noteStore.readArchive(session.id, ordinal);
      return archived.trim().length === 0
        ? `Segment ${ordinal} kept no notes.`
        : `Notes archived with segment ${ordinal}:\n\n${archived}`;
    },
  });
}

/** `notes_search`: keyword search over the draft and every archived segment. */
export function notesSearchTool(options) {
  return defineTool({
    name: 'notes_search',
    description: NOTES_SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', description: 'Words to find, ignoring case.', required: true },
      limit: { type: 'integer', description: 'Maximum lines to return (default 20, ceiling 100).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const limit = clampNoteLimit(args.limit);
      const haystacks = [{ label: 'draft', text: await options.noteStore.read(session.id) }];
      for (const name of await options.noteStore.listArchive(session.id)) {
        const ordinal = Number.parseInt(name.replace(/[^0-9]/gu, ''), 10);
        if (!Number.isInteger(ordinal)) continue;
        haystacks.push({
          label: `segment ${ordinal}`,
          text: await options.noteStore.readArchive(session.id, ordinal),
        });
      }
      const hits = searchNoteLines(haystacks, args.query, limit);
      if (hits.length === 0) return `No note line matches "${args.query}".`;
      return [`${hits.length} matching note line(s):`, ...hits.map((hit) => `${hit.label}: ${hit.line}`)].join('\n');
    },
  });
}

/**
 * Find note lines containing every word of a query.
 *
 * Notes are a few hundred lines at most, so a literal scan is both simpler and
 * cheaper than anything indexed, and it keeps working when notes mode was turned
 * off after the notes were written.
 *
 * @param haystacks - labelled note texts to scan.
 * @param query - words that must all appear, in order.
 * @param limit - maximum lines to return.
 * @returns matching lines with their source label.
 */
export function searchNoteLines(haystacks, query, limit) {
  const needle = String(query).trim().toLowerCase();
  if (needle.length === 0) return [];
  const words = needle.split(/\s+/u).filter((word) => word.length > 0);
  const out = [];
  for (const { label, text } of haystacks) {
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const hay = line.toLowerCase();
      let from = 0;
      let matched = true;
      for (const word of words) {
        const at = hay.indexOf(word, from);
        if (at === -1) {
          matched = false;
          break;
        }
        from = at + word.length;
      }
      if (!matched) continue;
      out.push({ label, line: line.length > 400 ? `${line.slice(0, 397)}...` : line });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Clamp the notes search line budget. */
function clampNoteLimit(value) {
  if (value === undefined) return 20;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

/** Resolve the calling agent's own session, or fail the call. */
function requireSession(exec) {
  const session = exec.agent?.session;
  if (session === undefined) throw new Error('this tool only works inside an agent turn');
  return session;
}

/** Resolve the session-query service, or fail with an actionable message. */
function requireQuery(ctx) {
  const query = ctx.get('sessionQuery');
  if (query === undefined) {
    throw new Error('session history review is unavailable: this deployment composes no session-query service');
  }
  return query;
}

/** Bound a requested character budget. */
function clampChars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HISTORY_READ_DEFAULT_CHARS;
  return Math.min(HISTORY_READ_MAX_CHARS, Math.max(1000, Math.trunc(value)));
}

/**
 * Count where any of `terms` occurs in `body`, and the first such offset.
 *
 * Offsets are deduplicated, so overlapping terms are not counted twice and the number
 * means "places in this event that mention what was asked for".
 *
 * @param body - the event body, in the same offset space the read uses.
 * @param terms - query terms, matched case-insensitively as literal text.
 * @returns the count and the first offset, or -1 when nothing matched.
 */
function countTermHits(body, terms) {
  const haystack = body.toLowerCase();
  // A Set of offsets plus `Math.min(...set)` looks tidy and dies on a large event: a
  // term that occurs 200,000 times produces 200,000 arguments and the spread exceeds
  // the call stack. The minimum is tracked as it goes instead.
  const starts = new Set();
  let firstAt = -1;
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      starts.add(at);
      if (firstAt === -1 || at < firstAt) firstAt = at;
      from = at + 1;
    }
  }
  return { count: starts.size, firstAt };
}

/**
 * Where each query term lands in one event, and how many places mention it.
 *
 * The count alone says how many places matched but not where any of them is. Measured
 * across the archive, the model issued 239 reads with no offset and 187 at round numbers
 * it invented (70000, 80000, 88000, 100000 …), and used a supplied offset zero times: it
 * had no address to use. This is what produces one.
 *
 * @param body - the event body, in the same offset space the read uses.
 * @param terms - query terms, matched case-insensitively as literal text.
 * @returns one entry per term, in the order given.
 */
function locateTermHits(body, terms) {
  const haystack = body.toLowerCase();
  return terms.map((term) => {
    const needle = term.toLowerCase();
    if (needle.length === 0) return { term, count: 0, firstAt: -1 };
    const at = haystack.indexOf(needle);
    if (at === -1) return { term, count: 0, firstAt: -1 };
    let count = 1;
    for (let from = at + 1; ; ) {
      const next = haystack.indexOf(needle, from);
      if (next === -1) break;
      count += 1;
      from = next + 1;
    }
    return { term, count, firstAt: at };
  });
}

/** Bound a requested context window. */
function clampContext(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HISTORY_READ_CONTEXT_EVENTS;
  return Math.min(50, Math.max(0, Math.trunc(value)));
}

/** Bound a requested hit count. */
function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HISTORY_SEARCH_DEFAULT_LIMIT;
  return Math.min(HISTORY_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

export default { registerTools, historySegmentsTool, historyReadTool, historySearchTool, notesWriteTool };
