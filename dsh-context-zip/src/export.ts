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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';

import { blocksToText, loadSegments } from './segments.ts';
import { exportsRoot, safeSessionName } from './notes.ts';
import { renderEvent } from './transcript.ts';

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
export class ContextZipService extends Service {
  constructor(ctx) {
    super(ctx, 'contextZip');
  }

  /**
   * List one session's own compaction segments.
   *
   * @param sessionId - session to describe.
   * @returns segment descriptors in ordinal order.
   */
  async listSegments(sessionId) {
    const session = await this.sessionFor(sessionId);
    return await loadSegments(this.ctx, session);
  }

  /**
   * Read the complete replacement record of one segment.
   *
   * @param sessionId - session owning the segment.
   * @param ordinal - segment ordinal.
   * @returns the segment, its summary text, and its shadowed events.
   */
  async readSegment(sessionId, ordinal) {
    const session = await this.sessionFor(sessionId);
    const segments = await loadSegments(this.ctx, session);
    const segment = segments[ordinal];
    if (segment === undefined) throw new Error(`no segment ${ordinal} in session ${sessionId}`);
    const log = session.snapshotEvents();
    const events = [];
    for (const seq of segment.shadowedSeqs) {
      const event = await this.eventAt(session, log, seq);
      if (event !== undefined) events.push(event);
    }
    sortBySeq(events);
    const summaryEvent = await this.eventAt(session, log, segment.summarySeq);
    return {
      segment,
      summary: blocksToText(summaryEvent?.data?.summary),
      // Carried for the export header: the summary event is the only record of
      // which route produced it and when.
      summaryMeta: {
        provider: typeof summaryEvent?.data?.provider === 'string' ? summaryEvent.data.provider : '',
        model: typeof summaryEvent?.data?.model === 'string' ? summaryEvent.data.model : '',
        time: typeof summaryEvent?.time === 'number' ? new Date(summaryEvent.time).toISOString() : '',
      },
      events,
    };
  }

  /**
   * Resolve one event by seq, preferring the session's own log.
   *
   * @param session - session owning the event.
   * @param log - that session's already-read event snapshot.
   * @param seq - event sequence number.
   * @returns the event, or undefined when neither the log nor the query has it.
   */
  async eventAt(session, log, seq) {
    const local = log[seq];
    if (local !== undefined) return local;
    const query = this.ctx.get('sessionQuery');
    if (query === undefined) return void 0;
    try {
      return (await query.readEvent({ sessionId: session.id, seq, before: 0, after: 0 })).target;
    } catch {
      // A retired node is skipped; the rest of the segment still reads.
      return void 0;
    }
  }

  /**
   * Render one segment, or every segment, as markdown.
   *
   * @param sessionId - session to export.
   * @param ordinal - one segment ordinal, or null for every segment.
   * @returns markdown documents, one per exported segment.
   */
  async renderMarkdown(sessionId, ordinal = null) {
    // `sessionFor`, not `sessionOf`: exporting is a review exit, and the whole
    // point is that it reaches a session that is no longer open in this process.
    // `sessionOf` throws for anything but a live session, which left the command
    // unable to export the very history it exists to preserve.
    const session = await this.sessionFor(sessionId);
    const all = await this.listSegments(sessionId);
    const selected = ordinal === null ? all : all.filter((segment) => segment.ordinal === ordinal);
    const documents = [];
    for (const segment of selected) {
      const { summary, summaryMeta, events } = await this.readSegment(sessionId, segment.ordinal);
      documents.push({ segment, markdown: renderSegmentMarkdown(session, segment, summary, events, summaryMeta) });
    }
    return documents;
  }

  /**
   * Export one session's segments to markdown files.
   *
   * @param sessionId - session to export.
   * @param ordinal - one segment ordinal, or null for every segment.
   * @returns the written file paths.
   */
  async export(sessionId, ordinal = null) {
    const documents = await this.renderMarkdown(sessionId, ordinal);
    const directory = exportsRoot();
    await mkdir(directory, { recursive: true });
    const written = [];
    for (const { segment, markdown } of documents) {
      const path = join(directory, exportFileName(sessionId, segment.ordinal));
      await writeFile(path, markdown, 'utf8');
      written.push(path);
    }
    return written;
  }


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
  async sessionFor(sessionId) {
    const live = this.ctx.sessions.get(sessionId);
    if (live !== undefined) return live;
    const snapshot = await this.queryService().readSession(sessionId);
    // Both trailing arguments matter: `inheritedEventCount` is what puts a
    // restored fork's boundary in the right place, and `eventState` says whether
    // the seed may be aliased or has to be copied.
    return Session.fromRestore(
      snapshot.session.id,
      snapshot.events,
      snapshot.session,
      snapshot.inheritedEventCount ?? 0,
      'shared-frozen',
    );
  }

