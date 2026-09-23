// src/index.ts
import { dirname as dirname3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { createUserMessage as createUserMessage2 } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import {
  setSharedFallbackReader,
  setSharedModeReader,
  setSharedNotesReader,
  setSharedRewriteReader,
  runManualCompaction
} from "dsh-context-zip/engine";

// src/models.ts
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

// src/producer.ts
import { PLUGIN_ID } from "dsh-context-zip/engine";
var PRODUCER_KIND = `plugin:${PLUGIN_ID}`;

// src/models.ts
var PROBE_MAX_TOKENS = 8;
var PROBE_SYSTEM_INSTRUCTION = "Reply with the single word: ok";
var PROBE_USER_TEXT = "ok";
var PROBE_TIMEOUT_MS = 3e4;
var PROBE_SESSION_ID = "context-zip-rewrite-probe";
async function readModelCatalog(llm) {
  const providers = typeof llm?.listProviders === "function" ? llm.listProviders() : [];
  const groups = [];
  const failures = [];
  for (const provider of providers ?? []) {
    const id = String(provider?.id ?? "");
    if (id.length === 0) continue;
    const name2 = typeof provider?.name === "string" && provider.name.length > 0 ? provider.name : id;
    try {
      const models = await llm.listModels(id);
      groups.push({
        id,
        name: name2,
        models: (models ?? []).map((model) => ({ id: String(model?.id ?? ""), name: String(model?.name ?? model?.id ?? "") })).filter((model) => model.id.length > 0)
      });
    } catch (error) {
      failures.push({ id, name: name2, message: String(error?.message ?? error) });
    }
  }
  return { providers: groups, failures };
}
function requireRegisteredProvider(llm, provider) {
  const providers = typeof llm?.listProviders === "function" ? llm.listProviders() : [];
  const ids = (providers ?? []).map((entry) => String(entry?.id ?? "")).filter((id) => id.length > 0);
  if (ids.includes(provider)) return;
  throw new Error(
    `LLM provider "${provider}" is not registered; registered providers: ${ids.join(", ") || "(none)"}`
  );
}
async function probeModel(llm, provider, model, options = {}) {
  requireRegisteredProvider(llm, provider);
  await llm.resolveModelInfo(provider, model, options.signal);
  const maxTokens = Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : PROBE_MAX_TOKENS;
  const assembler = new BlockAssembler();
  const request = {
    provider,
    model,
    // 见 PROBE_SESSION_ID：没有它，需要路由头的 provider 会拒答或超时。
    sessionId: PROBE_SESSION_ID,
    messages: [
      createUserMessage({
        content: [{ type: "text", text: PROBE_USER_TEXT }],
        // `ContextForm` 是闭集：instructions / catalog / snapshot / notice / relay /
        // recall，没有「探活」这一档。该类型自己的文档写明「不声明的上下文就是文档化
        // 的默认档，按不透明内容呈现」，而这条消息只发不落盘、插件侧也从不回读 form，
        // 所以在这里不声明 form，而不是自造一个词表外的值。
        source: { kind: PRODUCER_KIND, plugin: "context-zip" }
      })
    ],
    system: PROBE_SYSTEM_INSTRUCTION,
    maxTokens,
    ...options.signal === void 0 ? {} : { signal: options.signal }
  };
  for await (const chunk of llm.stream(request)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind === "error" || finish.kind === "aborted") {
    const failure = finish.failure ?? {};
    throw new Error(
      `the probe call to ${provider}/${model} finished as ${finish.kind}${failure.message === void 0 ? "" : `: ${failure.message}`}${failure.status === void 0 ? "" : ` (HTTP ${failure.status})`}`
    );
  }
  return { finish: finish.kind, usage: assembler.usage };
}

// src/export.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";

// src/segments.ts
import { SEQ_LIST_HEAD, SEQ_LIST_TAIL } from "dsh-context-zip/engine/prompt";
async function readSessionEvents(ctx, session) {
  try {
    const own = session.snapshotEvents();
    if (Array.isArray(own)) return [...own];
  } catch (error) {
    ctx.logger?.debug?.(`[context-zip] the live session log was unreadable, falling back to the query service: ${String(error)}`);
  }
  if (session.header?.isSeeded === true) return [];
  const query = ctx.get("sessionQuery");
  if (query === void 0) return [];
  const snapshot = await query.readSession(session.id);
  return snapshot.events;
}
function ownHistoryStart(session, events) {
  if (session.header?.isSeeded !== true) return 0;
  const inherited = toNonNegativeInt(session.inheritedEventCount);
  if (inherited > 0 && inherited <= events.length) return inherited;
  let marker = 0;
  for (const event of events) {
    if (event.type === "session/end-seed") marker = toNonNegativeInt(event.seq) + 1;
  }
  const live = toNonNegativeInt(session.firstLiveSeq);
  if (marker > 0) return marker;
  return live > 0 && live <= events.length ? live : 0;
}
function deriveSegments(session, events) {
  const start = ownHistoryStart(session, events);
  const segments = [];
  for (const event of events) {
    if (event.type !== "compaction/summary") continue;
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
        end: toNonNegativeInt(data.shadowedRange?.end)
      },
      shadowedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.map(toNonNegativeInt) : [],
      tokenCount: toNonNegativeInt(data.shadowedTokenCount),
      label: labelFromSummary(data.summary, ordinal)
    });
  }
  return segments;
}
function deriveTurnStart(events) {
  let start = null;
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const seq = toNonNegativeInt(event.seq);
    if (start === null || seq > start) start = seq;
  }
  return start;
}
async function loadSegments(ctx, session) {
  return deriveSegments(session, await readSessionEvents(ctx, session));
}
async function loadSegmentsAndTurn(ctx, session) {
  const events = await readSessionEvents(ctx, session);
  return { segments: deriveSegments(session, events), turnStart: deriveTurnStart(events) };
}
function segmentForSeq(segments, seq) {
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
function labelFromSummary(summary, ordinal) {
  const text = blocksToText(summary);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^[#>*\-\s]+/u, "").trim();
    if (line.length === 0) continue;
    if (/^(Goal and intent|Decisions|Current state|Next steps|Anchors)$/iu.test(line)) continue;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return `segment ${ordinal}`;
}
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}
function compactSeqList(seqs) {
  if (seqs.length <= SEQ_LIST_HEAD + SEQ_LIST_TAIL) return seqs.join(",");
  const head = seqs.slice(0, SEQ_LIST_HEAD).join(",");
  const tail = seqs.slice(-SEQ_LIST_TAIL).join(",");
  return `${head},\u2026,${tail}`;
}
function describeSegment(segment) {
  return `${segment.ordinal}. ${segment.label} (events ${compactSeqList(segment.shadowedSeqs)}, ~${segment.tokenCount} tokens, summary seq ${segment.summarySeq}, id ${segment.compactionId})`;
}
function toNonNegativeInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
function latestContextWindow(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/context") continue;
    const window = event.data?.contextWindow;
    if (typeof window === "number" && window > 0) return window;
  }
  return null;
}

