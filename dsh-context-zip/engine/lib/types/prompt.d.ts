/**
 * Prompt and copy constants for dsh-context-zip.
 *
 * Every model-facing string lives here so the wording can be revised without
 * touching behavior. The five section headings are contractual: the same set
 * appears in the summarizer instruction, in the segment label heuristic, and in
 * the documentation.
 *
 * @module dsh-context-zip/prompt
 */
/** Heading of section 1 of the five-section handoff summary. */
export declare const H_GOAL = "Goal and intent";
/** Heading of section 2 of the five-section handoff summary. */
export declare const H_DECISIONS = "Decisions";
/** Heading of section 3 of the five-section handoff summary. */
export declare const H_STATE = "Current state";
/** Heading of section 4 of the five-section handoff summary. */
export declare const H_NEXT = "Next steps";
/** Heading of section 5 of the five-section handoff summary. */
export declare const H_ANCHORS = "Anchors";
/**
 * Section headings the summary must contain to be accepted.
 *
 * Declared here, ABOVE every instruction that names the headings, rather than next
 * to {@link SUMMARY_MIN_HEADINGS}: `REWRITE_INSTRUCTION` interpolates this list at
 * module-evaluation time, and a `const` read before its declaration sits in the
 * temporal dead zone. Moving the declaration above its first reader is the fix, and
 * it costs nothing.
 */
export declare const SUMMARY_HEADINGS: string[];
/** Soft size target written into the summarizer instruction, in tokens. */
export declare const SUMMARY_SOFT_TARGET_TOKENS = 3072;
/**
 * Hard generation cap for one summarization call, in tokens.
 *
 * Sent as the provider `maxTokens` and recorded on the `compaction/summary`
 * event. A reasoning summarizer spends part of this budget on reasoning, so the
 * visible summary may land shorter than this number.
 */
export declare const SUMMARY_HARD_CAP_TOKENS = 6144;
/** Percentage of the routed context window at which the notes reminder fires. */
export declare const REMINDER_THRESHOLD_PERCENT = 75;
/** Maximum characters kept in one session's live notes draft. */
export declare const NOTES_MAX_CHARS = 6000;
/** Default page size of `history_search`. */
export declare const HISTORY_SEARCH_DEFAULT_LIMIT = 20;
/** Hard page size of `history_search`. */
export declare const HISTORY_SEARCH_MAX_LIMIT = 100;
/** Characters of context kept around one `history_search` match. */
export declare const HISTORY_SEARCH_SNIPPET_CHARS = 400;
/**
 * Character bound for one rendered page of `history_search`.
 *
 * `HISTORY_SEARCH_MAX_LIMIT` bounds rows, and rows do not bound characters: at 100
 * rows of production-sized snippets this page reached 40,000 characters, well past
 * the store ceiling, where the harness keeps a silent prefix. The budget is what
 * actually keeps the promise the header makes about how many hits are shown.
 */
export declare const HISTORY_SEARCH_PAGE_BUDGET_CHARS = 4000;
/**
 * Most query terms one `history_find` call may carry.
 *
 * The measured problem this tool exists for is synonym enumeration: one session
 * issued 139 searches carrying 130 distinct queries, almost all of them
 * rephrasings of the same two ideas. Capping the batch well above any hand-written
 * synonym list keeps one call enough, while keeping the parameter schema bounded.
 */
export declare const HISTORY_FIND_MAX_QUERIES = 32;
/** Default character budget for one `history_find` result. */
export declare const HISTORY_FIND_DEFAULT_BUDGET_CHARS = 1200;
/** Hard character budget for one `history_find` result. */
export declare const HISTORY_FIND_MAX_BUDGET_CHARS = 4000;
/** Tool description for `history_find`. */
export declare const RETRIEVAL_RECEIPT_NOTE: string;
export declare const HISTORY_FIND_DESCRIPTION: string;
/**
 * The retrieval receipt contract, shared by both discovery tools.
 *
 * Placed in the descriptions rather than in an injected message on purpose: the tools
 * are where a caller reads about a tool's output, and injecting a system message would
 * add an event to the session, which the no-event-splitting rule exists to prevent.
 */
/** Parameter description for `history_find`'s `queries`. */
export declare const HISTORY_FIND_QUERIES_DESCRIPTION: string;
/** Parameter description for `history_find`'s `extract`. */
export declare const HISTORY_FIND_EXTRACT_DESCRIPTION: string;
/** Parameter description for `history_find`'s `budgetChars`. */
export declare const HISTORY_FIND_BUDGET_DESCRIPTION: string;
/** Default character budget of one `history_read` transcript. */
export declare const HISTORY_READ_DEFAULT_CHARS = 1500;
/** Hard character budget of one `history_read` transcript. */
export declare const HISTORY_READ_MAX_CHARS = 6000;
/**
 * Every ceiling above stays under this, and that is the point.
 *
 * The harness stores a tool result of about 18,000 characters and DROPS the rest
 * without a marker. A tool that returns more than that is not returning more: the
 * model receives a silent prefix, while any range the tool printed in its own header
 * describes text that never arrived. That is worse than a small answer, because the
 * caller has no way to know which part it is missing — and "read the passage, then
 * quote it" is exactly the job here.
 *
 * So the bounds are set below the observed store ceiling with margin. Sizes were
 * measured, not guessed: a 45,000-character read was stored as 18,200.
 */
