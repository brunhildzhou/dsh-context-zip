/**
 * The compaction backend.
 *
 * {@link ContextZipEngine} subclasses the shipped basic backend and overrides its
 * sole documented customization hook, `summarize()`. Everything that makes
 * compaction safe — the 80% pressure policy, the retained tail, the durable lock
 * bracket, retry, overflow recovery, and the surface replacement itself — is
 * inherited unchanged.
 *
 * What this subclass changes:
 *
 * - the summarizer instruction becomes the five-section handoff template;
 * - the live notes draft is appended as explicitly labeled intent material;
 * - the generation cap is pinned to the documented hard cap.
 *
 * All three apply only to sessions the plugin half reports as being in plugin
 * mode. A session in default mode is handed back to `super.summarize()`, which
 * reproduces the shipped behavior exactly, including the shipped 8192-token cap.
 *
 * The summarization call itself is written here against the public
 * `ctx.llm.stream()` and `BlockAssembler` API rather than reusing the backend's
 * internal helper: that helper is not part of the package's public exports, and
 * a plugin may not reach into another package's private module graph. The shape
 * of the call is identical, including the prefix reuse that keeps the provider's
 * prompt cache warm.
 *
 * @module dsh-context-zip-engine
 */

import { BlockAssembler, contentHasImage, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';

import {
  buildRewriteInstruction,
  NOTES_MATERIAL_NOTE,
  REWRITE_SYSTEM_INSTRUCTION,
  SUMMARY_HARD_CAP_TOKENS,
  SUMMARY_HEADINGS,
  SUMMARY_INSTRUCTION,
  SUMMARY_MIN_HEADINGS,
  SUMMARY_SECTION_PATTERNS,
  SUMMARY_MIN_CHARS,
  looksLikeToolCallMarkup,
  SUMMARY_SYSTEM_INSTRUCTION,
} from './prompt.js';

/**
 * Decide whether a summarizer's text is a usable handoff summary.
 *
 * Separates the two cases the gate exists to separate, and names which one it saw so
 * the caller can throw on the fatal pair and merely log the survivable one.
 *
 * @param text - the summarizer's joined text output.
 * @returns the verdict, with `sections` counted and `detail` ready to log or throw.
 */
/** How many unsupported tokens are reported; the count is what gets compared. */
const UNSUPPORTED_CLAIM_LIMIT = 12;

/** Shortest token worth checking: below this, ordinary words dominate. */
const UNSUPPORTED_CLAIM_MIN_CHARS = 4;

/** A bare number is only a claim when it is not a count the summarizer made up. */
const UNSUPPORTED_CLAIM_MIN_NUMBER = 100;

export function classifySummary(text) {
  const sections = SUMMARY_SECTION_PATTERNS.filter((section) => section.re.test(text)).length;
  const counted = `${sections} of ${SUMMARY_SECTION_PATTERNS.length} required sections present in ${text.length} characters of output`;
  if (sections >= SUMMARY_MIN_HEADINGS) {
    return { accept: true, sections, reason: 'sections', detail: counted };
  }
  if (looksLikeToolCallMarkup(text)) {
    return { accept: false, sections, reason: 'tool-call-markup', detail: counted };
  }
  if (text.trim().length < SUMMARY_MIN_CHARS) {
    return { accept: false, sections, reason: 'too-short', detail: counted };
  }
  return {
    accept: true,
    sections,
    reason: 'unrecognised-sections',
    detail: `a summarization was accepted with ${counted}: its headings use a wording this plugin does not match, so the five-section shape is not guaranteed for this session`,
  };
}

/**
 * Concrete tokens a summary asserts that its source never contained.
 *
 * The shape gate above answers "is this a handoff summary". It cannot answer "is it
 * TRUE", and the failure that motivated this check is the second kind: a summary that
 * reads perfectly and states a rule nobody wrote down. Measured cost of that class —
 * the recursion cell answered both questions with a decision the material never made,
 * and 16.1% of A2 compactions failed outright.
 *
 * The check is deliberately narrow. It looks only for tokens that are CHEAP TO VERIFY
 * and expensive to get wrong: identifiers, paths, constants and large numbers. A token
 * that appears nowhere in the source is not proof of a hallucination — it can be a
 * paraphrase, a derived value, or a word the summarizer coined for a concept — which is
 * exactly why this is a WARNING and not a gate. What it does give is a short list a
 * human or a later pass can check, and a count that can be compared across arms.
 *
 * @param summaryText - the summarizer's joined output.
 * @param sourceText - the text it was asked to replace.
 * @param options - `scope` as before; `normalizePaths` (待办 17, default ON) folds the
 *   spelling variants the source itself mixes; `fileExists` (待办 16 判据 1) is consulted
 *   only when nothing else explains the token, and is **not wired by default**.
 * @returns the tokens not found in the source, longest first, capped.
 */
export function findUnsupportedClaims(summaryText, sourceText, options: UnsupportedClaimOptions = {}) {
  return selectUnsupported(auditUnsupportedClaims(summaryText, sourceText, options));
}

/** 判据 1 的判定结果。`unknown` 是「判不了」，不是「不存在」。 */
export type FileExistenceVerdict = 'exists' | 'absent' | 'unknown';

/**
 * 判据 1：一个路径 token 指向的文件在不在工作区里。
 *
 * **为什么它是一个注入的判定器而不是内部去读文件系统**：引擎跑在压缩调用里，压缩
 * 是旁路操作，不该在热路径上做磁盘遍历；而且真机上「工作区」的权威清单有多个来源
 * （真目录扫描、工具回执带回的文件列表、会话里出现过的树清单），由调用方决定用哪
 * 一个。所以这里只定义一个回答「在 / 不在 / 判不了」的函数。
 */
export type FileExistenceOracle = (token: string) => FileExistenceVerdict;

/** B10 的判据选项。 */
export type UnsupportedClaimOptions = {
  scope?: 'paths' | 'all';
  normalizePaths?: boolean;
  fileExists?: FileExistenceOracle | null;
};

/** 一条逐 token 的判定记录。 */
export type UnsupportedClaimAudit = {
  token: string;
  /** `present` 原文里有；`spelling` 归一化后原文里有；`missing` 两边都没有。 */
  source: 'present' | 'spelling' | 'missing';
  /** `source === 'spelling'` 时，原文里那种写法的形式。 */
  spelling?: string;
  /** 判据 1 的结论；没接判定器、或该 token 不是路径时恒为 `unknown`。 */
  existence: FileExistenceVerdict;
  /** 最终算不算「原文里没有的编造候选」。 */
  unsupported: boolean;
};

/**
 * 逐 token 的判定明细，`findUnsupportedClaims` 的完整版。
 *
 * **为什么要有它**：告警只要一个清单，而判据要的是「为什么」。抽样核对、真机复算
 * 与以后的拦截决策都要看每一行是怎么判的——是原文里真有、还是归一化救回来的、
 * 还是判据 1 说这个文件真的存在。返回的是全部候选 token（含判为「原文里有」的），
 * 顺序与 `findUnsupportedClaims` 内部的收集顺序一致。
 *
 * @param summaryText - the summarizer's joined output.
 * @param sourceText - the text it was asked to replace.
 * @param options - see {@link UnsupportedClaimOptions}.
 * @returns one row per token that reached the lookup.
 */
/**
 * 一份文本里的全部候选 token，按去重后的出现顺序。
 *
 * 两条扫法合起来才是 B10 的口径，缺一条会漏掉实测里最常见的那一类：
 * 1. **反引号 span**：那是摘要自己在声明「这是一个字面量」；
 * 2. **裸 token**：摘要经常不带反引号写标识符，只扫带引号的会漏掉这个检查存在的理由。
 *    形态测试把普通散文挡住：`retry` 与 `Anchors` 按它的任何一条规则都不是标识符，
 *    所以根本走不到查表那一步。
 *
 * 单独拆出来是因为「改写引入了哪些路径」也要用同一套口径——口径不同，两个集合没法比。
 *
 * @param text - 任意文本。
 * @returns 候选 token 集合。
 */
function candidateTokens(text): Set<string> {
  const seen = new Set<string>();
  const summary = String(text ?? '');
  for (const match of summary.matchAll(/`([^`\n]{2,80})`/gu)) {
    const token = match[1].trim();
    if (isVerifiableToken(token)) seen.add(token);
  }
  for (const match of summary.matchAll(/[A-Za-z_][A-Za-z0-9_-]*(?:[./][A-Za-z0-9_-]+)*|\d{3,}/gu)) {
    const token = match[0];
    if (isVerifiableToken(token)) seen.add(token);
  }
  return seen;
}

/**
 * 一份文本里的路径形 token（{@link candidateTokens} 的子集，B10 路径档的同一个集合）。
 *
 * @param text - 任意文本。
 * @returns 路径形 token，按出现顺序。
 */
export function pathTokensIn(text): string[] {
  return [...candidateTokens(text)].filter((token) => isPathShaped(token));
}

export function auditUnsupportedClaims(
  summaryText,
  sourceText,
  options: UnsupportedClaimOptions = {},
): UnsupportedClaimAudit[] {
  // Path-scoped by default. It is still the only class with evidence behind it, but the
  // evidence was corrected twice: the "7 out of 7 were fabrication" reading came from a
  // sample whose per-item records were never kept, and the 2026.09.18 recount over 522
  // summaries found the opposite — 27 of 30 sampled path flags were false positives. What
  // survives is the narrower claim: the other classes were mostly noise (`io_uring`,
  // `POSIX`, `TOCTOU` are general vocabulary a summary may use whether or not the source
  // does, and `2000`, `3900`, `1500` are usually values the summarizer derived), so the
  // narrow scope is kept while its precision is remeasured.
  const scope = options.scope ?? 'paths';
  // 归一化默认**开**：待办 17 实测出来的主因就是「同一份原文自己就混用多种写法」，
  // 关掉它等于把 95.1% 的路径标记继续当编造报。留这个开关是为了能复现归一化之前的
  // 数字（测量用），不是为了给生产留一条关闭的路。
  const normalizePaths = options.normalizePaths !== false;
  const oracle = typeof options.fileExists === 'function' ? options.fileExists : null;
  const source = String(sourceText ?? '');
  // Separators are compared loosely. A summary that writes `segment.retention_days` for a
  // source's `segment_retention_days` has not invented anything, and the strict lookup
  // called it a fabrication — one of the two false-positive classes the first measurement
  // exposed.
  const haystack = normalizeSeparators(source.toLowerCase());
  const index = normalizePaths ? indexSourcePaths(source) : null;
  const summary = String(summaryText ?? '');
  const seen = candidateTokens(summary);
  const rows: UnsupportedClaimAudit[] = [];
  for (const token of seen) {
    if (scope === 'paths' && !isPathShaped(token)) continue;
    if (haystack.includes(normalizeSeparators(token.toLowerCase()))) {
      rows.push({ token, source: 'present', existence: 'unknown', unsupported: false });
      continue;
    }
    // 判据 2 的归一化扩展：同一个文件的另一种写法。**只对路径形 token 生效**——
    // 这几条规则全是关于目录与文件名的，套到标识符上只会乱救。
    const spelling = index === null || !isPathShaped(token) ? null : spellingVariant(token, index);
    if (spelling !== null) {
      rows.push({ token, source: 'spelling', spelling, existence: 'unknown', unsupported: false });
      continue;
    }
    // 判据 1 只对路径形 token 发问：`retention_sweep_interval_ms` 不是一个文件。
    // `exists` 是**救回来**：文件真的在，这个 token 就不是「编造了一个不存在的
    // 东西」的证据；`absent` 与 `unknown` 都照旧报出来，方向是保守的。
    const existence =
      oracle !== null && isPathShaped(token) ? oracle(token) : 'unknown';
    rows.push({ token, source: 'missing', existence, unsupported: existence !== 'exists' });
  }
  return rows;
}

/** 把判定明细压成上报清单：只留编造候选，长的在前，截断到上限。 */
function selectUnsupported(rows: UnsupportedClaimAudit[]): string[] {
  return rows
    .filter((row) => row.unsupported)
    .map((row) => row.token)
    // Longest first: a missing path carries more than a missing abbreviation, and the
    // caller reads a capped list.
    .sort((left, right) => right.length - left.length)
    .slice(0, UNSUPPORTED_CLAIM_LIMIT);
}

/**
 * 用一份「真实存在的文件清单」造一个判据 1 判定器。
 *
 * **清单从哪来由调用方决定**，这正是真机与语料的差别所在：语料里没有真实代码树，
 * 所以判据 1 在那里没有对象；真机的原文里带着工具回执，会话日志里也有整棵树的
 * 清单，那些都能拼出这份清单。
 *
 * 判定与 B10 的路径写法归一化同一套：`./`、前导 `/`、分隔符折叠、大小写都不影响。
 * **只有整条路径对得上才回 `exists`**；只对上文件名（换目录）回 `unknown`——那正是
 * 真编造里「真实文件换了目录」那一类，回 `exists` 会把它救掉。
 *
 * @param paths - 已知真实存在的文件路径，任意写法。
 * @returns 判据 1 判定器。
 */
export function fileOracleFromList(paths: Iterable<string>): FileExistenceOracle {
  const list = [];
  for (const path of paths ?? []) {
    const text = String(path).trim();
    if (text.length > 0) list.push(text);
  }
  const index = indexSourcePaths(list.join('\n'));
  return (token) => {
    const components = pathComponents(token);
    if (components.length === 0) return 'unknown';
    if (index.forms.has(components.join('/'))) return 'exists';
    // 只对上文件名（换目录）**回判不了，不回存在**：真编造里的「真实文件换了目录」
    // 正是这一档，回 `exists` 会把它救掉。
    return index.byBasename.has(components[components.length - 1]) ? 'unknown' : 'absent';
  };
}

/**
 * 两个路径 token 是不是「同一个文件的两种写法」。
 *
 * 判据与 判据 2 的规则 1 同一套：按段比较（小写、折叠 `.`/`_`/`-`、去掉 `./`、`../`、
 * 前导 `/`），一方的段序列是另一方的后缀就是同一个文件。`diag/ledger.rs` 对
 * `src/diag/ledger.rs`、对 `./diag/ledger.rs` 都成立，`ci/secret-audit.sh` 对
 * `ci/secrets-audit.sh`（文件名不同）不成立。
 *
 * **段序列相同一律算**；只做后缀比较时，**短的那一方必须有目录段**（≥2 段）。
 * 没有这一条，`zzzcache/watermark.rs` 会因为名字在原文里裸着出现过而与 `watermark.rs`
 * 认成同一个文件——那正是待办 17 实测出来的两个洞之一。护栏只在 `before`（B10 报出来的
 * 标记，全部带 `/`）上比，所以这条限制不损失任何真的换写法。
 *
 * @param left - 一个路径 token。
 * @param right - 另一个路径 token。
 * @returns 同一个文件时为 true。
 */
export function sameFileSpelling(left, right): boolean {
  const first = pathComponents(left);
  const second = pathComponents(right);
  if (first.length === 0 || second.length === 0) return false;
  if (first.join('/') === second.join('/')) return true;
  const long = first.length >= second.length ? first : second;
  const short = first.length >= second.length ? second : first;
  if (short.length < 2) return false;
  return long.slice(long.length - short.length).join('/') === short.join('/');
}

/**
 * 丁：改写护栏的判决——`added` 里该退掉这次改写的那几条。
 *
 * **与甲的区别**：甲是「新增集合差非空就退」，不问新增的是什么；丁把每一条新增拿去问
 * 判据 1（{@link FileExistenceOracle}），只在**判据 1 没有正面证据说这个文件存在**、
 * **而且它也不是改写前就被标出的那个文件的另一种写法**时才退。
 * 前者放行真机上「文件真的在」的 token，后者放行 W1/W2 残留的那 17 条
 * （`diag/ledger.rs` → `src/diag/ledger.rs` 这类：集合差按字符串比，换写法会被读成新增）。
 *
 * **判据 1 不接（`oracle` 为 `null`）时不退任何东西**：那是「这次压缩取不到清单」的
 * 降级，方向是安全侧（没有证据就不动用户已经拿到的摘要）。代价写在同一份报告里：
 * 这一档下新增的编造一条也拦不住。
 *
 * @param added - `after ∖ before` 的 token（{@link addedClaims}）。
 * @param flagged - 改写**前**就报出来的 token（甲口径的 `before`，不掺判据 1 的救援）。
 * @param oracle - 判据 1 的判定器，或 `null`（不接）。
 * @returns 该退掉的 token；空数组表示放行。
 */
/**
 * 丁：改写护栏的判决——该退掉这次改写的那几条路径 token。
 *
 * **与甲的区别**：甲是「`after ∖ before` 非空就退」，两个集合都是 B10 的**上报清单**，
 * 于是它有两个问题：一是「同一文件换写法」在字符串差里成了新成员（W1/W2 残留的 17 条），
 * 二是判据 2 的宽松规则（裸名补目录、同目录一字之差）先把 token 救走了，判据 1 根本没
 * 机会说话（待办 17 实测的两个洞）。丁换成一条判据：
 *
 * **改写里出现了一条改写前没有的路径，而判据 1 又不能证明这个文件存在 → 退。**
 *
 * 「改写前没有」按两步算（{@link introducedPaths}）：逐字出现过就算有；没逐字出现过，
 * 但按 {@link sameFileSpelling} 是同一个文件的另一种写法（`diag/ledger.rs` 对
 * `src/diag/ledger.rs`、对 `./diag/ledger.rs`）也算有。
 *
 * 「证明这个文件存在」只有一档：判据 1 回 `exists`。回 `unknown`（只对上文件名、目录对
 * 不上）与 `absent` 都算证不出来——那正是「真实文件换目录」「同目录一字之差」「裸名 +
 * 编造目录」三种形状。
 *
 * **判据 1 不接（`oracle` 为 `null`）时不退任何东西**：那是「这次压缩取不到清单」的降级，
 * 方向是安全侧（没有证据就不动用户已经拿到的摘要）。代价写在报告里：这一档下新增的
 * 编造一条也拦不住。
 *
 * @param rewrittenText - 改写后的摘要。
 * @param originalText - 改写前的摘要（身份对照集从这里来）。
 * @param oracle - 判据 1 的判定器，或 `null`（不接）。
 * @returns 该退掉的 token；空数组表示放行。
 */
/**
 * 改写相对原摘要**新引入**的路径 token（丁口径的「新增」）。
 *
 * 两步都过不了才算新引入：
 * 1. **逐字**：这条 token 在改写前的摘要里出现过；
 * 2. **身份**：它是改写前某个路径 token 的另一种写法（{@link sameFileSpelling}）。
 *
 * 第 2 步是 W1/W2 那 17 条的出口：集合差按字符串比时，`diag/ledger.rs` 加一个 `src/`
 * 或 `./` 就成了「新成员」，而它并不是改写新引入的文件。
 *
 * @param rewrittenText - 改写后的摘要。
 * @param originalText - 改写前的摘要。
 * @returns 新引入的 token，按在改写里出现的顺序。
 */
export function introducedPaths(rewrittenText, originalText): string[] {
  const known = pathTokensIn(originalText);
  const verbatim = new Set(known);
  return pathTokensIn(rewrittenText).filter(
    (token) => !verbatim.has(token) && !known.some((other) => sameFileSpelling(token, other)),
  );
}

export function rewriteGuardBlocks(rewrittenText, originalText, oracle: FileExistenceOracle | null): string[] {
  if (typeof oracle !== 'function') return [];
  return introducedPaths(rewrittenText, originalText).filter((token) => oracle(token) !== 'exists');
}

/**
 * 一份「这次压缩能看到的文件清单」，判据 1 的输入。
 *
 * 三个数分开报，是因为它们的差别就是「清单从哪来」的答案：`receipts` 是工具回执带回来
 * 的真实文件列表，`session` 是会话正文里出现过的路径写法（回执正文也算正文，所以
 * `session` 不小于 `receipts`）。
 */
export type CompactionFileList = {
  /** 判据 1 的判定器；清单为空时是 `null`，表示这次压缩取不到清单。 */
  oracle: FileExistenceOracle | null;
  /** 清单条目（去重后的路径写法，裸文件名也收）。 */
  paths: string[];
  /** 其中来自工具回执的条数。 */
  receipts: number;
  /**
   * 清单的来源。`receipts` 工具回执里有；`session` 只有会话正文；`none` 取不到清单；
   * `deps` 用的是嵌入方给的判定器（`deps.fileExists`）；`off` 是嵌入方明确关掉判据 1。
   */
  source: 'deps' | 'receipts' | 'session' | 'none' | 'off';
};

/** 路径形状的词：与 `indexSourcePaths` 收原文路径时同一条正则，裸名也收。 */
const PATH_LIKE_RE = /[a-z0-9_.][a-z0-9_./-]*\.[a-z0-9]+/gu;

/**
 * 递归读一条消息里所有可读正文，把路径形状的词收进清单。
 *
 * **为什么要递归读**：真机上工具回执的形状是
 * `{type:'tool-result', toolCallId, content:[{type:'text', text:'…'}]}`，正文不在
 * `text` 字段上，而在嵌套的 `content` 里；那条消息的 `role` 甚至是 `user`，只有
 * `source.kind === 'tool'` 与块类型 `tool-result` 能认出它是回执。
 * {@link messageContentText}（分节归属与机械摘要用的那个窄投影）对这一档返回空串，所以
 * 这里另走一条更深的读取；B10 的原文位走 {@link messageVisibleText}，同样是递归读的。
 *
 * @param value - 一条消息，或它下面的任意一层。
 * @param session - 全部路径写法（含回执）。
 * @param receipts - 只收工具回执里的那些。
 * @param inReceipt - 当前这一层是不是已经在回执里面。
 * @param depth - 递归深度，防病态嵌套。
 */
function collectPathLike(value, session: Set<string>, receipts: Set<string>, inReceipt: boolean, depth: number): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = value.toLowerCase();
    for (const match of text.matchAll(PATH_LIKE_RE)) {
      session.add(match[0]);
      if (inReceipt) receipts.add(match[0]);
    }
    return;
  }
  if (typeof value !== 'object') return;
  const receipt =
    inReceipt || value.type === 'tool-result' || value.source?.kind === 'tool' || value.role === 'tool';
  if (typeof value.text === 'string') collectPathLike(value.text, session, receipts, receipt, depth + 1);
  const content = value.content;
  if (typeof content === 'string') collectPathLike(content, session, receipts, receipt, depth + 1);
  else if (Array.isArray(content)) {
    for (const block of content) collectPathLike(block, session, receipts, receipt, depth + 1);
  } else if (content !== null && typeof content === 'object') {
    collectPathLike(content, session, receipts, receipt, depth + 1);
  }
}

/**
 * 从这次压缩的原文事件里抽一份文件清单，造判据 1 的判定器（丁的清单来源）。
 *
 * **为什么从这里抽、不扫工作区**：改写发生在压缩调用里，压缩是旁路操作，不该在热路径
 * 上遍历磁盘；而且判据 1 在护栏这一支要回答的是「**这次压缩**里有没有证据说这个文件
 * 存在」，证据就在被压缩的那段原文里。工具回执带回的文件列表是其中最硬的一份
 * （`ls`、`rg --files`、读文件回执都会带出真实文件名），会话正文里出现过的路径是它的
 * 兜底：语料里的原文是散文、没有回执，清单只能从正文来。
 *
 * @param messages - 本次压缩的输入消息。
 * @returns 清单与判定器；清单为空时 `oracle` 是 `null`（判据 1 不接）。
 */
export function fileListFromMessages(messages): CompactionFileList {
  const session = new Set<string>();
  const receipts = new Set<string>();
  for (const message of Array.isArray(messages) ? messages : []) {
    collectPathLike(message, session, receipts, false, 0);
  }
  const paths = [...session];
  if (paths.length === 0) return { oracle: null, paths: [], receipts: 0, source: 'none' };
  return {
    oracle: fileOracleFromList(paths),
    paths,
    receipts: receipts.size,
    source: receipts.size > 0 ? 'receipts' : 'session',
  };
}

/**
 * Whether a token is worth checking at all.
 *
 * Prose in backticks is not: a summarizer that writes `the retry policy` has quoted a
 * phrase, not asserted an identifier. Thresholds are set so that ordinary words and
 * small counts fall out and only tokens with a distinctive shape survive.
 *
 * @param token - a candidate token, already trimmed.
 * @returns true when the token is specific enough that its absence means something.
 */
function isVerifiableToken(token) {
  if (token.length < UNSUPPORTED_CLAIM_MIN_CHARS) return false;
  if (/\s/u.test(token)) return false;
  // A wildcard is a pattern, not a literal. `E_LOCK_*` was reported against a source that
  // contains `E_LOCK_` — the second false-positive class the first measurement exposed.
  if (/[*?]/u.test(token)) return false;
  // A long number is a claim about a value; `3` is usually a count the summarizer made
  // while compressing, and flagging it would bury the real signals in noise.
  if (/^\d+$/u.test(token)) return Number(token) >= UNSUPPORTED_CLAIM_MIN_NUMBER;
  // A slash is only a path separator when what follows the last one looks like a file.
  // Measured on 522 archived summaries: without this rule the check flagged 93.7% of
  // them, and nearly every flag was prose — `ingestion/storage/query/export`,
  // `deb/rpm/AppImage/macOS`, `rollover/compaction` are lists of concepts written with
  // slashes, not locations. A check that fires on nine summaries in ten reports nothing.
  if (token.includes('/')) {
    const last = token.slice(token.lastIndexOf('/') + 1);
    const rooted = token.startsWith('/') || token.startsWith('./') || token.startsWith('../');
    return rooted || /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/u.test(last);
  }
  return (
    /[_.:]/u.test(token) ||
    /[a-z][A-Z]/u.test(token) ||
    /^[A-Z][A-Z0-9_]+$/u.test(token) ||
    /^\d+[A-Za-z]/u.test(token)
  );
}

/**
 * Everything readable in one message, whichever shape it arrives in.
 *
 * Three shapes reach this code and only one of them was assumed at first: a bare string
 * (which is what the probes and several tests pass), an object whose `content` is a
 * string, and an object whose `content` is a list of blocks with `text`. Reading only the
 * middle one produces an empty source, and an empty source makes every token in every
 * summary look unsupported — a check that cries wolf on its first real run is worse than
 * no check.
 *
 * @param message - one entry of the summarization input.
 * @returns its text, or '' when it carries none.
 */
function messageContentText(message) {
  if (typeof message === 'string') return message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .join('\n');
}

/**
 * 递归读取的深度上限。真机实测的最深一层是工具回执的 `content`（27,645/27,645 都是
 * 一层），留出余量只是防病态嵌套，不影响真机上的任何一个字节。
 */
const VISIBLE_TEXT_MAX_DEPTH = 8;

/**
 * 一条消息里**模型真正看得见**的全部文本，B10 的原文投影。
 *
 * **为什么 B10 不能继续用 {@link messageContentText}**：那个投影只读 `block.text`，而
 * 真机的三样材料里有两样的正文不在这个字段上——
 *
 * 1. **工具回执**：形状是
 *    `{source:{kind:'tool'}, role:'user', content:[{type:'tool-result', toolCallId, content:[{type:'text', text:'…'}]}]}`，
 *    正文在嵌套的 `content` 里，`block.text` 是 undefined，窄投影对整条消息返回空串；
 * 2. **工具调用**：形状是 `{type:'tool-call', name, arguments}`，`arguments` 是模型自己
 *    写出来的那段 JSON 文本（实测全库 27,524/27,524 都是非空字符串），窄投影也不读它。
 *
 * 实测代价（真机 31 次压缩上窄投影的原文中位
 * 304,281 字符，而模型实际看到 643,287 字符；A 臂 49 个「原文里没有」的标记里 42 个的
 * 路径就明明白白出现在工具回执或 `arguments` 里。原文缺了一半，判据就把模型真读过的
 * 东西当成编造。
 *
 * **共用函数不动**：`messageContentText` 还有别的调用方（分节归属、机械摘要），它们的
 * 口径是另外两件事，改它等于顺手改掉两处与本条无关的行为。所以这里另立一条更全的投影，
 * 只有 B10 的两个原文位用它：`runSummarizationCall` 的查原文、以及改写护栏之后那次回查。
 *
 * 只读字符串字段（`text`、`arguments`），不把对象序列化进来：真机上这两样都是字符串，
 * 序列化别的对象（例如图片的 `attachment`）会往原文里塞进模型没读过的字节。
 *
 * @param message - 一条消息，或它下面的任意一层。
 * @returns 它携带的全部文本，'\n' 连接；没有可读文本时是 ''。
 */
export function messageVisibleText(message) {
  const parts: string[] = [];
  const visit = (value, depth: number): void => {
    if (depth > VISIBLE_TEXT_MAX_DEPTH) return;
    if (typeof value === 'string') {
      if (value.length > 0) parts.push(value);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (typeof value.text === 'string' && value.text.length > 0) parts.push(value.text);
    if (typeof value.arguments === 'string' && value.arguments.length > 0) parts.push(value.arguments);
    const content = value.content;
    if (typeof content === 'string') visit(content, depth + 1);
    else if (Array.isArray(content)) for (const block of content) visit(block, depth + 1);
  };
  if (typeof message === 'string') return message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) visit(block, 0);
  return parts.join('\n');
}

/**
 * Whether a token names a file rather than a concept.
 *
 * The last segment must look like a filename, which is what separates `src/diag/x.rs`
 * from `ingestion/storage/query/export`. Prose written with slashes was the single largest
 * source of noise before this rule existed.
 *
 * @param token - a candidate token.
 * @returns true when the token is a path ending in a filename.
 */
function isPathShaped(token) {
  if (!token.includes('/')) return false;
  const last = token.slice(token.lastIndexOf('/') + 1);
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/u.test(last);
}

/** Fold `.`, `_` and `-` together so separator style is not read as invention. */
function normalizeSeparators(text) {
  // Leading and trailing separators are trimmed as well: a summary that writes
  // `.segment_retention_days` at the end of a sentence has not invented the token, and
  // comparing it raw reported a fabrication that was a full stop.
  return text.replace(/[._-]+/gu, '_').replace(/^_+|_+$/gu, '');
}

/**
 * 一条路径的段序列，比较用的规范形：小写、折叠分隔符、去掉 `./`、`../` 与前导 `/`。
 *
 * **为什么要拆成段**：字面 `includes` 会把 `prewarm.sh` 认成「在原文里」——因为
 * 原文里的 `ci/prewarm.sh` 里就有这串字符。实测的 12 个真编造里，`tools/prewarm.sh`
 * 与 `ci/check-licenses.py` 正是这一类：文件名真、目录错。按段比才不会把它们救掉。
 *
 * @param path - 任意写法的路径。
 * @returns 规范化后的段数组；全空段被丢掉。
 */
function pathComponents(path: string): string[] {
  return String(path)
    .replace(/^(?:\.{1,2}\/|\/)+/u, '')
    .split('/')
    .map((part) => normalizeSeparators(part.toLowerCase()))
    .filter((part) => part.length > 0);
}

/** 正则里的字面量转义。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 两个字符串的编辑距离是否 ≤ 1。
 *
 * 只用来兜「单复数与一个字符的笔误」这一档：`ci/secret-audit.sh` 对
 * `ci/secrets-audit.sh`、`packing` 对 `packaging`。**超过一个字符就不算**——
 * `import` 对 `export` 是两个字符（实测：那正是真编造里「真实文件换了目录」的一例，
 * 放宽到 2 就会把它救掉）。
 *
 * @param left - 一个字符串。
 * @param right - 另一个字符串。
 * @returns 距离 ≤ 1 时为 true。
 */
function withinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (left.length < right.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (left.length - i) + (right.length - j) <= 1;
}

/** 原文里所有路径写法，以及文件名到写法的反查。 */
type SourcePathIndex = {
  /** 每一条路径写法的全部「段后缀」（`src/a/b.rs` 给出 `src/a/b.rs`、`a/b.rs`、`b.rs`）。 */
  forms: Set<string>;
  /** 文件名 → 原文里带这个文件名的完整写法。 */
  byBasename: Map<string, string[]>;
  /** 原文里出现过的全部文件名，供「差一个字符」那一档做模糊查找。 */
  basenames: Set<string>;
  /** 在原文里以裸名出现的文件名（前面不接路径字符）。 */
  bare: Set<string>;
  /** 点文件去掉前导点后的文件名（`runtime/.emberlog.lock` 给出 `emberlog_lock`）。 */
  dotFiles: Set<string>;
};

/**
 * 把原文里所有像路径的词收成一张索引。
 *
 * 收的时候就按段拆开并生成段后缀，是为了后面能回答「摘要这个写法是不是把原文那种
 * 写法的前导段补上了」。裸名与点文件单独记，因为它们在原文里的形态与规范形不同。
 *
 * @param sourceText - 被替换掉的原文。
 * @returns 路径写法索引。
 */
function indexSourcePaths(sourceText): SourcePathIndex {
  const forms = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const basenames = new Set<string>();
  const bare = new Set<string>();
  const dotFiles = new Set<string>();
  const text = String(sourceText ?? '').toLowerCase();
  // 只收「最后一段带扩展名」的词：`src/segment` 这种目录不是文件，收进来会让
  // `segment.rs` 这类编造名在对上目录名时被救掉。
  //
  // **不要在这里对每个文件名各造一条正则去全文搜**：那在 378KB 的原文上是 O(n²)，
  // 实测直接把一次测量跑过 60 秒。这条正则从左往右贪心匹配，所以「这个词前面有没有
  // 目录」就等于「这次匹配吃到了几段」：一段即裸名。
  for (const match of text.matchAll(/[a-z0-9_.][a-z0-9_./-]*\.[a-z0-9]+/gu)) {
    const raw = match[0].replace(/^(?:\.{1,2}\/)+/u, '');
    const rawParts = raw.split('/').filter((part) => part.length > 0);
    if (rawParts.length === 0) continue;
    const parts = rawParts.map((part) => normalizeSeparators(part));
    const base = parts[parts.length - 1];
    if (base.length === 0) continue;
    for (let at = 0; at < parts.length; at += 1) {
      const form = parts.slice(at).join('/');
      if (form.length === 0) continue;
      forms.add(form);
      if (at === 0) {
        const list = byBasename.get(base);
        if (list === undefined) {
          byBasename.set(base, [form]);
          basenames.add(base);
        } else if (!list.includes(form)) list.push(form);
      }
    }
    const rawBase = rawParts[rawParts.length - 1];
    if (rawBase.length > 1 && rawBase.startsWith('.')) dotFiles.add(normalizeSeparators(rawBase.slice(1)));
    // 裸名：这个名字在原文里出现时前面不接目录段。
    if (rawParts.length === 1) bare.add(base);
  }
  return { forms, byBasename, basenames, bare, dotFiles };
}

/** 两个目录段是不是同一个目录的两种写法（`index` 对 `emberlog-index`）。 */
function componentAlias(left: string, right: string): boolean {
  if (left === right) return true;
  // 分隔符已折叠成 `_`，所以段边界就是 `_`。
  return right.endsWith(`_${left}`) || left.endsWith(`_${right}`);
}

/**
 * 摘要里的路径 token 在原文里有没有「同一个文件的另一种写法」。
 *
 * 五条规则，全部按段比较，逐条对应实测到的子类：
 * 1. **补前导段**（268 个，最大的一档）：`src/a/b.rs` 对 `a/b.rs`。丢掉前导段后必须
 *    仍是「目录+文件」，所以 `tools/prewarm.sh` 丢成 `prewarm.sh` 不算——那正是真
 *    编造里「换目录」的一例。
 * 2. **补目录**（143 个）：原文只给裸名 `text_sniff.rs`，摘要补成 `src/import/text_sniff.rs`。
 * 3. **点文件去点**：`runtime/emberlog.lock` 对 `runtime/.emberlog.lock`。
 * 4. **长路径缩写**：`index/offset.rs` 对 `crates/emberlog-index/src/offset.rs`，要求
 *    摘要的每一个目录段都能对上原文那条写法里的某个目录段（相等，或段边界后缀）。
 * 5. **单复数与一个字符的笔误**：目录结构相同、文件名差一个字符。
 *
 * 相对与绝对、`./` 前缀由 {@link pathComponents} 在比较前统一掉。
 *
 * @param token - 摘要里的路径 token。
 * @param index - 原文的路径写法索引。
 * @returns 原文里那种写法的形式，或 null 表示归一化解释不了它。
 */
function spellingVariant(token, index: SourcePathIndex): string | null {
  const components = pathComponents(token);
  if (components.length === 0) return null;
  const base = components[components.length - 1];
  const dirs = components.slice(0, -1);
  // 1. 补前导段：丢掉至少一段后仍要「目录+文件」，裸名不在这一档。
  for (let drop = 1; drop <= components.length - 2; drop += 1) {
    const tail = components.slice(drop).join('/');
    if (index.forms.has(tail)) return tail;
  }
  // 2. 补目录：原文里这个文件名是裸名。
  if (dirs.length > 0 && index.bare.has(base)) return base;
  // 3. 点文件去点。
  if (index.dotFiles.has(base)) return `.${base}`;
  const candidates = index.byBasename.get(base) ?? [];
  for (const form of candidates) {
    // 4. 长路径缩写：目录段逐个对得上（相等或段边界后缀），且不是同一个写法。
    const formDirs = pathComponents(form).slice(0, -1);
    if (dirs.length > 0 && dirs.every((dir) => formDirs.some((other) => componentAlias(dir, other)))) return form;
  }
  for (const form of candidates) {
    // 5. 目录相同、文件名差一个字符。
    const formComponents = pathComponents(form);
    if (formComponents.length !== components.length) continue;
    if (formComponents.slice(0, -1).join('/') !== dirs.join('/')) continue;
    if (withinOneEdit(base, formComponents[formComponents.length - 1])) return form;
  }
  // 5'. 差一个字符的那一档要模糊查文件名：`ci/secret-audit.sh` 对
  // `ci/secrets-audit.sh` 连文件名的键都对不上，精确查表走不到上面那一步。
  // 只按长度筛一遍再比，且仍然要求目录完全相同——放宽目录就轮到真编造被救。
  for (const other of index.basenames) {
    if (Math.abs(other.length - base.length) > 1) continue;
    if (!withinOneEdit(base, other)) continue;
    for (const form of index.byBasename.get(other) ?? []) {
      const formComponents = pathComponents(form);
      if (formComponents.length !== components.length) continue;
      if (formComponents.slice(0, -1).join('/') !== dirs.join('/')) continue;
      return form;
    }
  }
  return null;
}

/**
 * Which part of the replaced text each summary section came from.
 *
 * The acceptance criterion for this is "every summary line can be traced back to a range
 * of the original". The obvious way to get that is to make the summarizer emit the ranges,
 * and that way is closed: the five-section template already costs 16.1% of compactions
 * outright, and every additional required field is another way for the response to miss
 * the shape gate. So the attribution is DERIVED instead of asserted — the summary is never
 * asked to describe itself.
 *
 * The method is overlap on distinctive tokens, which is enough for the question this
 * answers: given a summary line, which part of the source should a reader open to check
 * it. It is not a claim about which sentence caused which words.
 *
 * @param summaryText - the summarizer's joined output.
 * @param messages - the summarization input, in source order.
 * @returns one entry per section, with the message range it best matches.
 */
export function attributeSummarySections(summaryText, messages) {
  const texts = (messages ?? []).map(messageContentText);
  // Section boundaries are markdown headings; a summary with none is attributed whole.
  const headings = [...String(summaryText ?? '').matchAll(/^#{1,6}[^\n]*$/gmu)];
  const sections = [];
  if (headings.length === 0) {
    sections.push({ heading: '(no heading)', body: String(summaryText ?? '') });
  } else {
    for (let index = 0; index < headings.length; index += 1) {
      const start = headings[index].index ?? 0;
      const end = index + 1 < headings.length ? headings[index + 1].index ?? 0 : String(summaryText ?? '').length;
      sections.push({ heading: headings[index][0].trim(), body: String(summaryText ?? '').slice(start, end) });
    }
  }
  const messageTokens = texts.map((text) => distinctiveTokens(text));
  return sections.map((section) => {
    const wanted = distinctiveTokens(section.body);
    let bestAt = -1;
    let bestScore = 0;
    for (let index = 0; index < messageTokens.length; index += 1) {
      let score = 0;
      for (const token of wanted) if (messageTokens[index].has(token)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestAt = index;
      }
    }
    // Three outcomes, kept apart because they mean different things and merging them was
    // the first thing this measurement got wrong. A section with no distinctive token at
    // all (`from: -1`) is prose and cannot be traced by this method; a section whose
    // tokens are absent everywhere (`from: -1`, `score: 0`, non-empty `shared`) is a
    // finding, and it is the same finding the claim check reports.
    if (wanted.size === 0) {
      return { heading: section.heading, from: -1, to: -1, score: 0, shared: null, traceable: false };
    }
    return {
      heading: section.heading,
      from: bestAt,
      to: bestAt,
      score: bestScore,
      shared: Number((bestScore / wanted.size).toFixed(3)),
      traceable: true,
    };
  });
}

/**
 * Tokens distinctive enough to indicate that two passages are about the same thing.
 *
 * Reuses the shape test the claim check uses, for the same reason: ordinary words appear
 * everywhere and would make every section match every message.
 *
 * @param text - any passage.
 * @returns the set of distinctive tokens it contains.
 */
function distinctiveTokens(text) {
  const out = new Set<string>();
  for (const match of String(text ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_-]*(?:[./][A-Za-z0-9_-]+)*|\d{3,}/gu)) {
    const token = match[0];
    if (isVerifiableToken(token)) out.add(normalizeSeparators(token.toLowerCase()));
  }
  return out;
}

/** Plugin identity used for synthesized messages. */
export const PLUGIN_ID = 'context-zip';

/**
 * The producer-owned message-source kind these messages carry.
 *
 * 0.1.7-alpha.1 deleted the shared catch-all `plugin` kind and refuses that
 * retired literal at the session-format boundary, so a message carrying it
 * fails the whole turn instead of landing. The harness's own V3 migration
 * rewrites released `{ kind: 'plugin', plugin: X }` rows to `plugin:X`, which is
 * why this spelling also matches the rows already on disk. `source.plugin`
 * stays beside it: the mechanical summary below filters by that field.
 */
export const PRODUCER_KIND = `plugin:${PLUGIN_ID}`;

/**
 * Build the final user message of a summarization call.
 *
 * @param notes - the live notes draft, or '' when the session has none.
 * @returns one frozen user message carrying the instruction.
 */
export function buildSummarizationInstruction(notes) {
  const parts = [SUMMARY_INSTRUCTION];
  const draft = typeof notes === 'string' ? notes.trim() : '';
  if (draft.length > 0) parts.push(NOTES_MATERIAL_NOTE, '```text', draft, '```');
  return createUserMessage({
    content: [{ type: 'text', text: parts.join('\n\n') }],
    source: { kind: PRODUCER_KIND, plugin: PLUGIN_ID, form: 'instructions' },
  });
}

/**
 * Resolve the provider/model one summarization call should use.
 *
 * Precedence matches the shipped backend: an explicit configured pair wins, then
 * the conversation's latest durable routed request, then the agent's own options.
 *
 * @param config - resolved backend configuration.
 * @param agent - the agent being compacted.
 * @returns the target route, or undefined when none is resolvable.
 */
export function summarizeTarget(config, agent) {
  if (typeof config?.summarizationProvider === 'string' && config.summarizationProvider.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel };
  }
  const latest = agent.session.requestHeader?.()?.config;
  if (latest !== undefined && typeof latest.provider === 'string' && typeof latest.model === 'string') {
    return { provider: latest.provider, model: latest.model };
  }
  const options = agent.options ?? {};
  if (
    typeof options.provider === 'string' &&
    options.provider.length > 0 &&
    typeof options.model === 'string' &&
    options.model.length > 0
  ) {
    return { provider: options.provider, model: options.model };
  }
  return undefined;
}

/**
 * Run one cache-reusing summarization call and reduce it to text.
 *
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix to condense.
 * @param agent - supplies routing history, fallback target, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @param claims - B10 的判据选项，从引擎的 `deps` 透传进来；缺省即两样都不接。
 * @returns text-only summary blocks plus the exact call envelope.
 */
export async function runSummarizationCall(ctx, config, input, agent, signal, claims: UnsupportedClaimOptions = {}) {
  const target = summarizeTarget(config, agent);
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both summarization fields, route one request, or set both AgentOptions fields',
    );
  }
  const assembler = new BlockAssembler();
  // NO tool roster is forwarded, and there is now a second measurement behind that.
  //
  // The first: a request carrying the session's own tools invites the model to replay
  // a call it can see in the transcript. A conversation whose last instruction was
  // "call the bash tool, then reply" made the summarizer replay that call, the call
  // settled as `tool-calls` with no text at all, and the whole compaction aborted.
  // Measured against the shipped backend on the same session, dropping the roster is
  // the difference between a five-section summary and no summary.
  //
  // The second, which closed the obvious loophole. A single purpose-built
  // `submit_handoff` tool was tried in place of the roster, on the reasoning that a
  // tool whose call IS the summary is a different proposition from an unrelated action
  // the transcript happens to mention. It is not. Two live attempts, two different
  // failures: one submitted 1,441 characters of arguments that parsed to nothing
  // usable, the other submitted malformed JSON with shortened key names (`"Goal` for
  // `"Goal and intent"`, unclosed). Both times the model called the tool and wrote no
  // prose at all, so the form-as-text path never ran. `GenerateOptions` has no
  // `toolChoice`, so the invitation could not be made reliable; the tool was removed.
  // With the roster empty the model writes the form as text and the section classifier
  // accepts it, which is the behavior the acceptance measurements were taken under.
  const options = {
    provider: target.provider,
    model: target.model,
    messages: [...input.messages],
    // Deliberately NOT `input.system`: the conversation's own system prompt says
    // "you are a coding agent with tools", which is what made the model answer
    // the summarization request by replaying the last instruction.
    system: SUMMARY_SYSTEM_INSTRUCTION,
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new HarnessError(
      `summarization call finished as ${finish.kind}`,
      finish.kind === 'aborted' ? 'ABORTED' : 'PROVIDER_ERROR',
      { cause: finish.failure },
    );
  }
  const rawOutput = assembler.blocks();
  if (contentHasImage(rawOutput)) {
    throw new HarnessError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT');
  }
  const summary = rawOutput.filter((block) => block.type === 'text');
  if (!summary.some((block) => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content');
  }
  // Text is not enough. A summarizer that treated the transcript as a live turn
  // once answered by writing the tool-call markup out as prose; the call settled
  // as `stop`, the text was non-empty, and the compacted history was replaced by
  // a transcript of a tool call. That is the failure this gate is for.
  //
  // It used to test for the five English headings by substring, which also rejected
  // summaries whose headings were worded differently — and rejecting those fails the
  // whole compaction over a wording. Measured on the dense corpus: 16.1% of plugin-arm
  // compactions failed against 0% on the arm delegating to the shipped backend, and
  // every failure was a normal-length summary carrying none of the exact strings. So
  // the gate now separates the two cases it always meant to separate: markup is
  // refused, and a substantial non-markup summary is accepted whichever dialect its
  // headings are in. An accepted-but-unrecognised shape is logged rather than
  // swallowed, because a silent drift in what the template produces is worth seeing.
  const text = summary.map((block) => block.text).join('\n');
  const verdict = classifySummary(text);
  if (verdict.reason === 'tool-call-markup' || verdict.reason === 'too-short') {
    throw new Error(`summarization returned no handoff summary (${verdict.reason}): ${verdict.detail}`);
  }
  if (verdict.reason === 'unrecognised-sections') {
    ctx.logger?.warn?.(`[context-zip] ${verdict.detail}`);
  }
  // Content, not shape. Warning-only by design: a token absent from the source can be a
  // paraphrase or a derived value, so this reports and does not refuse. The count and the
  // sample travel with the result so a run can be compared against another run, which is
  // what the acceptance criterion for this check needs.
  // 原文用 {@link messageVisibleText}：B10 问的是「摘要写出了它读过的材料里没有的东西
  // 吗」，所以原文必须是**模型看得见的全部文本**，含工具回执的嵌套正文与工具调用的
  // `arguments`。窄投影漏了这两样，实测把 A 臂 49 个标记里的 42 个真材料里的路径判成了编造。
  const sourceText = (input.messages ?? []).map(messageVisibleText).join('\n');
  const claimAudit = auditUnsupportedClaims(text, sourceText, claims);
  const unsupportedClaims = selectUnsupported(claimAudit);
  // Derived, never asserted: see attributeSummarySections for why the summarizer is not
  // asked to emit ranges itself.
  const sectionSources = attributeSummarySections(text, input.messages ?? []);
  if (unsupportedClaims.length > 0) {
    ctx.logger?.warn?.(
      `[context-zip] ${unsupportedClaims.length} token(s) in this summary do not appear in the text it replaced: ${unsupportedClaims.join(', ')}`,
    );
  }
  // 归一化救回来的那些单独记一行：它们是「同一个文件的另一种写法」，不是编造。判据 1
  // 救回来的也在这里（`existence === 'exists'`）。两样都不进 `unsupportedClaims`，
  // 但要看得出检测器做过什么，否则「一个都没报」与「报了一堆归一化掉」长得一样。
  const spelled = claimAudit.filter((row) => row.source === 'spelling');
  const realFiles = claimAudit.filter((row) => row.source === 'missing' && row.existence === 'exists');
  if (spelled.length > 0 || realFiles.length > 0) {
    ctx.logger?.info?.(
      `[context-zip] claim check passed over ${spelled.length} spelling variant(s) and ${realFiles.length} token(s) naming files that really exist`,
    );
  }
  return {
    summary,
    rawOutput,
    unsupportedClaims,
    sectionSources,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  };
}

/**
 * 思考档位从低到高的次序表，用于把改写调用锁在最低档。
 *
 * **为什么需要一个次序表**：`LlmResolvedModelInfo.reasoning.efforts` 的类型只承诺
 * 「adapter 偏好的展示顺序」，没承诺是升序还是降序。实测本机两个 adapter 都用升序
 * （`dsh-llm-deepseek` 的 `REASONING_EFFORTS` 是 off/low/high/max；`dsh-llm-pi-ai`
 * 的 `THINKING_LEVELS` 是 off/minimal/low/medium/high/xhigh/max），但那是实测到的
 * 事实，不是接口保证。所以先按这张已知次序表选，表里一个都对不上时才退回
 * `efforts[0]`（adapter 自己的顺序），并把这件事记在结果里。
 */
const REASONING_ESCALATION = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 一个模型能用的最低思考档位。
 *
 * 用户拍板：改写是机械任务，思考深度锁最低档，界面不暴露旋钮。理由有两条，都在
 * 用户原话里：推理模型倾向「顺便把内容改好」，档位越高越容易越界；暴露旋钮等于
 * 邀请用户调高。所以这里没有「让用户选」的分支。
 *
 * `reasoning` 为 undefined 表示该模型根本没有思考档位可调（不是「不知道」）——
 * 此时不传 `reasoningEffort`，因为传了会被 `LlmRuntime` 以
 * `UNSUPPORTED_REASONING_EFFORT` 拒掉。
 *
 * @param reasoning - `LlmResolvedModelInfo.reasoning`，或 undefined。
 * @returns 要传给 `GenerateOptions.reasoningEffort` 的值，或 undefined 表示不传。
 */
export function lowestReasoningEffort(reasoning) {
  const efforts = Array.isArray(reasoning?.efforts)
    ? reasoning.efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  if (efforts.length === 0) return undefined;
  for (const candidate of REASONING_ESCALATION) {
    if (efforts.includes(candidate)) return candidate;
  }
  // 未知方言：退回 adapter 自己给的第一个，并让调用方把这件事写进日志。
  return efforts[0];
}

/**
 * 改写相对原文**新增**的编造 token = 两个集合的差。
 *
 * **为什么是集合差而不是数量差**：数量差会把「退掉一个、新增一个」读成没变。护栏要
 * 回答的是「这份改写往上下文里塞了原文没有、原摘要也没有的东西吗」，那是一个关于
 * 成员的问题，不是关于多少的问题。
 *
 * **比较是字面的**，不做分隔符归一。`findUnsupportedClaims` 内部查原文时会把
 * `.`/`_`/`-` 折叠成一个字符，那是它自己的判据；护栏这一层不再叠一层归一，因为
 * 那等于替用户放宽他拍板的判据。代价是实测出来的：见
 * `docs/功能文档.md` §九 的误退率。
 *
 * @param before - 原摘要跑 B10 的结果。
 * @param after - 改写跑 B10 的结果。
 * @returns `after` 里有、`before` 里没有的 token，保持 `after` 的顺序。
 */
export function addedClaims(before, after) {
  const known = new Set((Array.isArray(before) ? before : []).map((token) => String(token)));
  const out = [];
  for (const token of Array.isArray(after) ? after : []) {
    const text = String(token);
    if (known.has(text)) continue;
    known.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 从改写设置的读取器返回值里算出一次改写要用的路由，或算出为什么不能用。
 *
 * 三种「不能用」都退回原散文，不抛错：开关没开、provider/model 没选全。
 *
 * @param value - reader 的返回值 `{ enabled, provider, model }`。
 * @returns `{ route }` 或 `{ reason }`。
 */
export function resolveRewriteRoute(value) {
  if (value === null || typeof value !== 'object' || value.enabled !== true) {
    return { reason: 'the layout-only rewrite is switched off' };
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (provider.length === 0 || model.length === 0) {
    return { reason: 'no provider/model is selected for the layout-only rewrite' };
  }
  return { route: { provider, model } };
}

/**
 * 跑一次只改格式的改写调用。
 *
 * **输入只有那份摘要。** 被压缩的对话不重发：一是贵（那是整段对话再发一遍），二是
 * 改写本来就不该看见新素材——它看不见，就没有东西可以编。护栏仍然要跑，因为「看不见」
 * 是提示词层面的事实，不是接口层面的保证。
 *
 * **思考档位锁最低。** 见 {@link lowestReasoningEffort}。
 *
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration; `maxTokens` is reused as the cap.
 * @param summaryText - the summary to re-lay-out; the only model-visible input.
 * @param route - `{ provider, model, reasoningEffort? }`.
 * @param sessionId - owning session id, stamped for routing like the summary call.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the rewritten text.
 */
export async function runRewriteCall(ctx, config, summaryText, route, sessionId, signal) {
  const assembler = new BlockAssembler();
  const options = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: buildRewriteInstruction(summaryText) }],
        source: { kind: PRODUCER_KIND, plugin: PLUGIN_ID, form: 'instructions' },
      }),
    ],
    system: REWRITE_SYSTEM_INSTRUCTION,
    maxTokens: config.maxTokens,
    ...(sessionId === undefined ? {} : { sessionId }),
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    // provider 的原话与 HTTP 状态写进 message，不只挂在 `cause` 上：调用方记的是
    // message，而排障要看的正是「哪个 provider 说了什么」。
    // 标注成 Partial：`error` / `aborted` 两个变体都要求 failure 存在，`{}` 只是
    // 适配器违约时的兜底，不能让它的空对象类型把 message/status 抹掉。
    const failure: Partial<LlmFailure> = finish.failure ?? {};
    throw new HarnessError(
      `layout-only rewrite finished as ${finish.kind}${failure.message === undefined ? '' : `: ${failure.message}`}${
        failure.status === undefined ? '' : ` (HTTP ${failure.status})`
      }`,
      finish.kind === 'aborted' ? 'ABORTED' : 'PROVIDER_ERROR',
      { cause: finish.failure },
    );
  }
  const rawOutput = assembler.blocks();
  if (contentHasImage(rawOutput)) {
    throw new HarnessError('layout-only rewrite cannot contain image output', 'UNSUPPORTED_CONTENT');
  }
  const text = rawOutput
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (text.trim().length === 0) throw new Error('the layout-only rewrite produced no text');
  return text;
}

