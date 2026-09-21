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
export declare function readSessionEvents(ctx: any, session: any): Promise<any>;
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
export declare function ownHistoryStart(session: any, events: any): number;
/**
 * Derive the segment directory of one session.
 *
 * @param session - session whose own compactions are numbered.
 * @param events - its complete raw event log.
 * @returns segment descriptors in ordinal order.
 */
export declare function deriveSegments(session: any, events: any): any[];
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
export declare function deriveTurnStart(events: any): any;
/**
 * Derive one session's segment directory through the service.
 *
 * @param ctx - context carrying the session-query service.
 * @param session - session to describe.
 * @returns segment descriptors in ordinal order.
 */
export declare function loadSegments(ctx: any, session: any): Promise<any[]>;
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
export declare function loadSegmentsAndTurn(ctx: any, session: any): Promise<{
    segments: any[];
    turnStart: any;
}>;
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
export declare function segmentForSeq(segments: any, seq: any): any;
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
export declare function labelFromSummary(summary: any, ordinal: any): string;
/**
 * Join the text blocks of a content-block array.
 *
 * @param blocks - content blocks of any kind; non-text blocks contribute nothing.
 * @returns newline-joined text.
 */
export declare function blocksToText(blocks: any): string;
/**
 * Render a shadowed-seq list compactly for a directory line.
 *
 * @param seqs - shadowed seqs in surface order.
 * @returns a comma-separated list, elided in the middle when long.
 */
export declare function compactSeqList(seqs: any): any;
/** Render one segment as a single directory line. */
export declare function describeSegment(segment: any): string;
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
export declare function latestContextWindow(events: any): number;
declare const _default: {
    readSessionEvents: typeof readSessionEvents;
    latestContextWindow: typeof latestContextWindow;
    deriveTurnStart: typeof deriveTurnStart;
    ownHistoryStart: typeof ownHistoryStart;
    deriveSegments: typeof deriveSegments;
    loadSegments: typeof loadSegments;
    segmentForSeq: typeof segmentForSeq;
    labelFromSummary: typeof labelFromSummary;
    blocksToText: typeof blocksToText;
    compactSeqList: typeof compactSeqList;
    describeSegment: typeof describeSegment;
};
export default _default;