export declare const TOOL_RESULT_STORE_CEILING_CHARS = 6000;
/**
 * The ceiling that actually binds, and it is a BYTE ceiling.
 *
 * The harness keeps roughly 50 KiB of a tool result and drops the rest without a
 * marker — the same 50 KiB its own `read` tool caps at (`READ_MAX_BYTES`). A
 * character bound therefore does not bound anything: 12,000 CJK characters are
 * 36,000 bytes, so a "small" answer can still be clipped, and a clipped answer is
 * worse than a short one because the header describes text that never arrived.
 *
 * Both bounds are applied and whichever binds first wins.
 */
export declare const TOOL_RESULT_STORE_CEILING_BYTES: number;
/** UTF-8 size of a string, for the byte ceiling. */
export declare function utf8Bytes(text: any): number;
/**
 * Trim `text` to fit both ceilings without splitting a surrogate pair.
 *
 * @param text - the string to bound.
 * @param maxChars - character bound.
 * @returns the text, cut to whichever ceiling binds first.
 */
export declare function clampToStoreCeiling(text: any, maxChars: any): string;
/** Events of raw context kept on each side of a sequence-addressed read. */
export declare const HISTORY_READ_CONTEXT_EVENTS = 2;
/** Characters kept from one event by the transcript renderer. */
export declare const EVENT_TEXT_CHARS = 1200;
/** Shadowed sequence numbers listed verbatim before elision. */
export declare const SEQ_LIST_HEAD = 12;
/** Shadowed sequence numbers listed verbatim after elision. */
export declare const SEQ_LIST_TAIL = 4;
/** The summarizer instruction appended after the replayed conversation. */
export declare const SUMMARY_INSTRUCTION: string;
/**
 * System instruction for the summarization call.
 *
 * The call must not inherit the conversation's own system prompt: that prompt
 * tells the model it is a coding agent with tools, and a summarization request
 * carrying the conversation's last instruction ("call the bash tool first")
 * makes the model either call a tool or, when no roster is offered, write the
 * tool-call markup out as prose. Both outcomes replace the compacted history
 * with a transcript of a tool call instead of a summary. This prompt says what
 * the call actually is.
 */
export declare const SUMMARY_SYSTEM_INSTRUCTION: string;
/**
 * System instruction for the layout-only rewrite call.
 *
 * The call is given ONE input: the summary text. It never sees the conversation
 * it summarises, which is what keeps the call cheap and what makes the guard
 * meaningful — a rewriter that cannot see new material has no source to invent
 * from, so any token it adds is a stylistic rewrite of something already there.
 */
export declare const REWRITE_SYSTEM_INSTRUCTION: string;
/**
 * The single user message of a layout-only rewrite call.
 *
 * Deliberately explicit about the three ways a "reformat" turns into a rewrite —
 * re-wording, tidy-up of identifiers, and dropping what looks redundant — because
 * each of them changes what a later model can find, which is the whole reason
 * this call exists.
 *
 * The line-3 clause about breaking paths is the fourth one, and it is the only
 * one whose damage is invisible to the rewriter: a wrap that lands inside a path
 * leaves two half-tokens on the page, neither of which is the path that was
 * there. Measured on the 522-cell corpus with a mechanical 60-column wrap, that
 * is the difference between 15 and 259 rejected rewrites, so the instruction
 * says what to do instead of only what not to do: move the whole path down, or
 * leave the line alone.
 */
export declare const REWRITE_INSTRUCTION: string;
/**
 * Compose the rewrite user message for one summary.
 *
 * The summary is substituted for the placeholder rather than interpolated into a
 * template literal, so a summary that itself contains `__SUMMARY_TEXT__` cannot
 * turn into a second substitution.
 *
 * @param summaryText - the summary to re-lay-out; the only input this call gets.
 * @returns the finished instruction text.
 */
export declare function buildRewriteInstruction(summaryText: any): string;
/**
 * How many of {@link SUMMARY_HEADINGS} one accepted summary must carry.
 *
 * All five are demanded by the instruction, but a model that merges two thin
 * sections still produced a usable handoff; a model that answered with a tool
 * call produces none of them. Three separates those two cases without rejecting
 * a slightly restructured summary.
 */