/** 改写档位的读取器，与 {@link setSharedFallbackReader} 同构。 */
let sharedRewriteReader = null;

/**
 * 注册「格式改写」档位的读取器，由 `src/index.ts` 在设置变化时注入。
 *
 * @param reader - `() => { enabled, provider, model }`，或 null 清除。
 * @returns 注销函数，恢复注册前的读取器。
 */
export function setSharedRewriteReader(reader) {
  const previous = sharedRewriteReader;
  sharedRewriteReader = typeof reader === 'function' ? reader : null;
  return () => {
    if (sharedRewriteReader === reader) sharedRewriteReader = previous;
  };
}

/**
 * Process-wide fallback notes reader, registered by the plugin's host half.
 *
 * The plugin owns note storage, but the engine instance that actually compacts
 * is constructed by the `compaction-basic` row. In the web profile that row
 * lives inside an agent-preset realm the host plugin cannot reach, so the reader
 * cannot be handed over as a service. Both halves resolve this package to the
 * same module instance, which makes a module-level registration the one seam
 * that crosses that boundary without either side reaching into the other's
 * realm.
 */
let sharedNotesReader = null;

/**
 * Register the fallback reader used when an engine carries none of its own.
 *
 * @param reader - `(sessionId) => Promise<string>`, or null to clear.
 * @returns the disposer that restores the previous registration.
 */
