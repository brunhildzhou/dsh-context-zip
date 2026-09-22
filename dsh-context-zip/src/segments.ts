/**
 * Segment index projection: the read-only, recomputable directory of this
 * session's own compactions.
 *
 * The projection is derived from the log every time it is asked for. Two log
 * facts decide the numbering:
 *
 * - the inherited seed prefix is excluded, so a forked child numbers only the
 *   compactions it produced itself and never learns that it was forked.
 * - the `compaction/summary` event is the authoritative record of one
 *   compaction: its identity, the surface span it replaced, and the exact set of
 *   shadowed events.
 *
 * Nothing here is persisted; no second source of truth exists.
 *
 * @module dsh-context-zip/segments
 */

import { SEQ_LIST_HEAD, SEQ_LIST_TAIL } from 'dsh-context-zip/engine/prompt';

/**
 * Read this session's complete event log.
 *
 * The live in-memory log is authoritative and cheap; a session that is not live
 * in this process is read back through the session-query service.
 *
 * @param ctx - context, for the session-query fallback.
 * @param session - session to read.
 * @returns the raw events in ascending seq order.
 */
export async function readSessionEvents(ctx, session) {
  // The live Session's own reader comes FIRST, and the query service is only a
  // fallback. Reversing these two breaks every seeded (forked) session:
  // `sessionQuery.readSession` rebuilds through `Session.create()`, which rejects
  // a seeded session whose log has grown past its inherited prefix
  // ("seeded session constructor seed must equal its inherited prefix"). A fork
  // that has compacted even once is exactly that, so every review tool threw and
  // the model got a raw constructor error as its tool result.
  //
  // `snapshotEvents()` is authoritative for a session we hold: it IS the log,
  // with no reconstruction step that can disagree with it.
  try {
    const own = session.snapshotEvents();
    if (Array.isArray(own)) return [...own];
  } catch (error) {
    ctx.logger?.debug?.(`[context-zip] the live session log was unreadable, falling back to the query service: ${String(error)}`);
  }
  // The query path rebuilds through `Session.create`, which rejects a seeded
  // session that has grown past its inherited prefix — precisely the state a fork
  // reaches after one compaction. So it is only a safe fallback for an unseeded
  // session; for a seeded one, surface the original failure instead of swapping in
  // an error from a path that could never have answered.
  //
  // `ContextZipService.sessionFor` restores an offline session through
  // `Session.fromRestore` before it ever gets here, so reaching this branch with a
  // seeded session means the live log was unreadable AND the session is a fork.
  if (session.header?.isSeeded === true) return [];
  const query = ctx.get('sessionQuery');
  if (query === undefined) return [];
  const snapshot = await query.readSession(session.id);
  return snapshot.events;
}

/**
 * Resolve the first seq of this session's own history.
 *
 * A forked child's log begins with the parent's prefix; everything before this
 * boundary belongs to the parent and is deliberately not numbered here. The
 * durable answer is the last `session/end-seed` marker, because a detached
 * replay of an untouched session can carry a `firstLiveSeq` equal to the whole
 * log; the in-process field is the exact answer when it is smaller.
 *
 * @param session - session whose boundary is resolved.
 * @param events - its complete raw event log.
 * @returns the first seq this session owns.
 */
export function ownHistoryStart(session, events) {
  if (session.header?.isSeeded !== true) return 0;
  // The durable fork-lineage cut is the primary answer: it is persisted with the
  // session, identical in every process, and unaffected by how this particular
  // instance happened to be constructed.
  const inherited = toNonNegativeInt(session.inheritedEventCount);
  if (inherited > 0 && inherited <= events.length) return inherited;
  let marker = 0;
  for (const event of events) {
    if (event.type === 'session/end-seed') marker = toNonNegativeInt(event.seq) + 1;
  }
  const live = toNonNegativeInt(session.firstLiveSeq);
  if (marker > 0) return marker;
  return live > 0 && live <= events.length ? live : 0;
}

/**
 * Derive the segment directory of one session.
 *
 * @param session - session whose own compactions are numbered.
 * @param events - its complete raw event log.
 * @returns segment descriptors in ordinal order.
 */
export function deriveSegments(session, events) {
  const start = ownHistoryStart(session, events);
  const segments = [];
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue;
    if (toNonNegativeInt(event.seq) < start) continue;
    const data = event.data;
    const ordinal = segments.length;
    segments.push({
      ordinal,
      id: `${session.id}#${ordinal}`,
      compactionId: String(data.compactionId),
      summarySeq: toNonNegativeInt(event.seq),
      shadowedRange: {
        start: toNonNegativeInt(data.shadowedRange?.start),
        end: toNonNegativeInt(data.shadowedRange?.end),
      },
      shadowedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.map(toNonNegativeInt) : [],
      tokenCount: toNonNegativeInt(data.shadowedTokenCount),
      label: labelFromSummary(data.summary, ordinal),
    });
  }
  return segments;
}

