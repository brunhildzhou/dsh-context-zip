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
/**
 * Turn the throttle on or off.
 *
 * @param on - true to let the throttle change tool behavior.
 */
export declare function setThrottleEnabled(on: any): void;
/**
 * Install the trace destination.
 *
 * @param path - file to append JSONL to, or null to turn tracing off.
 */
export declare function setTracePath(path: any): void;
/**
 * Install the narrowing listener.
 *
 * @param listener - receives the session and whether its sweep tools should be hidden.
 */
export declare function setThrottleListener(listener: any): void;
/**
 * Register every tool this plugin contributes.
 *
 * @param ctx - plugin context carrying `tools`.
 * @param options - session-scoped notes access and the per-session mode lookup.
 * @returns the disposer for everything registered.
 */
export declare function registerTools(ctx: any, options: any): () => void;
/** `history_segments`: the directory of this session's own compactions. */
export declare function historySegmentsTool(ctx: any): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** `history_read`: read original text by segment number or by event number. */
export declare function historyReadTool(ctx: any): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function historySearchTool(ctx: any, options: any): import("@deepseek-ai/dsh-tools").ToolDefinition;
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
export declare function historyFindTool(ctx: any, options: any): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** `notes_write`: append durable working notes for the next compaction. */
export declare function notesWriteTool(options: any): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** `notes_read`: read the live draft, or the notes archived under one segment. */
export declare function notesReadTool(options: any): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** `notes_search`: keyword search over the draft and every archived segment. */
export declare function notesSearchTool(options: any): import("@deepseek-ai/dsh-tools").ToolDefinition;
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
export declare function searchNoteLines(haystacks: any, query: any, limit: any): any[];
declare const _default: {
    registerTools: typeof registerTools;
    historySegmentsTool: typeof historySegmentsTool;
    historyReadTool: typeof historyReadTool;
    historySearchTool: typeof historySearchTool;
    notesWriteTool: typeof notesWriteTool;
};
export default _default;
