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

import { EVENT_TEXT_CHARS, HISTORY_READ_MAX_CHARS, SEQ_LIST_HEAD, SEQ_LIST_TAIL } from 'dsh-context-zip-engine/prompt';

/**
 * Project one stored session event into transcript text.
 *
 * @param event - a raw session event.
 * @returns one or more lines; structural events render as a bare header.
 */
export function renderEvent(event) {
  const data = event?.data ?? {};
  const head = `#${event.seq} ${event.type}`;
  switch (event.type) {
    // `user/message` carries its message directly, while `assistant/message` and
    // `tool/result` wrap theirs (the assistant one keeps its step accounting
    // beside it). The two shapes are read differently on purpose.
    case 'user/message':
      return `${head}\n${indent(textOf(data.content) || '(empty)')}`;
    case 'system/message':
      return `${head}\n${indent(textOf(data.content) || '(empty)')}`;
    case 'assistant/message':
      return `${head}\n${indent(textOf(data.message?.content) || '(no text)')}`;
    case 'tool/call':
      return `${head} name=${String(data.name ?? '?')}\n${indent(bound(textOf(data.arguments) || safeJson(data.arguments)))}`;
    case 'tool/result':
      return `${head}${data.isError === true ? ' error' : ''}\n${indent(bound(textOf(data.message?.content)))}`;
    case 'compaction/summary':
      return `${head} compactionId=${String(data.compactionId ?? '?')} shadowed=${describeRange(data.shadowedRange)} shadowedSeqs=${describeSeqs(data.shadowedSeqs)} tokens=${String(data.shadowedTokenCount ?? '?')}\n${indent(bound(textOf(data.summary)))}`;
    case 'compaction/start':
      return `${head} compactionId=${String(data.compactionId ?? '?')}`;
    case 'compaction/end':
      return `${head} compactionId=${String(data.compactionId ?? '?')}${data.error === undefined ? '' : ` error=${String(data.error)}`}`;
    case 'compaction/prune':
      return `${head} shadowed=${describeRange(data.shadowedRange)} tokens=${String(data.shadowedTokenCount ?? '?')}`;
    case 'todo/write':
      return `${head}\n${indent(bound(textOf(data.todos)))}`;
    case 'session/title':
      return `${head} ${String(data.title ?? '')}`;
    default:
      return head;
  }
}

/**
 * Render a bounded transcript over a list of events.
 *
 * @param events - events in ascending seq order.
 * @param maxChars - hard character budget for the transcript.
 * @returns the transcript text plus whether it was cut short.
 */
/**
 * Appended when a single entry is larger than the whole character budget. Kept
 * separate from the ordinary truncation notice because the two mean different
 * things: the ordinary one says "there is more after this", this one says "what
 * you are looking at is already cut".
 */
const CLIPPED_NOTICE =
  '\n\n[... this one entry exceeds the character budget on its own, so only its opening is shown above; raise maxChars or read a narrower window ...]';

/** Leading text of the ordinary truncation notice, for callers that must detect it. */
const TRUNCATED_NOTICE_PREFIX = '[... transcript truncated at ';

/**
 * How much room a clipped block needs before showing a head of it is worth doing.
 *
 * Below this the head would be a few characters and a notice, which reads as an empty
 * event. Emitting the notice alone is more honest at that point, because the notice says
 * the budget ran out rather than implying there was nothing to show.
 */
const CLIPPED_MIN_CHARS = 200;

/** `1 entry (#7)` or `3 entries (#7..#9)`, for a notice that has to name what it dropped. */
function nameRange(from, to, count) {
  return `${count} ${count === 1 ? 'entry' : 'entries'} (${from === to ? `#${from}` : `#${from}..#${to}`})`;
}

/**
 * @param events - the window, in source order.
 * @param maxChars - character budget.
 * @param targetSeq - the event the caller actually addressed, when there is one. Blocks
 *   before it are given up so that it is always rendered. Pass null for a plain window.
 * @returns the text, whether it was cut, and `shown`: the entry range that actually landed
 *   (`from`, `to`, `count`, `total`) plus whether the last landed entry is only a head.
 */