export function setSharedNotesReader(reader) {
  const previous = sharedNotesReader;
  sharedNotesReader = typeof reader === 'function' ? reader : null;
  return () => {
    if (sharedNotesReader === reader) sharedNotesReader = previous;
  };
}

/** Per-session compaction mode chosen by the plugin half. */
/**
 * 兜底开关的读取器，与 `sharedModeReader` 同构：由 `src/index.ts` 在设置变化时注入。
 * 返回 `{ enabled, after }`；reader 缺失时返回保守值（关闭、默认次数）。
 */
let sharedFallbackReader = null;

/**
 * 注册兜底开关的读取器。
 *
 * @param reader - `() => { enabled, after }`，或 null 清除。
 * @returns 注销函数，恢复注册前的读取器。
 */
export function setSharedFallbackReader(reader) {
  const previous = sharedFallbackReader;
  sharedFallbackReader = typeof reader === 'function' ? reader : null;
  return () => {
    if (sharedFallbackReader === reader) sharedFallbackReader = previous;
  };
}

/** 每次压缩尝试失败后累加，成功即清零。按会话记。 */
const failureStreaks = new Map();

/** 只在测试里用：清掉计数。 */
export function resetFailureStreaks() {
  failureStreaks.clear();
}

/**
 * 读一个会话的连续失败次数。
 *
 * 手动压缩的报错文案要带出「已经失败了几次」，否则用户只看到「压缩失败」，
 * 分不清该重试还是该等兜底。计数只在**本插件自己压的会话**上累加：交回内置
 * 后端的会话永远读到 0，调用方要能说出这一点（见 `manualFailureText`）。
 *
 * @param sessionId - 要读的会话号。
 * @returns 连续失败次数，从未失败过是 0。
 */