// src/notes.ts
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { NOTES_MAX_CHARS } from "dsh-context-zip/engine/prompt";
function contextZipRoot() {
  return dshHomePath("context-zip");
}
function notesRoot() {
  return join(contextZipRoot(), "notes");
}
function exportsRoot() {
  return join(contextZipRoot(), "exports");
}
function safeSessionName(sessionId) {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9._-]/gu, "_");
  return cleaned.length === 0 ? "session" : cleaned;
}
function segmentFileName(ordinal) {
  return `seg-${String(Math.max(0, ordinal | 0)).padStart(3, "0")}.md`;
}
var NoteStore = class {
  /** Root directory this store writes under. */
  root;
  /**
   * @param root - root directory this store writes under; injectable for tests.
   *   Omitted, the store uses the plugin's own notes directory.
   */
  constructor(root) {
    this.root = root ?? notesRoot();
  }
  /** Absolute path of one session's live draft. */
  draftPath(sessionId) {
    return join(this.root, `${safeSessionName(sessionId)}.md`);
  }
  /** Absolute path of one session's archive directory. */
  archiveDir(sessionId) {
    return join(this.root, safeSessionName(sessionId));
  }
  /** Absolute path of one archived segment file. */
  archivePath(sessionId, ordinal) {
    return join(this.archiveDir(sessionId), segmentFileName(ordinal));
  }
  /**
   * Read one session's live draft.
   *
   * @param sessionId - session whose draft is read.
   * @returns the draft text, or '' when no draft exists.
   */
  async read(sessionId) {
    try {
      return await readFile(this.draftPath(sessionId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }
  /**
   * Append lines to one session's live draft, trimming the oldest content when
   * the single-file bound is exceeded.
   *
   * @param sessionId - session whose draft grows.
   * @param text - the model's note text.
   * @returns the stored character count and whether trimming happened.
   */
  async append(sessionId, text) {
    const existing = await this.read(sessionId);
    const entry = formatEntry(text);
    const next = existing.length === 0 ? entry : `${existing}
${entry}`;
    const trimmed = trimToLimit(next, NOTES_MAX_CHARS);
    const path = this.draftPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, trimmed.text);
    return {
      chars: trimmed.text.length,
      trimmed: trimmed.trimmed,
      droppedOlder: trimmed.trimmed && existing.length > 0,
      entryCut: trimmed.trimmed && !trimmed.text.includes(entry)
    };
  }
  /**
   * Read one archived segment's notes.
   *
   * @param sessionId - session whose archive is read.
   * @param ordinal - segment ordinal the archive belongs to.
   * @returns the archived text, or '' when that segment kept no notes.
   */
  async readArchive(sessionId, ordinal) {
    try {
      return await readFile(this.archivePath(sessionId, ordinal), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }
  /**
   * Move the live draft into the archive under one segment ordinal.
   *
   * @param sessionId - session whose draft is archived.
   * @param ordinal - segment ordinal the draft belongs to.
   * @returns the archive path, or null when there was nothing to archive.
   */
  async archive(sessionId, ordinal) {
    const draft = await this.read(sessionId);
    if (draft.trim().length === 0) return null;
    const target = this.archivePath(sessionId, ordinal);
    await mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, draft);
    await rm(this.draftPath(sessionId), { force: true });
    return target;
  }
  /**
   * List the archived segment files of one session.
   *
   * @param sessionId - session whose archive is listed.
   * @returns file names in ascending order.
   */
  async listArchive(sessionId) {
    try {
      const names = await readdir(this.archiveDir(sessionId));
      return names.filter((name2) => name2.startsWith("seg-") && name2.endsWith(".md")).sort();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
};
function formatEntry(text) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(11, 16);
  const body = String(text).replace(/\s+$/u, "");
  return `- [${stamp}] ${body}`;
}
function trimToLimit(text, limit) {
  if (text.length <= limit) return { text, trimmed: false };
  const marker = "[earlier notes dropped: per-session limit reached]\n";
  const lines = text.split("\n");
  while (lines.length > 1 && marker.length + lines.join("\n").length > limit) lines.shift();
  const body = lines.join("\n");
  return { text: `${marker}${body}`.slice(0, limit), trimmed: true };
}
async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// src/transcript.ts
import { EVENT_TEXT_CHARS, HISTORY_READ_MAX_CHARS, SEQ_LIST_HEAD as SEQ_LIST_HEAD2, SEQ_LIST_TAIL as SEQ_LIST_TAIL2 } from "dsh-context-zip/engine/prompt";
function renderEvent(event) {
  const data = event?.data ?? {};
  const head = `#${event.seq} ${event.type}`;
  switch (event.type) {
    // `user/message` carries its message directly, while `assistant/message` and
    // `tool/result` wrap theirs (the assistant one keeps its step accounting
    // beside it). The two shapes are read differently on purpose.
    case "user/message":
      return `${head}
${indent(textOf(data.content) || "(empty)")}`;
    case "system/message":
      return `${head}
${indent(textOf(data.content) || "(empty)")}`;
    case "assistant/message":
      return `${head}
${indent(textOf(data.message?.content) || "(no text)")}`;
    case "tool/call":
      return `${head} name=${String(data.name ?? "?")}
${indent(bound(textOf(data.arguments) || safeJson(data.arguments)))}`;
    case "tool/result":
      return `${head}${data.isError === true ? " error" : ""}
${indent(bound(textOf(data.message?.content)))}`;
    case "compaction/summary":
      return `${head} compactionId=${String(data.compactionId ?? "?")} shadowed=${describeRange(data.shadowedRange)} shadowedSeqs=${describeSeqs(data.shadowedSeqs)} tokens=${String(data.shadowedTokenCount ?? "?")}
${indent(bound(textOf(data.summary)))}`;
    case "compaction/start":
      return `${head} compactionId=${String(data.compactionId ?? "?")}`;
    case "compaction/end":
      return `${head} compactionId=${String(data.compactionId ?? "?")}${data.error === void 0 ? "" : ` error=${String(data.error)}`}`;
    case "compaction/prune":
      return `${head} shadowed=${describeRange(data.shadowedRange)} tokens=${String(data.shadowedTokenCount ?? "?")}`;
    case "todo/write":
      return `${head}
${indent(bound(textOf(data.todos)))}`;
    case "session/title":
      return `${head} ${String(data.title ?? "")}`;
    default:
      return head;
  }
}
var CLIPPED_NOTICE = "\n\n[... this one entry exceeds the character budget on its own, so only its opening is shown above; raise maxChars or read a narrower window ...]";
var TRUNCATED_NOTICE_PREFIX = "[... transcript truncated at ";
var CLIPPED_MIN_CHARS = 200;
function nameRange(from, to, count2) {
  return `${count2} ${count2 === 1 ? "entry" : "entries"} (${from === to ? `#${from}` : `#${from}..#${to}`})`;
}
function renderTranscript(events, maxChars = HISTORY_READ_MAX_CHARS, targetSeq = null) {
  const budget = clamp(maxChars, 1e3, HISTORY_READ_MAX_CHARS);
  const blocks = [];
  for (const event of events) {
    const block = renderEvent(event);
    if (block.length > 0) blocks.push({ seq: event?.seq ?? null, block });
  }
  const targetAt = targetSeq === null ? -1 : blocks.findIndex((entry) => entry.seq === targetSeq);
  const lossNotice = (start, stopAt, budget2) => {
    const facts = [];
    if (start > 0) {
      const suffix = targetAt < 0 ? "" : ` for #${targetSeq}`;
      facts.push(
        `${nameRange(blocks[0].seq, blocks[start - 1].seq, start)} ${start === 1 ? "was" : "were"} left out to make room${suffix}`
      );
    }
    if (stopAt < blocks.length) {
      const count2 = blocks.length - stopAt;
      facts.push(`${nameRange(blocks[stopAt].seq, blocks[blocks.length - 1].seq, count2)} came after the cut`);
    }
    return facts.length === 0 ? "" : `

${TRUNCATED_NOTICE_PREFIX}${budget2} characters: ${facts.join(", and ")} ...]`;
  };
  const renderFrom = (start) => {
    const parts = [];
    let used = 0;
    let truncated = false;
    let clipped = false;
    let clippedAt = -1;
    let covered = targetAt < 0;
    let end = start - 1;
    let stopAt = blocks.length;
    for (let index = start; index < blocks.length; index += 1) {
      const { block, seq } = blocks[index];
      const separator = parts.length === 0 ? 0 : 1;
      const room = Math.max(
        0,
        budget - used - separator - CLIPPED_NOTICE.length - lossNotice(start, index + 1, budget).length
      );
      if (used + separator + block.length > budget) {
        if (room >= CLIPPED_MIN_CHARS) {
          parts.push(block.slice(0, room));
          end = index;
          clipped = true;
          clippedAt = index;
          if (seq === targetSeq) covered = true;
          stopAt = index + 1;
        } else {
          stopAt = index;
        }
        truncated = true;
        break;
      }
      used += separator + block.length;
      parts.push(block);
      end = index;
      if (seq === targetSeq) covered = true;
    }
    if (start > 0) truncated = true;
    return {
      text: parts.join("\n"),
      truncated,
      clipped,
      covered,
      start,
      end,
      stopAt,
      // 被寻址事件这一轮实际落了多少字，以及它是不是只给了开头。两者都在这里算，
      // 调用方不必再按窗口另算一遍。
      targetChars: targetAt >= start && targetAt <= end ? parts[targetAt - start].length : 0,
      targetClipped: clippedAt >= 0 && clippedAt === targetAt,
      // 这一轮定下来的丢块提示语。`truncated` 为真时它一定非空：截断要么来自丢前导块，
      // 要么来自某一块没进正文，两者都会写进这条提示语。
      loss: lossNotice(start, stopAt, budget)
    };
  };
  const firstStart = targetAt < 0 ? 0 : targetAt;
  let result = renderFrom(0);
  for (let start = 1; start <= firstStart; start += 1) {
    if (result.covered && !result.targetClipped) break;
    result = renderFrom(start);
  }
  const shown = result.end >= result.start ? {
    from: blocks[result.start].seq,
    to: blocks[result.end].seq,
    count: result.end - result.start + 1,
    total: blocks.length,
    clipped: result.clipped
  } : { from: null, to: null, count: 0, total: blocks.length, clipped: false };
  if (!result.truncated) return { text: result.text, truncated: false, shown };
  const notices = `${result.clipped ? CLIPPED_NOTICE : ""}${result.loss}`;
  return { text: `${result.text}${notices}`, truncated: true, shown };
}
function windowWasTruncated(text) {
  return text.includes(TRUNCATED_NOTICE_PREFIX) || text.includes(CLIPPED_NOTICE);
}
function renderWindow(events, header, maxChars, targetSeq = null) {
  const rendered = renderTranscript(events, maxChars, targetSeq);
  const { from, to, count: count2, total, clipped } = rendered.shown;
  const span = count2 === 0 ? "-" : `${from}..${to}`;
  const read = count2 === total ? `${total} read` : `${count2} of ${total} read`;
  const address = `events ${span} (${read}${clipped ? ", last entry cut" : ""})
${header}`;
  if (rendered.text.length === 0) return `${address}
(no readable content in this window)`;
  return `${address}

${rendered.text}`;
}
function describeRange(range) {
  if (range === null || typeof range !== "object") return "?";
  return `${range.start}..${range.end}`;
}
function describeSeqs(seqs) {
  if (!Array.isArray(seqs)) return "?";
  if (seqs.length <= SEQ_LIST_HEAD2 + SEQ_LIST_TAIL2) return seqs.join(",");
  return `${seqs.slice(0, SEQ_LIST_HEAD2).join(",")},\u2026,${seqs.slice(-SEQ_LIST_TAIL2).join(",")}`;
}
function locateAround(text, query, maxChars) {
  const raw = String(text ?? "");
  const needle = String(query ?? "").trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const at = needle.length === 0 ? -1 : raw.toLowerCase().indexOf(needle);
  const view = locateAt(raw, at, maxChars);
  return { ...view, text: view.text.replace(/\s+/gu, " ") };
}
var SENTENCE_END = /[\u3002\uFF01\uFF1F\uFF1B]/u;
var SENTENCE_TAIL = /[\u300D\u300F\uFF09\u201D\u2019"')\]]/u;
function endsSentence(text, index) {
  const ch = text[index];
  if (ch === void 0) return false;
  if (SENTENCE_END.test(ch)) return true;
  if (ch !== "." && ch !== "!" && ch !== "?" && ch !== ";") return false;
  const next = text[index + 1];
  return next === void 0 || /\s/u.test(next);
}
function sentenceEnd(text, at) {
  for (let i = at; i < text.length; i += 1) {
    if (!endsSentence(text, i)) continue;
    let end = i + 1;
    while (end < text.length && SENTENCE_TAIL.test(text[end])) end += 1;
    return end;
  }
  return text.length;
}
function sentenceStart(text, at) {
  let i = at;
  while (i > 0) {
    i -= 1;
    if (!endsSentence(text, i)) continue;
    let start = i + 1;
    while (start < text.length && /[ \t]/u.test(text[start])) start += 1;
    return start;
  }
  return 0;
}
function snapWindow(text, at, maxChars) {
  const body = String(text ?? "");
  const total = body.length;
  const bound2 = Math.max(1, Math.floor(maxChars));
  const mark = Number.isFinite(at) && at >= 0 && at < total ? at : -1;
  if (total <= bound2) {
    return { text: body, start: 0, end: total, total, snapped: true, cut: false };
  }
  if (mark >= 0) {
    const first = sentenceStart(body, mark);
    const last = sentenceEnd(body, mark);
    if (last - first <= bound2) {
      return { text: body.slice(first, last), start: first, end: last, total, snapped: true, cut: false };
    }
    const half = Math.floor(bound2 / 2);
    const cutStart = Math.max(0, mark - half);
    const cutEnd = Math.min(total, cutStart + bound2);
    return { text: body.slice(cutStart, cutEnd), start: cutStart, end: cutEnd, total, snapped: false, cut: true };
  }
  const end = Math.min(total, bound2);
  return { text: body.slice(0, end), start: 0, end, total, snapped: false, cut: end < total };
}
function locateAt(text, at, maxChars) {
  const flat = String(text ?? "");
  const offset = Number.isFinite(at) ? at : -1;
  if (flat.length <= maxChars) {
    return { text: flat, offset, total: flat.length, found: offset >= 0 };
  }
  const half = Math.floor(maxChars / 2);
  const start = offset < 0 ? 0 : Math.max(0, offset - half);
  const slice = flat.slice(start, start + maxChars);
  return {
    text: `${start > 0 ? "\u2026" : ""}${slice}${start + maxChars < flat.length ? "\u2026" : ""}`,
    offset,
    total: flat.length,
    found: offset >= 0
  };
}
function scoreText(text, query) {
  const haystack = String(text ?? "").toLowerCase();
  let score = 0;
  for (const term of String(query ?? "").toLowerCase().split(/\s+/u)) {
    if (term.length === 0) continue;
    let at = haystack.indexOf(term);
    while (at !== -1) {
      score += 1;
      at = haystack.indexOf(term, at + term.length);
    }
  }
  return score;
}
function textOf(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool-result") parts.push(textOf(block.content));
  }
  return parts.filter((part) => part.length > 0).join("\n");
}
function eventBody(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case "user/message":
    case "system/message":
      return textOf(data.content);
    case "assistant/message":
      return textOf(data.message?.content);
    case "tool/call":
      return textOf(data.arguments) || safeJson(data.arguments);
    case "tool/result":
      return textOf(data.message?.content);
    case "compaction/summary":
      return textOf(data.summary);
    default:
      return "";
  }
}
function indent(text) {
  return String(text).split("\n").map((line) => `  ${line}`).join("\n");
}
function bound(text, maxChars = EVENT_TEXT_CHARS) {
  const value = String(text ?? "");
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\u2026`;
}
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
function clamp(value, min, max) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : max;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// src/export.ts
var ContextZipService = class extends Service {
  constructor(ctx) {
    super(ctx, "contextZip");
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
    if (segment === void 0) throw new Error(`no segment ${ordinal} in session ${sessionId}`);
    const log = session.snapshotEvents();
    const events = [];
    for (const seq of segment.shadowedSeqs) {
      const event = await this.eventAt(session, log, seq);
      if (event !== void 0) events.push(event);
    }
    sortBySeq(events);
    const summaryEvent = await this.eventAt(session, log, segment.summarySeq);
    return {
      segment,
      summary: blocksToText(summaryEvent?.data?.summary),
      // Carried for the export header: the summary event is the only record of
      // which route produced it and when.
      summaryMeta: {
        provider: typeof summaryEvent?.data?.provider === "string" ? summaryEvent.data.provider : "",
        model: typeof summaryEvent?.data?.model === "string" ? summaryEvent.data.model : "",
        time: typeof summaryEvent?.time === "number" ? new Date(summaryEvent.time).toISOString() : ""
      },
      events
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
    if (local !== void 0) return local;
    const query = this.ctx.get("sessionQuery");
    if (query === void 0) return void 0;
    try {
      return (await query.readEvent({ sessionId: session.id, seq, before: 0, after: 0 })).target;
    } catch {
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
    await mkdir2(directory, { recursive: true });
    const written = [];
    for (const { segment, markdown } of documents) {
      const path = join2(directory, exportFileName(sessionId, segment.ordinal));
      await writeFile2(path, markdown, "utf8");
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
    if (live !== void 0) return live;
    const snapshot = await this.queryService().readSession(sessionId);
    return Session.fromRestore(
      snapshot.session.id,
      snapshot.events,
      snapshot.session,
      snapshot.inheritedEventCount ?? 0,
      "shared-frozen"
    );
  }
  /** Resolve the session-query service. */
  queryService() {
    const query = this.ctx.get("sessionQuery");
    if (query === void 0) throw new Error("session-query is not composed; cannot read stored history");
    return query;
  }
};
function sortBySeq(events) {
  events.sort((left, right) => left.seq - right.seq);
  return events;
}
function exportFileName(sessionId, ordinal) {
  return `${safeSessionName(sessionId)}-seg-${String(Math.max(0, ordinal | 0)).padStart(3, "0")}.md`;
}
function renderSegmentMarkdown(session, segment, summary, events, summaryMeta = {}) {
  const seqs = events.map((event) => event.seq);
  const range = seqs.length === 0 ? "(none)" : `${Math.min(...seqs)}..${Math.max(...seqs)} (${seqs.length} event(s))`;
  const lines = [
    `# Segment ${segment.ordinal} \u2014 ${segment.label}`,
    "",
    `- session: ${session.id}`,
    `- segment: ${segment.ordinal}`,
    `- replaced event numbers: ${range}`,
    `- compacted at: ${summaryMeta.time === "" || summaryMeta.time === void 0 ? "(unknown)" : summaryMeta.time}`,
    `- model: ${summaryMeta.model === "" || summaryMeta.model === void 0 ? "(unknown)" : `${String(summaryMeta.provider ?? "")}/${summaryMeta.model}`.replace(/^\//u, "")}`,
    `- compaction id: ${segment.compactionId}`,
    `- summary event: ${segment.summarySeq}`,
    `- replaced surface span: ${segment.shadowedRange.start}..${segment.shadowedRange.end}`,
    `- replaced tokens (estimated): ${segment.tokenCount}`,
    `- exported at: ${(/* @__PURE__ */ new Date()).toISOString()}`,
    "",
    "## Handoff summary",
    "",
    summary.trim().length === 0 ? "(summary text unavailable)" : summary.trim(),
    "",
    "## Original text (in event order)",
    ""
  ];
  for (const event of events) {
    lines.push("```text", renderEvent(event), "```", "");
  }
  return lines.join("\n");
}
function registerExportCommand(ctx) {
  const commands = ctx.get("commands");
  if (commands === void 0) return null;
  return commands.register({
    name: "zip-export",
    description: "Write this session's compaction segments (summary plus original text) to markdown files",
    // Without this descriptor a browser client treats `/zip-export <id>` as an
    // ordinary message and only the bare token reaches the handler: the client's
    // enter dispatch falls through to a normal submission whenever a command
    // carries trailing input but declares no `input`. The handler has always read
    // `invocation.rawInput`, so the argument was unreachable from the GUI.
    // `optional` is spelled out (2026.09.19): the id defaults to the calling
    // session, and a bare `session id` read as a required argument.
    input: { hint: "optional session id (defaults to this session)" },
    recordInput: false,
    async handler(invocation) {
      const sessionId = invocation.rawInput.trim().length > 0 ? invocation.rawInput.trim() : invocation.agent.session.id;
      try {
        const paths = await ctx.contextZip.export(sessionId, null);
        if (paths.length === 0) {
          return { kind: "success", text: `No compaction segments to export in ${sessionId}.` };
        }
        return { kind: "success", text: `Exported ${paths.length} segment(s):
${paths.join("\n")}` };
      } catch (error) {
        return { kind: "error", text: `Export failed: ${String(error?.message ?? error)}` };
      }
    }
  });
}

// src/manual.ts
import { toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { failureCount, isRangeTooSmallFailure } from "dsh-context-zip/engine";
var ManualTargetError = class extends Error {
  /** Stable reason code, so the browser half can localize it. */
  code;
  /**
   * @param code - stable reason code.
   * @param message - human-readable diagnostic.
   */
  constructor(code, message) {
    super(message);
    this.name = "ManualTargetError";
    this.code = code;
  }
};
function selectManualRange(session, measurement, retainTokens = 0) {
  const pricedNodes = measurement?.nodes ?? [];
  if (pricedNodes.length === 0) return null;
  const surfaceNodes = session.surface.nodes;
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error("compaction: token-meter surface does not match the current session surface");
  }
  const head = surfaceNodes[0] === void 0 ? void 0 : session.eventAt(surfaceNodes[0]);
  const firstIdx = head?.type === "system/message" ? 1 : 0;
  let accumulated = 0;
  let keepFromIdx = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;
  return { startIdx: firstIdx, endIdx: keepFromIdx - 1 };
}
function planManualCompaction(sessionId, session, measurement) {
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
    end: surfaceNodes[range.endIdx] ?? null
  };
}
function failureReason(code, message) {
  const detail = String(message ?? "").trim();
  switch (code) {
    case "busy":
      return "the session is busy (an active compaction, an open turn, or a non-idle agent)";
    case "cancelled":
      return "the compaction was cancelled";
    case "changed":
      return `the history selected for compaction changed before it could be replaced${detail.length > 0 ? `: ${detail}` : ""}`;
    case "summary":
      return `the summarizer could not produce a usable handoff summary${detail.length > 0 ? `: ${detail}` : ""}`;
    case "commit":
      return `the commit stage failed, so some history may have changed; inspect the session before retrying${detail.length > 0 ? `: ${detail}` : ""}`;
    case "persistence":
      return `the summary landed but the session could not be saved${detail.length > 0 ? `: ${detail}` : ""}`;
    default:
      return detail.length > 0 ? detail : "unknown failure";
  }
}
function failureCountText(settings = {}, inapplicable = false) {
  const failures = Number.isFinite(Number(settings.failures)) ? Math.max(0, Math.trunc(Number(settings.failures))) : 0;
  const after = Number.isFinite(Number(settings.fallbackAfter)) ? Math.max(0, Math.trunc(Number(settings.fallbackAfter))) : 0;
  if (inapplicable) {
    return `this failure class is not counted towards the mechanical fallback: the span was too small for the framed summary to replace it, and a mechanical summary is longer than a model one, so no summarizer can make this attempt succeed (the recorded count stays ${failures}; the fallback threshold ${after} is not the thing to wait for here)`;
  }
  if (failures === 0) {
    return "the consecutive-failure count for this session is still 0, so the attempt that just failed was either not counted or the session summarises through the shipped backend, which this plugin does not count";
  }
  if (settings.fallbackEnabled === true) {
    return `${failures} consecutive attempt(s) have now failed; from attempt ${after + 1} the mechanical fallback writes the summary instead`;
  }
  return `${failures} consecutive attempt(s) have now failed; the mechanical fallback is off, so the next failure is reported the same way (turn it on to let attempt ${after + 1} fall back)`;
}
function manualPlanText(plan) {
  if (plan.events === 0) {
    return `Nothing to compact in ${plan.sessionId}: no safe, useful history span was found (an empty or single-node surface has no range the backend would accept).`;
  }
  return `Add "--yes" and run /zip-compact again to go ahead: it will replace ${plan.events} event(s) (~${plan.tokens} tokens) of ${plan.sessionId} with one handoff summary. The replaced events leave the model-visible surface but stay readable with the history tools.`;
}
function manualDoneText(outcome) {
  const summary = outcome.summarySeq === null ? "" : `, summary event #${outcome.summarySeq}`;
  return `Compacted ${outcome.events} event(s) (~${outcome.tokens} tokens) of ${outcome.sessionId}${summary}.`;
}
function manualFailureText(sessionId, error, settings = {}) {
  const code = typeof error?.code === "string" ? error.code : void 0;
  const message = String(error?.message ?? error ?? "");
  return `Compaction failed for ${sessionId}: ${failureReason(code, message)}. ${failureCountText(settings, isRangeTooSmallFailure(error))}`;
}
function registerManualCompactCommand(ctx, actions) {
  const commands = ctx.get("commands");
  if (commands === void 0) return null;
  return commands.register({
    name: "zip-compact",
    // The confirmation flag leads the description (user decision, 2026.09.19).
    // The discovery menu clips this string to one line, so anything after the
    // first few words is invisible; with `--yes` in the middle the user read the
    // command as "compact now" and reported it as not working.
    description: `Add "--yes" to confirm: compact this session's older history now. Without it the command only reports how many events it would replace. Not gated by the plugin switch: it also works while the switch is off`,
    // The session id is optional and defaults to the calling session, so the
    // flag comes first here too: leading with `session id` made readers think an
    // id was required before the command could run at all.
    input: { hint: "--yes to confirm; optional session id (bare invocation only reports the plan)" },
    recordInput: false,
    async handler(invocation) {
      const tokens = invocation.rawInput.trim().split(/\s+/u).filter((token) => token.length > 0);
      const confirmed = tokens.includes("--yes");
      const unknown = tokens.find((token) => token.startsWith("--") && token !== "--yes");
      if (unknown !== void 0) {
        return { kind: "error", text: `zip-compact: unknown option ${unknown}. Usage: /zip-compact [session id] [--yes]` };
      }
      const named = tokens.find((token) => !token.startsWith("--")) ?? "";
      const fallbackId = String(invocation.agent?.session?.id ?? "");
      try {
        if (!confirmed) {
          const plan = await actions.plan(named.length > 0 ? named : fallbackId);
          return { kind: "success", text: manualPlanText(plan) };
        }
        const outcome = await actions.run(named.length > 0 ? named : fallbackId, invocation.signal, invocation.commandId);
        return { kind: "success", text: manualDoneText(outcome) };
      } catch (error) {
        const sessionId = named.length > 0 ? named : fallbackId;
        let settings = {};
        try {
          settings = actions.failure(sessionId) ?? {};
        } catch {
        }
        return { kind: "error", text: manualFailureText(sessionId, error, settings) };
      }
    }
  });
}
function readFailureCount(sessionId) {
  try {
    return failureCount(sessionId);
  } catch {
    return 0;
  }
}

// src/index.ts
import {
  COMPACTED_ANSWER_GUIDANCE,
  NOTES_GUIDANCE,
  NOTES_MAX_CHARS as NOTES_MAX_CHARS3,
  NOTES_REMINDER_INSTRUCTION,
  REMINDER_THRESHOLD_PERCENT,
  SUMMARY_HARD_CAP_TOKENS,
  SUMMARY_SOFT_TARGET_TOKENS
} from "dsh-context-zip/engine/prompt";

// src/session-key.ts
var SESSION_KEY = /^session-[A-Za-z0-9-]{1,120}$/;
function isSessionKey(key) {
  return typeof key === "string" && SESSION_KEY.test(key);
}

// src/routes.ts
var ROUTE_PREFIX = "/dsh-context-zip";
var MAX_BODY_BYTES = 16 * 1024;
var MAX_QUERY_CHARS = 512;
var SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/u;
function listedSessionKeys(value) {
  const keys = [...Object.keys(value?.agents ?? {}), ...Object.keys(value?.retrievalAgents ?? {})];
  return [...new Set(keys.filter((key) => isSessionKey(key)))];
}
function titlesNow(state, options, keys) {
  if (typeof options?.createTitles !== "function") return {};
  try {
    if (state.memo === null) {
      const memo = options.createTitles({
        read: (batch) => options.readSessionTitles(batch),
        warn: (message) => options.warn?.(message)
      });
      state.memo = memo !== null && typeof memo.titles === "function" ? memo : void 0;
    }
    return state.memo?.titles(keys) ?? {};
  } catch (error) {
    options.warn?.(`session titles memo failed: ${String(error?.message ?? error)}`);
    return {};
  }
}
async function attentionNow(options, input) {
  if (typeof options?.readAttention !== "function") return null;
  try {
    const attention = await options.readAttention(input);
    return attention !== null && typeof attention === "object" ? attention : null;
  } catch {
    return null;
  }
}
function registerRoutes(ctx, options) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) return [];
  const titles = { memo: null, options };
  return [
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/settings`,
      handler: (req, res) => {
        if (!isLoopback(req) || req.method !== "GET") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        const value = options.readSettings();
        return respond(res, 200, {
          ok: true,
          value,
          effective: options.readEffectiveMode(),
          titles: titlesNow(titles, options, listedSessionKeys(value))
        });
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/live`,
      handler: (req, res) => {
        if (!isLoopback(req) || req.method !== "GET") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        const nextTitles = titlesNow(titles, options, listedSessionKeys(options.readSettings()));
        return respond(res, 200, { ok: true, effective: options.readEffectiveMode(), titles: nextTitles });
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/settings/update`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return respond(res, 403, { ok: false, error: "forbidden" });
        if (req.method !== "POST") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
          return respond(res, 415, { ok: false, error: "content-type-must-be-json" });
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return respond(res, 400, { ok: false, error: "bad-request" });
        }
        try {
          const value = await options.writeSettings(body);
          return respond(res, 200, { ok: true, value });
        } catch (error) {
          return respond(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/wire`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return respond(res, 403, { ok: false, error: "forbidden" });
        if (req.method === "GET") {
          try {
            const status = await options.readWireStatus();
            const processStartedAt = processStartedAtNow();
            const attention = await attentionNow(options, { status, processStartedAt });
            return respond(res, 200, { ok: true, ...status, processStartedAt, attention });
          } catch (error) {
            const processStartedAt = processStartedAtNow();
            const attention = await attentionNow(options, { kind: "unknown" });
            return respond(res, 500, {
              ok: false,
              error: String(error?.message ?? error),
              processStartedAt,
              attention
            });
          }
        }
        if (req.method !== "POST") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
          return respond(res, 415, { ok: false, error: "content-type-must-be-json" });
        }
        try {
          const result = await options.wireRow();
          const processStartedAt = processStartedAtNow();
          const attention = await attentionNow(options, { status: result, processStartedAt });
          return respond(res, 200, { ok: true, ...result, processStartedAt, attention });
        } catch (error) {
          const processStartedAt = processStartedAtNow();
          const attention = await attentionNow(options, { kind: "failed" });
          return respond(res, 500, {
            ok: false,
            error: String(error?.message ?? error),
            processStartedAt,
            attention
          });
        }
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/mode`,
      handler: (req, res) => {
        if (!isLoopback(req) || req.method !== "GET") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const raw = url.searchParams.get("sessionId") ?? "";
        if (raw.length > MAX_QUERY_CHARS || !SESSION_ID_RE.test(raw)) {
          return respond(res, 400, { ok: false, error: "invalid-session-id" });
        }
        const mode = options.readModeFor(raw);
        if (mode === null) return respond(res, 404, { ok: false, error: "session-not-found" });
        return respond(res, 200, { ok: true, mode });
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/models`,
      handler: async (req, res) => {
        if (!isLoopback(req) || req.method !== "GET") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        try {
          const catalog = await options.listModels();
          return respond(res, 200, { ok: true, providers: catalog.providers, failures: catalog.failures });
        } catch (error) {
          return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/segments`,
      handler: async (req, res) => {
        if (!isLoopback(req) || req.method !== "GET") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const raw = url.searchParams.get("sessionId") ?? "";
        if (raw.length > MAX_QUERY_CHARS || !SESSION_ID_RE.test(raw)) {
          return respond(res, 400, { ok: false, error: "invalid-session-id" });
        }
        try {
          const segments = await options.listSegments(raw);
          return respond(res, 200, {
            ok: true,
            lines: segments.map((segment) => describeSegment(segment))
          });
        } catch (error) {
          return respond(res, 404, { ok: false, error: String(error?.message ?? error) });
        }
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/compact/plan`,
      handler: async (req, res) => {
        if (!isLoopback(req) || req.method !== "GET") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const raw = url.searchParams.get("sessionId") ?? "";
        if (raw.length > MAX_QUERY_CHARS || raw.length > 0 && !SESSION_ID_RE.test(raw)) {
          return respond(res, 400, { ok: false, error: "invalid-session-id" });
        }
        try {
          const plan = await options.readManualPlan(raw.length > 0 ? raw : null);
          return respond(res, 200, {
            ok: true,
            ...plan,
            failure: readManualFailure(options, plan.sessionId)
          });
        } catch (error) {
          return respond(res, manualStatus(error), {
            ok: false,
            error: typeof error?.code === "string" ? error.code : "plan-failed",
            message: String(error?.message ?? error)
          });
        }
      }
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/compact`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return respond(res, 403, { ok: false, error: "forbidden" });
        if (req.method !== "POST") return respond(res, 405, { ok: false, error: "method-not-allowed" });
        if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
          return respond(res, 415, { ok: false, error: "content-type-must-be-json" });
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return respond(res, 400, { ok: false, error: "bad-request" });
        }
        const named = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        if (named.length > MAX_QUERY_CHARS || named.length > 0 && !SESSION_ID_RE.test(named)) {
          return respond(res, 400, { ok: false, error: "invalid-session-id" });
        }
        try {
          const outcome = await options.runManualCompaction(named.length > 0 ? named : null);
          return respond(res, 200, { ok: true, ...outcome, failure: readManualFailure(options, outcome.sessionId) });
        } catch (error) {
          return respond(res, 500, {
            ok: false,
            error: "compaction-failed",
            code: typeof error?.code === "string" ? error.code : "unknown",
            message: String(error?.message ?? error),
            sessionId: named,
            failure: readManualFailure(options, named)
          });
        }
      }
    })
  ];
}
function manualStatus(error) {
  switch (error?.code) {
    case "session-required":
      return 409;
    case "invalid-session-id":
      return 400;
    default:
      return 404;
  }
}
function readManualFailure(options, sessionId) {
  if (typeof options.readManualFailure !== "function" || typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }
  try {
    return options.readManualFailure(sessionId) ?? null;
  } catch {
    return null;
  }
}
function processStartedAtNow() {
  return new Date(Date.now() - process.uptime() * 1e3).toISOString();
}
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function readJsonBody(req) {
  return new Promise((resolve2, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (data.length === 0) return resolve2({});
      try {
        resolve2(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
function respond(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

// src/session-titles.ts
var TITLE_TTL_MS = 6e4;
var NO_TITLE = Symbol("no-title");
async function sessionTitlesFor(ctx, keys) {
  const titles = {};
  const wanted = [];
  const seen = /* @__PURE__ */ new Set();
  for (const key of keys ?? []) {
    if (typeof key !== "string" || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    wanted.push(key);
  }
  if (wanted.length === 0) return titles;
  const query = ctx.get("sessionQuery");
  if (query === void 0 || typeof query.readTitleSnapshots !== "function") return titles;
  let results;
  try {
    results = await query.readTitleSnapshots(wanted);
  } catch {
    return titles;
  }
  if (!Array.isArray(results)) return titles;
  for (const result of results) {
    const id = result?.sessionId;
    if (typeof id !== "string" || id.length === 0) continue;
    if (result.status !== "fulfilled") continue;
    const raw = result.value?.title?.title;
    const title = typeof raw === "string" ? raw.trim() : "";
    if (title.length > 0) titles[id] = title;
  }
  return titles;
}
function createTitleMemo(options) {
  const read = options?.read;
  const warn = typeof options?.warn === "function" ? options.warn : () => {
  };
  const now = typeof options?.now === "function" ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(options?.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TITLE_TTL_MS;
  let resolved = {};
  let supported = /* @__PURE__ */ new Set();
  let absent = /* @__PURE__ */ new Set();
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let wanted = /* @__PURE__ */ new Set();
  let inFlight = /* @__PURE__ */ new Set();
  let pending = [];
  const fold = async (batch) => {
    const keys = batch.keys;
    if (keys.length === 0) return {};
    for (const id of keys) {
      inFlight.add(id);
      wanted.add(id);
    }
    let titles2;
    try {
      titles2 = typeof read === "function" ? await read(keys) : {};
    } catch (error) {
      warn(`session titles read failed: ${String(error?.message ?? error)}`);
      return {};
    } finally {
      for (const id of keys) inFlight.delete(id);
    }
    if (titles2 === null || typeof titles2 !== "object") return {};
    if (batch.stale) {
      supported = /* @__PURE__ */ new Set();
      absent = /* @__PURE__ */ new Set();
    }
    for (const id of keys) {
      const title = typeof titles2[id] === "string" ? titles2[id].trim() : "";
      if (title.length > 0) {
        resolved[id] = title;
        supported.add(id);
        absent.delete(id);
      } else if (!supported.has(id)) {
        resolved = { ...resolved };
        delete resolved[id];
        absent.add(id);
      }
    }
    if (batch.stale) {
      for (const id of Object.keys(resolved)) {
        if (wanted.has(id) && !supported.has(id)) {
          resolved = { ...resolved };
          delete resolved[id];
        }
      }
    }
    refreshedAt = now();
    return titles2;
  };
  const runRefresh = async () => {
    try {
      while (pending.length > 0) {
        const [batch, ...rest] = pending;
        pending = rest;
        await fold(batch);
      }
    } catch (error) {
      warn(`session titles refresh failed: ${String(error?.message ?? error)}`);
    }
  };
  const known = (id) => supported.has(id) || absent.has(id);
  let busy = false;
  const refresh = (keys, stale = false) => {
    const unknown = [];
    for (const id of keys ?? []) {
      if (typeof id !== "string" || id.length === 0) continue;
      wanted.add(id);
      if (inFlight.has(id)) continue;
      if (stale === false && known(id)) continue;
      if (!unknown.includes(id)) unknown.push(id);
    }
    if (unknown.length === 0) return busy;
    pending.push({ stale, keys: unknown });
    if (busy) return true;
    busy = true;
    void runRefresh().finally(() => {
      busy = false;
      if (pending.length > 0) refresh([]);
    });
    return true;
  };
  const titles = (keys) => {
    const asked = [];
    for (const id of keys ?? []) {
      if (typeof id !== "string" || id.length === 0) continue;
      wanted.add(id);
      if (!asked.includes(id)) asked.push(id);
    }
    if (asked.length > 0) {
      if (now() - refreshedAt >= ttlMs) {
        refreshedAt = now();
        refresh([...wanted], true);
      } else if (asked.some((id) => !known(id))) {
        refresh(asked, false);
      }
    }
    return { ...resolved };
  };
  return { titles, refresh, ttlMs };
}

// src/wire.ts
import { cp, lstat, mkdir as mkdir3, readFile as readFile2, readdir as readdir2, realpath, rm as rm2, stat, writeFile as writeFile3 } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname as dirname2, join as join3, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dshHomePath as dshHomePath2 } from "@deepseek-ai/dsh-home-paths";

// src/threshold.ts
var THRESHOLD_MIN_FORM = "Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))";
var THRESHOLD_RATIO_FORM = "Math.floor(contextWindow * policy.thresholdRatio)";
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}
function inspectThreshold(text) {
  const min = count(text, THRESHOLD_MIN_FORM);
  const ratio = count(text, THRESHOLD_RATIO_FORM);
  if (min === 0 && ratio === 1) return "ratio-only";
  if (min === 1 && ratio === 0) return "stock";
  return "unknown";
}
function planThreshold(source, options = {}) {
  const observed = inspectThreshold(source);
  if (observed === "stock") {
    return {
      state: "ratio-only",
      text: source.replace(THRESHOLD_MIN_FORM, THRESHOLD_RATIO_FORM),
      reason: "second cap removed: the threshold is the ratio alone, as 0.1.5 through 0.1.6-alpha.2 had it"
    };
  }
  if (observed === "ratio-only") {
    return {
      state: "not-needed",
      text: source,
      reason: "this backend already caps by the ratio alone; nothing to change"
    };
  }
  if (options.allowStock === true) {
    return {
      state: "none",
      text: source,
      reason: "backend wired unpatched (--stock-backend)"
    };
  }
  throw new Error(
    `the shipped backend does not carry the threshold expression this plugin patches (0.1.7 form \xD7${count(source, THRESHOLD_MIN_FORM)}, ratio-only form \xD7${count(source, THRESHOLD_RATIO_FORM)}): refusing to wire a redirect whose backend cannot be verified. Re-run install.mjs with --stock-backend to wire it unpatched, then update this plugin.`
  );
}
function thresholdWriteMatches(text, plan) {
  if (text !== plan.text) return false;
  return plan.state === "none" || inspectThreshold(text) === "ratio-only";
}
function thresholdDrift(stamped, text) {
  const observed = inspectThreshold(text);
  if (stamped === "ratio-only" || stamped === "not-needed") return observed !== "ratio-only";
  if (stamped === "none") return false;
  return observed === "stock";
}

// src/wire.ts
var REDIRECT_PACKAGE = "@deepseek-ai/dsh-compaction-basic";
var REDIRECT_MARKER = "context-zip";
var STAMP_FILE = "base.json";
var PLUGIN_NAME = "dsh-context-zip";
async function canonical(target) {
  return realpath(target).catch(() => resolve(target));
}
function isInside(real, root) {
  return real === root || real.startsWith(`${root}${sep}`);
}
async function flattenPath(target) {
  const parts = [];
  let probe = target;
  for (; ; ) {
    try {
      return { flattened: join3(await realpath(probe), ...parts), anchor: probe, rest: parts };
    } catch {
      const parent = dirname2(probe);
      if (parent === probe) return { flattened: target, anchor: probe, rest: [] };
      parts.unshift(basename(probe));
      probe = parent;
    }
  }
}
async function assertPathInsideProfile(target, label, profileReal) {
  const absolute = resolve(target);
  const { flattened, anchor, rest } = await flattenPath(absolute);
  if (!isInside(flattened, profileReal)) {
    throw new Error(
      `${label} is ${absolute}, which resolves to ${flattened}, outside the profile ${profileReal}. This route writes through symlinks. Refusing before anything is written. Fix: make the affected directory a real directory and symlink each package inside it individually, instead of symlinking the directory as a whole.`
    );
  }
  let current = anchor;
  for (const segment of rest) {
    const candidate = join3(current, segment);
    let stats;
    try {
      stats = await lstat(candidate);
    } catch {
      break;
    }
    current = candidate;
    if (stats.isSymbolicLink()) {
      let resolved;
      try {
        resolved = await realpath(current);
      } catch {
        throw new Error(
          `${label} is hidden behind the symlink ${current}, which points at nothing that exists. This route writes through symlinks, so it cannot tell where that would land. Refusing.`
        );
      }
      if (!isInside(resolved, profileReal)) {
        throw new Error(
          `${label} is hidden behind the symlink ${current}, which resolves to ${resolved}, outside the profile ${profileReal}. This route writes through symlinks. Refusing before anything is written. Fix: make the directory that holds it a real directory and symlink each package inside that directory individually, instead of symlinking the directory as a whole.`
        );
      }
    }
  }
  return flattened;
}
async function profileRejection(dir, pluginDir) {
  const real = await canonical(dir);
  const pluginReal = await canonical(pluginDir);
  if (real === pluginReal) return "it is the directory this plugin itself lives in";
  let manifest;
  try {
    manifest = JSON.parse(await readFile2(join3(dir, "package.json"), "utf8"));
  } catch {
    return "there is no readable package.json there";
  }
  if (manifest?.name === PLUGIN_NAME) return "its package.json names this plugin";
  return null;
}
async function profileFromHome(pluginDir) {
  const profiles = join3(dshHomePath2(), "profiles");
  let names;
  try {
    names = await readdir2(profiles);
  } catch {
    return null;
  }
  const pluginReal = await canonical(pluginDir);
  const matches = [];
  for (const name2 of names) {
    const dir = join3(profiles, name2);
    let here;
    try {
      here = await realpath(join3(dir, "node_modules", PLUGIN_NAME));
    } catch {
      continue;
    }
    if (here !== pluginReal) continue;
    if (await profileRejection(dir, pluginDir) !== null) continue;
    matches.push(dir);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function resolveProfileDirectory(baseUrl, pluginDir) {
  const typed = typeof baseUrl === "string" && baseUrl.length > 0 ? toDirectory(baseUrl) : null;
  if (typed !== null) {
    const rejection = await profileRejection(typed, pluginDir);
    if (rejection === null) return typed;
    const fromHome2 = await profileFromHome(pluginDir);
    if (fromHome2 !== null) return fromHome2;
    throw new Error(
      `the DSH context base URL is ${typed}, and that is not a profile: ${rejection}. No profile under ${join3(dshHomePath2(), "profiles")} holds this plugin either, so the profile cannot be named. Refusing to write: guessing a profile would put the redirect in somebody else's tree. Re-run \`node install.mjs --profile-dir <profile>\` instead.`
    );
  }
  const fromHome = await profileFromHome(pluginDir);
  if (fromHome !== null) return fromHome;
  throw new Error(
    `the DSH context carries no base URL, and no profile under ${join3(dshHomePath2(), "profiles")} holds this plugin, so the profile cannot be named. Refusing to write: guessing a profile would put the redirect in somebody else's tree. Re-run \`node install.mjs --profile-dir <profile>\` instead.`
  );
}
function toDirectory(candidate) {
  if (candidate.startsWith("file:")) {
    try {
      return fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  return resolve(candidate);
}
async function resolveModulesRoot(profileDir, profileReal) {
  const modules = resolve(join3(profileDir, "node_modules"));
  const { flattened } = await flattenPath(modules);
  if (!isInside(flattened, profileReal)) {
    throw new Error(
      `${modules} resolves to ${flattened}, which is outside the profile ${profileReal}. This route writes through symlinks. Refusing before anything is written. Fix: make node_modules a real directory and symlink each package inside it individually.`
    );
  }
  if (flattened === profileReal) {
    throw new Error(
      `${modules} resolves to the profile directory itself (${profileReal}), not to a directory inside it. Refusing to write into the profile root.`
    );
  }
  return flattened;
}
async function redirectTarget(profileDir, profileReal) {
  const modulesRoot = await resolveModulesRoot(profileDir, profileReal);
  const target = join3(modulesRoot, REDIRECT_PACKAGE);
  return assertPathInsideProfile(target, "the redirect directory", profileReal);
}
async function redirectOccupant(redirectDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile2(join3(redirectDir, "package.json"), "utf8"));
  } catch {
    return "absent";
  }
  return String(manifest.version ?? "").includes(REDIRECT_MARKER) ? "ours" : "foreign";
}
async function readStamp(redirectDir) {
  try {
    const stamp = JSON.parse(await readFile2(join3(redirectDir, STAMP_FILE), "utf8"));
    return stamp !== null && typeof stamp === "object" ? stamp : null;
  } catch {
    return null;
  }
}
async function hostLookupBases() {
  const entry = process.argv?.[1];
  if (typeof entry !== "string" || entry.length === 0) return [];
  let started;
  try {
    started = await realpath(entry);
  } catch {
    started = resolve(entry);
  }
  const bases = [];
  for (let dir = dirname2(started); ; dir = dirname2(dir)) {
    bases.push(join3(dir, "node_modules"));
    bases.push(join3(dir, "node_modules", ".pnpm", "node_modules"));
    const parent = dirname2(dir);
    if (parent === dir) break;
  }
  return bases;
}
async function basePackageDir(profileDir) {
  const require2 = createRequire(join3(profileDir, "package.json"));
  const bases = [...require2.resolve.paths(REDIRECT_PACKAGE) ?? []];
  for (const base of await hostLookupBases()) {
    if (!bases.includes(base)) bases.push(base);
  }
  for (const base of bases) {
    const candidate = join3(base, REDIRECT_PACKAGE);
    let manifest;
    try {
      manifest = JSON.parse(await readFile2(join3(candidate, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (String(manifest.version ?? "").includes(REDIRECT_MARKER)) continue;
    return candidate;
  }
  throw new Error(`cannot locate a shipped ${REDIRECT_PACKAGE} from ${profileDir}`);
}
async function recordedBackendDir(redirectDir) {
  let stamp;
  try {
    stamp = JSON.parse(await readFile2(join3(redirectDir, STAMP_FILE), "utf8"));
  } catch {
    return null;
  }
  const source = typeof stamp.source === "string" ? stamp.source : null;
  if (source === null) return null;
  try {
    const manifest = JSON.parse(await readFile2(join3(source, "package.json"), "utf8"));
    if (String(manifest.version ?? "").includes(REDIRECT_MARKER)) return null;
    return source;
  } catch {
    return null;
  }
}
async function wireBackendDir(profileDir, redirectDir) {
  try {
    return await basePackageDir(profileDir);
  } catch (error) {
    const recorded = await recordedBackendDir(redirectDir);
    if (recorded !== null) return recorded;
    throw new Error(
      `${String(error?.message ?? error)}. A redirect is installed at ${redirectDir}, so this profile no longer resolves that specifier, and the source its stamp recorded is gone too. Plant a copy of the real package at ${join3(dirname2(profileDir), "node_modules", "@deepseek-ai", "dsh-compaction-basic")} and press the button again.`
    );
  }
}
async function readWireStatus(options) {
  const { baseUrl, pluginDir } = options ?? {};
  const profileDir = await resolveProfileDirectory(baseUrl, pluginDir);
  const profileReal = await canonical(profileDir);
  const redirectDir = await redirectTarget(profileDir, profileReal);
  const occupant = await redirectOccupant(redirectDir);
  if (occupant !== "ours") {
    return { wired: false, version: null, copiedAt: null, stale: false, foreign: occupant === "foreign" };
  }
  const stamp = await readStamp(redirectDir);
  if (stamp === null) {
    return { wired: false, version: null, copiedAt: null, stale: false, partial: true };
  }
  const version = typeof stamp.version === "string" ? stamp.version : null;
  let stale = false;
  let current = null;
  try {
    const shippedDir = await basePackageDir(profileDir);
    const shipped = JSON.parse(await readFile2(join3(shippedDir, "package.json"), "utf8"));
    current = String(shipped.version ?? "unknown");
    stale = current !== version;
  } catch {
  }
  let patchObserved = null;
  let patchDrift = false;
  try {
    const text = await readFile2(join3(redirectDir, "base.js"), "utf8");
    patchObserved = inspectThreshold(text);
    patchDrift = thresholdDrift(stamp.patch, text);
  } catch {
    patchDrift = true;
  }
  return {
    wired: true,
    version,
    current,
    copiedAt: typeof stamp.copiedAt === "string" ? stamp.copiedAt : null,
    stale,
    foreign: false,
    patch: typeof stamp.patch === "string" ? stamp.patch : null,
    patchObserved,
    patchDrift
  };
}
async function wireCompactionRow(options) {
  const { baseUrl, pluginDir } = options ?? {};
  const profileDir = await resolveProfileDirectory(baseUrl, pluginDir);
  const profileReal = await canonical(profileDir);
  const redirectDir = await redirectTarget(profileDir, profileReal);
  const occupant = await redirectOccupant(redirectDir);
  if (occupant === "foreign") {
    throw new Error(
      `${redirectDir} holds a real ${REDIRECT_PACKAGE}, not this plugin's redirect: refusing to overwrite a package this plugin did not put there. Move that copy up to ${join3(dirname2(profileDir), "node_modules")} (the shared level, where the backend is expected) and press the button again.`
    );
  }
  const baseDir = await wireBackendDir(profileDir, redirectDir);
  const baseManifest = JSON.parse(await readFile2(join3(baseDir, "package.json"), "utf8"));
  if (String(baseManifest.version ?? "").includes(REDIRECT_MARKER)) {
    throw new Error(
      `${baseDir} is a previous redirect, not the shipped backend: remove ${redirectDir} and press the button again so the real package resolves.`
    );
  }
  const baseEntry = join3(baseDir, baseManifest.exports?.["."]?.default ?? baseManifest.main);
  const baseSource = await readFile2(baseEntry, "utf8");
  const version = String(baseManifest.version ?? "unknown");
  const plan = planThreshold(baseSource, { allowStock: false });
  const sourceDir = join3(pluginDir, "redirect");
  const sourceIndex = join3(sourceDir, "index.js");
  const sourceManifest = join3(sourceDir, "package.json");
  try {
    await stat(sourceIndex);
    await stat(sourceManifest);
  } catch (error) {
    throw new Error(
      `this plugin's own redirect files are missing under ${sourceDir}: ${String(error?.message ?? error)}. Reinstall the plugin package and press the button again.`
    );
  }
  const stamp = {
    package: REDIRECT_PACKAGE,
    version,
    source: baseDir,
    copiedAt: (/* @__PURE__ */ new Date()).toISOString(),
    patch: plan.state
  };
  await rm2(redirectDir, { recursive: true, force: true });
  await mkdir3(redirectDir, { recursive: true });
  await cp(sourceManifest, join3(redirectDir, "package.json"));
  await cp(sourceIndex, join3(redirectDir, "index.js"));
  await writeFile3(join3(redirectDir, "base.js"), plan.text);
  const written = await readFile2(join3(redirectDir, "base.js"), "utf8");
  if (!thresholdWriteMatches(written, plan)) {
    await rm2(redirectDir, { recursive: true, force: true });
    throw new Error(
      `wrote ${join3(redirectDir, "base.js")} but read back ${inspectThreshold(written)}: removed the redirect rather than leave an unverified backend in place`
    );
  }
  await writeFile3(join3(redirectDir, STAMP_FILE), JSON.stringify(stamp, void 0, 2) + "\n");
  return { wired: true, version, copiedAt: stamp.copiedAt, source: baseDir, patch: plan.state };
}
var IMPORTED_SETTINGS = "settings.yaml.imported";
var LIVE_SETTINGS = "settings.yaml";
var SETTINGS_SECTION_RE = /^["']?context-zip["']?[ \t]*:/mu;
async function importedSettingsPending(home) {
  if (typeof home !== "string" || home.length === 0) return false;
  for (const name2 of [IMPORTED_SETTINGS, LIVE_SETTINGS]) {
    try {
      const text = await readFile2(join3(home, name2), "utf8");
      if (SETTINGS_SECTION_RE.test(text)) return true;
    } catch {
    }
  }
  return false;
}
function copiedAfterStart(copiedAt, processStartedAt) {
  if (typeof copiedAt !== "string" || copiedAt.length === 0) return false;
  if (typeof processStartedAt !== "string" || processStartedAt.length === 0) return false;
  const copied = Date.parse(copiedAt);
  const started = Date.parse(processStartedAt);
  if (Number.isFinite(copied) === false || Number.isFinite(started) === false) return false;
  return copied > started;
}
function attentionKind(status, processStartedAt) {
  const wired = status?.wired === true;
  if (wired && status?.stale === true) return "update";
  if (wired !== true) {
    if (status?.foreign === true) return null;
    return status?.partial === true ? "incomplete" : "inactive";
  }
  if (copiedAfterStart(status?.copiedAt, processStartedAt)) return "restart";
  return null;
}
async function readAttention(options) {
  const { status, processStartedAt, profileDir, rowConfigured, kind: forced } = options ?? {};
  let home;
  try {
    home = dshHomePath2();
  } catch {
    return null;
  }
  if (typeof home !== "string" || home.length === 0) return null;
  const profile = typeof profileDir === "string" && profileDir.length > 0 ? basename(profileDir) : "";
  if (profile.length === 0) return null;
  const kind = typeof forced === "string" && forced.length > 0 ? forced : attentionKind(status, processStartedAt);
  if (kind === null) return null;
  if (kind === "inactive" && rowConfigured === false) {
    let pending = false;
    try {
      pending = await importedSettingsPending(home);
    } catch {
      pending = false;
    }
    if (pending) return { kind: "migrate", home, profile };
  }
  return { kind, home, profile };
}

// src/panel-copy.ts
var FALLBACK_ENABLED_COPY = {
  en: "When a compaction keeps failing to produce a usable summary, fall back to a summary the plugin writes itself from the session events, instead of failing the compaction again. Off (the default) reports the failure and leaves the conversation untouched, which is the conservative behaviour: nothing enters the context that a model did not write. On, the compaction always lands, at the cost of a summary that reads like a ledger and carries none of a model summary judgement. The mechanical summary cannot invent anything, because every line of it comes from the events themselves.",
  zh: "\u538B\u7F29\u5C1D\u8BD5\u8FDE\u7EED\u5931\u8D25\u8FBE\u5230\u300C\u5931\u8D25\u51E0\u6B21\u540E\u515C\u5E95\u300D\u8BBE\u5B9A\u7684\u6B21\u6570\u65F6\uFF0C\u4EE5\u63D2\u4EF6\u4F9D\u636E\u4F1A\u8BDD\u4E8B\u4EF6\u81EA\u884C\u62FC\u5199\u7684\u53F0\u8D26\u6458\u8981\u66FF\u4EE3\u6A21\u578B\u6458\u8981\uFF0C\u4F7F\u538B\u7F29\u843D\u5730\u3002\u5173\u95ED\uFF08\u9ED8\u8BA4\uFF09\u65F6\uFF0C\u5C1D\u8BD5\u6B21\u6570\u7528\u5C3D\u5373\u62A5\u544A\u5931\u8D25\uFF0C\u65E7\u5BF9\u8BDD\u539F\u6837\u4FDD\u7559\uFF0C\u4E0A\u4E0B\u6587\u4E2D\u4E0D\u8FDB\u5165\u4EFB\u4F55\u975E\u6A21\u578B\u64B0\u5199\u7684\u5185\u5BB9\u3002\u5F00\u542F\u65F6\u538B\u7F29\u5FC5\u7136\u5B8C\u6210\uFF0C\u4EE3\u4EF7\u662F\u6458\u8981\u5F62\u5982\u53F0\u8D26\uFF0C\u4E0D\u5177\u5907\u6A21\u578B\u6458\u8981\u7684\u5224\u65AD\u529B\uFF1B\u8BE5\u6458\u8981\u7684\u6BCF\u4E00\u884C\u5747\u6765\u81EA\u4F1A\u8BDD\u4E8B\u4EF6\u672C\u8EAB\uFF0C\u4E0D\u53EF\u80FD\u7F16\u9020\u3002"
};
var REWRITE_ENABLED_COPY = {
  en: 'Rewrite the FORM of a summary that the shape gate accepted as prose, so a later model can find things in it again. Off by default. It fires only on the summaries the gate reports as "unrecognised-sections" \u2014 the accepted-but-unstructured ones \u2014 never on the tool-call-markup or too-short failures, which go through retry and the mechanical fallback instead. The call receives the summary and nothing else, is asked to change layout only, is pinned to the lowest reasoning effort the model advertises, and is discarded whenever it adds a token the original summary did not have. Any failure keeps the original prose, so this can never fail a compaction.',
  zh: "\u5BF9\u5F62\u6001\u95E8\u5224\u5B9A\u4E3A\u65E0\u5C0F\u6807\u9898\u7ED3\u6784\u7684\u6458\u8981\uFF0C\u8FFD\u52A0\u4E00\u6B21\u4EC5\u8C03\u6574\u6392\u7248\u7684\u91CD\u6392\u8C03\u7528\u3002\u8BE5\u8C03\u7528\u53EA\u643A\u5E26\u8FD9\u4EFD\u6458\u8981\uFF0C\u4E0D\u91CD\u53D1\u88AB\u538B\u7F29\u7684\u5BF9\u8BDD\uFF0C\u601D\u8003\u6863\u4F4D\u56FA\u5B9A\u5728\u6A21\u578B\u58F0\u660E\u7684\u6700\u4F4E\u6863\uFF0C\u4E14\u53EA\u5141\u8BB8\u6309\u4E94\u6BB5\u5F0F\u91CD\u6392\uFF0C\u4E0D\u5F97\u589E\u5220\u4E8B\u5B9E\u3002\u91CD\u6392\u524D\u540E\u5404\u6267\u884C\u4E00\u6B21\u7F16\u9020\u68C0\u67E5\uFF0C\u53EA\u8981\u51FA\u73B0\u539F\u6458\u8981\u4E2D\u6CA1\u6709\u7684 token\uFF0C\u5373\u4E22\u5F03\u91CD\u6392\u7ED3\u679C\u5E76\u91C7\u7528\u539F\u6458\u8981\uFF1B\u8C03\u7528\u5931\u8D25\u540C\u6837\u91C7\u7528\u539F\u6458\u8981\uFF0C\u56E0\u6B64\u8BE5\u529F\u80FD\u4E0D\u4F1A\u5BFC\u81F4\u538B\u7F29\u5931\u8D25\u3002"
};

// src/tools.ts
import { appendFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
  HISTORY_READ_MAX_CHARS as HISTORY_READ_MAX_CHARS2,
  HISTORY_SEARCH_DEFAULT_LIMIT,
  HISTORY_SEARCH_MAX_LIMIT,
  HISTORY_SEARCH_SNIPPET_CHARS,
  NOTES_MAX_CHARS as NOTES_MAX_CHARS2,
  NOTES_READ_DESCRIPTION,
  NOTES_SEARCH_DESCRIPTION,
  NOTES_WRITE_ACK,
  NOTES_WRITE_DESCRIPTION,
  HISTORY_SEARCH_PAGE_BUDGET_CHARS,
  RETRIEVAL_RECEIPT_NOTE,
  TOOL_RESULT_STORE_CEILING_CHARS,
  clampToStoreCeiling
} from "dsh-context-zip/engine/prompt";
var TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value) }]
};
var NARROW_AFTER_ZERO_STREAK = 2;
var MAX_SEARCH_CREDITS = 1;
var HELD_SEQ_LIST_LIMIT = 12;
var FIND_TERM_LIST_LIMIT = 6;
var NARROWED_READ_MAX_CHARS = HISTORY_READ_DEFAULT_CHARS;
var NARROWED_READ_BUDGET = 3;
function narrowedForReads(sessionId, turnStart) {
  if (turnStart === null) return false;
  const ledger = turnLedgers.get(`${sessionId}#${turnStart}`);
  return ledger !== void 0 && ledger.narrowed;
}
function narrowedReadsExhausted(sessionId, turnStart) {
  if (!narrowedForReads(sessionId, turnStart)) return false;
  const ledger = turnLedgers.get(`${sessionId}#${turnStart}`);
  return ledger !== void 0 && ledger.narrowedReads >= NARROWED_READ_BUDGET;
}
function narrowedReadsSpent() {
  return [
    `[Reads are exhausted for this turn: ${NARROWED_READ_BUDGET} were allowed after narrowing began and`,
    `they are used up. Answer from what you already have and name the part you could not resolve.]`
  ].join("\n");
}
function narrowedReadNote() {
  return [
    `[Narrowing is in force, so this read is capped at ${NARROWED_READ_MAX_CHARS} characters: enough to check a`,
    `lead, not enough to load an event into context. Page with "offset" if you need the next slice, or`,
    `answer from what you have and name the part you could not resolve.]`
  ].join("\n");
}
var throttleEnabled = false;
function setThrottleEnabled(on) {
  throttleEnabled = on === true;
}
var tracePath = null;
function setTracePath(path) {
  tracePath = typeof path === "string" && path.length > 0 ? path : null;
}
function traceRetrieval(record) {
  if (tracePath === null) return;
  try {
    appendFileSync(tracePath, `${JSON.stringify(record)}
`, "utf8");
  } catch {
  }
}
var throttleListener = null;
function setThrottleListener(listener) {
  throttleListener = listener;
}
function servedInTurn(sessionId, turnStart) {
  if (!throttleEnabled) return /* @__PURE__ */ new Set();
  if (turnStart === null) return /* @__PURE__ */ new Set();
  const served = turnLedgers.get(`${sessionId}#${turnStart}`)?.served;
  if (served === void 0) return /* @__PURE__ */ new Set();
  const fully = /* @__PURE__ */ new Set();
  for (const seq of served.keys()) if (isFullyHeld(served, seq)) fully.add(seq);
  return fully;
}
function isFullyHeld(served, seq) {
  const entry = served.get(seq);
  if (entry === void 0) return false;
  if (entry.whole) return true;
  if (entry.total === null) return false;
  let reach = 0;
  for (const [start, end] of [...entry.ranges].sort((a, b) => a[0] - b[0])) {
    if (start > reach) return false;
    if (end > reach) reach = end;
  }
  return reach >= entry.total;
}
function addHeld(served, seq, partial) {
  let entry = served.get(seq);
  if (entry === void 0) {
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
function notifyThrottle(session, ledger) {
  if (throttleListener === null) return;
  try {
    throttleListener(session, ledger.narrowed && ledger.searchCredits <= 0);
  } catch {
  }
}
var turnLedgers = /* @__PURE__ */ new Map();
var TURN_LEDGER_MEMORY = 64;
function recordRetrieval(sessionId, turnStart, seqs, discovery, heldSeqs = [], partial = null, termNote = "") {
  const omitted = heldSeqs.length;
  const termOnly = termNote === "" ? "" : `[${termNote}]`;
  if (turnStart === null || seqs.length + omitted === 0) return termOnly;
  const key = `${sessionId}#${turnStart}`;
  let ledger = turnLedgers.get(key);
  if (ledger === void 0) {
    if (turnLedgers.size >= TURN_LEDGER_MEMORY) {
      turnLedgers.delete(turnLedgers.keys().next().value);
    }
    ledger = {
      served: /* @__PURE__ */ new Map(),
      retrievals: 0,
      zeroStreak: 0,
      narrowed: false,
      searchCredits: 0,
      narrowedReads: 0
    };
    turnLedgers.set(key, ledger);
  }
  let fresh = 0;
  for (const seq of seqs) if (!isFullyHeld(ledger.served, seq)) fresh += 1;
  ledger.retrievals += 1;
  if (discovery) {
    if (fresh === 0) ledger.zeroStreak += 1;
    else ledger.zeroStreak = 0;
    if (ledger.zeroStreak === 0) ledger.narrowed = false;
    if (ledger.zeroStreak >= NARROW_AFTER_ZERO_STREAK) ledger.narrowed = true;
    if (ledger.narrowed && ledger.searchCredits > 0) ledger.searchCredits -= 1;
  } else if (ledger.narrowed) {
    ledger.narrowedReads += 1;
    ledger.searchCredits = Math.min(MAX_SEARCH_CREDITS, ledger.searchCredits + 1);
  }
  for (const seq of seqs) {
    const applies = partial !== null && (partial.seq === null || partial.seq === seq);
    addHeld(ledger.served, seq, applies ? partial : null);
  }
  traceRetrieval({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    session: sessionId,
    turn: turnStart,
    n: ledger.retrievals,
    kind: discovery ? "sweep" : "read",
    fresh,
    omitted,
    servedTotal: ledger.served.size,
    heldInFull: [...ledger.served.keys()].filter((seq) => isFullyHeld(ledger.served, seq)).length,
    zeroStreak: ledger.zeroStreak,
    narrowed: ledger.narrowed,
    credits: ledger.searchCredits,
    throttle: throttleEnabled
  });
  const total = seqs.length;
  const noun = total === 1 ? "event" : "events";
  const counts = omitted === 0 ? fresh === total ? `${total} ${noun}, all new` : fresh === 0 ? `${total} ${noun}, none of them new: every one was already returned earlier this turn` : `${total} ${noun}, ${fresh} new and ${total - fresh} already returned earlier this turn` : total === 0 ? `nothing new; ${omitted} match(es) were already returned earlier this turn and are left out` : `${total} ${noun} shown; ${omitted} more were already returned earlier this turn and are left out`;
  const termPart = termNote === "" ? "" : `; ${termNote}`;
  const line = `[retrieval #${ledger.retrievals} this turn: ${counts}${termPart}]`;
  if (throttleEnabled) notifyThrottle({ id: sessionId }, ledger);
  const notes = [];
  if (!throttleEnabled) {
    return termNote === "" ? "" : `[retrieval #${ledger.retrievals} this turn: ${termNote}]`;
  }
  if (total === 0) {
    const named = heldSeqs.slice(0, HELD_SEQ_LIST_LIMIT);
    notes.push(
      `[Nothing new was returned because every match is already in this turn's context. The`,
      `${omitted} event(s) this query reaches are ${named.map((seq) => `#${seq}`).join(", ")}${omitted > named.length ? `, and ${omitted - named.length} more` : ""}.`,
      `Read any of them in full with history_read, or answer from what you have and name the part`,
      `you could not resolve.]`
    );
  }
  if (discovery && ledger.narrowed) {
    notes.push(
      `[Two retrievals in a row added nothing new, so history_search and history_find are paused: the`,
      `material they can reach is already in this turn's context. history_read still works \u2014 read any`,
      `event number you have already seen, and one read gives you one more search.]`
    );
  }
  return notes.length === 0 ? line : [line, ...notes].join("\n");
}
function registerTools(ctx, options) {
  const disposers = [
    ctx.tools.register(historySegmentsTool(ctx)),
    ctx.tools.register(historyReadTool(ctx)),
    ctx.tools.register(historySearchTool(ctx, options)),
    ctx.tools.register(historyFindTool(ctx, options)),
    ctx.tools.register(notesWriteTool(options)),
    ctx.tools.register(notesReadTool(options)),
    ctx.tools.register(notesSearchTool(options))
  ];
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
      }
    }
  };
}
function historySegmentsTool(ctx) {
  return defineTool({
    name: "history_segments",
    description: [
      "List this session's own compaction segments: one line per compaction, oldest first,",
      "with the events it replaced and the summary event number.",
      "Segment numbers count only the compactions that happened after this session was created,",
      "so a session with no compactions of its own reports an empty list.",
      "Use a listed event number with history_read to read the original text back."
    ].join(" "),
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
      return [`${segments.length} compaction segment(s) in this session:`, ...lines].join("\n");
    }
  });
}
function historyReadTool(ctx) {
  return defineTool({
    name: "history_read",
    description: [
      "Read the original stored text of this conversation, including text that was compacted",
      'away and is no longer in the live context. Address it either by "segment" (a number from',
      'history_segments) or by "seq" (an event number, with optional before/after context).',
      "Compacted text is never deleted, so anything summarized away is still readable here.",
      'The result is bounded by "maxChars".'
    ].join(" "),
    parameters: {
      segment: {
        type: "integer",
        description: "Segment number from history_segments. Reads every event that segment replaced."
      },
      seq: { type: "integer", description: "A single event number to read." },
      before: {
        type: "integer",
        description: `Event numbers of leading context to include with "seq" (default ${HISTORY_READ_CONTEXT_EVENTS}).`
      },
      after: {
        type: "integer",
        description: `Event numbers of trailing context to include with "seq" (default ${HISTORY_READ_CONTEXT_EVENTS}).`
      },
      maxChars: {
        type: "integer",
        description: `Character budget for the returned transcript (default ${HISTORY_READ_DEFAULT_CHARS}, hard ceiling ${HISTORY_READ_MAX_CHARS2}).`
      },
      offset: {
        type: "integer",
        description: `Zero-based character position WITHIN event "seq" to start from. Positions are the same ones history_find reports as "matched at character N", and the same space the text is returned in, so a hit can be read back exactly. Only valid together with "seq" and without "before"/"after"/"segment": it addresses one point in one event, and mixing it with a multi-event window has no defined meaning.`
      }
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const sessionSegments = await loadSegmentsAndTurn(ctx, session);
      if (throttleEnabled && narrowedReadsExhausted(session.id, sessionSegments.turnStart)) {
        return narrowedReadsSpent();
      }
      const cappedByNarrowing = throttleEnabled && narrowedForReads(session.id, sessionSegments.turnStart) && clampChars(args.maxChars) > NARROWED_READ_MAX_CHARS;
      const maxChars = cappedByNarrowing ? NARROWED_READ_MAX_CHARS : clampChars(args.maxChars);
      const withCap = (text) => {
        if (!cappedByNarrowing) return text;
        const newline = text.indexOf("\n");
        return newline === -1 ? `${text}
${narrowedReadNote()}` : `${text.slice(0, newline)}
${narrowedReadNote()}${text.slice(newline)}`;
      };
      const query = requireQuery(ctx);
      if (typeof args.segment === "number") {
        const { segments, turnStart: turnStart2 } = sessionSegments;
        const segment = segments[args.segment];
        if (segment === void 0) {
          const available = segments.length === 0 ? "none" : `0..${segments.length - 1}`;
          return `No segment ${args.segment} in this session. Available segments: ${available}.`;
        }
        const events = [];
        for (const seq of segment.shadowedSeqs) {
          try {
            const window2 = await query.readEvent({ sessionId: session.id, seq, before: 0, after: 0 });
            events.push(window2.target);
          } catch {
          }
        }
        const header = `segment ${segment.ordinal}: ${segment.label}
compactionId ${segment.compactionId}, summary event #${segment.summarySeq}, ~${segment.tokenCount} tokens replaced`;
        const segmentSeqs = events.map((event) => event?.seq).filter((seq) => Number.isSafeInteger(seq));
        const segmentProbe = renderWindow(events, header, maxChars);
        const segmentPartial = windowWasTruncated(segmentProbe) ? { seq: null, start: 0, end: 0, total: null } : null;
        const segmentReceipt = recordRetrieval(session.id, turnStart2, segmentSeqs, false, [], segmentPartial);
        return withCap(renderWindow(events, segmentReceipt === "" ? header : `${segmentReceipt}
${header}`, maxChars));
      }
      if (typeof args.offset === "number") {
        if (typeof args.seq !== "number") {
          return '"offset" needs "seq": it addresses one point in one event. Pass seq as well, or drop offset and use "segment"/"before"/"after".';
        }
        if (args.before !== void 0 || args.after !== void 0) {
          return '"offset" cannot be combined with "before" or "after". A slice starts at one point in one event, while before/after widen it to neighbouring events; the two have no single meaning together.';
        }
        if (!Number.isSafeInteger(args.offset) || args.offset < 0) {
          return `"offset" must be a non-negative integer, got ${JSON.stringify(args.offset)}.`;
        }
        const window2 = await query.readEvent({ sessionId: session.id, seq: args.seq, before: 0, after: 0 });
        const body = eventBody(window2.target);
        const total = body.length;
        if (args.offset >= total) {
          return `Event #${args.seq} is ${total} characters; offset ${args.offset} is past its end. Check the event number, or drop "offset" to read the whole event.`;
        }
        const end = Math.min(total, args.offset + maxChars);
        const { segments, turnStart: turnStart2 } = sessionSegments;
        const owner = segmentForSeq(segments, args.seq);
        const origin = owner === null ? "not inside any compaction segment" : `segment ${owner.ordinal}, replaced by summary #${owner.summarySeq}`;
        const more = end < total ? `
(${end - args.offset} shown; continue with offset ${end})` : `
(${end - args.offset} shown; end of event)`;
        const sliceEnd = args.offset + clampToStoreCeiling(body.slice(args.offset, end), maxChars).length;
        const lineCount = body.split("\n").length;
        const receipt = recordRetrieval(session.id, turnStart2, [args.seq], false, [], {
          seq: args.seq,
          start: args.offset,
          end: sliceEnd,
          total
        });
        return withCap(clampToStoreCeiling(
          `${receipt === "" ? "" : `${receipt}
`}#${args.seq} ${String(window2.target?.type ?? "?")} characters ${args.offset}..${sliceEnd} of ${total} (${lineCount} lines) (${origin})${more}

${body.slice(args.offset, sliceEnd)}`,
          TOOL_RESULT_STORE_CEILING_CHARS
        ));
      }
      if (typeof args.seq === "number") {
        const before = clampContext(args.before);
        const after = clampContext(args.after);
        const window2 = await query.readEvent({ sessionId: session.id, seq: args.seq, before, after });
        const { segments, turnStart: turnStart2 } = sessionSegments;
        const owner = segmentForSeq(segments, args.seq);
        const header = owner === null ? "not inside any compaction segment" : `inside segment ${owner.ordinal}: ${owner.label}`;
        const windowSeqs = window2.events.map((event) => event?.seq).filter((seq) => Number.isSafeInteger(seq));
        const windowProbe = renderWindow(window2.events, header, maxChars);
        const windowPartial = windowWasTruncated(windowProbe) ? { seq: null, start: 0, end: 0, total: null } : null;
        const windowReceipt = recordRetrieval(session.id, turnStart2, windowSeqs, false, [], windowPartial);
        return withCap(
          renderWindow(window2.events, windowReceipt === "" ? header : `${windowReceipt}
${header}`, maxChars, args.seq)
        );
      }
      const last = Math.max(0, session.seq - 1);
      const { turnStart } = sessionSegments;
      const window = await query.readEvent({ sessionId: session.id, seq: last, before: 20, after: 0 });
      const tailHeader = 'no address given, so the tail of this session was read; pass "segment" or "seq" to aim it';
      const tailSeqs = window.events.map((event) => event?.seq).filter((seq) => Number.isSafeInteger(seq));
      const tailProbe = renderWindow(window.events, tailHeader, maxChars);
      const tailPartial = windowWasTruncated(tailProbe) ? { seq: null, start: 0, end: 0, total: null } : null;
      const tailReceipt = recordRetrieval(session.id, turnStart, tailSeqs, false, [], tailPartial);
      return withCap(
        renderWindow(window.events, tailReceipt === "" ? tailHeader : `${tailReceipt}
${tailHeader}`, maxChars, last)
      );
    }
  });
}
var searchBounds = /* @__PURE__ */ new Map();
var SEARCH_BOUND_MEMORY = 256;
function searchBoundKey(sessionId, query, scope, cursor) {
  return `${sessionId}\0${query}\0${scope}\0${cursor}`;
}
function encodeSearchCursor(offset, bound2) {
  return typeof bound2 === "number" && Number.isFinite(bound2) && bound2 >= 0 ? `${offset}~${bound2}` : `${offset}~`;
}
function decodeSearchCursor(text) {
  if (typeof text !== "string") return null;
  const match = /^(\d+)~(\d*)$/u.exec(text);
  if (match === null) return null;
  return { offset: Number(match[1]), bound: match[2].length === 0 ? void 0 : Number(match[2]) };
}
function historySearchTool(ctx, options) {
  return defineTool({
    name: "history_search",
    description: [
      "Search this session's stored events by keyword and return bounded excerpts with event",
      "numbers. Compacted-away text is included, so this finds things the live context no",
      "longer shows. Read a hit in full with history_read and its event number.",
      `Returns at most ${HISTORY_SEARCH_MAX_LIMIT} hits of about ${HISTORY_SEARCH_SNIPPET_CHARS} characters each.`,
      RETRIEVAL_RECEIPT_NOTE
    ].join(" "),
    parameters: {
      query: {
        type: "string",
        description: "Words to find. All words must appear, in order, ignoring case and line breaks.",
        required: true
      },
      limit: {
        type: "integer",
        description: `Maximum hits (default ${HISTORY_SEARCH_DEFAULT_LIMIT}, ceiling ${HISTORY_SEARCH_MAX_LIMIT}).`
      },
      scope: {
        type: "string",
        enum: ["all", "shadowed"],
        description: "Search every stored event (default) or only text replaced by a compaction."
      },
      cursor: {
        type: "string",
        description: "Continuation cursor from a previous call, to read the next page of the same search."
      }
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const query = requireQuery(ctx);
      const limit = clampLimit(args.limit);
      const scope = args.scope ?? "all";
      const cursor = typeof args.cursor === "string" && args.cursor.length > 0 ? args.cursor : void 0;
      const filters = [];
      if (scope === "shadowed") filters.push({ kind: "surface", values: ["shadowed"] });
      const own = decodeSearchCursor(cursor);
      const boundKey = cursor === void 0 ? void 0 : searchBoundKey(session.id, args.query, scope, cursor);
      if (cursor !== void 0 && own === null && !(boundKey !== void 0 && searchBounds.has(boundKey))) {
        return [
          `This cursor was not issued by this session, or it was issued by a search that is no longer pending: ${JSON.stringify(cursor)}.`,
          'Re-run the search without "cursor" and page from the start.'
        ].join(" ");
      }
      const boundary = own !== null ? own.bound : boundKey !== void 0 && searchBounds.has(boundKey) ? searchBounds.get(boundKey) : options?.historyBoundary?.(session);
      if (typeof boundary === "number" && Number.isFinite(boundary) && boundary >= 0) {
        filters.push({ kind: "seq", to: boundary });
      }
      const request = {
        sessionId: session.id,
        query: args.query,
        limit,
        ...filters.length === 0 ? {} : { filters },
        ...cursor === void 0 ? {} : { cursor }
      };
      let page;
      try {
        page = await query.searchEvents(request);
      } catch (error) {
        page = await filterSearchPage(query, session, args.query, filters, limit, cursor);
        if (page === null) throw error;
      }
      if (page.items.length === 0) {
        return cursor === void 0 ? `No event in this session matches "${args.query}".` : `No further match for "${args.query}".`;
      }
      const searchEvents_ = await readSessionEvents(ctx, session);
      const segments = deriveSegments(session, searchEvents_);
      const turnStart = deriveTurnStart(searchEvents_);
      let ownTurnHits = 0;
      const lines = [];
      const shownSeqs = [];
      const held = servedInTurn(session.id, turnStart);
      const alreadyHeldSeqs = [];
      let spent = 0;
      let dropped = 0;
      for (const hit of page.items) {
        if (held.has(hit.seq)) {
          alreadyHeldSeqs.push(hit.seq);
          continue;
        }
        const owner = segmentForSeq(segments, hit.seq);
        const where = owner === null ? "" : ` [segment ${owner.ordinal}]`;
        const located = typeof hit.text === "string" && hit.text.length > 0 ? locateAround(hit.text, args.query, HISTORY_SEARCH_SNIPPET_CHARS) : await locateHit(query, session, { ...hit, term: args.query }, filters);
        const snippet = located === null ? typeof hit.snippet === "string" && hit.snippet.length > 0 ? hit.snippet.slice(0, HISTORY_SEARCH_SNIPPET_CHARS) : "(no excerpt available; read it with history_read and its event number)" : located.text;
        const address = located === null ? "" : located.found ? ` @${located.offset} of ${located.total}` : ` @not found of ${located.total}`;
        const own2 = turnStart !== null && hit.seq >= turnStart ? " [this turn, not a source]" : "";
        if (own2 !== "") ownTurnHits += 1;
        const line = `#${hit.seq} ${hit.type}${where}${own2}${address}: ${snippet}`;
        if (spent + line.length > HISTORY_SEARCH_PAGE_BUDGET_CHARS) {
          dropped += 1;
          continue;
        }
        spent += line.length;
        lines.push(line);
        shownSeqs.push(hit.seq);
      }
      if (page.nextCursor !== void 0) {
        if (searchBounds.size >= SEARCH_BOUND_MEMORY) {
          searchBounds.delete(searchBounds.keys().next().value);
        }
        searchBounds.set(searchBoundKey(session.id, args.query, scope, page.nextCursor), boundary);
      }
      const footer = page.nextCursor === void 0 ? ["", "That is the last page."] : ["", `More matches exist; call again with cursor=${JSON.stringify(page.nextCursor)}.`];
      const ownNote = ownTurnHits > 0 ? ` ${ownTurnHits} are this turn's own messages, marked below.` : "";
      const heldNote = alreadyHeldSeqs.length === 0 ? "" : ` ${alreadyHeldSeqs.length} were already returned this turn and are left out.`;
      const summaryLine = dropped === 0 ? `${page.items.length} matching event(s), strongest first.${heldNote}${ownNote}` : `${page.items.length} matching event(s), strongest first; ${lines.length} shown and ${dropped} omitted for size.${heldNote}${ownNote} Raise "limit" only if you need the smaller hits, or narrow the query:`;
      const receipt = recordRetrieval(session.id, turnStart, shownSeqs, true, alreadyHeldSeqs);
      return clampToStoreCeiling(
        [receipt === "" ? summaryLine : `${receipt}
${summaryLine}`, ...lines, ...footer].join("\n"),
        TOOL_RESULT_STORE_CEILING_CHARS
      );
    }
  });
}
function historyFindTool(ctx, options) {
  return defineTool({
    name: "history_find",
    description: HISTORY_FIND_DESCRIPTION,
    parameters: {
      queries: {
        type: "array",
        items: { type: "string" },
        required: true,
        description: HISTORY_FIND_QUERIES_DESCRIPTION
      },
      extract: {
        type: "string",
        description: HISTORY_FIND_EXTRACT_DESCRIPTION
      },
      limit: {
        type: "integer",
        description: `Hits kept per query term (default ${HISTORY_SEARCH_DEFAULT_LIMIT}, ceiling ${HISTORY_SEARCH_MAX_LIMIT}).`
      },
      scope: {
        type: "string",
        enum: ["all", "shadowed"],
        description: "Search every stored event (default) or only text replaced by a compaction."
      },
      budgetChars: {
        type: "integer",
        description: HISTORY_FIND_BUDGET_DESCRIPTION
      }
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
      const scope = args.scope === "shadowed" ? "shadowed" : "all";
      const filters = [];
      if (scope === "shadowed") filters.push({ kind: "surface", values: ["shadowed"] });
      const boundary = options?.historyBoundary?.(session);
      if (typeof boundary === "number" && Number.isFinite(boundary) && boundary >= 0) {
        filters.push({ kind: "seq", to: boundary });
      }
      const extract = compileExtract(args.extract);
      if (extract.error !== null) return extract.error;
      const merged = /* @__PURE__ */ new Map();
      const unsearchable = [];
      let truncatedTerms = 0;
      for (const term of terms) {
        let page;
        try {
          page = await query.searchEvents({
            sessionId: session.id,
            query: term,
            limit: HISTORY_SEARCH_MAX_LIMIT,
            ...filters.length === 0 ? {} : { filters }
          });
        } catch (error) {
          page = await filterSearchPage(query, session, term, filters, limit, void 0);
          if (page === null) {
            unsearchable.push(term);
            continue;
          }
        }
        if (page.nextCursor !== void 0) truncatedTerms += 1;
        for (const hit of page.items ?? []) {
          if (typeof hit?.seq !== "number") continue;
          const seen = merged.get(hit.seq);
          if (seen === void 0) merged.set(hit.seq, { seq: hit.seq, type: hit.type, terms: [term] });
          else if (!seen.terms.includes(term)) seen.terms.push(term);
        }
      }
      if (merged.size === 0) {
        const tried = terms.length === 1 ? `"${terms[0]}"` : `${terms.length} terms`;
        const note = unsearchable.length > 0 ? " (this profile has no searchable index for these terms)" : "";
        const bound2 = typeof boundary === "number" ? ` Nothing at or below event #${boundary} matched.` : "";
        return `No event in this session matches ${tried}${note}.${bound2}`;
      }
      const events = await readSessionEvents(ctx, session);
      const segments = deriveSegments(session, events);
      const turnStart = deriveTurnStart(events);
      const originOf = (seq) => {
        const owner = segmentForSeq(segments, seq);
        return owner === null ? "" : ` [segment ${owner.ordinal}, replaced by summary #${owner.summarySeq}]`;
      };
      const isOwnTurn = (seq) => turnStart !== null && seq >= turnStart;
      const ownTurnCount = merged.size === 0 ? 0 : [...merged.keys()].filter(isOwnTurn).length;
      const ordered = [
        ...[...merged.values()].filter((entry) => !isOwnTurn(entry.seq)),
        ...[...merged.values()].filter((entry) => isOwnTurn(entry.seq))
      ];
      const held = servedInTurn(session.id, turnStart);
      const alreadyHeldCandidates = ordered.filter((candidate) => held.has(candidate.seq));
      const candidates = ordered.filter((candidate) => !held.has(candidate.seq));
      const excerptChars = Math.max(120, Math.min(240, Math.floor(budget / 4)));
      const lines = [];
      const shownSeqs = [];
      let spent = 0;
      let omitted = 0;
      const presentTerms = /* @__PURE__ */ new Set();
      const absentTerms = /* @__PURE__ */ new Set();
      let scanned = 0;
      let stoppedEarly = false;
      for (const candidate of candidates) {
        const body = await readEventBody(query, session.id, candidate.seq);
        if (body === null) continue;
        scanned += 1;
        const found = countTermHits(body, candidate.terms);
        let matchAt = found.firstAt;
        if (extract.pattern !== null) {
          const match = extract.pattern.exec(body);
          if (match === null) continue;
          matchAt = match.index;
        }
        const view = snapWindow(body, matchAt, excerptChars);
        const lead = view.start > 0 ? "\u2026" : "";
        const trail = view.end < view.total ? "\u2026" : "";
        const locatedTerms = locateTermHits(body, terms);
        for (const one of locatedTerms) (one.count > 0 ? presentTerms : absentTerms).add(one.term);
        const hits = locatedTerms.filter((one) => one.count > 0);
        const missing = locatedTerms.filter((one) => one.count === 0);
        const named = hits.slice(0, FIND_TERM_LIST_LIMIT).map((one) => `${one.term}@${one.firstAt}`);
        const extraHits = hits.length - named.length;
        const namedMissing = missing.slice(0, FIND_TERM_LIST_LIMIT).map((one) => `${one.term} absent`);
        const extraMissing = missing.length - namedMissing.length;
        const addressParts = [...named, ...namedMissing];
        if (extraHits > 0) addressParts.push(`+${extraHits} more term(s) not listed`);
        if (extraMissing > 0) addressParts.push(`+${extraMissing} more absent`);
        const addressSuffix = addressParts.length === 0 ? "" : ` (${addressParts.join(", ")})`;
        const literal = found.count > 0 ? `${found.count} literal hit(s)${addressSuffix}` : `not present literally (the index matched it some other way)${addressSuffix}`;
        const at = extract.pattern !== null && matchAt >= 0 ? `; extract matched at ${matchAt + 1}` : "";
        const own = isOwnTurn(candidate.seq) ? " [this turn, not a source]" : "";
        const head2 = `#${candidate.seq} ${String(candidate.type)}${originOf(candidate.seq)}${own}: ${literal}, ${body.length} chars${at}`;
        const line = `${head2}
  ${lead}${view.text}${trail}`;
        if (spent + line.length > budget) {
          omitted = candidates.length - lines.length;
          break;
        }
        spent += line.length;
        lines.push(line);
        shownSeqs.push(candidate.seq);
        if (extract.pattern !== null) {
          stoppedEarly = true;
          break;
        }
      }
      if (lines.length === 0) {
        if (alreadyHeldCandidates.length > 0) {
          const receipt2 = recordRetrieval(session.id, turnStart, [], true, alreadyHeldCandidates.map((candidate) => candidate.seq));
          return [
            receipt2,
            `${alreadyHeldCandidates.length} event(s) matched, and this turn already returned every one of them:`,
            ...alreadyHeldCandidates.slice(0, 12).map((candidate) => `  #${candidate.seq} ${String(candidate.type)}`),
            "Read any of them in full with history_read, or answer from what you have and name the gap."
          ].join("\n");
        }
        return [
          `Tried ${terms.length} term(s); ${candidates.length} event(s) matched, but none matched the extract pattern.`,
          scanned > 0 ? `Read ${scanned} event body(ies) looking for it.` : ""
        ].filter((line) => line.length > 0).join(" ");
      }
      const heldFindNote = alreadyHeldCandidates.length === 0 ? "" : ` ${alreadyHeldCandidates.length} more matched but were already returned this turn and are left out.`;
      const countLine = `${candidates.length + alreadyHeldCandidates.length} event(s) matched in this session${heldFindNote}` + (ownTurnCount > 0 ? `; ${ownTurnCount} of them are this turn's own messages and are listed last` : "") + (truncatedTerms === 0 ? "." : `; at least one term has more matches than the ${HISTORY_SEARCH_MAX_LIMIT}-row ceiling, so the true total may be higher.`);
      const header = [
        `Tried ${terms.length} term(s) in one call.`,
        countLine,
        extract.pattern === null ? "" : `${lines.length} matched the extract pattern${stoppedEarly ? ", stopped at the first" : ""}.`,
        omitted > 0 ? `${lines.length} shown within the ${budget}-character budget.` : ""
      ].filter((part) => part.length > 0).join(" ");
      const footer = omitted > 0 ? `
${omitted} further event(s) omitted for budget. Narrow the terms, or raise "budgetChars".` : "";
      const neverLanded = [...absentTerms].filter((term) => !presentTerms.has(term));
      const termNote = terms.length <= 1 ? "" : `${presentTerms.size} of ${terms.length} term(s) present${neverLanded.length === 0 ? "" : `, absent everywhere: ${neverLanded.join(", ")}`}`;
      const receipt = recordRetrieval(session.id, turnStart, shownSeqs, true, alreadyHeldCandidates.map((candidate) => candidate.seq), null, termNote);
      const head = receipt === "" ? header : `${receipt}
${header}`;
      return clampToStoreCeiling(`${head}
${lines.join("\n")}${footer}`, TOOL_RESULT_STORE_CEILING_CHARS);
    }
  });
}
function normalizeFindQueries(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const entry of value) {
    const term = typeof entry === "string" ? entry.trim() : "";
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= HISTORY_FIND_MAX_QUERIES) break;
  }
  return out;
}
function clampFindBudget(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return HISTORY_FIND_DEFAULT_BUDGET_CHARS;
  return Math.min(HISTORY_FIND_MAX_BUDGET_CHARS, Math.max(1e3, Math.trunc(value)));
}
function compileExtract(value) {
  if (typeof value !== "string" || value.trim().length === 0) return { pattern: null, error: null };
  const source = value.trim();
  if (source.length > 500) return { pattern: null, error: 'history_find: "extract" is limited to 500 characters.' };
  try {
    return { pattern: new RegExp(source, "u"), error: null };
  } catch (error) {
    return { pattern: null, error: `history_find: "extract" is not a valid regular expression: ${String(error)}` };
  }
}
async function readEventBody(query, sessionId, seq) {
  try {
    const window = await query.readEvent({ sessionId, seq, before: 0, after: 0 });
    const target = window?.target ?? window?.events?.[0] ?? null;
    return target === null ? null : eventBody(target);
  } catch {
    return null;
  }
}
async function locateHit(query, session, hit, filters) {
  const page = await filterSearchPage(query, session, hit.term, filters, 1, void 0);
  const item = page?.items?.find((entry) => entry.seq === hit.seq) ?? page?.items?.[0];
  if (item === void 0) return null;
  return { text: item.snippet, offset: item.offset, total: item.total, found: item.found };
}
async function filterSearchPage(query, session, text, filters, limit, cursor) {
  if (typeof query.filterEvents !== "function") return null;
  let hits;
  try {
    hits = await query.filterEvents(session.id, [...filters, { kind: "text", text }]);
  } catch {
    return null;
  }
  const scored = hits.map((hit) => ({ hit, score: scoreText(hit.text, text) })).sort((left, right) => right.score - left.score || right.hit.seq - left.hit.seq);
  const decoded = decodeSearchCursor(cursor);
  const offset = decoded === null ? 0 : decoded.offset;
  const ceiling = filters.find((filter) => filter.kind === "seq")?.to;
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
        found: located.found
      };
    }),
    ...offset + window.length < scored.length ? { nextCursor: encodeSearchCursor(offset + window.length, ceiling) } : {}
  };
}
function notesWriteTool(options) {
  return defineTool({
    name: "notes_write",
    description: NOTES_WRITE_DESCRIPTION,
    parameters: {
      text: { type: "string", description: "A few lines of notes.", required: true }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
          trimmed: { type: "boolean" },
          chars: { type: "integer" },
          droppedOlder: { type: "boolean" },
          entryCut: { type: "boolean" }
        }
      },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: "text", text: `not recorded: ${value.reason ?? "notes mode is off"}` }];
        if (value.trimmed === true) {
          const parts = [];
          if (value.droppedOlder === true) {
            parts.push(
              `The draft holds at most ${NOTES_MAX_CHARS2} characters, so the oldest entries were dropped to fit this one; it now holds ${value.chars ?? "?"}.`
            );
          }
          if (value.entryCut === true) {
            parts.push(
              value.droppedOlder === true ? "This entry was larger than the remaining room as well, so only its opening was kept." : `This entry alone is larger than the ${NOTES_MAX_CHARS2}-character draft, so only its opening was kept.`
            );
          }
          if (parts.length === 0) {
            parts.push(`The draft is at its ${NOTES_MAX_CHARS2}-character limit.`);
          }
          return [{ type: "text", text: `${NOTES_WRITE_ACK} ${parts.join(" ")}` }];
        }
        return [{ type: "text", text: NOTES_WRITE_ACK }];
      }
    },
    async execute(args, exec) {
      const session = requireSession(exec);
      if (options.modeFor(session)?.compaction !== "plugin") {
        return { ok: false, reason: "this session compacts with the shipped backend, so notes are off for it" };
      }
      try {
        const outcome = await options.noteStore.append(session.id, args.text);
        if (outcome.trimmed === true) {
          options.warn?.(
            `the notes draft reached its ${NOTES_MAX_CHARS2}-character limit; the oldest entries were dropped, leaving ${outcome.chars} characters`
          );
          return {
            ok: true,
            trimmed: true,
            chars: outcome.chars,
            droppedOlder: outcome.droppedOlder,
            entryCut: outcome.entryCut
          };
        }
        return { ok: true };
      } catch (error) {
        options.warn?.(`notes write failed: ${String(error)}`);
        return { ok: false, reason: "write failed" };
      }
    }
  });
}
function notesReadTool(options) {
  return defineTool({
    name: "notes_read",
    description: NOTES_READ_DESCRIPTION,
    parameters: {
      segment: {
        type: "integer",
        description: "Read the notes archived under this segment number instead of the live draft."
      }
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const ordinal = args.segment;
      if (ordinal === void 0) {
        const draft = await options.noteStore.read(session.id);
        return draft.trim().length === 0 ? "No working notes have been written for this session." : `Live notes draft for this session:

${draft}`;
      }
      if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error("segment must be a non-negative integer");
      const archived = await options.noteStore.readArchive(session.id, ordinal);
      return archived.trim().length === 0 ? `Segment ${ordinal} kept no notes.` : `Notes archived with segment ${ordinal}:

${archived}`;
    }
  });
}
function notesSearchTool(options) {
  return defineTool({
    name: "notes_search",
    description: NOTES_SEARCH_DESCRIPTION,
    parameters: {
      query: { type: "string", description: "Words to find, ignoring case.", required: true },
      limit: { type: "integer", description: "Maximum lines to return (default 20, ceiling 100)." }
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec);
      const limit = clampNoteLimit(args.limit);
      const haystacks = [{ label: "draft", text: await options.noteStore.read(session.id) }];
      for (const name2 of await options.noteStore.listArchive(session.id)) {
        const ordinal = Number.parseInt(name2.replace(/[^0-9]/gu, ""), 10);
        if (!Number.isInteger(ordinal)) continue;
        haystacks.push({
          label: `segment ${ordinal}`,
          text: await options.noteStore.readArchive(session.id, ordinal)
        });
      }
      const hits = searchNoteLines(haystacks, args.query, limit);
      if (hits.length === 0) return `No note line matches "${args.query}".`;
      return [`${hits.length} matching note line(s):`, ...hits.map((hit) => `${hit.label}: ${hit.line}`)].join("\n");
    }
  });
}
function searchNoteLines(haystacks, query, limit) {
  const needle = String(query).trim().toLowerCase();
  if (needle.length === 0) return [];
  const words = needle.split(/\s+/u).filter((word) => word.length > 0);
  const out = [];
  for (const { label, text } of haystacks) {
    for (const raw of String(text).split("\n")) {
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
function clampNoteLimit(value) {
  if (value === void 0) return 20;
  if (typeof value !== "number" || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}
function requireSession(exec) {
  const session = exec.agent?.session;
  if (session === void 0) throw new Error("this tool only works inside an agent turn");
  return session;
}
function requireQuery(ctx) {
  const query = ctx.get("sessionQuery");
  if (query === void 0) {
    throw new Error("session history review is unavailable: this deployment composes no session-query service");
  }
  return query;
}
function clampChars(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return HISTORY_READ_DEFAULT_CHARS;
  return Math.min(HISTORY_READ_MAX_CHARS2, Math.max(1e3, Math.trunc(value)));
}
function countTermHits(body, terms) {
  const haystack = body.toLowerCase();
  const starts = /* @__PURE__ */ new Set();
  let firstAt = -1;
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    for (; ; ) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      starts.add(at);
      if (firstAt === -1 || at < firstAt) firstAt = at;
      from = at + 1;
    }
  }
  return { count: starts.size, firstAt };
}
function locateTermHits(body, terms) {
  const haystack = body.toLowerCase();
  return terms.map((term) => {
    const needle = term.toLowerCase();
    if (needle.length === 0) return { term, count: 0, firstAt: -1 };
    const at = haystack.indexOf(needle);
    if (at === -1) return { term, count: 0, firstAt: -1 };
    let count2 = 1;
    for (let from = at + 1; ; ) {
      const next = haystack.indexOf(needle, from);
      if (next === -1) break;
      count2 += 1;
      from = next + 1;
    }
    return { term, count: count2, firstAt: at };
  });
}
function clampContext(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return HISTORY_READ_CONTEXT_EVENTS;
  return Math.min(50, Math.max(0, Math.trunc(value)));
}
function clampLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return HISTORY_SEARCH_DEFAULT_LIMIT;
  return Math.min(HISTORY_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

// src/index.ts
var name = "dsh-context-zip";
var inject = ["tools", "llm", "tokenMeter", "sessions"];
var NOTES_GUIDANCE_ORDER = 3e3;
var COMPACTED_ANSWER_ORDER = 3100;
var DEFAULT_THROTTLE = false;
var DEFAULT_FALLBACK_AFTER_FAILURES = 5;
var DEFAULT_REWRITE_ENABLED = false;
var SETTINGS_NS = "context-zip";
var VOLATILE_REF = Symbol.for("cosmokit.volatile.write");
function isConfigReference(value) {
  return typeof value === "object" && value !== null && VOLATILE_REF in value;
}
function configValue(value) {
  return isConfigReference(value) ? value.get() : value;
}
var DEFAULT_ENABLED = false;
var settingsFields = {
  enabled: z.boolean().default(DEFAULT_ENABLED).description(
    "Compact new sessions with this plugin: the five-section handoff template plus working notes merged into the summary. Off delegates to the shipped backend."
  ),
  agents: z.dict(z.boolean()).default({}).description(
    "Per-session override: the map key is an agent preset name or a session id, and it overrides the global switch for that session. Session ids let two sessions open at once compact differently."
  ),
  retrieval: z.union(["granular", "batched", "batched-only"]).default("granular").description(
    'How the history review tools are presented. "granular" (default) hides history_find and keeps one call per query, exactly as before this option existed. "batched" adds history_find alongside them. "batched-only" hides history_search, so several query terms and the stopping rule go in one call; measured runs on a fixed task put it at 9/10/12 answer-round round trips against 2 for "granular", so it is kept as an experimental arm rather than recommended.'
  ),
  retrievalAgents: z.dict(z.union(["granular", "batched", "batched-only"])).default({}).description(
    'Per-session override for "retrieval", keyed the same way as "agents": a session id or an agent preset name, session id first.'
  ),
  throttle: z.boolean().default(DEFAULT_THROTTLE).description(
    "Let the retrieval throttle change what the model sees: a receipt saying what this turn has already returned, withholding of events already returned in full, a pause on history_search and history_find after two consecutive zero-novelty sweeps, and a cap on how much one read may return. Off (the default) leaves every tool behaving as it did before the throttle existed. The ledger and the tracePath log still run while off, so an unthrottled baseline stays measurable. The effect was never established: over three runs of the same four cells the token ratio against baseline ranged from 0.10x to 8.46x, and published work on aggressive retrieval throttling reports accuracy losses."
  ),
  fallbackEnabled: z.boolean().default(false).description(FALLBACK_ENABLED_COPY.en),
  fallbackAfterFailures: z.number().default(DEFAULT_FALLBACK_AFTER_FAILURES).description(
    'How many compaction attempts may fail before the fallback fires, counting attempts rather than model calls. 5 (the default) means attempts 1 through 5 use the model and attempt 6 is mechanical. 0 means the first failure falls back immediately. Range 0 to 10; values outside it are clamped. Only meaningful while "fallbackEnabled" is on: with it off, reaching this count reports the failure instead. Each attempt already retries once internally for the two kinds of failure a retry can fix, so this counts attempts, not calls.'
  ),
  rewriteEnabled: z.boolean().default(DEFAULT_REWRITE_ENABLED).description(REWRITE_ENABLED_COPY.en),
  rewriteProvider: z.string().default("").description(
    "Provider route the layout-only rewrite calls. Empty (the default) means nothing is selected, and the rewrite does not run. The provider must be registered in the live LLM registry; saving a selection probes it once with a minimal request and refuses to save when the probe fails."
  ),
  rewriteModel: z.string().default("").description(
    'Model id the layout-only rewrite calls, within "rewriteProvider". Empty (the default) means nothing is selected. Together with the provider it forms the route; both fields must be set for the rewrite to run.'
  ),
  tracePath: z.string().default("").description(
    "Optional file to append one JSON line per history retrieval to. Empty (the default) writes nothing. Use it to see how the retrieval throttle behaves: each line carries the turn, the retrieval number, whether it was a sweep or a read, how many events were new, how many were withheld as already-held, the zero-novelty streak, and whether narrowing is in force. This harness ships no logger exporter, so plugin logs reach only an in-memory buffer; a file is the one place the numbers can actually be read from."
  )
};
var ContextZipSettings = z.object(settingsFields);
function liveField(field) {
  return typeof field?.volatile === "function" ? field.volatile() : field;
}
var CONFIG_IS_LIVE = typeof settingsFields.enabled?.volatile === "function";
var Config = z.object(
  Object.fromEntries(Object.entries(settingsFields).map(([key, field]) => [key, liveField(field)]))
);
var settingsState = {
  /** Resolved value, or null when no settings provider is composed. */
  value: null,
  /** Monotonic revision of the raw user section, when the provider reports one. */
  revision: void 0,
  /** Whether the stored user section names the global switch. */
  userEnabled: false,
  /** Whether the stored user section names the retrieval presentation. */
  userRetrieval: false,
  /** Agent/preset keys the stored user section names for retrieval. */
  userRetrievalAgents: /* @__PURE__ */ new Set(),
  /** Agent/preset keys the stored user section names. */
  userAgents: /* @__PURE__ */ new Set(),
  /** Whether the stored user section names anything at all. */
  rowConfigured: false,
  /** Whether the plugin's own row is the settings store (the 0.1.7 shape). */
  settingsInRow: CONFIG_IS_LIVE
};
function applySettingsPatch(current, patch) {
  const source = patch !== null && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const next = {
    enabled: typeof source.enabled === "boolean" ? source.enabled : current.enabled,
    agents: { ...current.agents ?? {} },
    retrieval: RETRIEVAL_VALUES.includes(source.retrieval) ? source.retrieval : current.retrieval,
    retrievalAgents: { ...current.retrievalAgents ?? {} },
    throttle: typeof source.throttle === "boolean" ? source.throttle : current.throttle,
    fallbackEnabled: typeof source.fallbackEnabled === "boolean" ? source.fallbackEnabled : current.fallbackEnabled,
    fallbackAfterFailures: typeof source.fallbackAfterFailures === "number" && Number.isFinite(source.fallbackAfterFailures) ? source.fallbackAfterFailures : current.fallbackAfterFailures,
    rewriteEnabled: typeof source.rewriteEnabled === "boolean" ? source.rewriteEnabled : current.rewriteEnabled,
    rewriteProvider: typeof source.rewriteProvider === "string" ? source.rewriteProvider : current.rewriteProvider,
    rewriteModel: typeof source.rewriteModel === "string" ? source.rewriteModel : current.rewriteModel,
    tracePath: typeof source.tracePath === "string" ? source.tracePath : current.tracePath
  };
  let touched = typeof source.enabled === "boolean" || typeof source.throttle === "boolean" || typeof source.fallbackEnabled === "boolean" || typeof source.fallbackAfterFailures === "number" || typeof source.rewriteEnabled === "boolean" || typeof source.rewriteProvider === "string" || typeof source.rewriteModel === "string" || typeof source.tracePath === "string" || RETRIEVAL_VALUES.includes(source.retrieval);
  if (source.retrievalAgents !== null && typeof source.retrievalAgents === "object" && !Array.isArray(source.retrievalAgents)) {
    const entries = Object.entries(source.retrievalAgents);
    const table = {};
    for (const [key, value] of entries) {
      if (typeof key !== "string" || key.length === 0 || key.length > 200) continue;
      if (!RETRIEVAL_VALUES.includes(value)) continue;
      table[key] = value;
    }
    if (entries.length > 0 && Object.keys(table).length === 0) {
      throw new Error("every row in retrievalAgents was unusable: keys must be non-empty and values one of granular/batched/batched-only");
    }
    next.retrievalAgents = table;
    touched = true;
  }
  if (source.agents !== null && typeof source.agents === "object" && !Array.isArray(source.agents)) {
    const entries = Object.entries(source.agents);
    const agents = {};
    for (const [key, value] of entries) {
      if (typeof key !== "string" || key.length === 0 || key.length > 200) continue;
      if (typeof value !== "boolean") continue;
      agents[key] = value;
    }
    if (entries.length > 0 && Object.keys(agents).length === 0) {
      throw new Error("every row in agents was unusable: keys must be non-empty and values boolean");
    }
    next.agents = agents;
    touched = true;
  }
  return touched ? next : null;
}
var engineClass = null;
function setEngineClass(EngineClass) {
  engineClass = EngineClass;
}
async function resolveEngineClass() {
  if (engineClass !== null) return engineClass;
  const namespace = await import("@deepseek-ai/dsh-compaction-basic");
  const redirect = namespace;
  engineClass = redirect.ContextZipEngine ?? redirect.default;
  return engineClass;
}
async function apply(ctx, config) {
  const noteStore = new NoteStore();
  const pluginDir = dirname3(dirname3(fileURLToPath2(import.meta.url)));
  const profileBaseUrl = ctx.baseUrl;
  const reminded = /* @__PURE__ */ new WeakSet();
  const lastAssistantSeqs = /* @__PURE__ */ new Map();
  let chain = Promise.resolve();
  let scope = null;
  const optionalFibers = [];
  const settleTimers = /* @__PURE__ */ new Set();
  const whenAvailable = (names, callback) => {
    try {
      optionalFibers.push(ctx.inject(names, callback));
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] deferring on ${names.join(", ")} failed: ${String(error)}`);
    }
  };
  const retrievalLayers = /* @__PURE__ */ new Map();
  const throttledAgents = /* @__PURE__ */ new Set();
  const applyRetrievalVisibility = (agent) => {
    const previous = retrievalLayers.get(agent);
    if (previous !== void 0) {
      retrievalLayers.delete(agent);
      try {
        previous();
      } catch {
      }
    }
    let mode;
    try {
      mode = resolveRetrieval(agent.session).retrieval;
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] reading the retrieval setting for one session failed: ${String(error)}`);
      return;
    }
    const deny = mode === "granular" ? ["history_find"] : mode === "batched-only" ? ["history_search"] : [];
    if (throttledAgents.has(agent)) deny.push("history_find", "history_search");
    const unique = [...new Set(deny)];
    if (unique.length === 0) return;
    try {
      retrievalLayers.set(agent, agent.ctx.tools.restrict({ deny: unique }));
    } catch (error) {
      ctx.logger?.warn?.(
        `[context-zip] the retrieval presentation for one session could not be applied: ${String(error)}`
      );
    }
  };
  const refreshRetrievalVisibility = () => {
    for (const agent of ctx.get("agents")?.list() ?? []) {
      if (retrievalLayers.has(agent) || resolveRetrievalSafe(agent)) applyRetrievalVisibility(agent);
    }
  };
  const resolveRetrievalSafe = (agent) => {
    try {
      return resolveRetrieval(agent.session).retrieval !== "batched";
    } catch (error) {
      ctx.logger?.warn?.(
        `[context-zip] the retrieval mode for one session could not be read, so its tool presentation was left unchanged: ${String(error)}`
      );
      return false;
    }
  };
  let settingsNs = SETTINGS_NS;
  if (config !== null && typeof config === "object") {
    settingsState.value = settingsFromConfig(config);
    installGlobalReaders(settingsState.value);
  }
  whenAvailable(["settings"], (scoped) => {
    const settings = scoped.settings;
    const reportSwitch = (message) => ctx.logger?.info?.(`[context-zip] ${message}`);
    const usesForms = typeof settings.register !== "function";
    settingsState.settingsInRow = usesForms;
    if (!usesForms) {
      scope = settings.register(SETTINGS_NS, ContextZipSettings, {
        base: { enabled: DEFAULT_ENABLED, agents: {} },
        applies: "live"
      });
    } else {
      settingsNs = ctx.fiber?.entry?.options?.id ?? SETTINGS_NS;
      try {
        scoped.effect(() => settings.configure({ auto: false }, ctx.fiber));
      } catch (error) {
        ctx.logger?.warn?.(`[context-zip] configuring the settings page policy failed: ${String(error)}`);
      }
      scope = {
        // Re-read on every call, so the value is as live as the references are.
        get: () => settingsFromConfig(config),
        replace: async (next) => {
          if (CONFIG_IS_LIVE) {
            await settings.replace(settingsNs, next);
            return;
          }
          const entry = ctx.fiber?.entry;
          const editor = ctx.get("configEditor");
          if (entry === void 0 || editor === void 0) {
            throw new Error(
              "this profile cannot store plugin settings: its schemastery has no volatile() fields and no configuration editor is composed"
            );
          }
          await editor.edit(entry, () => ({ ...next }));
        },
        // The Loader emits this on the plugin's own fiber once it has committed
        // new volatile values: the moment every reader has to re-read.
        watch: (callback) => {
          ctx.on("loader/volatile-update", () => callback());
        }
      };
    }
    refreshSettings(scope, settings, settingsNs, usesForms ? void 0 : reportSwitch, ctx);
    try {
      scope.watch(() => {
        refreshSettings(scope, settings, settingsNs, reportSwitch, ctx);
        refreshRetrievalVisibility();
      });
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] watching the settings namespace failed: ${String(error)}`);
    }
    if (usesForms) {
      const settle = (attempt) => {
        const timer = setTimeout(
          () => {
            settleTimers.delete(timer);
            refreshSettings(scope, settings, settingsNs, reportSwitch, ctx);
            if (settingsState.revision === void 0 && attempt < 10) settle(attempt + 1);
          },
          attempt === 0 ? 0 : 100
        );
        settleTimers.add(timer);
      };
      settle(0);
    }
  });
  const sequence = (task) => {
    const next = chain.then(task, task);
    chain = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  };
  const modeFor = (session) => resolveMode(session);
  const isPluginMode = (session) => modeFor(session).compaction === "plugin";
  const EngineClass = await resolveEngineClass();
  if (typeof EngineClass !== "function") {
    throw new Error("the compaction backend is unavailable: the compaction-basic row resolves to a package that exports no engine class");
  }
  const undoNotesReader = setSharedNotesReader((sessionId) => noteStore.read(sessionId));
  const undoModeReader = setSharedModeReader((session) => resolveMode(session).compaction);
  const undoFallbackReader = setSharedFallbackReader(() => ({
    enabled: settingsState.value?.fallbackEnabled === true,
    after: settingsState.value?.fallbackAfterFailures
  }));
  const undoRewriteReader = setSharedRewriteReader(() => ({
    enabled: settingsState.value?.rewriteEnabled === true,
    provider: settingsState.value?.rewriteProvider ?? "",
    model: settingsState.value?.rewriteModel ?? ""
  }));
  whenAvailable(["systemPrompt"], (scoped) => {
    scoped.systemPrompt.section({
      name: "context-zip:compacted-answer",
      order: COMPACTED_ANSWER_ORDER,
      text: () => COMPACTED_ANSWER_GUIDANCE
    });
  });
  const guidanceFibers = /* @__PURE__ */ new Map();
  const mountGuidance = (agent) => {
    if (guidanceFibers.has(agent)) return;
    try {
      const fiber = agent.ctx.inject(["systemPrompt"], (scoped) => {
        scoped.systemPrompt.section({
          name: "context-zip:notes-guidance",
          order: NOTES_GUIDANCE_ORDER,
          // An empty string, not an absent section: the scoped section has to
          // exist to shadow anything a wider scope contributes under this name.
          text: () => isPluginMode(agent.session) ? NOTES_GUIDANCE : ""
        });
      });
      guidanceFibers.set(agent, fiber);
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] mounting the notes guidance failed: ${String(error)}`);
    }
  };
  setThrottleListener((session, narrowed) => {
    let agents;
    try {
      agents = ctx.get("agents")?.list() ?? [];
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] listing agents for the retrieval throttle failed: ${String(error)}`);
      return;
    }
    for (const agent of agents) {
      if (agent?.session?.id !== session.id) continue;
      const changed = narrowed ? !throttledAgents.has(agent) : throttledAgents.has(agent);
      if (narrowed) throttledAgents.add(agent);
      else throttledAgents.delete(agent);
      if (changed) applyRetrievalVisibility(agent);
    }
  });
  ctx.on("agent/created", ({ agent }) => {
    mountGuidance(agent);
    applyRetrievalVisibility(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    const layer = retrievalLayers.get(agent);
    if (layer !== void 0) {
      retrievalLayers.delete(agent);
      try {
        layer();
      } catch {
      }
    }
    const fiber = guidanceFibers.get(agent);
    if (fiber === void 0) return;
    guidanceFibers.delete(agent);
    try {
      void fiber.dispose();
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] disposing the notes guidance failed: ${String(error)}`);
    }
  });
  ctx.on("session/event", (session, event) => {
    if (event.type === "user/message") {
      for (const agent2 of ctx.get("agents")?.list() ?? []) {
        if (agent2?.session?.id !== session.id) continue;
        if (!throttledAgents.has(agent2)) continue;
        throttledAgents.delete(agent2);
        applyRetrievalVisibility(agent2);
      }
    }
    if (event.type === "compaction/summary") {
      void sequence(async () => {
        const segments = await loadSegments(ctx, session);
        const last = segments[segments.length - 1];
        if (last === void 0) return;
        const archived = await noteStore.archive(session.id, last.ordinal);
        if (archived !== null) ctx.logger?.debug?.(`[context-zip] archived working notes to ${archived}`);
      });
      return;
    }
    if (event.type === "compaction/end") {
      const agent2 = ctx.get("agents")?.get(session.id);
      if (agent2 !== void 0) reminded.delete(agent2);
      return;
    }
    if (event.type === "assistant/message") {
      lastAssistantSeqs.set(session.id, event.seq);
      return;
    }
    if (event.type !== "step/end") return;
    const agent = ctx.get("agents")?.get(session.id);
    if (agent === void 0 || reminded.has(agent)) return;
    if (!isPluginMode(session)) return;
    reminded.add(agent);
    void sequence(async () => {
      const ratio = await pressureRatio(ctx, agent);
      if (ratio === null || ratio < REMINDER_THRESHOLD_PERCENT / 100) {
        reminded.delete(agent);
        return;
      }
      try {
        agent.inject(reminderMessage(ratio));
        ctx.logger?.info?.(
          `[context-zip] notes reminder delivered at ${Math.round(ratio * 100)}% context pressure`
        );
      } catch (error) {
        reminded.delete(agent);
        ctx.logger?.warn?.(`[context-zip] the notes reminder could not be delivered: ${String(error)}`);
      }
    });
  });
  const disposeTools = registerTools(ctx, {
    noteStore,
    modeFor,
    // One below the carrier message: the message itself and the `tool/call` it
    // produced are both in the requesting turn, and neither is history yet.
    historyBoundary: (session) => {
      const seq = lastAssistantSeqs.get(session.id);
      return typeof seq === "number" && seq > 0 ? seq - 1 : void 0;
    },
    warn: (message) => ctx.logger?.warn?.(`[context-zip] ${message}`)
  });
  const service = new ContextZipService(ctx);
  const manual = createManualActions(ctx);
  whenAvailable(["commands"], (scoped) => registerExportCommand(scoped));
  whenAvailable(["commands"], (scoped) => registerManualCompactCommand(scoped, manual));
  whenAvailable(
    ["webServer"],
    (scoped) => registerRoutes(scoped, {
      readSettings: () => settingsState.value ?? { enabled: DEFAULT_ENABLED, agents: {} },
      // The host read the memo is built over. This is the one place allowed to
      // call `ctx.get('sessionQuery')`; the memo reaches it through this closure,
      // so no route ever touches the host reader directly.
      readSessionTitles: (keys) => sessionTitlesFor(ctx, keys),
      // Called once, on the first panel request. The route answers from the memo
      // synchronously; the fold it starts runs behind the response and swallows
      // its own failures into the log.
      createTitles: (deps) => createTitleMemo({
        read: deps.read,
        warn: (message) => ctx.logger?.warn?.(`[context-zip] ${message}`)
      }),
      writeSettings: async (patch) => {
        if (scope === null) throw new Error("no settings provider is composed");
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object");
        const current = scope.get() ?? { enabled: DEFAULT_ENABLED, agents: {} };
        const next = applySettingsPatch(current, patch);
        if (next === null) throw new Error("nothing to update");
        const rewriteProvider = String(next.rewriteProvider ?? "").trim();
        const rewriteModel = String(next.rewriteModel ?? "").trim();
        const rewriteChanged = current.rewriteEnabled !== next.rewriteEnabled || String(current.rewriteProvider ?? "") !== rewriteProvider || String(current.rewriteModel ?? "") !== rewriteModel;
        if (next.rewriteEnabled === true && rewriteProvider.length > 0 && rewriteModel.length > 0 && rewriteChanged) {
          let advertised = true;
          try {
            const catalog = await readModelCatalog(ctx.llm);
            const group = catalog.providers.find((entry) => entry.id === rewriteProvider);
            advertised = group !== void 0 && group.models.some((model) => model.id === rewriteModel);
          } catch {
          }
          const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : void 0;
          try {
            await probeModel(ctx.llm, rewriteProvider, rewriteModel, { signal });
          } catch (error) {
            throw new Error(
              `format rewrite probe failed for ${rewriteProvider}/${rewriteModel}: ${String(error?.message ?? error)}`
            );
          }
          if (!advertised) {
            ctx.logger?.warn?.(
              `[context-zip] ${rewriteProvider} does not advertise ${rewriteModel}; the probe answered, so the route was accepted anyway`
            );
          }
        }
        await scope.replace(next);
        return scope.get() ?? next;
      },
      listSegments: (sessionId) => service.listSegments(sessionId),
      // The settings panel's "wire the compaction row" read and action. Both go
      // through `./wire.ts`, which owns the profile derivation and the guards; the
      // route only decides which verb is allowed and how a failure is reported.
      readWireStatus: () => readWireStatus({ baseUrl: profileBaseUrl, pluginDir }),
      wireRow: () => wireCompactionRow({ baseUrl: profileBaseUrl, pluginDir }),
      // The `attention` field of the same route: the panel's question mark renders
      // only when this answers non-null. The profile is resolved here, through the
      // same function the status read uses, so the prompt's `{profile}` is the real
      // one; when it cannot be named the read answers `null` rather than filling a
      // template with a guess. `rowConfigured` is gated on the row being the store,
      // so a 0.1.5 profile with values in `settings.yaml` is never called unmigrated.
      readAttention: async (input) => {
        let profileDir = "";
        try {
          profileDir = await resolveProfileDirectory(profileBaseUrl, pluginDir);
        } catch {
        }
        return readAttention({
          ...input,
          profileDir,
          rowConfigured: settingsState.settingsInRow ? settingsState.rowConfigured : void 0
        });
      },
      // 面板的模型下拉框读这个。从活的注册表现读，所以 adapter 增删路由之后刷新
      // 面板就能看到，不需要重启，也不需要在插件里维护第二份清单。
      listModels: () => readModelCatalog(ctx.llm),
      // The manual entry, served by the same actions the slash command uses.
      readManualPlan: (sessionId) => manual.plan(sessionId),
      runManualCompaction: (sessionId) => manual.run(sessionId, void 0, void 0),
      readManualFailure: (sessionId) => manual.failure(sessionId),
      // The toolbar chip asks this before every render. Answered through the same
      // resolver the engine calls, so a session whose mode comes from its preset
      // key, or from the global switch, reports what will really happen.
      readModeFor: (sessionId) => {
        const session = ctx.get("sessions")?.get(sessionId);
        if (session === void 0) return null;
        const mode = resolveMode(session);
        return {
          compaction: mode.compaction,
          source: mode.source,
          revision: mode.revision ?? null
        };
      },
      readEffectiveMode: () => {
        const live = { on: 0, off: 0 };
        for (const session of ctx.get("sessions")?.list() ?? []) {
          if (resolveMode(session).compaction === "plugin") live.on += 1;
          else live.off += 1;
        }
        return effectiveMode(live);
      }
    })
  );
  ctx.logger?.info?.(
    `[context-zip] ready: ${SUMMARY_SOFT_TARGET_TOKENS}/${SUMMARY_HARD_CAP_TOKENS} token handoff summary, ${NOTES_MAX_CHARS3}-character notes, reminder at ${REMINDER_THRESHOLD_PERCENT}%`
  );
  return () => {
    for (const timer of settleTimers) clearTimeout(timer);
    settleTimers.clear();
    for (const fiber of optionalFibers) {
      try {
        fiber?.dispose?.();
      } catch {
      }
    }
    disposeTools();
    for (const layer of retrievalLayers.values()) {
      try {
        layer();
      } catch {
      }
    }
    retrievalLayers.clear();
    for (const fiber of guidanceFibers.values()) {
      try {
        void fiber?.dispose?.();
      } catch {
      }
    }
    guidanceFibers.clear();
    undoNotesReader();
    undoModeReader();
    undoFallbackReader();
    undoRewriteReader();
  };
}
function resolveMode(session) {
  return resolveModeFrom(settingsState, session);
}
var RETRIEVAL_VALUES = ["granular", "batched", "batched-only"];
function resolveRetrievalFrom(state, session) {
  const fallback = { retrieval: "granular", source: "default", revision: void 0 };
  const value = state?.value ?? null;
  if (value === null) return fallback;
  const table = value.retrievalAgents ?? {};
  for (const key of [session.id, session.header.agentPreset]) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (Object.hasOwn(table, key)) {
      const row = table[key];
      if (row === "granular" || row === "batched" || row === "batched-only") {
        return {
          retrieval: row,
          source: state.userRetrievalAgents?.has(key) === true ? "settings" : "default",
          revision: state.revision
        };
      }
    }
  }
  const global = value.retrieval;
  const effective = global === "batched" || global === "batched-only" ? global : "granular";
  return {
    retrieval: effective,
    source: state.userRetrieval === true ? "settings" : "default",
    revision: state.revision
  };
}
function resolveRetrieval(session) {
  return resolveRetrievalFrom(settingsState, session);
}
function resolveModeFrom(state, session) {
  const fallback = {
    compaction: DEFAULT_ENABLED ? "plugin" : "default",
    source: "default",
    revision: void 0
  };
  const value = state?.value ?? null;
  if (value === null) return fallback;
  const table = value.agents ?? {};
  for (const key of [session.id, session.header.agentPreset]) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (Object.hasOwn(table, key)) {
      return {
        compaction: table[key] === true ? "plugin" : "default",
        source: state.userAgents?.has(key) === true ? "settings" : "default",
        revision: state.revision
      };
    }
  }
  return {
    compaction: value.enabled === true ? "plugin" : "default",
    source: state.userEnabled === true ? "settings" : "default",
    revision: state.revision
  };
}
function liveAgentFor(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (agents === void 0) {
    throw new ManualTargetError("no-live-session", "the agent registry is not composed, so no session can be compacted on demand");
  }
  const wanted = typeof sessionId === "string" ? sessionId.trim() : "";
  if (wanted.length > 0) {
    const agent = agents.get(wanted);
    if (agent === void 0) {
      throw new ManualTargetError(
        "session-not-live",
        `${wanted} is not a live session in this process; a manual compaction needs the running agent, so open the session first`
      );
    }
    return agent;
  }
  const live = agents.list() ?? [];
  if (live.length === 0) throw new ManualTargetError("no-live-session", "this process has no live session to compact");
  if (live.length > 1) {
    const ids = live.map((agent) => agent?.session?.id).filter((id) => typeof id === "string" && id.length > 0);
    throw new ManualTargetError(
      "session-required",
      `this process holds ${live.length} live sessions (${ids.join(", ")}), so the request has to name one`
    );
  }
  return live[0];
}
function createManualActions(ctx) {
  return {
    async plan(sessionId) {
      const agent = liveAgentFor(ctx, sessionId);
      const session = agent.session;
      return planManualCompaction(session.id, session, ctx.tokenMeter.measure(session));
    },
    async run(sessionId, signal, commandId) {
      const agent = liveAgentFor(ctx, sessionId);
      const abort = signal ?? new AbortController().signal;
      const compaction = agent?.ctx?.get?.("compaction") ?? ctx.get("compaction");
      const result = compaction === void 0 ? await runManualCompaction(agent, abort, commandId) : await compaction.compactNow(agent, abort, commandId);
      if (result === null) return { sessionId: agent.session.id, events: 0, tokens: 0, summarySeq: null };
      return {
        sessionId: agent.session.id,
        events: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
        tokens: Number(result.shadowedTokenCount ?? 0),
        summarySeq: typeof result.summarySeq === "number" ? result.summarySeq : null
      };
    },
    failure(sessionId) {
      return {
        failures: readFailureCount(sessionId),
        fallbackAfter: fallbackAfterValue(),
        fallbackEnabled: settingsState.value?.fallbackEnabled === true
      };
    }
  };
}
function fallbackAfterValue() {
  const raw = Number(settingsState.value?.fallbackAfterFailures);
  return Number.isFinite(raw) ? Math.min(10, Math.max(0, Math.trunc(raw))) : DEFAULT_FALLBACK_AFTER_FAILURES;
}
function effectiveMode(live) {
  const value = settingsState.value;
  const enabled = value === null ? DEFAULT_ENABLED : value.enabled === true;
  return {
    compaction: enabled ? "plugin" : "default",
    source: settingsState.userEnabled ? "settings" : "default",
    revision: settingsState.revision,
    overrides: Object.keys(value?.agents ?? {}).length,
    live
  };
}
var reportedSwitch;
function settingsFromConfig(config) {
  const source = config !== null && typeof config === "object" ? config : {};
  const read = (key) => configValue(source[key]);
  const map = (key) => {
    const value = read(key);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  return {
    enabled: read("enabled") === true,
    agents: map("agents"),
    retrieval: read("retrieval"),
    retrievalAgents: map("retrievalAgents"),
    throttle: read("throttle") === true,
    fallbackEnabled: read("fallbackEnabled") === true,
    fallbackAfterFailures: read("fallbackAfterFailures"),
    rewriteEnabled: read("rewriteEnabled") === true,
    rewriteProvider: typeof read("rewriteProvider") === "string" ? read("rewriteProvider") : "",
    rewriteModel: typeof read("rewriteModel") === "string" ? read("rewriteModel") : "",
    tracePath: typeof read("tracePath") === "string" ? read("tracePath") : ""
  };
}
function installGlobalReaders(value) {
  try {
    setTracePath(value?.tracePath ?? "");
  } catch {
  }
  try {
    setThrottleEnabled(value?.throttle ?? DEFAULT_THROTTLE);
  } catch {
  }
}
function rowOverrideFrom(ctx, ns) {
  let configuration;
  try {
    configuration = ctx?.get?.("configEditor")?.configuration?.();
  } catch {
    return void 0;
  }
  const rows = Array.isArray(configuration) ? configuration : [];
  const override = rows.find((item) => item?.entry?.options?.id === ns)?.override;
  return override !== null && typeof override === "object" ? override : void 0;
}
function userLayerFrom(descriptorUser, override) {
  const section = descriptorUser !== null && typeof descriptorUser === "object" ? descriptorUser : override !== null && typeof override === "object" ? override : null;
  const agents = section !== null && section.agents !== null && typeof section.agents === "object" ? section.agents : null;
  const retrievalAgents = section !== null && section.retrievalAgents !== null && typeof section.retrievalAgents === "object" ? section.retrievalAgents : null;
  return {
    rowConfigured: section !== null && Object.keys(section).length > 0,
    userEnabled: section !== null && Object.hasOwn(section, "enabled"),
    userAgents: new Set(agents === null ? [] : Object.keys(agents)),
    userRetrieval: section !== null && Object.hasOwn(section, "retrieval"),
    userRetrievalAgents: new Set(retrievalAgents === null ? [] : Object.keys(retrievalAgents))
  };
}
function refreshSettings(scope, settings, ns, report, ctx) {
  try {
    settingsState.value = scope.get();
  } catch (error) {
    settingsState.value = null;
    return;
  }
  installGlobalReaders(settingsState.value);
  try {
    const descriptor = settings.describe().find((entry) => entry.ns === ns);
    settingsState.revision = typeof descriptor?.revision === "number" ? descriptor.revision : void 0;
    const override = descriptor === void 0 ? rowOverrideFrom(ctx, ns) : void 0;
    const layer = userLayerFrom(descriptor?.user, override);
    settingsState.rowConfigured = layer.rowConfigured;
    settingsState.userEnabled = layer.userEnabled;
    settingsState.userAgents = layer.userAgents;
    settingsState.userRetrieval = layer.userRetrieval;
    settingsState.userRetrievalAgents = layer.userRetrievalAgents;
  } catch {
    settingsState.revision = void 0;
    settingsState.rowConfigured = false;
    settingsState.userEnabled = false;
    settingsState.userAgents = /* @__PURE__ */ new Set();
    settingsState.userRetrieval = false;
    settingsState.userRetrievalAgents = /* @__PURE__ */ new Set();
  }
  if (typeof report === "function") {
    const mode = settingsState.value?.enabled === true ? "plugin" : "shipped";
    if (mode !== reportedSwitch) {
      reportedSwitch = mode;
      report(`compaction switch: ${mode} (${settingsState.userEnabled ? "settings" : "default"})`);
    }
  }
}
async function routedContextWindow(ctx, agent) {
  try {
    const window = latestContextWindow(await readSessionEvents(ctx, agent.session));
    if (window !== null) return window;
  } catch (error) {
    ctx.logger?.debug?.(`[context-zip] the session route record was unreadable: ${String(error)}`);
  }
  try {
    const info = await ctx.llm.resolveModelInfo(agent.options?.provider, agent.options?.model);
    const window = info?.context?.contextWindow;
    if (typeof window === "number" && window > 0) return window;
  } catch {
  }
  return null;
}
async function pressureRatio(ctx, agent) {
  const window = await routedContextWindow(ctx, agent);
  if (window === null) return null;
  const measurement = ctx.tokenMeter.measure(agent.session);
  return measurement.totalTokens / window;
}
function reminderMessage(_ratio) {
  return createUserMessage2({
    content: [{ type: "text", text: NOTES_REMINDER_INSTRUCTION }],
    source: { kind: PRODUCER_KIND, plugin: "context-zip", form: "notice", summary: "context pressure reminder" }
  });
}
var index_default = {
  name,
  inject,
  apply,
  Config,
  ContextZipSettings,
  SETTINGS_NS,
  resolveMode,
  setEngineClass
};
export {
  CONFIG_IS_LIVE,
  Config,
  ContextZipSettings,
  SETTINGS_NS,
  apply,
  applySettingsPatch,
  index_default as default,
  effectiveMode,
  inject,
  name,
  resolveMode,
  resolveModeFrom,
  resolveRetrieval,
  resolveRetrievalFrom,
  rowOverrideFrom,
  sessionTitlesFor,
  setEngineClass,
  userLayerFrom
};
