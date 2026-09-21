/**
 * The extraction exits.
 *
 * Two read-only ways out of the compaction state, both derived from the log and
 * neither appending to it:
 *
 * - {@link ContextZipService}, addressable as `ctx.contextZip`, for another
 *   plugin that wants segment data;
 * - the `/zip-export` command, which writes human-readable markdown for people.
 *
 * @module dsh-context-zip/export
 */
import { Service } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Read-only view of one session's compaction segments and their originals. */
        contextZip: ContextZipService;
    }
}
/**
 * Read-only projection of the compaction state of one session.
 *
 * Every method derives its answer from the session log through `ctx.sessionQuery`,
 * so callers can never observe a second source of truth.
 */
export declare class ContextZipService extends Service {
    constructor(ctx: any);
    /**
     * List one session's own compaction segments.
     *
     * @param sessionId - session to describe.
     * @returns segment descriptors in ordinal order.
     */
    listSegments(sessionId: any): Promise<any[]>;
    /**
     * Read the complete replacement record of one segment.
     *
     * @param sessionId - session owning the segment.
     * @param ordinal - segment ordinal.
     * @returns the segment, its summary text, and its shadowed events.
     */
    readSegment(sessionId: any, ordinal: any): Promise<{
        segment: any;
        summary: string;
        summaryMeta: {
            provider: any;
            model: any;
            time: string;
        };
        events: any[];
    }>;
    /**
     * Resolve one event by seq, preferring the session's own log.
     *
     * @param session - session owning the event.
     * @param log - that session's already-read event snapshot.
     * @param seq - event sequence number.
     * @returns the event, or undefined when neither the log nor the query has it.
     */
    eventAt(session: any, log: any, seq: any): Promise<any>;
    /**
     * Render one segment, or every segment, as markdown.
     *
     * @param sessionId - session to export.
     * @param ordinal - one segment ordinal, or null for every segment.
     * @returns markdown documents, one per exported segment.
     */
    renderMarkdown(sessionId: any, ordinal?: any): Promise<any[]>;
    /**
     * Export one session's segments to markdown files.
     *
     * @param sessionId - session to export.
     * @param ordinal - one segment ordinal, or null for every segment.
     * @returns the written file paths.
     */
    export(sessionId: any, ordinal?: any): Promise<any[]>;
    /**
     * Resolve a session for a read-only projection.
     *
     * A live session is preferred; a session that only exists in storage is
     * reconstructed as a detached instance from its stored log, which is what lets
     * a human review a session that is not currently open.
     *
     * @param sessionId - session to resolve.
     * @returns a session instance usable for log-derived reads.
     */
    sessionFor(sessionId: any): Promise<Session>;
    /** Resolve the session-query service. */
    queryService(): any;
}
/**
 * Put a segment's original events in ascending event order, in place.
 *
 * The shadowed list is recorded in surface order, which is not numeric order;
 * the export document promises the originals by event number.
 *
 * @param events - events to sort; mutated.
 * @returns the same array.
 */
export declare function sortBySeq(events: any): any;
/**
 * File name for one exported segment, in the documented
 * `<session id>-seg-<ordinal>.md` shape.
 *
 * @param sessionId - session owning the segment.
 * @param ordinal - segment ordinal.
 * @returns one flat file name; every segment of a session shares the directory.
 */
export declare function exportFileName(sessionId: any, ordinal: any): string;
/**
 * Render one segment as a markdown document.
 *
 * The original text follows the summary rather than replacing it: the point of
 * this exit is that nothing was lost.
 *
 * @param session - owning session.
 * @param segment - the segment descriptor.
 * @param summary - the handoff summary text.
 * @param events - the shadowed events in surface order.
 * @returns the markdown document.
 */
/** Provenance of the summary event behind one segment. */
type SummaryMeta = {
    time?: string;
    provider?: string;
    model?: string;
};
export declare function renderSegmentMarkdown(session: any, segment: any, summary: any, events: any, summaryMeta?: SummaryMeta): string;
/**
 * Register the `/zip-export` human command.
 *
 * @param ctx - context carrying the command registry.
 * @returns the disposer, or null when no command registry is composed.
 */
export declare function registerExportCommand(ctx: any): any;
declare const _default: {
    ContextZipService: typeof ContextZipService;
    registerExportCommand: typeof registerExportCommand;
    renderSegmentMarkdown: typeof renderSegmentMarkdown;
    exportFileName: typeof exportFileName;
};
export default _default;