export function failureCount(sessionId) {
  return failureStreaks.get(String(sessionId ?? '')) ?? 0;
}

/**
 * 手动压缩的「座位」：能跑 `compactNow` 的引擎实例，模块级登记。
 *
 * **为什么需要它**：`compaction` 服务是按 agent 预设 realm 隔离的，而 web profile
 * 把宿主平面那一行 `compaction-basic` 打了 `disabled: true`（`--dump-config` 实测），
 * 于是宿主半层的 `ctx.get('compaction')`、甚至 `agent.ctx.get('compaction')` 和
 * `agent.ctx.inject(['compaction'], …)` 全都拿不到它（都在真进程里探过）。**唯一在
 * 那个 realm 里跑的本插件代码就是这个引擎实例**，所以由它在构造时把「我能压」登记
 * 到这里，宿主半层按需取用。
 *
 * 与 `setSharedNotesReader` / `setSharedModeReader` / `setSharedFallbackReader` 同一个
 * 机制，理由也一样：两半解析到同一个模块实例，模块级登记是唯一一条不越过对方 realm
 * 边界的缝。
 *
 * 用集合而不是单个变量：一个进程可能挂多个预设 realm，每个都构造一个实例。手动压缩
 * 以 `agent` 为参数、不绑定会话，所以任一实例都能压任一会话；配置差异只影响自动压缩
 * 的门槛，手动这一路本来就传 `retainTokens = 0`。
 */