export declare const SUMMARY_MIN_HEADINGS = 3;
/**
 * The five sections matched by MEANING rather than by exact heading text.
 *
 * The gate used to be `text.includes('## ' + heading)` over the five English names,
 * and that is a substring test on one dialect of one language. Measured on the dense
 * corpus it failed 16.1% of compactions on the plugin arm against 0% on the arm that
 * delegates to the shipped backend, and the failures were bimodal: 71 successful
 * summaries carried all five English headings, the failures carried none while being
 * a normal 9,000-10,700 characters long. A summary of the right size whose headings
 * are worded differently is still a summary, and throwing it away fails the whole
 * compaction.
 *
 * Each pattern tolerates bold markers and matches the English name or its Chinese
 * equivalent, which is the dialect a Chinese transcript invites.
 */
export declare const SUMMARY_SECTION_PATTERNS: {
    name: string;
    re: RegExp;
}[];
/**
 * Shortest output still accepted as a summary when the sections are not recognised.
 *
 * The gate exists to reject one specific failure: a summarizer that treated the
 * transcript as a live turn and wrote tool-call markup out as prose, which once
 * replaced the compacted history with a transcript of a tool call. That failure is
 * caught by {@link looksLikeToolCallMarkup} and by this floor; a long output that is
 * neither is a summary in a shape this file did not anticipate, and keeping it beats
 * failing the compaction.
 */
export declare const SUMMARY_MIN_CHARS = 400;
/**
 * Whether text is a tool call written out as prose.
 *
 * @param text - the summarizer's text output.
 * @returns true when it carries tool-call markup or a tool-call JSON payload.
 */
export declare function looksLikeToolCallMarkup(text: any): boolean;
/** Appended after {@link SUMMARY_INSTRUCTION} when the session has notes. */
export declare const NOTES_MATERIAL_NOTE: string;
/** Resident system-prompt guidance for notes mode. */
export declare const NOTES_GUIDANCE: string;
/** Fired once per compaction cycle when context pressure crosses the threshold. */
export declare const NOTES_REMINDER_INSTRUCTION: string;
/** Description of the `notes_write` tool. */
export declare const NOTES_WRITE_DESCRIPTION: string;
/** Answer used when a user asks whether older context was dropped. */
export declare const COMPACTED_USER_ANSWER = "Earlier parts of this conversation were compacted into a summary. The full original text is still stored and can be read back by anchor or by search.";
/** Short acknowledgment returned by a successful `notes_write`. */
export declare const NOTES_WRITE_ACK = "ok";
/** Fixed answer for "was earlier context dropped?", plus when to give it. */
export declare const COMPACTED_ANSWER_GUIDANCE: string;
/** Tool description for `notes_read`. */
export declare const NOTES_READ_DESCRIPTION: string;
/** Tool description for `notes_search`. */
export declare const NOTES_SEARCH_DESCRIPTION: string;
declare const _default: {
    HISTORY_FIND_BUDGET_DESCRIPTION: string;
    HISTORY_FIND_DEFAULT_BUDGET_CHARS: number;
    HISTORY_FIND_DESCRIPTION: string;
    HISTORY_FIND_EXTRACT_DESCRIPTION: string;
    HISTORY_FIND_MAX_BUDGET_CHARS: number;
    TOOL_RESULT_STORE_CEILING_CHARS: number;
    TOOL_RESULT_STORE_CEILING_BYTES: number;
    clampToStoreCeiling: typeof clampToStoreCeiling;
    utf8Bytes: typeof utf8Bytes;
    HISTORY_FIND_MAX_QUERIES: number;
    HISTORY_FIND_QUERIES_DESCRIPTION: string;
    SUMMARY_INSTRUCTION: string;
    SUMMARY_SYSTEM_INSTRUCTION: string;
    REWRITE_SYSTEM_INSTRUCTION: string;
    REWRITE_INSTRUCTION: string;
    buildRewriteInstruction: typeof buildRewriteInstruction;
    SUMMARY_HEADINGS: string[];
    SUMMARY_MIN_HEADINGS: number;
    SUMMARY_SECTION_PATTERNS: {
        name: string;
        re: RegExp;
    }[];
    SUMMARY_MIN_CHARS: number;
    looksLikeToolCallMarkup: typeof looksLikeToolCallMarkup;
    COMPACTED_ANSWER_GUIDANCE: string;
    NOTES_READ_DESCRIPTION: string;
    NOTES_SEARCH_DESCRIPTION: string;
    NOTES_MATERIAL_NOTE: string;
    NOTES_GUIDANCE: string;
    NOTES_REMINDER_INSTRUCTION: string;
    NOTES_WRITE_DESCRIPTION: string;
    COMPACTED_USER_ANSWER: string;
    NOTES_WRITE_ACK: string;
};
export default _default;