export function renderTranscript(events, maxChars = HISTORY_READ_MAX_CHARS, targetSeq = null) {
  const budget = clamp(maxChars, 1000, HISTORY_READ_MAX_CHARS);
  const blocks = [];
  for (const event of events) {
    const block = renderEvent(event);
    if (block.length > 0) blocks.push({ seq: event?.seq ?? null, block });
  }
  const targetAt = targetSeq === null ? -1 : blocks.findIndex((entry) => entry.seq === targetSeq);

  /**
   * 这一次渲染丢了什么，写成一条提示语（没丢就是空串）。
   *
   * 两种损失各说各的：`start` 之前的前导条目是为腾地方主动丢的，`stopAt` 起的条目是
   * 预算到头没进的。只说一句「截断了」的话，读者会把上面的正文当成窗口的开头。
   *
   * @param start - 这一轮从哪一块开始装。
   * @param stopAt - 第一块一个字都没进正文的下标。
   * @param budget - 这一轮的字数预算。
   */
  const lossNotice = (start, stopAt, budget) => {
    const facts = [];
    if (start > 0) {
      const suffix = targetAt < 0 ? '' : ` for #${targetSeq}`;
      facts.push(
        `${nameRange(blocks[0].seq, blocks[start - 1].seq, start)} ${start === 1 ? 'was' : 'were'} left out to make room${suffix}`,
      );
    }
    if (stopAt < blocks.length) {
      const count = blocks.length - stopAt;
      facts.push(`${nameRange(blocks[stopAt].seq, blocks[blocks.length - 1].seq, count)} came after the cut`);
    }
    // 前导的 `\n\n` 不能省：提示语要自成一段，粘在最后一块正文后面会被读成正文的一部分。
    return facts.length === 0 ? '' : `\n\n${TRUNCATED_NOTICE_PREFIX}${budget} characters: ${facts.join(', and ')} ...]`;
  };

  const renderFrom = (start) => {
    const parts = [];
    // `used` is the exact length of `parts.join('\n')`, so it carries a separator only
    // BETWEEN entries. Charging every entry one made the arithmetic drift a character per
    // entry, and the budget then cut a window that fitted exactly.
    let used = 0;
    let truncated = false;
    let clipped = false;
    let clippedAt = -1;
    let covered = targetAt < 0;
    // 实际落了哪几块。`end` 是最后一块有字进正文的下标，`stopAt` 是第一块一个字都没进的下标
    //（预算就是在这里停下的）。地址行与提示语都要说这里的事实，不能拿窗口顶替。
    let end = start - 1;
    let stopAt = blocks.length;
    for (let index = start; index < blocks.length; index += 1) {
      const { block, seq } = blocks[index];
      const separator = parts.length === 0 ? 0 : 1;
      // 提示语占预算，不加在预算外面：CLIPPED 那条一直是先留出位置的，丢块那条也一样。
      // 不预留的话「切片 + 提示语」会比 maxChars 长出一截，而这一段正是要交出去的正文。
      // 这里按「这一块被裁」的提示语长度预留，取的是两种情况里更长的那个。
      const room = Math.max(
        0,
        budget - used - separator - CLIPPED_NOTICE.length - lossNotice(start, index + 1, budget).length,
      );
      if (used + separator + block.length > budget) {
        // Whatever does not fit is shown as a head rather than dropped whole. An
        // acceptance run found what dropping costs: `history_read {seq: 8}` on an event of
        // 5,269 characters returned 149 characters of its neighbours and NOT ONE CHARACTER
        // of the event that was asked for by number.
        if (room >= CLIPPED_MIN_CHARS) {
          parts.push(block.slice(0, room));
          end = index;
          clipped = true;
          clippedAt = index;
          // `covered` 只有在这里才置真。放在条件外面会让「超预算且连头部都推不下」
          // 也算覆盖到，重试循环随即收工，走不到把被寻址事件排首位的那一步。
          // R1 的第二次复验就是这么打穿的：同一事件 `{"seq":18}` 贡献 0 字，
          // 加 `before:1` 却给 1251 字。
          if (seq === targetSeq) covered = true;
          stopAt = index + 1;
        } else {
          // 连头部都推不下：这一块一个字都没进正文，正文到此为止。
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
    // Giving up the leading entries to make room for the addressed one is still a
    // truncation, and the caller has to be told. Without this the window came back looking
    // whole while silently missing everything before the addressed entry.
    if (start > 0) truncated = true;
    return {
      text: parts.join('\n'),
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
      loss: lossNotice(start, stopAt, budget),
    };
  };

  // The addressed entry is won by giving up the entries before it, not by squeezing it in
  // after them. Without this the first over-budget entry ends the render and every entry
  // after it — the addressed one included — contributes nothing, which is what the second
  // acceptance round found on `{"seq": 10}`: an event of 390 characters, well under the
  // budget, returning zero characters because a longer neighbour came first.
  //
  // 只给一个头部不等于给到了那一条，所以循环在「被寻址事件只拿到头部」时也继续丢前缀。
  // 停在头部会得到一个方向相反的结果：前缀刚好卡在「够放一个头部」的线下时，被寻址
  // 事件只拿约 200 字；前缀再多一个字、逼得丢前缀时，反而拿约 1356 字。
  const firstStart = targetAt < 0 ? 0 : targetAt;
  let result = renderFrom(0);
  for (let start = 1; start <= firstStart; start += 1) {
    if (result.covered && !result.targetClipped) break;
    result = renderFrom(start);
  }
  // 实际落块区间。地址行不能再拿窗口顶替它：`events 16..20 (5 read)` 底下的正文只有
  // 17..20 时，读到地址行的人会引用一段自己根本没看到的区间。
  const shown =
    result.end >= result.start
      ? {
          from: blocks[result.start].seq,
          to: blocks[result.end].seq,
          count: result.end - result.start + 1,
          total: blocks.length,
          clipped: result.clipped,
        }
      : { from: null, to: null, count: 0, total: blocks.length, clipped: false };
  if (!result.truncated) return { text: result.text, truncated: false, shown };
  // 两种损失可以同时成立，一个布尔值报不全：给了头部的意思是「这一条被裁了」，
  // 说不出「为了腾地方丢了前面哪几条」；丢块提示说的是「谁没进来」，也说不出被裁的是谁。
  // 所以两条一起发，先说自己被裁、再说丢了谁。
  const notices = `${result.clipped ? CLIPPED_NOTICE : ''}${result.loss}`;
  return { text: `${result.text}${notices}`, truncated: true, shown };
}

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
export function windowWasTruncated(text) {
  return text.includes(TRUNCATED_NOTICE_PREFIX) || text.includes(CLIPPED_NOTICE);
}

/**
 * @param events - the window, in source order.
 * @param header - the line saying where this window sits.
 * @param maxChars - character budget.
 * @param targetSeq - the event the caller addressed, or null. Passed through so that the
 *   addressed entry is rendered even when its neighbours are longer than the budget.
 */
export function renderWindow(events, header, maxChars, targetSeq = null) {
  const rendered = renderTranscript(events, maxChars, targetSeq);
  // 地址行描述的是它**下面**的正文，不是调用方要的窗口。原先印窗口，于是地址行说
  // `events 16..20 (5 read)`、正文里只有 17..20。丢了前导条目时，被丢的区间由
  // 「left out」那条提示点名，窗口仍然拼得回来。
  const { from, to, count, total, clipped } = rendered.shown;
  const span = count === 0 ? '-' : `${from}..${to}`;
  const read = count === total ? `${total} read` : `${count} of ${total} read`;
  const address = `events ${span} (${read}${clipped ? ', last entry cut' : ''})\n${header}`;
  if (rendered.text.length === 0) return `${address}\n(no readable content in this window)`;
  return `${address}\n\n${rendered.text}`;
}

/** Describe a shadowed surface-position span. */
export function describeRange(range) {
  if (range === null || typeof range !== 'object') return '?';
  return `${range.start}..${range.end}`;
}

/** Describe a seq list compactly. */
export function describeSeqs(seqs) {
  if (!Array.isArray(seqs)) return '?';
  if (seqs.length <= SEQ_LIST_HEAD + SEQ_LIST_TAIL) return seqs.join(',');
  return `${seqs.slice(0, SEQ_LIST_HEAD).join(',')},…,${seqs.slice(-SEQ_LIST_TAIL).join(',')}`;
}

/**
 * Build the excerpt shown for one search hit.
 *
 * @param text - the event's searchable text.
 * @param query - the user's query, used to centre the excerpt.
 * @param maxChars - excerpt bound.
 * @returns a single-line excerpt.
 */
export function excerptAround(text, query, maxChars) {
  const flat = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (flat.length <= maxChars) return flat;
  const needle = String(query ?? '')
    .trim()
    .split(/\s+/u)[0]
    ?.toLowerCase() ?? '';
  const at = needle.length === 0 ? -1 : flat.toLowerCase().indexOf(needle);
  const half = Math.floor(maxChars / 2);
  const start = at < 0 ? 0 : Math.max(0, at - half);
  const slice = flat.slice(start, start + maxChars);
  return `${start > 0 ? '…' : ''}${slice}${start + maxChars < flat.length ? '…' : ''}`;
}

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
export function locateAround(text, query, maxChars) {
  const raw = String(text ?? '');
  const needle = String(query ?? '')
    .trim()
    .split(/\s+/u)[0]
    ?.toLowerCase() ?? '';
  // The offset is found in the RAW text, because that is the space `history_read`'s
  // `offset` addresses. Flattening whitespace first — as this did — moved every offset
  // past the first newline: in the 132,920-character dense seed the drift reaches 361
  // characters by the end, so the printed offset pointed somewhere the snippet did not
  // show and feeding it to `history_read` landed in the wrong place.
  const at = needle.length === 0 ? -1 : raw.toLowerCase().indexOf(needle);
  const view = locateAt(raw, at, maxChars);
  // Whitespace is collapsed for DISPLAY only. Doing it before locating is what broke
  // the coordinate; doing it after cannot, because the offset is already fixed.
  return { ...view, text: view.text.replace(/\s+/gu, ' ') };
}

/**
 * Endings that close a sentence in the material this plugin reads.
 *
 * CJK enders need no lookahead: they are unambiguous. The Latin ones do, because
 * `0.1.5`, `file.log` and `e.g.` all contain them mid-token, so a Latin ender only
 * counts when whitespace or the end of the text follows it.
 */
const SENTENCE_END = /[\u3002\uFF01\uFF1F\uFF1B]/u;
const SENTENCE_TAIL = /[\u300D\u300F\uFF09\u201D\u2019"')\]]/u;

/** Offset just past the paragraph containing `at`, or the text end. */
function paragraphEnd(text, at) {
  const blank = text.indexOf('\n\n', at);
  const line = text.indexOf('\n', at);
  const boundary = blank === -1 ? line : blank === line - 1 ? blank + 1 : line;
  return boundary === -1 ? text.length : boundary;
}

/** Offset of the paragraph start containing `at`. */
function paragraphStart(text, at) {
  const blank = text.lastIndexOf('\n\n', at);
  const line = text.lastIndexOf('\n', at);
  return Math.max(0, blank === -1 ? (line === -1 ? 0 : line + 1) : blank + 2);
}

/** True when the text at `index` closes a sentence. */
function endsSentence(text, index) {
  const ch = text[index];
  if (ch === undefined) return false;
  if (SENTENCE_END.test(ch)) return true;
  if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== ';') return false;
  // A Latin ender only counts before whitespace or the end; otherwise it is part
  // of a token such as a version number or a filename.
  const next = text[index + 1];
  return next === undefined || /\s/u.test(next);
}

/** Offset just past the sentence containing `at`. */
function sentenceEnd(text, at) {
  for (let i = at; i < text.length; i += 1) {
    if (!endsSentence(text, i)) continue;
    let end = i + 1;
    while (end < text.length && SENTENCE_TAIL.test(text[end])) end += 1;
    return end;
  }
  return text.length;
}

/** Offset of the sentence start containing `at`. */
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
export function snapWindow(text, at, maxChars) {
  const body = String(text ?? '');
  const total = body.length;
  const bound = Math.max(1, Math.floor(maxChars));
  const mark = Number.isFinite(at) && at >= 0 && at < total ? at : -1;
  if (total <= bound) {
    return { text: body, start: 0, end: total, total, snapped: true, cut: false };
  }
  if (mark >= 0) {
    // The containing sentence, and ONLY the containing sentence.
    //
    // An earlier version grew the window outward by whole sentences until the next
    // one would not fit, which treats the budget as a target. In this material a
    // paragraph runs to thousands of characters, so "grow while it fits" produced
    // excerpts of roughly the whole budget and saved almost nothing — and a returned
    // character is not paid for once, it is re-sent on every later turn.
    //
    // The caller who needs more has `history_read {seq, offset}`, which is one cheap
    // call that copies an offset. Progressive disclosure beats a generous default.
    const first = sentenceStart(body, mark);
    const last = sentenceEnd(body, mark);
    if (last - first <= bound) {
      return { text: body.slice(first, last), start: first, end: last, total, snapped: true, cut: false };
    }
    // A single sentence longer than the bound: cut, and say so.
    const half = Math.floor(bound / 2);
    const cutStart = Math.max(0, mark - half);
    const cutEnd = Math.min(total, cutStart + bound);
    return { text: body.slice(cutStart, cutEnd), start: cutStart, end: cutEnd, total, snapped: false, cut: true };
  }
  const end = Math.min(total, bound);
  return { text: body.slice(0, end), start: 0, end, total, snapped: false, cut: end < total };
}

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
export function locateAt(text, at, maxChars) {
  const flat = String(text ?? '');
  const offset = Number.isFinite(at) ? at : -1;
  if (flat.length <= maxChars) {
    return { text: flat, offset, total: flat.length, found: offset >= 0 };
  }
  const half = Math.floor(maxChars / 2);
  const start = offset < 0 ? 0 : Math.max(0, offset - half);
  const slice = flat.slice(start, start + maxChars);
  return {
    text: `${start > 0 ? '…' : ''}${slice}${start + maxChars < flat.length ? '…' : ''}`,
    offset,
    total: flat.length,
    found: offset >= 0,
  };
}

/** Count case-insensitive occurrences of one query's terms. */
export function scoreText(text, query) {
  const haystack = String(text ?? '').toLowerCase();
  let score = 0;
  for (const term of String(query ?? '')
    .toLowerCase()
    .split(/\s+/u)) {
    if (term.length === 0) continue;
    let at = haystack.indexOf(term);
    while (at !== -1) {
      score += 1;
      at = haystack.indexOf(term, at + term.length);
    }
  }
  return score;
}

/**
 * Join the text of a content-block array.
 *
 * A `tool-result` block nests the tool's own blocks, and a tool result is the
 * one thing a reader most often wants back, so that nesting is followed instead
 * of being dropped.
 */
export function textOf(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool-result') parts.push(textOf(block.content));
  }
  return parts.filter((part) => part.length > 0).join('\n');
}

/**
 * The readable body of one event, for a caller that wants to search it rather
 * than display it: no seq header, no indentation, and no per-event character
 * bound, because a stopping rule that only reads the first 1200 characters of a
 * 378,430-character event is the same defect this tool exists to fix.
 *
 * @param event - a stored event node.
 * @returns its text, or an empty string for a type that carries none.
 */
export function eventBody(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'user/message':
    case 'system/message':
      return textOf(data.content);
    case 'assistant/message':
      return textOf(data.message?.content);
    case 'tool/call':
      return textOf(data.arguments) || safeJson(data.arguments);
    case 'tool/result':
      return textOf(data.message?.content);
    case 'compaction/summary':
      return textOf(data.summary);
    default:
      return '';
  }
}

/** Indent every line of a block by two spaces. */
function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** Bound one rendered value. */
function bound(text, maxChars = EVENT_TEXT_CHARS) {
  const value = String(text ?? '');
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/** Serialize a non-text payload without throwing on cycles. */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Clamp a number into a range. */
function clamp(value, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : max;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export default {
  locateAt,
  snapWindow,
  renderEvent,
  renderTranscript,
  renderWindow,
  describeRange,
  describeSeqs,
  excerptAround,
  scoreText,
  textOf,
};