const manualSeats = new Set();

/**
 * 登记一个能执行手动压缩的引擎实例。
 *
 * @param seat - `(agent, signal, commandId) => Promise<CompactionResult|null>`。
 * @returns 注销函数。
 */
export function addManualCompactionSeat(seat) {
  if (typeof seat !== 'function') return () => {};
  manualSeats.add(seat);
  return () => {
    manualSeats.delete(seat);
  };
}

/** 当前有没有可用的手动压缩座位。 */
export function hasManualCompactionSeat() {
  return manualSeats.size > 0;
}

/**
 * 走登记好的引擎实例执行一次手动压缩。
 *
 * @param agent - 要压缩的活会话所属 agent。
 * @param signal - 取消信号。
 * @param commandId - 发起这次压缩的命令身份，可选。
 * @returns 压缩结果，或没有可压区间时的 null。
 * @throws 没有任何实例登记时抛错：这条信息比「压缩失败」有用，它说明插件没被装进
 *   任何 agent 预设 realm。
 */
export async function runManualCompaction(agent, signal, commandId) {
  const seat = manualSeats.values().next().value;
  if (seat === undefined) {
    throw new Error(
      'no compaction engine has registered a manual seat: the plugin is not mounted in any agent preset realm',
    );
  }
  return await seat(agent, signal, commandId);
}