  /** Resolve the session-query service. */
  queryService() {
    const query = this.ctx.get('sessionQuery');
    if (query === undefined) throw new Error('session-query is not composed; cannot read stored history');
    return query;
  }
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
export function sortBySeq(events) {
  events.sort((left, right) => left.seq - right.seq);
  return events;
}

/**
 * File name for one exported segment, in the documented
 * `<session id>-seg-<ordinal>.md` shape.
 *
 * @param sessionId - session owning the segment.
 * @param ordinal - segment ordinal.
 * @returns one flat file name; every segment of a session shares the directory.
 */
export function exportFileName(sessionId, ordinal) {
  return `${safeSessionName(sessionId)}-seg-${String(Math.max(0, ordinal | 0)).padStart(3, '0')}.md`;
}

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
type SummaryMeta = { time?: string; provider?: string; model?: string };

export function renderSegmentMarkdown(
  session,
  segment,
  summary,
  events,
  summaryMeta: SummaryMeta = {},
) {
  const seqs = events.map((event) => event.seq);
  const range =
    seqs.length === 0
      ? '(none)'
      : `${Math.min(...seqs)}..${Math.max(...seqs)} (${seqs.length} event(s))`;
  const lines = [
    `# Segment ${segment.ordinal} — ${segment.label}`,
    '',
    `- session: ${session.id}`,
    `- segment: ${segment.ordinal}`,
    `- replaced event numbers: ${range}`,
    `- compacted at: ${summaryMeta.time === '' || summaryMeta.time === undefined ? '(unknown)' : summaryMeta.time}`,
    `- model: ${summaryMeta.model === '' || summaryMeta.model === undefined ? '(unknown)' : `${String(summaryMeta.provider ?? '')}/${summaryMeta.model}`.replace(/^\//u, '')}`,
    `- compaction id: ${segment.compactionId}`,
    `- summary event: ${segment.summarySeq}`,
    `- replaced surface span: ${segment.shadowedRange.start}..${segment.shadowedRange.end}`,
    `- replaced tokens (estimated): ${segment.tokenCount}`,
    `- exported at: ${new Date().toISOString()}`,
    '',
    '## Handoff summary',
    '',
    summary.trim().length === 0 ? '(summary text unavailable)' : summary.trim(),
    '',
    '## Original text (in event order)',
    '',
  ];
  for (const event of events) {
    lines.push('```text', renderEvent(event), '```', '');
  }
  return lines.join('\n');
}

/**
 * Register the `/zip-export` human command.
 *
 * @param ctx - context carrying the command registry.
 * @returns the disposer, or null when no command registry is composed.
 */
export function registerExportCommand(ctx) {
  const commands = ctx.get('commands');
  if (commands === undefined) return null;
  return commands.register({
    name: 'zip-export',
    description: 'Write this session\'s compaction segments (summary plus original text) to markdown files',
    // Without this descriptor a browser client treats `/zip-export <id>` as an
    // ordinary message and only the bare token reaches the handler: the client's
    // enter dispatch falls through to a normal submission whenever a command
    // carries trailing input but declares no `input`. The handler has always read
    // `invocation.rawInput`, so the argument was unreachable from the GUI.
    // `optional` is spelled out (2026.09.19): the id defaults to the calling
    // session, and a bare `session id` read as a required argument.
    input: { hint: 'optional session id (defaults to this session)' },
    recordInput: false,
    async handler(invocation) {
      const sessionId = invocation.rawInput.trim().length > 0 ? invocation.rawInput.trim() : invocation.agent.session.id;
      try {
        const paths = await ctx.contextZip.export(sessionId, null);
        if (paths.length === 0) {
          return { kind: 'success', text: `No compaction segments to export in ${sessionId}.` };
        }
        return { kind: 'success', text: `Exported ${paths.length} segment(s):\n${paths.join('\n')}` };
      } catch (error) {
        return { kind: 'error', text: `Export failed: ${String(error?.message ?? error)}` };
      }
    },
  });
}

export default { ContextZipService, registerExportCommand, renderSegmentMarkdown, exportFileName };
