/**
 * Event rendering for the review tools.
 *
 * Review answers in plain text by design: the model reads a bounded excerpt,
 * decides whether it needs more, and asks again with a tighter address. Every
 * renderer here is pure, so the transcript shape can be tested without a live
 * session.
 *
 * @module dsh-context-zip/transcript
 */
/**
 * Project one stored session event into transcript text.
 *
 * @param event - a raw session event.
 * @returns one or more lines; structural events render as a bare header.
 */
export declare function renderEvent(event: any): string;
/**
 * @param events - the window, in source order.
 * @param maxChars - character budget.
 * @param targetSeq - the event the caller actually addressed, when there is one. Blocks
 *   before it are given up so that it is always rendered. Pass null for a plain window.
 * @returns the text, whether it was cut, and `shown`: the entry range that actually landed
 *   (`from`, `to`, `count`, `total`) plus whether the last landed entry is only a head.
 */
export declare function renderTranscript(events: any, maxChars?: number, targetSeq?: any): {
    text: string;
    truncated: boolean;
    shown: {
        from: any;
        to: any;
        count: number;
        total: number;
        clipped: boolean;
    };
};
/**
 * Render one transcript with its address header.
 *
 * @param events - events in ascending seq order.
 * @param header - address lines describing what was read.
 * @param maxChars - hard character budget.
 * @returns the complete tool text.
 */
/**
 * Did `renderTranscript` cut the window short?
 *
 * `renderWindow` returns a string, so the flag that says whether every event fitted is
 * otherwise lost, and the caller cannot tell "here is the whole event" from "here is as
 * much of it as fitted". The retrieval throttle has to tell those apart: marking a
 * truncated read as complete would hide the event from later searches, which is the
 * exact defect the coverage table exists to fix.
 *
 * @param text - the rendered text.
 * @returns true when the renderer reported truncation.
 */
export declare function windowWasTruncated(text: any): any;
/**
 * @param events - the window, in source order.
 * @param header - the line saying where this window sits.
 * @param maxChars - character budget.
 * @param targetSeq - the event the caller addressed, or null. Passed through so that the
 *   addressed entry is rendered even when its neighbours are longer than the budget.
 */
export declare function renderWindow(events: any, header: any, maxChars: any, targetSeq?: any): string;
/** Describe a shadowed surface-position span. */
export declare function describeRange(range: any): string;
/** Describe a seq list compactly. */
export declare function describeSeqs(seqs: any): string;
/**
 * Build the excerpt shown for one search hit.
 *
 * @param text - the event's searchable text.
 * @param query - the user's query, used to centre the excerpt.
 * @param maxChars - excerpt bound.
 * @returns a single-line excerpt.
 */
export declare function excerptAround(text: any, query: any, maxChars: any): string;
/**
 * Locate where a query sits inside an event's text, and excerpt around it.
 *
 * `excerptAround` returns the excerpt alone, so a caller that gets back
 * "…something that may or may not contain your words…" cannot tell a real hit
 * from an event that merely scored well: the first search that founded this
 * plugin's review tools returned "1 matching event" with a 400-character window
 * taken from a 378,430-character message, and the window held none of the query
 * terms. The model then re-ran the same search with a synonym, 139 times in one
 * turn. Reporting the offset and the event's true size is what lets it stop.
 *
 * The match is the first whitespace-delimited term of the query, matched
 * case-insensitively against the flattened text, which is the same rule
 * `excerptAround` centres on.
 *
 * @param text - the event's searchable text.
 * @param query - the query whose first term to locate.
 * @param maxChars - excerpt bound.
 * @returns the excerpt plus `offset` (match index in the flattened text, or -1),
 *   `total` (flattened length) and `found`.
 */
export declare function locateAround(text: any, query: any, maxChars: any): {
    text: string;
    offset: any;
    total: number;
    found: boolean;
};
/**
 * Choose the excerpt shown for one hit.
 *
 * A fixed-width window centred on the match cuts mid-sentence and mid-token, so the
 * caller cannot quote what it is shown and goes looking again — which is the churn
 * this tool exists to remove. So the window is the containing SENTENCE, which is the
 * smallest unit that can be quoted as it stands:
 *
 *   1. the containing sentence, when it fits the bound;
 *   2. otherwise a raw cut, marked with ellipses because it is a cut.
 *
 * The bound is a cap, never a target. Filling it with neighbouring sentences makes
 * every later turn carry text the caller did not ask for, so a caller who wants the
 * surroundings reads them with `history_read {seq, offset}` instead.
 *
 * Snapping changes WHICH characters are shown, never the truth of the offsets: the
 * returned `start` and `end` are where the excerpt actually begins and ends, so a
 * caller can feed them straight back into `history_read`.
 *
 * @param text - the event body, whitespace preserved (the offset space).
 * @param at - the match offset, or -1 to take the head.
 * @param maxChars - excerpt bound.
 * @returns the excerpt plus its exact `start`, `end` and `total`.
 */
export declare function snapWindow(text: any, at: any, maxChars: any): {
    text: string;
    start: any;
    end: any;
    total: number;
    snapped: boolean;
    cut: boolean;
};
/**
 * Excerpt a body around a known offset.
 *
 * `locateAround` finds the offset from the query term, which is the right centre
 * for a plain search: the caller asked for that word. It is the WRONG centre once
 * a stopping rule has fired, because the caller asked for a pattern and the term
 * that surfaced the event need not appear in it at all — centring on the term then
 * returns a window that shows everything except the thing that was being looked
 * for. This entry point takes the offset the pattern matched at instead.
 *
 * @param text - already-flattened body text.
 * @param at - the offset to centre on, or -1 to take the head.
 * @param maxChars - excerpt bound.
 * @returns the excerpt plus `offset`, `total` and `found`.
 */
export declare function locateAt(text: any, at: any, maxChars: any): {
    text: string;
    offset: any;
    total: number;
    found: boolean;
};
/** Count case-insensitive occurrences of one query's terms. */
export declare function scoreText(text: any, query: any): number;
/**
 * Join the text of a content-block array.
 *
 * A `tool-result` block nests the tool's own blocks, and a tool result is the
 * one thing a reader most often wants back, so that nesting is followed instead
 * of being dropped.
 */
export declare function textOf(blocks: any): string;
/**
 * The readable body of one event, for a caller that wants to search it rather
 * than display it: no seq header, no indentation, and no per-event character
 * bound, because a stopping rule that only reads the first 1200 characters of a
 * 378,430-character event is the same defect this tool exists to fix.
 *
 * @param event - a stored event node.
 * @returns its text, or an empty string for a type that carries none.
 */
export declare function eventBody(event: any): string;
declare const _default: {
    locateAt: typeof locateAt;
    snapWindow: typeof snapWindow;
    renderEvent: typeof renderEvent;
    renderTranscript: typeof renderTranscript;
    renderWindow: typeof renderWindow;
    describeRange: typeof describeRange;
    describeSeqs: typeof describeSeqs;
    excerptAround: typeof excerptAround;
    scoreText: typeof scoreText;
    textOf: typeof textOf;
};
export default _default;