/** 只在测试里用：清掉登记的座位。 */
export function resetManualCompactionSeats() {
  manualSeats.clear();
}

/**
 * 机械摘要：不加任何模型调用，从会话事件拼一份流水账。
 *
 * **为什么需要它**：模型反复写不出可用摘要时，压缩就一直压不成，窗口只涨不缩。
 * 这份摘要**永不失败、不可能编造**（每一行都来自事件本身），代价是没有模型摘要的
 * 判断力，读起来像台账。
 *
 * **为什么不用「接受任何非空摘要」兜底**：一份质量极差的模型摘要进了上下文**看不出
 * 它差**，这与本项目反复出现的那类毛病同类；机械摘要一眼能认出是兜底产物。
 *
 * **插件自己拼的消息不算事件**：摘要指令那条带着 `source.plugin === PLUGIN_ID`，而调用方交给
 * 这里的是「发给模型的那份消息数组」，末尾正挂着它。把它数进去会让两个数字同时虚高
 * （实测 1 条真事件加 1 条指令 → 正文写「2 event(s)」「user 2」，字数从 7 涨到 4398）。
 * 这条摘要存在的理由就是「不可能编造」，里面唯一的两个数字必须对，所以按 `source.plugin`
 * 过滤，不指望调用方记得换一个参数。
 *
 * @param messages - 即将被压缩掉的对话。
 */