/**
 * The seq where the turn being answered begins, or null when it cannot be told.
 *
 * A review tool searches the session it is running inside, so the most relevant
 * "hit" is often the asker's own words: a query about a port number matches the
 * question that asks about that port number, and matches the tool results that echoed
 * it. Those are not sources, and on a real run two of three reported events were
 * exactly that, which spends the caller's attention on text it wrote itself.
 *
 * The last `user/message` is the question, so everything at or after it belongs to
 * this turn. Earlier user messages stay in scope, which matters because the material
 * under review is itself a user message.
 *
 * @param events - the session's events in ascending seq order.
 * @returns the seq of the newest `user/message`, or null when there is none.
 */
export function deriveTurnStart(events) {
  let start = null;
  for (const event of events) {
    if (event?.type !== 'user/message') continue;
    const seq = toNonNegativeInt(event.seq);
    if (start === null || seq > start) start = seq;
  }
  return start;
}

/**
 * Derive one session's segment directory through the service.
 *
 * @param ctx - context carrying the session-query service.
 * @param session - session to describe.
 * @returns segment descriptors in ordinal order.
 */
export async function loadSegments(ctx, session) {
  return deriveSegments(session, await readSessionEvents(ctx, session));
}

/**
 * Segments and the current turn boundary, from ONE event read.
 *
 * Both values come from the same event list and each caller used to read the whole
 * session for its own half. Pairing them keeps a ledger-annotated `history_read`
 * from paying a second full read just to learn where the turn starts.
 *
 * @param ctx - plugin context carrying the session query service.
 * @param session - session to read.
 * @returns the segment directory and the seq the current turn starts at (or null).
 */
export async function loadSegmentsAndTurn(ctx, session) {
  const events = await readSessionEvents(ctx, session);
  return { segments: deriveSegments(session, events), turnStart: deriveTurnStart(events) };
}

/**
 * Find the segment that owns one event seq.
 *
 * A seq inside a segment's shadowed set is the precise answer; otherwise the
 * seq falls after every segment whose summary precedes it, which is what makes a
 * range scan on a surface position meaningful.
 *
 * @param segments - the directory to search.
 * @param seq - event seq to locate.
 * @returns the owning segment, or null when the seq precedes every compaction.
 */
export function segmentForSeq(segments, seq) {
  const target = toNonNegativeInt(seq);
  let containing = null;
  for (const segment of segments) {
    if (segment.shadowedSeqs.includes(target)) containing = segment;
  }
  if (containing !== null) return containing;
  let latest = null;
  for (const segment of segments) {
    if (segment.summarySeq <= target) latest = segment;
  }
  return latest;
}

/**
 * Pull a one-line label out of a summary's content blocks.
 *
 * The first non-heading, non-empty line wins. The label is a directory entry,
 * never an authority: the summary itself stays the source of truth.
 *
 * @param summary - content blocks of the `compaction/summary` event.
 * @param ordinal - ordinal used as the fallback label.
 * @returns one bounded line.
 */
export function labelFromSummary(summary, ordinal) {
  const text = blocksToText(summary);
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^[#>*\-\s]+/u, '').trim();
    if (line.length === 0) continue;
    if (/^(Goal and intent|Decisions|Current state|Next steps|Anchors)$/iu.test(line)) continue;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return `segment ${ordinal}`;
}

/**
 * Join the text blocks of a content-block array.
 *
 * @param blocks - content blocks of any kind; non-text blocks contribute nothing.
 * @returns newline-joined text.
 */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Render a shadowed-seq list compactly for a directory line.
 *
 * @param seqs - shadowed seqs in surface order.
 * @returns a comma-separated list, elided in the middle when long.
 */
export function compactSeqList(seqs) {
  if (seqs.length <= SEQ_LIST_HEAD + SEQ_LIST_TAIL) return seqs.join(',');
  const head = seqs.slice(0, SEQ_LIST_HEAD).join(',');
  const tail = seqs.slice(-SEQ_LIST_TAIL).join(',');
  return `${head},…,${tail}`;
}

/** Render one segment as a single directory line. */
export function describeSegment(segment) {
  return `${segment.ordinal}. ${segment.label} (events ${compactSeqList(segment.shadowedSeqs)}, ~${segment.tokenCount} tokens, summary seq ${segment.summarySeq}, id ${segment.compactionId})`;
}

/** Coerce an untrusted value to a non-negative integer. */
function toNonNegativeInt(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * The context window named by the session's most recent `request/context` event.
 *
 * The event is the harness's own record of the route a request went out on, so a
 * session that switched models mid-flight carries both windows and the LAST one is
 * the one in force. Reading it is what keeps this plugin's pressure ratio
 * comparable with the number the context meter shows: the agent's own `options`
 * are fixed at build time and still name the route the session started on.
 *
 * @param events - raw session events in ascending seq order.
 * @returns the last positive window, or null when the session has no such event.
 */
export function latestContextWindow(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'request/context') continue;
    const window = event.data?.contextWindow;
    if (typeof window === 'number' && window > 0) return window;
  }
  return null;
}

export default {
  readSessionEvents,
  latestContextWindow,
  deriveTurnStart,
  ownHistoryStart,
  deriveSegments,
  loadSegments,
  segmentForSeq,
  labelFromSummary,
  blocksToText,
  compactSeqList,
  describeSegment,
};