export function buildMechanicalSummary(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter(
    (message) => message?.source?.plugin !== PLUGIN_ID,
  );
  const kinds = new Map();
  const files = new Set();
  let chars = 0;
  for (const message of list) {
    const kind = String(message?.role ?? message?.type ?? 'unknown');
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const text = messageContentText(message);
    chars += text.length;
    // 只挑看着像文件路径的词，且限量，免得台账比正文还长。
    for (const token of text.split(/\s+/)) {
      const clean = token.replace(/^[`'"(\[]+|[`'")'\],.:;]+$/g, '');
      if (clean.length > 3 && clean.includes('/') && /\.[A-Za-z0-9]+$/.test(clean)) files.add(clean);
      if (files.size >= 40) break;
    }
  }
  const shape = [...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(', ') || 'none';
  const lines = [
    '## Handoff summary (mechanical fallback)',
    '',
    'This summary was written by the plugin, not by a model. The summarization call failed',
    'repeatedly, so the compaction fell back to this ledger rather than leave the window',
    'growing. Every line below comes from the events themselves; nothing here was inferred.',
    '',
    '## What was compacted',
    '',
    `- ${list.length} event(s), about ${chars} characters of text.`,
    `- Event kinds: ${shape}.`,
  ];
  if (files.size > 0) {
    lines.push('', '## Paths mentioned', '', ...[...files].sort().map((f) => `- ${f}`));
  }
  lines.push(
    '',
    '## What is missing',
    '',
    'The reasoning, decisions and open questions in this span were not summarised, because',
    'no model wrote them down. Read the original events with the history tools if any of it',
    'matters: the plugin never deletes them.',
    '',
  );
  return lines.join('\n');
}

let sharedModeReader = null;


/**
 * Register the reader that answers which summarizer one session uses.
 *
 * The engine and the plugin are separate packages, so this module-level hook is
 * how the per-session decision crosses the boundary — the same mechanism as
 * {@link setSharedNotesReader}. A missing reader degrades to `'plugin'`, which
 * is this package's own behavior and the reason it exists.
 *
 * @param reader - `(session) => Promise<'plugin'|'default'>|'plugin'|'default'`, or null to clear.
 *   Receives the session itself so a reader can consult its header, not only its id.
 * @returns the disposer that restores the previous registration.
 */
export function setSharedModeReader(reader) {
  const previous = sharedModeReader;
  sharedModeReader = typeof reader === 'function' ? reader : null;
  return () => {
    if (sharedModeReader === reader) sharedModeReader = previous;
  };
}

/**
 * Build the compaction engine class over a supplied base.
 *
 * The base is passed in rather than imported because this plugin's profile
 * redirects the `@deepseek-ai/dsh-compaction-basic` specifier to itself: an
 * import of that specifier from here would resolve back to this plugin. The
 * redirect package, which sits outside the redirect, is the one place that may
 * name it.
 *
 * @param Base - the shipped `BasicCompactionEngine` class.
 * @returns a subclass that overrides only the documented `summarize()` hook.
 */
export function createContextZipEngine(Base) {
  return class ContextZipEngine extends Base {
    /**
     * @param ctx - owning context; already carries `llm`, `tokenMeter`, and `sessions`.
     * @param config - partial basic-backend config, forwarded unchanged so a
     *   session that stays on the default mode gets the shipped defaults.
     * @param deps - test seams; production passes nothing.
     */
    constructor(ctx, config, deps) {
      // `config` is forwarded WITHOUT baking in the plugin's cap. The shipped
      // backend resolves `maxTokens` to 8192 when the row sets none, and a
      // session delegated back to it must see that number, not this plugin's
      // smaller cap. The plugin's own cap is applied at call time instead.
      super(ctx, config ?? {});
      /** Row-level config as written, so an explicit `maxTokens` still wins. */
      this.declaredConfig = config ?? {};
      this.deps = deps ?? {};
      // 手动压缩的座位：宿主半层看不到这个 realm 里的 `compaction` 服务，唯一在
      // 这里跑的本插件代码就是这个实例，所以由它把能力登记到模块级。绑定在构造它的
      // fiber 上，realm 一拆座位就撤，不会留下指向死实例的回调。
      this.undoManualSeat = addManualCompactionSeat((agent, signal, commandId) =>
        this.compactNow(agent, signal, commandId),
      );
      try {
        ctx.effect?.(() => this.undoManualSeat);
      } catch (error) {
        this.ctx.logger?.warn?.(`[context-zip] registering the manual compaction seat failed: ${String(error)}`);
      }
    }

    /**
     * Decide which summarizer one session uses.
     *
     * The whole session is handed over, not just its id: the plugin resolves the
     * mode from the session's header preset and its id, so an id-only lookup
     * would silently skip the preset key.
     *
     * @param agent - the agent being compacted.
     * @returns `'plugin'` for this plugin's handoff template, `'default'` to
     *   delegate to the shipped backend, or whatever a test seam returns.
     */
    async readMode(agent) {
      const reader = this.deps.readMode ?? this.modeReader ?? sharedModeReader;
      if (typeof reader !== 'function') return 'plugin';
      try {
        const mode = await reader(agent.session);
        return mode === 'default' ? 'default' : 'plugin';
      } catch (error) {
        this.ctx.logger?.warn?.(`[context-zip] reading the compaction mode failed: ${String(error)}`);
        return 'plugin';
      }
    }

    /**
     * B10 的判据选项：判据 1 只从 `deps` 接，缺省**不接**。
     *
     * **为什么默认不接**：判据 1 问的是「这个文件真的存在于工作区吗」，而这批测试
     * 语料是散文体、全工作区没有 `.rs` 文件，那条判据在那里没有对象；真机上原文
     * 带着工具回执，它才有可用的数据源。所以引擎只提供接口与透传，谁来喂这份清单
     * 是一个还没定的产品决定（真机上的判据 1 接线讨论见 `docs/功能文档.md` 的
     * 判据 1 一节）。
     *
     * `normalizePaths` 也留一个同样的透传口，用途是**测量**：跑出归一化之前的数字，
     * 好让「救了哪些、救错哪些」能对得上。
     *
     * @returns 传给 B10 的选项；两样都没配时是空对象，与加这个口之前逐字相同。
     */
    claimOptions() {
      const fileExists = typeof this.deps?.fileExists === 'function' ? this.deps.fileExists : undefined;
      const normalizePaths = typeof this.deps?.normalizePaths === 'boolean' ? this.deps.normalizePaths : undefined;
      return {
        ...(fileExists === undefined ? {} : { fileExists }),
        ...(normalizePaths === undefined ? {} : { normalizePaths }),
      };
    }

    /**
     * 丁：这次改写的护栏用哪一份文件清单。
     *
     * 三态，每一态都要有测试盯着：
     * 1. `deps.fileExists` 是函数 → 用它（嵌入方给的权威清单；测试与真机复算从这里注入）；
     * 2. `deps.fileExists === null` → 明确不接判据 1，护栏不拦（降级）；
     * 3. 没配（`undefined`）→ 引擎自己从这次压缩的原文事件里抽清单（工具回执 + 会话
     *    正文，见 {@link fileListFromMessages}）；抽不到清单时 `oracle` 也是 `null`，
     *    同样是「不拦」。
     *
     * @param messages - 本次压缩的输入消息。
     * @returns 清单与它的来源；`oracle` 为 `null` 即判据 1 不接。
     */
    rewriteFileList(messages) {
      if (typeof this.deps?.fileExists === 'function') {
        return { oracle: this.deps.fileExists, paths: [], receipts: 0, source: 'deps' };
      }
      if (this.deps?.fileExists === null) return { oracle: null, paths: [], receipts: 0, source: 'off' };
      return fileListFromMessages(messages);
    }

    /**
     * Summarize the replayed region with the five-section handoff instruction.
     *
     * A session whose mode is `'default'` is handed straight back to the shipped
     * implementation. Two sessions in one process can therefore compact
     * differently: one with this template and the live notes, one with the
     * backend's own wording. Nothing else about compaction branches here, because
     * `summarize()` is the only hook this class overrides.
     *
     * @param input - replayed conversation prefix: the derived system head followed by the shadowed region in surface order.
     * @param agent - the agent being compacted; supplies the notes draft, routing, and the mode decision.
     * @param signal - cancellation forwarded to the provider call.
     * @returns the framed summary plus the exact call envelope.
     */
    async summarize(input, agent, signal) {
      if ((await this.readMode(agent)) === 'default') return await super.summarize(input, agent, signal);
      const messages = [...input.messages, buildSummarizationInstruction(await this.readNotes(agent))];
      const run = this.deps.summarize ?? runSummarizationCall;
      const claims = this.claimOptions();
      const config = {
        ...this.config,
        maxTokens: this.declaredConfig.maxTokens ?? SUMMARY_HARD_CAP_TOKENS,
      };
      // 两类真失败各重试一次。**只重试这两类，不重试形态问题。**
      //
      // `tool-call-markup` 与 `too-short` 是「摘要完全不可用」，重试有价值；而它们
      // 的失败产物**从来没有进入会话**——摘要调用是一次旁路调用，被拒的只是本进程
      // 里的一个字符串，所以重试的输入与上一次完全相同，没有污染问题，成本只有钱
      // 与时间（要把被压缩的那段对话再发一遍）。
      //
      // 散文（`unrecognised-sections`）**不重试**：那是「模型拿到了模板却没用」，
      // 同样的提示再问一遍多半还是不写标题。它在 runSummarizationCall 里就被接受了，
      // 走不到这里。
      //
      // 重试仍失败则原样抛出，调用方按 N 次失败的口径处理。
      const sessionId = String(agent?.session?.id ?? '');
      for (let attempt = 0; ; attempt += 1) {
        try {
          const produced = await run(this.ctx, config, { ...input, messages }, agent, signal, claims);
          failureStreaks.delete(sessionId);
          // 形态合格的摘要原样返回。**只有散文那一支才改写**：`tool-call-markup`
          // 与 `too-short` 在 `runSummarizationCall` 里就抛了，走上面的重试与下面的
          // 机械兜底，这里根本看不到它们——那是用户明确要求不要动的两支。
          return await this.rewriteProseLayout(produced, input, agent, signal);
        } catch (error) {
          const message = String(error?.message ?? error);
          const retryable = message.includes('tool-call-markup') || message.includes('too-short');
          if (attempt < 1 && retryable) {
            this.ctx.logger?.warn?.(`[context-zip] retrying summarization once after: ${message}`);
            continue;
          }
          // 一次压缩尝试到此失败。计数按**尝试**记，不按模型调用记：一次尝试内部已经
          // 重试过一次，所以 N=5 表示前 5 次尝试用模型、第 6 次才走机械摘要。
          const failed = (failureStreaks.get(sessionId) ?? 0) + 1;
          failureStreaks.set(sessionId, failed);
          const reader = this.deps.readFallback ?? this.fallbackReader ?? sharedFallbackReader;
          let enabled = false;
          let after = 5;
          try {
            const value = typeof reader === 'function' ? await reader(agent?.session) : null;
            if (value && typeof value === 'object') {
              enabled = value.enabled === true;
              // 范围 0 到 10，越界就夹住。0 表示第一次失败就兜底。
              const raw = Number(value.after);
              after = Number.isFinite(raw) ? Math.min(10, Math.max(0, Math.trunc(raw))) : 5;
            }
          } catch {
            // 读不到设置就按保守档：不兜底，照常报错。
          }
          if (enabled && failed > after) {
            this.ctx.logger?.warn?.(
              `[context-zip] summarization failed ${failed} times; falling back to a mechanical summary for this session`,
            );
            return { summary: [{ type: 'text', text: buildMechanicalSummary(messages) }] };
          }
          throw error;
        }
      }
    }

    /**
     * 散文摘要的**只改格式**改写，由 B10 集合差护栏把关。
     *
     * **触发面**：只处理 `classifySummary` 判成 `unrecognised-sections` 的摘要，
     * 也就是用户 2026.09.18 拍板接受的散文形态。形态已合格的摘要一次模型调用都不发。
     *
     * **三条失败路径都退回原散文**，一次都不让压缩失败：
     * 1. 改写调用失败（provider 错误、超时、取消、空输出）；
     * 2. 拿不到模型的思考档位元数据（`resolveModelInfo` 抛错）——此时「锁最低档」
     *    这条用户硬约束无法执行，宁可不改；
     * 3. B10 护栏判出改写**新增**了编造 token。
     *
     * 另外若改写完仍然不是合格形态，也退回原文：这次改写的全部意义就是修形态，
     * 没修好就没有理由动它。
     *
     * @param produced - `runSummarizationCall` 的结果。
     * @param input - 本次压缩的输入（`messages` 是被替换掉的原文）。
     * @param agent - 被压缩的 agent。
     * @param signal - 取消信号，透传给改写调用。
     * @returns 采纳改写后的结果，或原样返回 `produced`。
     */
    async rewriteProseLayout(produced, input, agent, signal) {
      const originalText = (produced?.summary ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (originalText.trim().length === 0) return produced;
      if (classifySummary(originalText).reason !== 'unrecognised-sections') return produced;
      const reader = this.deps.readRewrite ?? this.rewriteReader ?? sharedRewriteReader;
      let value = null;
      try {
        value = typeof reader === 'function' ? await reader(agent?.session) : null;
      } catch (error) {
        this.ctx.logger?.warn?.(`[context-zip] reading the rewrite setting failed: ${String(error)}`);
        return produced;
      }
      const resolved = resolveRewriteRoute(value);
      if (resolved.route === undefined) {
        this.ctx.logger?.debug?.(`[context-zip] layout-only rewrite skipped: ${resolved.reason}`);
        return produced;
      }
      const route = resolved.route;
      // 护栏的原文用**被替换掉的那段文本**，不含摘要指令与工作笔记：那两样不是被压缩
      // 的对象。改写之后那条 B10（结果里带走的 `unsupportedClaims`）用同一份 haystack。
      // 与摘要那一路同一个投影：两处问的是同一个问题，原文口径必须一致，否则同一份摘要
      // 会因为「有没有走改写」而被报出两套结果。
      const sourceText = (input?.messages ?? []).map(messageVisibleText).join('\n');
      // 告警清单仍走 B10 那套判据：归一化开着，判据 1 按 `deps` 接不接。
      const claims = this.claimOptions();
      const config = {
        ...this.config,
        maxTokens: this.declaredConfig.maxTokens ?? SUMMARY_HARD_CAP_TOKENS,
      };
      let reasoningEffort;
      try {
        const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal);
        reasoningEffort = lowestReasoningEffort(info?.reasoning);
        // 档位锁不住就不改：见方法注释第 2 条。
        if (info?.reasoning !== undefined && reasoningEffort === undefined) {
          this.ctx.logger?.warn?.(
            `[context-zip] layout-only rewrite skipped: ${route.provider}/${route.model} advertises reasoning levels but none could be selected`,
          );
          return produced;
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[context-zip] layout-only rewrite skipped, its model could not be resolved: ${String(error?.message ?? error)}`,
        );
        return produced;
      }
      let rewritten;
      try {
        rewritten = await runRewriteCall(
          this.ctx,
          config,
          originalText,
          { ...route, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
          agent?.session?.id,
          signal,
        );
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[context-zip] the layout-only rewrite failed, keeping the original summary: ${String(error?.message ?? error)}`,
        );
        return produced;
      }
      if (classifySummary(rewritten).reason !== 'sections') {
        this.ctx.logger?.warn?.(
          '[context-zip] the layout-only rewrite did not produce the five-section shape, keeping the original summary',
        );
        return produced;
      }
      // 丁：改写护栏。判据 1 的清单优先用 `deps.fileExists`，没配时从这次压缩的原文
      // 事件里抽（工具回执 + 会话正文）；取不到清单就退到「不拦」。
      const fileList = this.rewriteFileList(input?.messages);
      const introduced = introducedPaths(rewritten, originalText);
      const blocked = rewriteGuardBlocks(rewritten, originalText, fileList.oracle);
      if (blocked.length > 0) {
        this.ctx.logger?.warn?.(
          `[context-zip] the layout-only rewrite introduced ${blocked.length} path token(s) 判据 1 cannot vouch for, keeping the original summary: ${blocked.join(', ')}`,
        );
        return produced;
      }
      if (introduced.length > 0) {
        // 放行的那一档要留痕：这里能看出判据 1 接没接、清单从哪来、放行了什么。
        this.ctx.logger?.debug?.(
          `[context-zip] the layout-only rewrite introduced ${introduced.length} new path token(s), all released by 判据 1 (list: ${fileList.source}, ${fileList.paths.length} entries): ${introduced.join(', ')}`,
        );
        if (fileList.oracle === null) {
          this.ctx.logger?.warn?.(
            `[context-zip] the layout-only rewrite introduced ${introduced.length} new path token(s) and this compaction has no file list to check them against, keeping the rewrite (判据 1 not wired): ${introduced.join(', ')}`,
          );
        }
      }
      // 结果里带走的告警清单仍是 B10 那套判据的输出，本次不改它的口径。
      const after = findUnsupportedClaims(rewritten, sourceText, claims);
      this.ctx.logger?.info?.(
        `[context-zip] layout-only rewrite adopted (${route.provider}/${route.model}${reasoningEffort === undefined ? '' : `, reasoningEffort=${reasoningEffort}`})`,
      );
      return {
        ...produced,
        summary: [{ type: 'text', text: rewritten }],
        unsupportedClaims: after,
        sectionSources: attributeSummarySections(rewritten, input?.messages ?? []),
        layoutRewrite: {
          provider: route.provider,
          model: route.model,
          reasoningEffort: reasoningEffort ?? null,
        },
      };
    }

    /**
     * Read the live notes draft for the agent's session.
     *
     * A missing or unreadable draft degrades to "no notes", which reproduces the
     * plain summarizing behavior instead of failing the compaction.
     *
     * @param agent - agent whose session owns the draft.
     * @returns the draft text, or ''.
     */
    async readNotes(agent) {
      const reader = this.deps.readNotes ?? this.notesReader ?? sharedNotesReader;
      if (typeof reader !== 'function') return '';
      try {
        return (await reader(agent.session.id)) ?? '';
      } catch (error) {
        this.ctx.logger?.warn?.(`[context-zip] reading working notes failed: ${String(error)}`);
        return '';
      }
    }
  };
}

export default createContextZipEngine;

