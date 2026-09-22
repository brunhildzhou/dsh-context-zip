#!/usr/bin/env node
/**
 * Runtime checks for the logic that does not need a live harness.
 *
 * The plugin cannot be usefully unit-tested end to end without a composed
 * profile, but the parts that decide what the model reads — segment numbering,
 * transcript projection, and the durable notes-mode record — are pure functions
 * over a session log, and those are checked here against a synthetic log built
 * with the real event payloads the harness writes.
 *
 * The subject under test is the BUILT plugin, not the TypeScript sources: the
 * build is what a profile loads, so a bundling mistake has to fail these checks.
 *
 * Usage: node test/run.mjs
 *
 * @module dsh-context-zip/test
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Import the subject under test from `--installed <plugin dir>` when given, and
 * from this repository's own build output otherwise.
 *
 * The bundle keeps `@deepseek-ai/*` external on purpose, so it only links where
 * a profile's node_modules can answer those specifiers. The repository has no
 * copy of the harness, so the installed tree is the real subject.
 */
function subjectDirectory() {
  const index = process.argv.indexOf('--installed');
  if (index === -1) return join(here, 'build', 'lib', 'segments.js');
  const target = process.argv[index + 1];
  if (target === undefined || target.startsWith('--')) throw new Error('--installed needs a plugin directory');
  return join(resolve(target), 'test', 'build', 'lib', 'segments.js');
}

/**
 * The installed plugin directory when `--installed` named one, else null.
 *
 * The upstream guard needs the PROFILE, not the plugin: the shipped backend sits
 * beside the plugin under the same `node_modules`, and that is the copy the
 * running harness actually loads. Without `--installed` there is no profile to
 * compare against, and the guard says so instead of passing quietly.
 *
 * @returns absolute plugin directory, or null.
 */
function installedPluginDirectory() {
  const index = process.argv.indexOf('--installed');
  if (index === -1) return null;
  const target = process.argv[index + 1];
  if (target === undefined || target.startsWith('--')) return null;
  return resolve(target);
}

/**
 * The delivered tree when `--deliverable <package dir>` named one, else null.
 *
 * The delivered tree is the copy of this repository that carries its own build
 * output and gets snapshotted, so it makes the same `exports[*].types` promise to
 * whoever installs it. It is named on the command line rather than derived from
 * this file's location: the pipeline that builds the tree knows where it put it,
 * and a test that guessed would either hard-code a workspace layout or quietly
 * skip the check when the guess missed.
 *
 * @returns absolute package directory, or null.
 */
function deliverableDirectory() {
  const index = process.argv.indexOf('--deliverable');
  if (index === -1) return null;
  const target = process.argv[index + 1];
  if (target === undefined || target.startsWith('--')) throw new Error('--deliverable needs a package directory');
  return resolve(target);
}

/** Load the built subject, turning a missing harness into an actionable message. */
async function loadSubject() {
  const entry = subjectDirectory();
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error(
      [
        `cannot load ${entry}: ${String(error.message).split('\n')[0]}`,
        '',
        'The build keeps `@deepseek-ai/*` external, so the checks only run where a',
        'profile can answer those specifiers. Point them at an installed copy:',
        '',
        '  node install.mjs --profile-dir <profile directory>',
        '  node test/run.mjs --installed <profile directory>/node_modules/dsh-context-zip',
        '',
        'Running against this repository alone would need `npm install`, which pulls a',
        'second copy of the harness from the registry; see the README.',
      ].join('\n'),
    );
  }
}

const {
  deriveSegments,
  deriveTurnStart,
  classifySummary,
  findUnsupportedClaims,
  auditUnsupportedClaims,
  fileOracleFromList,
  fileListFromMessages,
  messageVisibleText,
  packageMessageVisibleText,
  sameFileSpelling,
  introducedPaths,
  rewriteGuardBlocks,
  attributeSummarySections,
  SUMMARY_HEADINGS,
  effectiveMode,
  resolveModeFrom,
  sessionTitlesFor,
  createTitleMemo,
  TITLE_TTL_MS,
  SESSION_KEY,
  isSessionKey,
  readSessionEvents,
  createContextZipEngine,
  exportFileName,
  ownHistoryStart,
  searchNoteLines,
  historySearchTool,
  historyReadTool,
  setThrottleEnabled,
  setThrottleListener,
  setTracePath,
  TOOL_RESULT_STORE_CEILING_CHARS,
  TOOL_RESULT_STORE_CEILING_BYTES,
  historyFindTool,
  eventBody,
  locateAround,
  resolveRetrievalFrom,
  registerExportCommand,
  renderSegmentMarkdown,
  sortBySeq,
  renderEvent,
  renderTranscript,
  NOTES_MAX_CHARS,
  applySettingsPatch,
  registerRoutes,
  LIVE_POLL_MS,
  LIVE_DEDUPE_MS,
  MODE_DEDUPE_MS,
  MODE_RETRY_SCHEDULE_MS,
  modeClickIntent,
  modeRetryDelay,
  startModeReadRetry,
  clockText,
  initialLiveHealth,
  liveHealthAfter,
  liveReadDue,
  mergeLivePayload,
  rowsAfterSave,
  startLivePoll,
  toRows,
  titlesFrom,
  NoteStore,
  trimToLimit,
  renderWindow,
  setSharedModeReader,
  setSharedFallbackReader,
  resetFailureStreaks,
  buildMechanicalSummary,
  segmentForSeq,
  SUMMARY_HARD_CAP_TOKENS,
  selectManualRange,
  planManualCompaction,
  failureCountText,
  isRangeTooSmallFailure,
  manualFailureText,
  registerManualCompactCommand,
  failureCount,
  ManualTargetError,
  setSharedRewriteReader,
  lowestReasoningEffort,
  addedClaims,
  resolveRewriteRoute,
  runRewriteCall,
  buildRewriteInstruction,
  buildSummarizationInstruction,
  latestContextWindow,
  pathTokensIn,
  PROBE_MAX_TOKENS,
  probeModel,
  readModelCatalog,
  requireRegisteredProvider,
  SETTINGS_NS,
  SAVE_FEEDBACK_MS,
  sameSettings,
  saveButtonEnabled,
  saveButtonFace,
  REDIRECT_PACKAGE,
  REDIRECT_MARKER,
  STAMP_FILE,
  basePackageDir,
  readWireStatus,
  resolveProfileDirectory,
  wireCompactionRow,
  wireStatusFrom,
  wireText,
  wireFace,
  stampText,
} = await loadSubject();

/** `existsSync` without pulling the whole namespace into the check file. */
function existsSyncSafe(target) {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Failures collected so one run reports every broken check. */
const failures = [];
let checks = 0;

/**
 * Compare one value with an expectation.
 *
 * @param {string} label - what is being checked.
 * @param {unknown} actual - produced value.
 * @param {unknown} expected - wanted value.
 */
function is(label, actual, expected) {
  checks += 1;
  // Arity is checked rather than trusted. A stray extra argument used to be ignored in
  // silence, which is how `ok(label, x.includes(y), false)` came to assert the OPPOSITE
  // of what it read as. Three such calls were written before this guard existed.
  if (arguments.length !== 3) failures.push(`${label} (is() takes exactly 3 arguments, got ${arguments.length})`);
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left === right) return;
  failures.push(`${label}\n     expected ${right}\n     actual   ${left}`);
}

/**
 * Assert a predicate with a message.
 *
 * @param {string} label - what is being checked.
 * @param {boolean} condition - the assertion.
 */
function ok(label, condition) {
  checks += 1;
  if (arguments.length !== 2) failures.push(`${label} (ok() takes exactly 2 arguments, got ${arguments.length})`);
  if (!condition) failures.push(`${label} (predicate was false)`);
}

/**
 * Let every queued microtask drain.
 *
 * Counting bare `await Promise.resolve()` calls is how these checks get flaky: a
 * background refresh passes through several awaits (the route's reader, the
 * reader's own promise, the memo's fold), and one more layer of `async` added
 * later silently turns a passing "the memo filled in" check into a passing "the
 * fold has not finished yet" one. A macrotask turn runs after the whole microtask
 * queue, however deep the chain is.
 *
 * @returns a promise that settles after the drain.
 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A minimal session whose append matches the harness envelope, ignoring nothing.
 *
 * The log is reachable only through `snapshotEvents()`, the same as a real
 * `Session`: a mock carrying a public `events` array would let a call site that
 * reads `session.events` pass here and throw against the harness.
 */
function makeSession(header) {
  const events = [];
  return {
    id: header.id,
    header,
    firstLiveSeq: 0,
    snapshotEvents() {
      return events;
    },
    append(type, data, options = {}) {
      const event = { type, seq: events.length, time: 1_700_000_000_000 + events.length, data };
      if (options.ignorable === true) event.ignorable = true;
      if (options.sourceEventSeqs !== undefined) event.sourceEventSeqs = options.sourceEventSeqs;
      events.push(event);
      return event;
    },
  };
}

/** One compaction/summary payload in the shape the shipped backend writes it. */
function summaryEvent(compactionId, start, end, shadowedSeqs, text) {
  return [
    'compaction/summary',
    {
      compactionId,
      summary: [{ type: 'text', text }],
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount: 1234,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxTokens: 6144,
    },
  ];
}

/**
 * Every `exports[*].types` pointer has to land on a file that exists.
 *
 * Those pointers are the package's public promise to an editor and to any other
 * TypeScript plugin that imports it, and `package.json` is the only place they
 * are written down. The build emits the files they name, so the two halves can
 * drift: someone edits a pointer and never rebuilds, a source file is renamed
 * and the emit step stops producing the entry, or the emit step is dropped from
 * `build.mjs` altogether. A pointer at a missing path is worse than no pointer
 * at all — the consumer falls through to the JavaScript and every type in the
 * package disappears without a word — so the check is a hard one.
 *
 * The list of pointers is READ from the manifest rather than written here, so an
 * export entry added tomorrow is covered the day it is added.
 *
 * It is called twice: once on this repository and, when `--deliverable` names one,
 * once on the delivered tree. The delivered tree needs its own call because it is
 * where the two halves actually drifted — its build removes `lib/types` and has no
 * `typescript` to put it back, so the delivery shipped a manifest promising
 * `./lib/types/index.d.ts` with no such file, and nothing looked.
 *
 * @param {string} pluginRoot - the package directory holding `package.json`.
 * @param {string} [label] - prefix for the check labels, so a failure names which
 *   tree it came from. Defaults to `exports`, which keeps this repository's labels
 *   as they were.
 */
async function checkDeclaredTypes(pluginRoot, label = 'exports') {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
  } catch (error) {
    ok(`${label}: ${pluginRoot}/package.json is readable`, false);
    failures.push(`  (reading it threw: ${error.message})`);
    return;
  }

  const declared = [];
  for (const [entry, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value !== 'object' || value === null) continue;
    if (typeof value.types === 'string') declared.push([entry, value.types]);
  }
  // A manifest whose `types` pointers were all deleted would otherwise pass this
  // check by having nothing to check, which is the one way the guard could go
  // quiet while looking green.
  ok(`${label}: at least one entry declares a types pointer`, declared.length > 0);

  for (const [entry, pointer] of declared) {
    let present = false;
    try {
      present = statSync(resolve(pluginRoot, pointer)).isFile();
    } catch {
      present = false;
    }
    ok(`${label}["${entry}"].types exists (${pointer})`, present);
  }
}

const root = await mkdtemp(join(tmpdir(), 'context-zip-test-'));
try {
  // A forked child: the first two events belong to the parent and must not be
  // numbered, and the seed end marker is a seq of its own.
  const child = makeSession({ id: 'session-child', isSeeded: true, seedLength: 2 });
  child.append('user/message', { content: [{ type: 'text', text: 'parent turn' }] });
  child.append(...summaryEvent('compaction-parent', 0, 1, [0], 'parent summary'));
  child.append('session/end-seed', {});
  for (let index = 0; index < 30; index += 1) {
    child.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: `padding ${index} `.repeat(8) } });
  }
  // An assistant turn and a tool result, in the shapes the harness actually
  // writes: both wrap their message, unlike `user/message`.
  child.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: 'the assistant answer' }] },
  });
  child.append('tool/result', {
    message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'the tool output' }] }] },
  });
  const ownOne = summaryEvent('compaction-own-1', 2, 4, [1, 2, 3], 'first own summary');
  child.append(...ownOne);
  child.append(...summaryEvent('compaction-own-2', 5, 6, [4, 5], 'second own summary'));

  const segments = deriveSegments(child, child.snapshotEvents());
  is('a seeded session numbers only its own compactions', segments.length, 2);
  is('the first own compaction is segment 0', segments[0]?.ordinal, 0);
  is('the second own compaction is segment 1', segments[1]?.ordinal, 1);
  is('segment 1 keeps its own compaction id', segments[0]?.compactionId, 'compaction-own-1');
  is('segment 1 lists its shadowed seqs', segments[0]?.shadowedSeqs, [1, 2, 3]);
  is(
    'segment 1 labels itself from its summary text',
    segments[0]?.label,
    'first own summary',
  );
  is('the shadowed token count is carried through', segments[0]?.tokenCount, 1234);
  is('a segment id joins the session id with its ordinal', segments[0]?.id, 'session-child#0');
  const ownOneSeq = child.snapshotEvents().find((event) => event.type === 'compaction/summary' && event.data.compactionId === 'compaction-own-1')?.seq;
  is('the summary seq is recorded', segments[0]?.summarySeq, ownOneSeq);
  is('the surface span is recorded', segments[0]?.shadowedRange, { start: 2, end: 4 });
  ok('the parent prefix is excluded', segments.every((s) => s.compactionId !== 'compaction-parent'));

  is('an unseeded session numbers from zero', deriveSegments(makeSession({ id: 'x' }), []).length, 0);
  is('seq lookup finds the owning segment', segmentForSeq(segments, ownOneSeq)?.ordinal, 0);
  is('seq lookup finds the later segment', segmentForSeq(segments, ownOneSeq + 1)?.ordinal, 1);
  is('seq lookup outside every segment is null', segmentForSeq(segments, 0), null);

  // One turn of each payload kind, which is what a read of a segment returns.
  const shadowed = child.snapshotEvents().filter(
    (event) => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result',
  );
  const transcript = renderTranscript(shadowed, 10_000);
  ok('the transcript renders the shadowed user turn', transcript.text.includes('parent turn'));
  ok('the transcript renders the wrapped assistant turn', transcript.text.includes('the assistant answer'));
  ok('the transcript renders the wrapped tool result', transcript.text.includes('the tool output'));
  ok('no payload kind renders as an empty marker', !transcript.text.includes('(no text)') && !transcript.text.includes('(empty)'));
  is('a transcript inside its budget is not marked truncated', transcript.truncated, false);
  // The budget floor is 1000 characters, so the probe has to exceed that.
  const clipped = renderTranscript(child.snapshotEvents(), 1000);
  ok('a transcript over budget says so', clipped.truncated === true && clipped.text.includes('truncated'));
  const window = renderWindow(child.snapshotEvents(), 'session session-child', 10_000);
  ok('a whole-log window renders something', window.length > 0);
  ok('a whole-log window names its span', window.includes('events 0..'));
  const emptyWindow = renderWindow([], 'session session-child', 10_000);
  ok('an empty window says so instead of rendering nothing', emptyWindow.includes('no readable content'));

  // An entry larger than the whole budget must still show its opening. Breaking
  // out of the budget loop with nothing collected made the caller report "no
  // readable content in this window" about an event that plainly has content —
  // and because maxChars is capped, such an event could never be read back at all.
  const oversized = makeSession({ id: 'session-oversized' });
  oversized.append('user/message', { content: [{ type: 'text', text: 'oversized '.repeat(4000) }] });
  const oversizedEvents = oversized.snapshotEvents();
  const oversizedText = renderTranscript(oversizedEvents, 20000);
  // Not just 'the string is non-empty': the truncation notice alone would
  // satisfy that while the entry's own text was still missing entirely.
  ok('an over-budget first entry still yields its own text', oversizedText.text.includes('oversized'));
  ok('an over-budget first entry is marked truncated', oversizedText.truncated === true);
  ok('an over-budget first entry says it was clipped', oversizedText.text.includes('exceeds the character budget'));
  ok('an over-budget first entry is not called empty', !oversizedText.text.includes('no readable content'));
  const oversizedWindow = renderWindow(oversizedEvents, 'session session-oversized', 20000);
  ok('the window does not claim an over-budget entry is unreadable', !oversizedWindow.includes('no readable content'));
  // The panel ships two locales. A wording fix applied to one and not the other
  // is invisible to any check that only renders the default language, so compare
  // the two objects structurally and screen both for the claim that was wrong.
  {
    const source = await readFile(join(here, '..', 'client', 'index.ts'), 'utf8');
    const block = (name) => {
      const start = source.indexOf(`const ${name} = {`);
      if (start < 0) return '';
      return source.slice(start, source.indexOf('\n};', start));
    };
    const zh = block('ZH');
    const en = block('EN');
    ok('the Chinese strings are present', zh.length > 0);
    ok('the English strings are present', en.length > 0);
    const keys = (text) => [...text.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gmu)].map((match) => match[1]).sort();
    is('both locales define the same keys', keys(en).join(','), keys(zh).join(','));
    // 「压缩后端」那一行的键：中英各一套、名字相同，且旧四相那批键已经删掉，不留死键。
    // 结构性比较在上面那条已经管住了「两边一样多」；这里管的是这一行真的两套都在、
    // 旧的真的没了——只删中文或只删英文都会从这里露出来。
    const wireKeys = [
      'rowTitle',
      'help',
      'inactiveMain',
      'inactiveSub',
      'takeover',
      'takingMain',
      'takingSub',
      'activeMain',
      'activeSubPrefix',
      'versionUnknown',
      'updateMain',
      'updateTpl',
      'reconnect',
      'restartMain',
      'restartSub',
      'takenSub',
      'incompleteMain',
      'incompleteSub',
      'unknownMain',
      'unknownSub',
      'failMain',
      'retry',
    ];
    const zhKeys = keys(zh);
    const enKeys = keys(en);
    ok(
      'the compaction-backend row defines every key in both locales',
      wireKeys.every((key) => zhKeys.includes(key) && enKeys.includes(key)),
    );
    ok(
      'the old four-phase wiring keys are gone, not left dead',
      [
        'wireOff',
        'wireAction',
        'wireBusy',
        'wireOnDetail',
        'wireOnStale',
        'wireDone',
        'wireForeign',
        'wirePartial',
        'wireUnknown',
        'wireReadFailed',
        'wireWriteFailed',
      ].every((key) => zhKeys.includes(key) === false && enKeys.includes(key) === false),
    );
    is('both locales name the row', /rowTitle: '压缩后端',/u.test(zh) && /rowTitle: 'Compaction',/u.test(en), true);
    // The defect was a promise that the mode is frozen at session creation, which
    // the implementation contradicts: mode is resolved live before each compaction.
    const frozen = /frozen|read when a session is created|read once when|会话创建时读|之后不再变|存续期间不随/u;
    ok('no locale promises a frozen per-session mode', frozen.test(zh) === false && frozen.test(en) === false);
    is(
      'both locales say the mode is read live',
      /每次压缩前现读/u.test(zh) && /read fresh before each compaction/u.test(en),
      true,
    );
    // 开关的范围：只管自动压缩那一步，不管 `/zip-compact` 命令。用户
    // 2026.09.19 拍板保留这个差异（选项「乙」，见 待决策-S10与T25.md 第三条），
    // 代价就是两套语言都得把范围说清——只写一套，等于另一种语言的用户关掉开关后
    // 不知道命令还能用。
    //
    // 同一天稍后用户又要求撤掉设置面板里那个「手动压缩」按钮，面板上从此没有手动
    // 入口，所以范围句里不能再提按钮：留着它等于向用户描述一个不存在的控件。
    // 断言拆成两半——范围句只说自动那一步，且两套语言都不再出现按钮字样。
    ok(
      'both locales say the /zip-compact command is not gated by the switch',
      /\/zip-compact 命令不受它管/u.test(zh) && /\/zip-compact command is not gated by it/u.test(en),
    );
    ok(
      'both locales scope the switch to the automatic step only',
      /只管自动压缩那一步/u.test(zh) && /covers the automatic step;/u.test(en),
    );
    // 撤掉的是一整套 UI（按钮、确认框、状态机、占位图标、按钮文案、CSS），不只是
    // 那一行字。这条守着它别被加回来：手动压缩的入口只有 `/zip-compact` 命令。
    ok(
      'the panel no longer ships any manual-compaction button',
      /__manual|data-manual-entry|ICON_MANUAL_PLACEHOLDER|manualButton/u.test(source) === false,
    );

    // ── 总开关的语义：ON 是「本插件压、五段式、带笔记」，OFF 是「交回内置后端」──
    //
    // 这一段是 2026.09.19 D1 的补紧。原先这里只查「键集合相同、禁用词表没命中、
    // 关键短语在不在」，**不查 ON/OFF 两句话说的是不是那两件事**，于是英文那句
    // `Off: only the summary template changes; the other three capabilities stay
    // available.` 与中文、与 `ContextZipSettings.enabled` 的 description
    // （`Off delegates to the shipped backend`）**正好相反**，套件照样 817 全绿。
    // 对照实验：把那句改成同义的别的说法仍全绿，换成 `frozen` 措辞立刻红一条。
    //
    // 判据按「开关的两半各要说出哪件事」写，用词表而不是整句比对：整句比对只能
    // 证明「这行字没变」，证明不了「这行字对」。两半各自要求**正向**说出自己的
    // 机制，所以「删掉假话、改成一句谁也没说清的中性话」也会红——这正是要拦住的
    // 下一种写法。
    //
    // 定位不许用 `text.indexOf('On:')`：`on: '开'` 这个键名里也有 `On:`，先撞上
    // 的是它，取到的会是 `effective` 那一堆键而不是提示语。所以先从 `enabledHint:`
    // 这个键取**它自己的值**（单引号或反引号，由代码自己决定用哪种），再从那段
    // 提示语里切 ON/OFF 两半。
    const enabledHintOf = (text) => {
      const key = text.indexOf('enabledHint:');
      if (key < 0) return '';
      const quote = text.indexOf("'", key);
      const close = text.indexOf("',\n", quote);
      if (quote < 0 || close < 0) return '';
      // 只反转义这一种：改写后的英文句子里有 `\u2019`（右单引号），它按字面参与
      // 判据会看不出是个撇号。别的不做通用反转义，免得把判据写成一个半吊子解析器。
      return text.slice(quote + 1, close).replaceAll('\\u2019', '\u2019');
    };
    // 只取每个半句的**第一句**：两个半句后面还跟着一句「命令不受开关管」的范围
    // 说明，与 ON/OFF 各干什么无关。整段尾巴都算进 OFF 的话，范围说明里的
    // `this plugin compacts` 会把「OFF 不该说本插件压」这条判据自己撞红。句号找的
    // 是**标签之后**的第一个：`开：` / `Off:` 自己那一小段里没有句号，从标签之后
    // 起算才不会把整个半句误判成空串。
    const firstSentence = (text) => {
      const colon = text.indexOf('：') >= 0 ? text.indexOf('：') : text.indexOf(':');
      const end = text.slice(colon + 1).search(/[.。]/u);
      return end < 0 ? text : text.slice(0, colon + 1 + end + 1);
    };
    // 两种语言的标签写法不同：英文 `On:` / `Off:`，中文 `开：` / `关：`。按各自
    // 的标签切，不把中文提示语硬按英文标签找。
    const switchClauses = (hint) => {
      const match = /(?:On|开)\s*[:：]([\s\S]*?)(?:Off|关)\s*[:：]([\s\S]*)$/u.exec(hint);
      if (match === null) return null;
      return { on: firstSentence(match[1]), off: firstSentence(match[2]) };
    };
    const zhSwitch = switchClauses(enabledHintOf(zh));
    const enSwitch = switchClauses(enabledHintOf(en));
    ok('both locales state the switch as an On/Off pair', zhSwitch !== null && enSwitch !== null);

    // 用词表：同一种机制在两种语言里各有哪些说法。
    const MECHANISM = {
      pluginCompacts: {
        zh: /本插件压|本插件压缩|五段|交接稿/u,
        en: /plugin compacts|this plugin summarises|this plugin summarizes|five-section|handoff/u,
      },
      shippedBackend: { zh: /内置后端|内置的压缩后端/u, en: /shipped backend|built-in backend/u },
      notesMerged: { zh: /笔记/u, en: /notes/u },
    };
    const says = (locale, text, mechanism) => MECHANISM[mechanism][locale].test(text);

    for (const [name, locale, clauses] of [
      ['Chinese', 'zh', zhSwitch],
      ['English', 'en', enSwitch],
    ]) {
      ok(
        `${name} switch hint says ON compacts with this plugin's own template`,
        clauses !== null && says(locale, clauses.on, 'pluginCompacts'),
      );
      ok(
        `${name} switch hint says OFF hands the session to the shipped backend`,
        clauses !== null && says(locale, clauses.off, 'shippedBackend'),
      );
      // 反向的那半：ON 不该说「交回后端」，OFF 不该说「还是本插件压」。
      ok(
        `${name} switch hint does not put the shipped backend on the ON side`,
        clauses !== null && says(locale, clauses.on, 'shippedBackend') === false,
      );
      ok(
        `${name} switch hint does not keep this plugin compacting on the OFF side`,
        clauses !== null && says(locale, clauses.off, 'pluginCompacts') === false,
      );
      ok(
        `${name} switch hint names the notes in both halves`,
        clauses !== null && says(locale, clauses.on, 'notesMerged') && says(locale, clauses.off, 'notesMerged'),
      );
    }
  }

  // ── 模式芯片不再有悬停提示（用户 2026.09.19 的决定）────────────────────────
  //
  // 原来的 `label` 上挂着 `title: tip`，那句提示是一整段说明（英文更长），用户原话
  // 「悬停提示删掉，这个不太优雅」。删的只是悬停那一处：`aria-label` 保留（辅助
  // 技术靠它，不是靠悬停），勾选状态、`data-failed` / `data-stuck` / `data-failures`
  // 钩子与点击路径一个字都不许动，所以这里逐个把它们钉住。
  //
  // 判据走**真 bundle、真渲染**：加载 `lib/client.js`，用替身 React 与替身
  // `react/jsx-runtime` 递归展开函数组件，直到拿到那棵 `label` 元素，直接看它收到
  // 的 props。只读源码文本证明不了「渲染出来没有 title」，这条必须走组件。
  {
    const calls = [];
    const makeElement = (type, props, ...children) => {
      calls.push({ type, props: props ?? {} });
      return { type, props: props ?? {}, children };
    };
    const hooks = {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useLayoutEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useContext: () => 'zh',
      createContext: (value) => ({ _value: value, Provider: 'LocaleProvider', Consumer: 'LocaleConsumer' }),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      Fragment: 'Fragment',
    };
    const fakeReact = {
      ...hooks,
      createElement: makeElement,
      jsx: makeElement,
      jsxs: makeElement,
      jsxDEV: makeElement,
    };
    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const priorFetch = globalThis.fetch;
    let factory = null;
    globalThis.window = {
      __ModuleLoader__: {
        load(spec) {
          factory = spec.factory;
        },
      },
    };
    globalThis.document = { createElement: () => ({ id: '', textContent: '', append() {} }), head: { append() {} } };
    // 不真发请求：芯片挂载时会自己读一次模式，这里给一个永不落地的应答。
    globalThis.fetch = () => new Promise(() => {});
    try {
      await import(pathToFileURL(join(here, '..', 'lib', 'client.js')).href);
      is('mode chip: the client bundle registers itself with the loader', typeof factory, 'function');
      // 外部依赖只有 react 与 react/jsx-runtime：两个都给替身，别的一律报错，
      // 免得将来多出一个外部依赖时这条判据悄悄跳过。
      const client = factory((name) => {
        if (name === 'react' || name === 'react/jsx-runtime') return fakeReact;
        throw new Error(`the client bundle required an unexpected external: ${name}`);
      });
      const registrations = [];
      client.apply({
        locale: { register() {}, getLocale: () => ({ active: 'zh' }) },
        slots: {
          inject(name, fn) {
            fn();
          },
          register(spec, component) {
            registrations.push({ spec, component });
            return () => {};
          },
        },
      });
      const registered = registrations.find((one) => one.spec.id === 'context-zip-mode');
      is('mode chip: the composer chip is registered', registered !== undefined, true);

      // 递归把函数组件展开成最终的元素树；每展开一层就把 `React.createElement`
      // 收到的 props 记一笔，因此「最终那棵 label 收到了什么」是渲染结果，不是
      // 源码文本的复述。
      const expand = (element, depth = 0) => {
        if (element === null || element === undefined || typeof element !== 'object') return element;
        // 函数组件才展开。类组件（`Function.prototype.toString` 以 class 开头）不能
        // 当函数调，那会直接抛 TypeError；本模块没有类组件，但这条判据要经得起
        // 以后有人加一个。
        const isFunctionComponent = typeof element.type === 'function' && /^\s*class\b/u.test(String(element.type)) === false;
        if (isFunctionComponent && depth < 40) return expand(element.type(element.props ?? {}), depth + 1);
        const children = (element.children ?? []).map((child) => expand(child, depth + 1));
        return { type: element.type, props: element.props ?? {}, children };
      };
      calls.length = 0;
      const tree = expand(registered.component({ sessionId: 'session-chip' }));
      const label = calls.find((one) => one.type === 'label' && one.props.className === 'dsh-context-zip-mode');
      // 芯片是被 locale 包装层套着的，展开后未必是第一层，所以按元素类型找那棵
      // label，而不是假定 tree 本身就是它。
      const findLabel = (node) => {
        if (node === null || node === undefined || typeof node !== 'object') return null;
        if (node.type === 'label' && node.props?.className === 'dsh-context-zip-mode') return node;
        for (const child of node.children ?? []) {
          const found = findLabel(child);
          if (found !== null) return found;
        }
        return null;
      };
      const chipTree = findLabel(tree);
      is('mode chip: the component renders its label', label !== undefined, true);
      is('mode chip: the label carries no title prop (no hover tooltip)', label !== undefined && 'title' in label.props, false);
      is('mode chip: the rendered chip is a label element', chipTree?.type, 'label');
      is(
        'mode chip: the label keeps its aria-label',
        typeof chipTree?.props?.['aria-label'] === 'string' && chipTree.props['aria-label'].length > 0,
        true,
      );
      is('mode chip: the label keeps its click handler', typeof chipTree?.props?.onClick, 'function');
      is('mode chip: the label keeps its failed hook', chipTree?.props?.['data-failed'], undefined);
      is('mode chip: the checkbox is still inside the label', (chipTree?.children ?? []).some((child) => child?.type === 'input'), true);
      const checkbox = (chipTree?.children ?? []).find((child) => child?.type === 'input');
      is('mode chip: the checkbox keeps its change handler', typeof checkbox?.props?.onChange, 'function');
      // 源码里也不许再把 title 挂回这个 label 上：渲染检查盯的是「这一次渲染」，
      // 源码检查盯的是「这一行有没有被改回来」。
      const clientSource = await readFile(join(here, '..', 'client', 'index.ts'), 'utf8');
      const chipSource = clientSource.slice(clientSource.indexOf("className: 'dsh-context-zip-mode'"));
      is(
        'mode chip: the source does not put title back on the chip',
        /^\s*className: 'dsh-context-zip-mode',\n\s*'aria-label':/u.test(chipSource),
        true,
      );
      is('mode chip: the source no longer names a tip for the chip', /title: tip/u.test(clientSource), false);
      // ── 2026.09.19 用户报「切 session 时图标也会播一个展开动画」的两次修 ────────
      //
      // 根因：过渡原先挂在基础规则上，`checked` 一变就播；而切会话会重挂载这个
      // 组件，`mode` 从 `undefined`（＝正在读取）开始，而「正在读取」渲染出来就是
      // 未勾选的样子，于是开→开也完整播一遍开启动画。
      //
      // 第一次修错了方向：把过渡整个关掉，结果是「从左到右直接闪一下」，比动画更
      // 刺眼（用户当场退回）。**正确做法是消掉那一帧，而不是消掉动画**：记住每个
      // 会话上次读到的模式，重挂载时首帧就按记得的值画，于是「开→开」根本没有变化
      // 可播，而「关→开」「开→关」照旧播与普通开关一致的过渡。
      //
      // 下面五条钉住的就是这套：过渡必须留在基础规则里（回滚的守卫）、缓存表要
      // 存在、初值要读它、读成功与点击都要写它。
      const baseHasTransition = (name) =>
        new RegExp(`^\\.dsh-context-zip-mode__${name}\\{[^}]*transition`, 'mu').test(clientSource);
      is(
        'mode chip: the base rules keep their transitions',
        baseHasTransition('track') === true && baseHasTransition('knob') === true && baseHasTransition('ic') === true,
        true,
      );
      is(
        'mode chip: nothing gates the transitions behind a click-only flag',
        /data-animate|setAnimate/u.test(clientSource) === false,
        true,
      );
      // ── 入场那条路：外观归 `data-look`，过渡留在基础规则上 ─────────────────────
      //
      // 切会话会把这颗芯片整颗卸载重挂，新元素没有上一帧可插值，所以光把过渡留在
      // 基础规则里还不够：外观必须由一个**属性**决定，新芯片才能先按上一颗的样子
      // 画、等自己有了答案再改这个属性。原来外观挂在 `input:checked + …` 上，那样
      // 只能「先画未勾选、再改成勾选」，重挂载必然硬切。下面三条把这条入场路径钉
      // 住：渲染出来的属性、样式表里由它驱动的三条规则、以及过渡仍在基础规则上跑
      // 面板令牌。谁把规则改回 `:checked`（或漏掉三条里的一条、把过渡挪到
      // `[data-look=…]` 那一侧），这里就必须红。
      const baseTransitionBody = (name) => {
        const match = new RegExp(`^\\.dsh-context-zip-mode__${name}\\{([^}]*)\\}`, 'mu').exec(clientSource);
        return match === null ? null : match[1];
      };
      const lookRuleBody = (name) => {
        const match = new RegExp(
          `^\\.dsh-context-zip-mode\\[data-look="on"\\] \\.dsh-context-zip-mode__${name}[^{]*\\{([^}]*)\\}`,
          'mu',
        ).exec(clientSource);
        return match === null ? null : match[1];
      };
      const trackLook = lookRuleBody('track');
      const knobLook = lookRuleBody('knob');
      const icLook = lookRuleBody('ic');
      is(
        'mode chip: the label paints itself from a look attribute',
        (chipTree?.props?.['data-look'] === 'on' || chipTree?.props?.['data-look'] === 'off') &&
          /'data-look': look \? 'on' : 'off',/u.test(clientSource),
        true,
      );
      is(
        'mode chip: all three appearance rules hang off that attribute',
        trackLook !== null &&
          /\bbackground\b/u.test(trackLook) &&
          knobLook !== null &&
          /\b(transform|background)\b/u.test(knobLook) &&
          icLook !== null &&
          /\bopacity\b/u.test(icLook),
        true,
      );
      is(
        'mode chip: the base transitions still run on the panel duration tokens',
        baseTransitionBody('track') !== null &&
          /transition:[^;}]*var\(--cz-dur\)[^;}]*var\(--cz-ease\)/u.test(baseTransitionBody('track')) &&
          baseTransitionBody('knob') !== null &&
          /transition:[^;}]*var\(--cz-dur\)[^;}]*var\(--cz-ease\)/u.test(baseTransitionBody('knob')) &&
          baseTransitionBody('ic') !== null &&
          /transition:[^;}]*var\(--cz-dur\)[^;}]*var\(--cz-ease\)/u.test(baseTransitionBody('ic')) &&
          // 反向：过渡不许搬到 `[data-look=…]` 那一侧——那样改属性的一刻反而不播。
          /^\.dsh-context-zip-mode\[data-look[^{]*\{[^}]*transition/u.test(clientSource) === false,
        true,
      );
      is(
        'mode chip: the per-session memory is a localStorage key',
        /const MODE_MEMORY_KEY = 'dsh-context-zip:modes';/u.test(clientSource) &&
          /window\.localStorage\.getItem\(MODE_MEMORY_KEY\)/u.test(clientSource) &&
          /window\.localStorage\.setItem\(MODE_MEMORY_KEY, JSON\.stringify\(table\)\)/u.test(clientSource),
        true,
      );
      is(
        'mode chip: the first frame seeds itself from that memory',
        /const \[mode, setMode\] = React\.useState\(\(\) => rememberedMode\(sessionId\)\);/u.test(clientSource),
        true,
      );
      is(
        'mode chip: a landed read and a click both write the memory',
        /writeModeMemory\(sessionId, data\.mode\);/u.test(clientSource) &&
          /writeModeMemory\(sessionId, optimistic\);/u.test(clientSource),
        true,
      );
      // 首次读失败仍按「正在读取」渲染：切到进程还没接管的会话会先答一次
      // `session-not-found`，400ms 后重试成功。旧判据 `failed = mode === null`
      // 让那一瞬闪一次暖色（用户描述为「快速切换时的一瞬间红色」）。
      is(
        'mode chip: one failed read still reads as loading',
        /const failed = mode === null && failures >= 2;/u.test(clientSource) &&
          /const loading = mode === void 0 \|\| \(mode === null && failures < 2\);/u.test(clientSource),
        true,
      );
    } finally {
      globalThis.window = priorWindow;
      globalThis.document = priorDocument;
      globalThis.fetch = priorFetch;
    }
  }

  // ── 显示名：左侧导航那一项与面板大标题，两种语言都是 `ContextZip` ─────────────
  //
  // 用户 2026.09.19 的决定：左侧名目栏无法一眼分辨「是这个插件呀」，所以把
  // **显示名**改成 `ContextZip`。同一批名字里还有三档用户明确不动——命令名
  // （`/zip-compact` / `/zip-export`）、`settings.yaml` 里的 `context-zip:` 段名、
  // 包名（`dsh-context-zip` / `dsh-context-zip-engine`）——面板里的说明长文与
  // schema 的 `description` 也不动。所以这段要同时钉住**改了什么**和**没改什么**：
  //
  // - 改了：`settings.section` 的 `label()`（左侧导航那一项）与面板渲染出来的
  //   `.dsh-context-zip__title`（大标题），两种语言都必须是 `ContextZip`。
  // - 没改：`settings.section` 的 `id` 仍是 `context-zip`（设置面板的段键，也是
  //   `only` 过滤用的 key），宿主侧设置段名仍是 `src/index.ts` 的
  //   `SETTINGS_NS = 'context-zip'`。后一条最要紧：段名一改，用户 `settings.yaml`
  //   里那一段（总开关、三条 session 覆盖、兜底与改写那几项）会整段失联，
  //   而界面照常显示、不报任何错——这正好是「改了没人知道」的那类回归。
  //
  // 判据走**真 bundle、真渲染**，替身与上面芯片那段同一套：`label()` 就是界面真正
  // 调用的那个函数，标题文本从渲染树上读。只搜源码文本证明不了是哪一处，因为同一个
  // 文件里还有 `intro`、`modeOn`、`manualTitle` 等好几段中文。
  {
    const makeElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
    // 两种语言各渲染一遍：只渲染默认语言的话，「只改中文、漏改英文」这类半拉子
    // 改动看不出来（D1 那次就是英文说反话而套件全绿）。
    let activeLocale = 'zh';
    const hooks = {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useLayoutEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useContext: () => activeLocale,
      createContext: (value) => ({ _value: value, Provider: 'LocaleProvider', Consumer: 'LocaleConsumer' }),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      Fragment: 'Fragment',
    };
    const fakeReact = {
      ...hooks,
      createElement: makeElement,
      jsx: makeElement,
      jsxs: makeElement,
      jsxDEV: makeElement,
    };
    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const priorFetch = globalThis.fetch;
    let factory = null;
    globalThis.window = {
      __ModuleLoader__: {
        load(spec) {
          factory = spec.factory;
        },
      },
    };
    globalThis.document = { createElement: () => ({ id: '', textContent: '', append() {} }), head: { append() {} } };
    // 面板挂载时会自己读一次设置与实时行，这里给一个永不落地的应答，别真发请求。
    globalThis.fetch = () => new Promise(() => {});
    try {
      // 查询串只是缓存破坏：上面芯片那段已经 import 过同一个 URL，Node 会直接给
      // 缓存模块、不再触发 `__ModuleLoader__.load`，`factory` 就还是 null。
      await import(`${pathToFileURL(join(here, '..', 'lib', 'client.js')).href}?display-name`);
      const client = factory((name) => {
        if (name === 'react' || name === 'react/jsx-runtime') return fakeReact;
        throw new Error(`the client bundle required an unexpected external: ${name}`);
      });
      const registrations = [];
      client.apply({
        locale: { register() {}, getLocale: () => ({ active: activeLocale }) },
        slots: {
          inject(name, fn) {
            fn();
          },
          register(spec, component) {
            registrations.push({ spec, component });
            return () => {};
          },
        },
      });
      const section = registrations.find((one) => one.spec.id === 'context-zip');
      is('display name: the settings section is registered', section !== undefined, true);
      // 显示名与「做 key 的那一个」必须是两个字段：`id` 是设置面板的段键，显示名换
      // 了它一个字符都不该动。
      is('display name: the section key is an identifier, not the display name', section?.spec.id, 'context-zip');
      is('display name: the host settings namespace is untouched', SETTINGS_NS, 'context-zip');
      // 递归展开函数组件，与芯片那段同一个理由：注册出来的是被 locale 包装层套着的
      // 组件，标题不一定在第一层。
      const expand = (element, depth = 0) => {
        if (element === null || element === undefined || typeof element !== 'object') return element;
        const isFunctionComponent = typeof element.type === 'function' && /^\s*class\b/u.test(String(element.type)) === false;
        if (isFunctionComponent && depth < 40) return expand(element.type(element.props ?? {}), depth + 1);
        const children = (element.children ?? []).map((child) => expand(child, depth + 1));
        return { type: element.type, props: element.props ?? {}, children };
      };
      const findTitle = (node) => {
        if (node === null || node === undefined || typeof node !== 'object') return null;
        if (node.type === 'span' && node.props?.className === 'dsh-context-zip__title') return node;
        for (const child of node.children ?? []) {
          const found = findTitle(child);
          if (found !== null) return found;
        }
        return null;
      };
      for (const locale of ['zh', 'en']) {
        activeLocale = locale;
        is(`display name: the ${locale} nav label is exactly ContextZip`, section?.spec.label(), 'ContextZip');
        const tree = expand(section.component({ close: () => {}, ctx: {} }));
        const title = findTitle(tree);
        is(
          `display name: the ${locale} panel title renders exactly ContextZip`,
          (title?.children ?? []).join(''),
          'ContextZip',
        );
        // 保存按钮与标题同一行，而且是那一行的最后一个孩子（同一行最右）。这一段
        // 走真渲染树，所以「按钮被挪到别处」或「标题行里塞进第三个东西」都会红。
        const findTitleRow = (node) => {
          if (node === null || node === undefined || typeof node !== 'object') return null;
          if ((node.children ?? []).some((child) => child?.props?.className === 'dsh-context-zip__title')) return node;
          for (const child of node.children ?? []) {
            const found = findTitleRow(child);
            if (found !== null) return found;
          }
          return null;
        };
        const titleRowChildren = findTitleRow(tree)?.children ?? [];
        is(
          `display name: the ${locale} save button is the last thing in the title row`,
          titleRowChildren.at(-1)?.props?.className,
          'dsh-context-zip__save',
        );
        is(
          `display name: the ${locale} title row holds exactly the title and the save button`,
          titleRowChildren.length,
          2,
        );
        is(
          `display name: the ${locale} save button is dead until settings load`,
          titleRowChildren.at(-1)?.props?.disabled,
          true,
        );
      }
    } finally {
      globalThis.window = priorWindow;
      globalThis.document = priorDocument;
      globalThis.fetch = priorFetch;
    }
  }

  // A patch's `agents` map must REPLACE the stored one. Under the merge the
  // provider applies to a nested object, a key left out kept its old value, so
  // deleting the last row was impossible and 删除 silently did nothing.
  {
    const installed = { enabled: true, agents: { 'session-a': true, 'session-b': false } };
    const kept = applySettingsPatch(installed, { agents: { 'session-a': true } });
    is('a patch that keeps one key drops the other', JSON.stringify(kept.agents), '{"session-a":true}');
    const cleared = applySettingsPatch(installed, { agents: {} });
    is('an empty map clears the table', JSON.stringify(cleared.agents), '{}');
    is('clearing the table keeps the switch it was not asked about', cleared.enabled, true);
    const flipped = applySettingsPatch(installed, { enabled: false });
    is('a switch-only patch keeps every row', JSON.stringify(flipped.agents), '{"session-a":true,"session-b":false}');
    is('a switch-only patch lands the switch', flipped.enabled, false);
    const both = applySettingsPatch(installed, { enabled: false, agents: { 'session-c': true } });
    // The shaped value now carries `retrievalAgents` on every patch, the same way it
    // already carried `agents`: the tables are materialized so that `replace` at the
    // settings layer writes a complete section rather than merging one.
    is(
      'a combined patch replaces rows and switch together',
      JSON.stringify(both),
      '{"enabled":false,"agents":{"session-c":true},"retrievalAgents":{}}',
    );
    is('a patch that asks for nothing is refused', applySettingsPatch(installed, {}), null);
    is('a patch that is not an object is refused', applySettingsPatch(installed, 'nope'), null);
    const junk = applySettingsPatch(installed, { agents: { '': true, 'session-d': 'yes', 'session-e': true } });
    is('junk rows are dropped rather than stored', JSON.stringify(junk.agents), '{"session-e":true}');
    is(
      'the stored value is not mutated in place',
      JSON.stringify(installed.agents),
      '{"session-a":true,"session-b":false}',
    );
    // All-junk input must not read as "clear the table".
    let refused = null;
    try {
      applySettingsPatch(installed, { agents: { 'session-x': null } });
    } catch (error) {
      refused = String(error?.message ?? error);
    }
    ok('an all-unusable table is refused', refused !== null);
    const stillThere = applySettingsPatch(installed, { agents: { 'session-a': true } });
    is('the table is still clearable on purpose', JSON.stringify(stillThere.agents), '{"session-a":true}');
  }

  // Both losses can happen at once, and one boolean cannot report the pair: with
  // a draft already near the cap, an oversized write drops older entries AND is
  // itself cut. Reporting only the older loss implies the new entry fitted.
  {
    const notesDir = await mkdtemp(join(tmpdir(), 'context-zip-both-'));
    const store = new NoteStore(notesDir);
    await store.append('session-both', 'f'.repeat(4000));
    const both = await store.append('session-both', 'n'.repeat(9000));
    is('a write that overflows and is itself too large is trimmed', both.trimmed, true);
    is('it reports that older entries were dropped', both.droppedOlder, true);
    is('it also reports that the new entry was cut', both.entryCut, true);
    const clean = new NoteStore(notesDir);
    await clean.append('session-clean', 'f'.repeat(5000));
    const cleanSecond = await clean.append('session-clean', 'g'.repeat(1500));
    is('a write that merely overflows is trimmed', cleanSecond.trimmed, true);
    is('a write that merely overflows drops older entries', cleanSecond.droppedOlder, true);
    is('a write that merely overflows is itself kept whole', cleanSecond.entryCut, false);
    await rm(notesDir, { recursive: true, force: true });
  }

  // A trim with nothing older to drop must not claim older entries were dropped.
  // Driven through the real store, not a copy of its arithmetic: the flag is set
  // inside `append`, so a re-implementation here would pass while the store drifted.
  {
    const notesDir = await mkdtemp(join(tmpdir(), 'context-zip-notes-'));
    const store = new NoteStore(notesDir);
    const solo = await store.append('session-solo', 'z'.repeat(9000));
    is('an oversized single entry is reported as trimmed', solo.trimmed, true);
    is('an oversized single entry dropped nothing older', solo.droppedOlder, false);
    is('the trimmed draft is bounded', solo.chars, NOTES_MAX_CHARS);

    const pair = new NoteStore(notesDir);
    await pair.append('session-pair', 'a'.repeat(4000));
    await pair.append('session-pair', 'b'.repeat(4000));
    const second = await pair.append('session-pair', 'c'.repeat(4000));
    is('a later write that pushes the draft over is trimmed', second.trimmed, true);
    is('a later write really did drop older entries', second.droppedOlder, true);
    await rm(notesDir, { recursive: true, force: true });

    const huge = trimToLimit('z'.repeat(9000), NOTES_MAX_CHARS);
    is('trimToLimit bounds the draft', huge.text.length, NOTES_MAX_CHARS);
  }

  // An entry that fits EXACTLY must be kept whole. Charging it a joining newline
  // it never pays cut it by the length of the clipped notice and then called it
  // over budget.
  const exactFit = makeSession({ id: 'session-exact' });
  const fitText = 'fits'.repeat(1000);
  exactFit.append('user/message', { content: [{ type: 'text', text: fitText }] });
  const fitBlock = renderEvent(exactFit.snapshotEvents()[0]);
  const fitRendered = renderTranscript(exactFit.snapshotEvents(), fitBlock.length);
  ok('an exactly-fitting entry is not called over budget', !fitRendered.text.includes('exceeds the character budget'));
  ok('an exactly-fitting entry keeps its text', fitRendered.text.includes('fitsfits'));
  ok('an exactly-fitting entry keeps its tail', fitRendered.text.endsWith(fitText.slice(-40)));
  const underFit = renderTranscript(exactFit.snapshotEvents(), fitBlock.length - 1);
  ok('an entry one character over budget is clipped', underFit.text.includes('exceeds the character budget'));

  // The separator is paid once, BETWEEN entries. Charging it again per entry made
  // `used` drift, so a two-entry window that fitted exactly lost its second entry.
  const twoUp = makeSession({ id: 'session-two' });
  twoUp.append('user/message', { content: [{ type: 'text', text: 'a'.repeat(500) }] });
  twoUp.append('user/message', { content: [{ type: 'text', text: 'b'.repeat(500) }] });
  const twoEvents = twoUp.snapshotEvents();
  const joinedLen = twoEvents.map((event) => renderEvent(event)).join('\n').length;
  const exactTwo = renderTranscript(twoEvents, joinedLen);
  ok('a two-entry window that fits exactly keeps its first entry', exactTwo.text.includes('aaaa'));
  ok('a two-entry window that fits exactly keeps its second entry', exactTwo.text.includes('bbbb'));
  ok('a two-entry window that fits exactly is not truncated', exactTwo.truncated === false);
  const tightTwo = renderTranscript(twoEvents, joinedLen - 1);
  // One character short now shows the head of the second entry rather than dropping it.
  // Dropping was the old rule and an acceptance run showed its cost: `history_read
  // {seq: 8}` on a 5,269-character event returned 149 characters of its neighbours and
  // nothing of the event that was asked for by number. Showing less of the entry that did
  // not fit beats showing none of it.
  ok('a two-entry window one character short keeps a head of the second entry', tightTwo.text.includes('bbbb'));
  ok('a two-entry window one character short still reports truncation', tightTwo.truncated === true);
  ok('a two-entry window one character short says the tail was clipped', tightTwo.text.includes('exceeds the character budget'));
  // And when there is not even room for a head, the notice stands alone rather than
  // emitting a few characters that would read as an empty event. The budget floors at
  // 1000, so the squeeze has to happen above that floor: a first entry near the whole
  // budget leaves the second one less than CLIPPED_MIN_CHARS of room.
  const squeeze = makeSession({ id: 'session-squeeze' });
  squeeze.append('user/message', { content: [{ type: 'text', text: 'a'.repeat(940) }] });
  squeeze.append('user/message', { content: [{ type: 'text', text: 'b'.repeat(500) }] });
  const noRoom = renderTranscript(squeeze.snapshotEvents(), 1000);
  ok('a window with no room for a head does not pretend to show one', noRoom.text.includes('bbbb') === false);
  ok('a window with no room for a head still says it was truncated', noRoom.text.includes('transcript truncated at'));

  // The addressed entry must appear even when the window holds several entries and only
  // the addressed one is large. This is the acceptance case in miniature.
  const wide = makeSession({ id: 'session-wide' });
  wide.append('user/message', { content: [{ type: 'text', text: 'short one' }] });
  wide.append('user/message', { content: [{ type: 'text', text: 'short two' }] });
  wide.append('user/message', { content: [{ type: 'text', text: `TARGET${'z'.repeat(5000)}` }] });
  const wideRendered = renderTranscript(wide.snapshotEvents(), 1500);
  ok('a large addressed entry still contributes text to a small window', wideRendered.text.includes('TARGET'));
  ok('and the window really is truncated', wideRendered.truncated === true);

  // The second acceptance round's case, and the one the first fix missed: a LONG entry
  // comes FIRST and the addressed entry comes after it and is SHORT. Breaking at the first
  // over-budget entry dropped everything after it, so `history_read {seq: 10}` on an event
  // of 390 characters returned zero characters of it because #8 was longer than the budget.
  const behind = makeSession({ id: 'session-behind' });
  behind.append('user/message', { content: [{ type: 'text', text: `LONG${'y'.repeat(4000)}` }] });
  behind.append('user/message', { content: [{ type: 'text', text: 'middle' }] });
  behind.append('user/message', { content: [{ type: 'text', text: 'ADDRESSED' }] });
  const behindEvents = behind.snapshotEvents();
  const behindSeq = behindEvents[2].seq;
  const plainWindow = renderWindow(behindEvents, 'header', 1500);
  ok('the addressed entry is what gets dropped without a target', plainWindow.includes('ADDRESSED') === false);
  const aimedWindow = renderWindow(behindEvents, 'header', 1500, behindSeq);
  ok('naming the addressed entry rescues it from behind a long neighbour', aimedWindow.includes('ADDRESSED'));
  // Giving up the leading entry is a truncation, and it is reported as one: the entry was
  // dropped rather than clipped, so the notice is the truncation notice. Saying nothing
  // would hand back a window that looks whole while missing its first event.
  ok('dropping a leading entry to reach the target is reported', aimedWindow.includes('transcript truncated at'));
  ok('and the drop is reflected in the truncation flag', renderTranscript(behindEvents, 1500, behindSeq).truncated === true);
  ok('and the dropped entry really is gone from the text', aimedWindow.includes('LONG') === false);

  // R1 的第二次复验打穿的那一处：前缀块把预算吃得只剩不足地板线的空间，于是那个
  // 块连头部都推不下。此时若仍把 `covered` 置真，重试循环立刻收工，永远走不到
  // 「把被寻址事件排首位」那一步。同一事件 `{"seq":18}` 贡献 0 字、加 `before:1`
  // 给 1251 字，差别就在这里。
  const tight = makeSession({ id: 'session-tight' });
  tight.append('user/message', { content: [{ type: 'text', text: `A${'a'.repeat(598)}` }] });
  tight.append('user/message', { content: [{ type: 'text', text: `B${'b'.repeat(598)}` }] });
  tight.append('user/message', { content: [{ type: 'text', text: `THETARGET${'t'.repeat(2900)}` }] });
  const tightEvents = tight.snapshotEvents();
  const tightSeq = tightEvents[2].seq;
  const tightRendered = renderTranscript(tightEvents, 1500, tightSeq);
  ok('an addressed entry behind budget-exhausting neighbours still gets rendered', tightRendered.text.includes('THETARGET'));

  // ── 提示语要说实际落块，不能拿窗口顶替 ────────────────────────────────
  //
  // 复验三在真机上量过：3,327 次调用里 1,159 次（34.8%）的地址行给的是**窗口**区间而不是
  // 实际落块区间；丢弃前导块的那 700 次只发一句普通截断提示，不点名丢的是哪一段；被寻址
  // 块同时被裁头时更只剩一句 CLIPPED。三处是同一件事：读的人以为看到的是那个区间，实际不是。
  {
    // `behind`：LONG(#0) / middle(#1) / ADDRESSED(#2)。预算装不下 #0，于是它被丢掉，
    // 落块只有 1..2，地址行必须这么说。
    const aimed = renderWindow(behindEvents, 'header', 1500, behindSeq);
    ok('地址行给的是实际落块区间而不是窗口区间', aimed.includes('events 1..2 (2 of 3 read)'));
    ok('丢前导块时点名丢了哪一条', aimed.includes('1 entry (#0) was left out to make room for #2'));
    ok('地址行不再声称整窗都读到了', aimed.includes('(3 read)') === false);

    // `tight`：两块前缀 + 一个 2900 字的被寻址块。丢了前缀之后它自己仍超预算，于是
    // 「被裁头」与「丢了前导块」同时成立，两条提示都要在，只发一句 CLIPPED 会漏掉后面那半。
    const tightWindow = renderWindow(tightEvents, 'header', 1500, tightSeq);
    ok('被裁头时地址行说明最后一条只给了开头', tightWindow.includes('(1 of 3 read, last entry cut)'));
    ok('被裁头又丢了前导块时，丢块提示也在', tightWindow.includes('2 entries (#0..#1) were left out to make room for #2'));
    ok('被裁头又丢了前导块时，CLIPPED 那条也还在', tightWindow.includes('exceeds the character budget'));

    // 前缀刚好卡在「够放一个头部」的线下时，被寻址事件不能再只拿两百字：旧行为是前缀
    // 1118 字给 237 字头部，前缀再多一个字、逼得丢前缀，反而给 1356 字，方向是反的。
    const staircase = makeSession({ id: 'session-staircase' });
    staircase.append('user/message', { content: [{ type: 'text', text: 'p'.repeat(1100) }] });
    staircase.append('user/message', { content: [{ type: 'text', text: `TARGET${'z'.repeat(5000)}` }] });
    const staircaseRendered = renderTranscript(staircase.snapshotEvents(), 1500, 1);
    ok('前缀在线下时被寻址事件不再只拿一个头部', staircaseRendered.text.includes('z'.repeat(1200)));
    ok('前缀在线下时也点名丢了前缀', staircaseRendered.text.includes('#0) was left out to make room for #1'));
    // 提示语占预算而不是加在预算外面：切片 + 两条提示语正好落在 maxChars 上。
    ok('切片加两条提示语不超出 maxChars', staircaseRendered.text.length <= 1500);
  }

  // 两类真失败各重试一次。用假 summarize 计数，不碰真模型。
  // 构造方式照抄本文件既有的引擎测试：createContextZipEngine(StubBase) + setSharedModeReader。
  {
    class RetryBase {
      // `this.ctx` 由基类构造函数设置，重试的告警要用它，所以这里必须存一下。
      constructor(ctx, config, deps) {
        this.ctx = ctx;
        this.config = config ?? {};
        this.deps = deps ?? {};
      }
      async summarize() {
        return { summary: [{ type: 'text', text: 'base' }], routedTo: 'base' };
      }
    }
    const RetryEngine = createContextZipEngine(RetryBase);
    const agentX = { session: { id: 'session-retry' }, mode: 'plugin' };
    const markup = new Error(
      'summarization returned no handoff summary (tool-call-markup): 0 of 5 required sections present in 900 characters of output',
    );
    const short = new Error(
      'summarization returned no handoff summary (too-short): 0 of 5 required sections present in 12 characters of output',
    );
    const okSummary = { summary: [{ type: 'text', text: 'five sections' }] };

    setSharedModeReader(() => 'plugin');
    for (const [label, failure] of [['tool-call-markup', markup], ['too-short', short]]) {
      let calls = 0;
      const engine = new RetryEngine({ logger: {} }, {}, {
        readNotes: async () => '',
        summarize: async () => {
          calls += 1;
          if (calls === 1) throw failure;
          return okSummary;
        },
      });
      const result = await engine.summarize({ messages: [] }, agentX, undefined);
      is(`a ${label} failure is retried exactly once`, calls, 2);
      is(`and the retry result is what comes back after ${label}`, result, okSummary);
    }

    let hardCalls = 0;
    const hard = new RetryEngine({ logger: {} }, {}, {
      readNotes: async () => '',
      summarize: async () => {
        hardCalls += 1;
        throw markup;
      },
    });
    let threw = false;
    try {
      await hard.summarize({ messages: [] }, agentX, undefined);
    } catch (error) {
      threw = String(error?.message ?? error).includes('tool-call-markup');
    }
    ok('a repeated failure throws instead of retrying forever', threw === true && hardCalls === 2);

    // 非这两类不重试：一次就抛。
    let otherCalls = 0;
    const other = new RetryEngine({ logger: {} }, {}, {
      readNotes: async () => '',
      summarize: async () => {
        otherCalls += 1;
        throw new Error('summarization call finished as error');
      },
    });
    let otherThrew = false;
    try {
      await other.summarize({ messages: [] }, agentX, undefined);
    } catch {
      otherThrew = true;
    }
    ok('a provider failure is not retried', otherThrew === true && otherCalls === 1);

    // 成功一次就不该有第二次调用。
    let onceCalls = 0;
    const once = new RetryEngine({ logger: {} }, {}, {
      readNotes: async () => '',
      summarize: async () => {
        onceCalls += 1;
        return okSummary;
      },
    });
    await once.summarize({ messages: [] }, agentX, undefined);
    is('a successful summary is not retried', onceCalls, 1);
    setSharedModeReader(null);
  }

  // 机械兜底：N 次失败后不再抛错，改用插件自己写的台账摘要。
  {
    class FbBase {
      constructor(ctx, config, deps) {
        this.ctx = ctx;
        this.config = config ?? {};
        this.deps = deps ?? {};
      }
      async summarize() {
        return { summary: [{ type: 'text', text: 'base' }], routedTo: 'base' };
      }
    }
    const FbEngine = createContextZipEngine(FbBase);
    const agentY = { session: { id: 'session-fb' }, mode: 'plugin' };
    const bad = new Error(
      'summarization returned no handoff summary (too-short): 0 of 5 required sections present in 3 characters of output',
    );
    const mk = (calls) =>
      new FbEngine({ logger: {} }, {}, {
        readNotes: async () => '',
        summarize: async () => {
          calls.n += 1;
          throw bad;
        },
      });

    // 开关关着：一直抛错，且每次尝试内部只重试一次（所以调用数是尝试数的两倍）。
    setSharedFallbackReader(() => ({ enabled: false, after: 0 }));
    resetFailureStreaks();
    let callsA = { n: 0 };
    const off = mk(callsA);
    let threwA = false;
    try {
      await off.summarize({ messages: [{ role: 'user', content: 'x' }] }, agentY, undefined);
    } catch {
      threwA = true;
    }
    ok('with the fallback off a failure still throws', threwA === true);
    is('and one attempt is exactly two model calls', callsA.n, 2);

    // 开关开着、after=0：第一次失败之后立刻机械兜底。
    setSharedFallbackReader(() => ({ enabled: true, after: 0 }));
    resetFailureStreaks();
    let callsB = { n: 0 };
    const on = mk(callsB);
    const fb = await on.summarize({ messages: [{ role: 'user', content: 'look at src/a.ts' }] }, agentY, undefined);
    const text = fb.summary.map((b) => b.text).join('\n');
    ok('with the fallback on the compaction lands instead of throwing', text.includes('mechanical fallback'));
    ok('and the ledger says no model wrote it', text.includes('not by a model'));
    ok('and it carries the paths it saw', text.includes('src/a.ts'));
    ok('and it points at the originals rather than pretending to summarise', text.includes('never deletes them'));

    // after=1：第一次失败照抛，第二次才兜底。
    setSharedFallbackReader(() => ({ enabled: true, after: 1 }));
    resetFailureStreaks();
    let callsC = { n: 0 };
    const on1 = mk(callsC);
    let threwC = false;
    try {
      await on1.summarize({ messages: [] }, agentY, undefined);
    } catch {
      threwC = true;
    }
    ok('the first failure still throws when the count allows one', threwC === true);
    const second = await on1.summarize({ messages: [] }, agentY, undefined);
    ok(
      'the second failure falls back',
      second.summary.map((b) => b.text).join('\n').includes('mechanical fallback'),
    );

    // 越界夹住：after=99 当 10，after=-5 当 0。
    setSharedFallbackReader(() => ({ enabled: true, after: 99 }));
    resetFailureStreaks();
    let callsD = { n: 0 };
    const clamped = mk(callsD);
    for (let i = 0; i < 3; i += 1) {
      try {
        await clamped.summarize({ messages: [] }, agentY, undefined);
        break;
      } catch {
        /* 还在计数内 */
      }
    }
    ok('an out-of-range count does not fall back early', callsD.n === 6);

    // 注销函数的形状。`src/index.ts` 把这两个 setter 的返回值当函数存下来，插件卸载
    // 时调用它们（`undoFallbackReader()` / `undoRewriteReader()`）。这两个 setter 曾经
    // 什么都不返回，于是卸载路径必然 TypeError：`tsc` 的 TS2349
    // （`Type 'void' has no call signatures`）就是这样把它挖出来的。这条检查锁住形状。
    const undoFallbackProbe = setSharedFallbackReader(() => ({ enabled: true, after: 0 }));
    is('setSharedFallbackReader hands back a callable disposer', typeof undoFallbackProbe, 'function');
    undoFallbackProbe?.();
    const undoRewriteProbe = setSharedRewriteReader(() => ({ enabled: false }));
    is('setSharedRewriteReader hands back a callable disposer', typeof undoRewriteProbe, 'function');
    undoRewriteProbe?.();

    setSharedFallbackReader(null);
    setSharedRewriteReader(null);
    resetFailureStreaks();
  }

  // -------------------------------------------------------------------------
  // 格式改写：只动排版，由 B10 的集合差护栏把关
  //
  // 四条必验都在这一块里：① 改写新增编造 token 时被丢弃；② 改写失败时压缩仍成功
  // 并退回原散文；③ 开关关闭时一次改写调用都不发生；④ 形态合格的改写被采纳。
  // 全部用假的 llm，不碰真模型。
  // -------------------------------------------------------------------------
  {
    class RwBase {
      constructor(ctx, config, deps) {
        this.ctx = ctx;
        this.config = config ?? {};
        this.deps = deps ?? {};
      }
      async summarize() {
        return { summary: [{ type: 'text', text: 'base' }] };
      }
    }
    const RwEngine = createContextZipEngine(RwBase);
    const rwAgent = { session: { id: 'session-rewrite' } };

    // 被压缩的原文。两处路径都在里面，改写照抄它们就不会被护栏挡。
    const rwSource = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '回滚计划在 src/segment/roll_plan.rs 里，修的时候不要动 src/segment/window_planner.rs。',
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: '收到，改动只落在 src/segment/roll_plan.rs。' }] },
    ];
    // 散文摘要：没有任何小标题、长度过 400 字，所以形态门判 unrecognised-sections。
    const rwProse = [
      '这轮的目标是把回滚计划修好，涉及的文件是 src/segment/roll_plan.rs，另一个文件 src/segment/window_planner.rs 只读不改。',
      '已经定下来的做法是不改接口，只在回滚计划内部调整顺序；理由是接口已经被三处调用方依赖。',
      '当前状态是改动还没开始，工作区干净，测试基线是通过的。',
      '下一步是打开回滚计划，找到排序那一段，把窗口计划里的边界条件抄过来。',
      ...Array.from(
        { length: 12 },
        (_, index) => `补充说明第 ${index + 1} 条：这一段只是把长度顶过散文门槛，内容与上面重复，没有任何新事实。`,
      ),
    ].join('\n');
    ok('the fixture really is prose the shape gate cannot match', classifySummary(rwProse).reason === 'unrecognised-sections');

    // 只动排版的合格改写：加五个小标题、折行成 bullet，路径照抄。
    const rwGood = [
      '## Goal and intent',
      '这轮的目标是把回滚计划修好，涉及的文件是 src/segment/roll_plan.rs，另一个文件 src/segment/window_planner.rs 只读不改。',
      '',
      '## Decisions',
      '- 不改接口，只在回滚计划内部调整顺序 | 接口已经被三处调用方依赖',
      '',
      '## Current state',
      '- 改动还没开始，工作区干净，测试基线是通过的。',
      '',
      '## Next steps',
      '1. 打开回滚计划，找到排序那一段，把窗口计划里的边界条件抄过来。',
      '',
      '## Anchors',
      '- path: src/segment/roll_plan.rs',
      '- path: src/segment/window_planner.rs',
    ].join('\n');
    ok('the fixture rewrite is a shape the gate accepts', classifySummary(rwGood).reason === 'sections');

    const makeRewriteLlm = (options = {}) => {
      const calls = { streams: 0, resolves: 0, requests: [] };
      const llm = {
        async resolveModelInfo() {
          calls.resolves += 1;
          if (options.resolveThrows === true) throw new Error('no adapter registered for provider "fake-provider"');
          if (options.noReasoning === true) return { provider: 'fake-provider', id: 'fake-model', name: 'Fake' };
          return {
            provider: 'fake-provider',
            id: 'fake-model',
            name: 'Fake',
            reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: 'high' },
          };
        },
        stream(request) {
          calls.streams += 1;
          calls.requests.push(request);
          if (options.streamThrows === true) throw new Error('provider exploded');
          const text = typeof options.text === 'function' ? options.text(calls.streams) : options.text ?? rwGood;
          const kind = options.kind ?? 'stop';
          return (async function* () {
            if (kind === 'error') {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad key', code: 'AUTH', status: 401 } } };
              return;
            }
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'finish', reason: { kind } };
          })();
        },
      };
      return { calls, llm };
    };

    const runRewriteEngine = async ({ llm, rewrite, summarize }) => {
      const logs = [];
      const engine = new RwEngine(
        { logger: { warn: (m) => logs.push(String(m)), info: (m) => logs.push(String(m)), debug: () => {} }, llm },
        {},
        {
          readNotes: async () => '',
          summarize: summarize ?? (async () => ({ summary: [{ type: 'text', text: rwProse }], unsupportedClaims: [], sectionSources: [] })),
          readRewrite: () => rewrite,
        },
      );
      const result = await engine.summarize({ messages: rwSource }, rwAgent, undefined);
      return { result, logs, text: result.summary.map((b) => b.text).join('\n') };
    };

    setSharedModeReader(() => 'plugin');
    setSharedRewriteReader(null);

    // ③ 开关关闭：一次改写调用都不发，也不去解析模型；摘要原样采纳。
    {
      const off = makeRewriteLlm({ text: rwGood });
      const run = await runRewriteEngine({ llm: off.llm, rewrite: { enabled: false, provider: 'fake-provider', model: 'fake-model' } });
      is('③ 开关关闭时改写调用次数为 0', off.calls.streams, 0);
      is('③ 开关关闭时也不解析模型', off.calls.resolves, 0);
      ok('③ 开关关闭时原散文被原样采纳', run.text === rwProse);
    }
    // provider/model 没选全，同样一次都不发。
    {
      const half = makeRewriteLlm({ text: rwGood });
      const run = await runRewriteEngine({ llm: half.llm, rewrite: { enabled: true, provider: 'fake-provider', model: '' } });
      is('只选了 provider 不发改写调用', half.calls.streams, 0);
      ok('只选了 provider 时原散文被采纳', run.text === rwProse);
    }
    // 形态已经合格的摘要走到这里根本不该改写：一次模型调用都不发。
    {
      const shaped = makeRewriteLlm({ text: rwGood });
      const run = await runRewriteEngine({
        llm: shaped.llm,
        rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' },
        summarize: async () => ({ summary: [{ type: 'text', text: rwGood }] }),
      });
      is('形态已合格的摘要不触发改写调用', shaped.calls.streams, 0);
      ok('形态已合格的摘要原样返回', run.text === rwGood);
    }

    // ④ 合格改写被采纳，且改写调用的形状正确。
    {
      const good = makeRewriteLlm({ text: rwGood });
      const run = await runRewriteEngine({ llm: good.llm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      ok('④ 只动排版的合格改写被采纳', run.text === rwGood);
      is('④ 采纳后记下了改写路由', run.result.layoutRewrite?.model, 'fake-model');
      is('改写调用恰好一次', good.calls.streams, 1);
      // 输入只有那份摘要：一条 user 消息，里面不含被压缩的对话。
      is('改写调用只带一条消息', good.calls.requests[0].messages.length, 1);
      const envelope = JSON.stringify(good.calls.requests[0]);
      ok('改写调用不重发被压缩的对话', envelope.includes('window_planner.rs') && !envelope.includes('收到，改动只落在'));
      // 思考档位锁最低：efforts 故意写成 [high, low]，选出来的必须是 low。
      is('思考档位锁在最低档', good.calls.requests[0].reasoningEffort, 'low');
      is('改写调用沿用压缩的输出上限', good.calls.requests[0].maxTokens, SUMMARY_HARD_CAP_TOKENS);
    }

    // ① 改写新增了编造 token：丢弃改写、用原文。
    {
      const fabricated = `${rwGood}\n- path: src/diag/ledger.rs`;
      const guard = makeRewriteLlm({ text: fabricated });
      const run = await runRewriteEngine({ llm: guard.llm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      ok('① 改写确实被发出去了（不是没跑）', guard.calls.streams === 1);
      ok('① 新增编造 token 的改写被丢弃、用回原文', run.text === rwProse);
      ok(
        '① 丢弃时说明了是哪个 token',
        run.logs.some((line) => line.includes('src/diag/ledger.rs') && line.includes('keeping the original summary')),
      );
    }
    // ① 的边界：数量相同但成员不同的两个 token 也算新增，不能被"数量差"漏掉。
    {
      const swapped = `${rwGood}\n- path: src/diag/alpha.rs\n- path: src/diag/beta.rs`;
      const swappedLlm = makeRewriteLlm({ text: swapped });
      const run = await runRewriteEngine({ llm: swappedLlm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      ok('① 两个新增 token 的改写同样被丢弃', run.text === rwProse);
    }

    // ② 改写调用失败：压缩仍然成功，退回原散文。
    {
      const boom = makeRewriteLlm({ streamThrows: true });
      const run = await runRewriteEngine({ llm: boom.llm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      is('② 失败时改写调用发生过', boom.calls.streams, 1);
      ok('② 改写失败后压缩仍成功', typeof run.text === 'string' && run.text.length > 0);
      ok('② 退回原散文', run.text === rwProse);
      ok('② 失败被记进日志', run.logs.some((line) => line.includes('the layout-only rewrite failed')));
    }
    // ② 的另一支：以 provider 错误收尾。
    {
      const errored = makeRewriteLlm({ kind: 'error' });
      const run = await runRewriteEngine({ llm: errored.llm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      ok('② provider 报错的改写也退回原散文', run.text === rwProse);
      ok('② provider 的原话进了日志', run.logs.some((line) => line.includes('bad key')));
    }
    // ② 的第三支：模型元数据取不到（锁不住思考档位就不改）。
    {
      const noInfo = makeRewriteLlm({ resolveThrows: true });
      const run = await runRewriteEngine({ llm: noInfo.llm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      is('② 元数据取不到时不发改写调用', noInfo.calls.streams, 0);
      ok('② 元数据取不到时退回原散文', run.text === rwProse);
    }
    // ② 的第四支：改写回来了但仍然不是五段式形态 → 退回原文。
    {
      const stillProse = makeRewriteLlm({ text: `${rwProse}\n还是没有小标题。` });
      const run = await runRewriteEngine({ llm: stillProse.llm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      ok('② 改写没修好形态时退回原散文', run.text === rwProse);
    }
    // 模型没有思考档位时照常改写，且不传 reasoningEffort（传了会被 provider 拒）。
    {
      const noReasoning = makeRewriteLlm({ text: rwGood, noReasoning: true });
      const run = await runRewriteEngine({ llm: noReasoning.llm, rewrite: { enabled: true, provider: 'fake-provider', model: 'fake-model' } });
      ok('模型没有思考档位时照常采纳合格改写', run.text === rwGood);
      is('没有思考档位时不传 reasoningEffort', noReasoning.calls.requests[0].reasoningEffort, undefined);
    }

    // 纯函数：最低档的选择，以及"新增 = 集合差"。
    is('最低档按已知次序表选，不看广告顺序', lowestReasoningEffort({ efforts: [{ id: 'high' }, { id: 'low' }, { id: 'max' }] }), 'low');
    is('off 在列表里时选 off', lowestReasoningEffort({ efforts: [{ id: 'high' }, { id: 'off' }] }), 'off');
    is('未知方言退回 adapter 自己的第一个', lowestReasoningEffort({ efforts: [{ id: 'zzz' }, { id: 'aaa' }] }), 'zzz');
    is('模型没有思考档位时不选', lowestReasoningEffort(undefined), undefined);
    is('新增是集合差', addedClaims(['a', 'b'], ['b', 'c']).join(','), 'c');
    is('数量相同但成员不同也算新增', addedClaims(['a'], ['b']).join(','), 'b');
    is('成员相同（顺序不同）不算新增', addedClaims(['a', 'b'], ['b', 'a']).length, 0);
    is('重复的新增 token 只报一次', addedClaims([], ['x', 'x']).join(','), 'x');
    is('逐字未改的改写新增集合为空', addedClaims(['a', 'b'], ['a', 'b']).length, 0);
    is('开关关着时不给路由', resolveRewriteRoute({ enabled: false, provider: 'p', model: 'm' }).route, undefined);
    is('没选全时不给路由', resolveRewriteRoute({ enabled: true, provider: 'p', model: '' }).route, undefined);
    is('reader 缺失时不给路由', resolveRewriteRoute(null).route, undefined);
    is('选全了才给路由', resolveRewriteRoute({ enabled: true, provider: 'p', model: 'm' }).route.model, 'm');

    setSharedRewriteReader(null);
    setSharedModeReader(null);
  }

  // -------------------------------------------------------------------------
  // 丁：改写护栏改用判据 1，清单从这次压缩的原文事件里来
  //
  // 三条必须有测试盯着：① 清单从工具回执与会话正文里抽得出来（回执的正文不在 `text`
  // 字段上，在嵌套的 content 里，role 还是 user）；② 「同一文件换写法」不算新增，
  // 编造文件名/换目录/同目录一字之差/裸名+编造目录都算；③ 判据 1 不接（清单取不到，
  // 或 `deps.fileExists` 明确给 null）时一条都不拦，压缩照旧成功。
  // -------------------------------------------------------------------------
  {
    // ① 清单来源。
    const receiptMessage = {
      source: { kind: 'tool', callId: 'call-1' },
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          isError: false,
          content: [{ type: 'text', text: 'src/segment/roll_plan.rs\nsrc/segment/window_planner.rs\nnotes/plan.md' }],
        },
      ],
    };
    const fromReceipts = fileListFromMessages([receiptMessage]);
    is('丁清单：工具回执里抽出了路径', fromReceipts.paths.length, 3);
    is('丁清单：来源标成回执', fromReceipts.source, 'receipts');
    is('丁清单：回执条数与路径数一致', fromReceipts.receipts, 3);
    is('丁清单：回执里的路径判存在', fromReceipts.oracle('src/segment/roll_plan.rs'), 'exists');
    is('丁清单：回执里没有的文件判不存在', fromReceipts.oracle('src/segment/ledger.rs'), 'absent');
    is('丁清单：只对上文件名时判不了（换目录那一档）', fromReceipts.oracle('tools/window_planner.rs'), 'unknown');
    is('丁清单：`./` 前缀不影响判存在', fromReceipts.oracle('./notes/plan.md'), 'exists');
    const fromProse = fileListFromMessages([
      { role: 'user', content: [{ type: 'text', text: '回滚计划在 src/segment/roll_plan.rs 里。' }] },
    ]);
    is('丁清单：散文正文也能出清单', fromProse.source, 'session');
    is('丁清单：散文正文不算回执', fromProse.receipts, 0);
    is('丁清单：散文正文里的路径判存在', fromProse.oracle('src/segment/roll_plan.rs'), 'exists');
    is('丁清单：裸名也进清单', fileListFromMessages(['见 notes/plan.md 与 plan.md']).paths.length, 2);
    is('丁清单：没有消息时取不到清单', fileListFromMessages([]).oracle, null);
    is('丁清单：消息里没有路径时取不到清单', fileListFromMessages(['没有任何路径的一句话']).oracle, null);
    is('丁清单：取不到清单时来源标 none', fileListFromMessages([]).source, 'none');

    // ② 「同一个文件的两种写法」。短的那一方必须有目录段，否则裸名配编造目录会被放行。
    is('丁身份：`./` 前缀不算换文件', sameFileSpelling('./diag/ledger.rs', 'diag/ledger.rs'), true);
    is('丁身份：补 `src/` 前缀不算换文件', sameFileSpelling('src/diag/ledger.rs', 'diag/ledger.rs'), true);
    is('丁身份：大小写与分隔符不影响', sameFileSpelling('SRC/Diag/ledger.rs', 'src/diag/ledger.rs'), true);
    is('丁身份：同目录一字之差算换文件', sameFileSpelling('ci/secret-audit.sh', 'ci/secrets-audit.sh'), false);
    is('丁身份：换目录不算换文件', sameFileSpelling('tools/prewarm.sh', 'ci/prewarm.sh'), false);
    is('丁身份：裸名配编造目录不算换文件', sameFileSpelling('zzzcache/watermark.rs', 'watermark.rs'), false);
    is('丁身份：绝对路径与相对路径段对不上就不算', sameFileSpelling('/srv/app/diag/tailwatch.rs', 'src/diag/tailwatch.rs'), false);

    // ③ 判决本身：改写里**新出现**的路径逐条过判据 1，只在判据 1 证不出「存在」时才拦。
    const guardOracle = fileOracleFromList(['diag/ledger.rs', 'ci/prewarm.sh']);
    is('丁判决：逐字没变时没有新引入', introducedPaths('见 `diag/ledger.rs`', '见 `diag/ledger.rs`').length, 0);
    is('丁判决：同一文件换写法放行', rewriteGuardBlocks('见 `src/diag/ledger.rs`', '见 `diag/ledger.rs`', guardOracle).length, 0);
    is(
      '丁判决：没有清单时同一文件换写法照样放行（身份先于判据 1）',
      rewriteGuardBlocks('见 `./diag/ledger.rs`', '见 `diag/ledger.rs`', fileOracleFromList([])).length,
      0,
    );
    is('丁判决：判据 1 说存在的放行', rewriteGuardBlocks('见 `ci/prewarm.sh`', '另一句话', guardOracle).length, 0);
    is('丁判决：判据 1 说不存在的拦住', rewriteGuardBlocks('见 `diag/budget.rs`', '另一句话', guardOracle).join(','), 'diag/budget.rs');
    is(
      '丁判决：只对上文件名的（真实文件换目录）拦住',
      rewriteGuardBlocks('见 `tools/prewarm.sh`', '另一句话', guardOracle).join(','),
      'tools/prewarm.sh',
    );
    is(
      '丁判决：同目录一字之差（待办 17 的洞一）补上了',
      rewriteGuardBlocks('见 `ci/secret-audit.sh`', '见 `ci/secrets-audit.sh`', fileOracleFromList(['ci/secrets-audit.sh'])).join(','),
      'ci/secret-audit.sh',
    );
    is(
      '丁判决：裸名 + 编造目录（待办 17 的洞二）补上了',
      rewriteGuardBlocks('见 `zzzcache/watermark.rs`', '见 `watermark.rs`', fileOracleFromList(['watermark.rs'])).join(','),
      'zzzcache/watermark.rs',
    );
    is('丁判决：判据 1 不接时一条都不拦', rewriteGuardBlocks('见 `diag/budget.rs`', '另一句话', null).length, 0);
    is('丁判决：新引入的路径按改写里的顺序给出来', introducedPaths('见 `b/x.rs` 与 `a/y.rs`', '另一句话').join(','), 'b/x.rs,a/y.rs');
    is('丁判决：路径形之外的 token 不进判决', introducedPaths('见 `retention_sweep_interval_ms`', '另一句话').length, 0);

    // ④ 端到端：引擎里判据 1 的三种状态。原文 = 一条普通消息 + 一条工具回执（回执就是
    //    清单来源）；散文摘要里先放一个改写前就被标出来的编造 token（`tools/prewarm.sh`，
    //    回执里那份真写法是 `ci/prewarm.sh`）。
    class DingBase {
      constructor(ctx, config, deps) {
        this.ctx = ctx;
        this.config = config ?? {};
        this.deps = deps ?? {};
      }
      async summarize() {
        return { summary: [{ type: 'text', text: 'base' }] };
      }
    }
    const DingEngine = createContextZipEngine(DingBase);
    const dingAgent = { session: { id: 'session-ding' }, options: { provider: 'fake-provider', model: 'fake-model' } };
    const dingSource = [
      { role: 'user', content: [{ type: 'text', text: '回滚计划在 src/segment/roll_plan.rs 里。' }] },
      {
        source: { kind: 'tool', callId: 'call-9' },
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-9',
            isError: false,
            content: [{ type: 'text', text: 'ci/prewarm.sh\nci/secrets-audit.sh\nsrc/segment/window_planner.rs' }],
          },
        ],
      },
    ];
    const dingProse = [
      '这轮的目标是把回滚计划修好，涉及的文件是 src/segment/roll_plan.rs，预热的脚本 tools/prewarm.sh 先不动。',
      '已经定下来的做法是不改接口，只在回滚计划内部调整顺序；理由是接口已经被三处调用方依赖。',
      '当前状态是改动还没开始，工作区干净，测试基线是通过的。',
      '下一步是打开回滚计划，找到排序那一段，把窗口计划里的边界条件抄过来。',
      ...Array.from(
        { length: 12 },
        (_, index) => `补充说明第 ${index + 1} 条：这一段只是把长度顶过散文门槛，内容与上面重复，没有任何新事实。`,
      ),
    ].join('\n');
    const dingGood = [
      '## Goal and intent',
      '这轮的目标是把回滚计划修好，涉及的文件是 src/segment/roll_plan.rs，预热的脚本 ./tools/prewarm.sh 先不动。',
      '',
      '## Decisions',
      '- 不改接口，只在回滚计划内部调整顺序 | 接口已经被三处调用方依赖',
      '',
      '## Current state',
      '- 改动还没开始，工作区干净，测试基线是通过的。',
      '',
      '## Next steps',
      '1. 打开回滚计划，找到排序那一段，把窗口计划里的边界条件抄过来。',
      '',
      '## Anchors',
      '- path: src/segment/roll_plan.rs',
      '- path: ./tools/prewarm.sh',
    ].join('\n');
    ok('丁 fixture：散文摘要过不了形态门', classifySummary(dingProse).reason === 'unrecognised-sections');
    ok('丁 fixture：改写是五段式形态', classifySummary(dingGood).reason === 'sections');
    const runDing = async (text, deps = {}) => {
      const logs = [];
      const llm = {
        async resolveModelInfo() {
          return {
            provider: 'fake-provider',
            id: 'fake-model',
            name: 'Fake',
            reasoning: { efforts: [{ id: 'high' }, { id: 'low' }], defaultEffort: 'high' },
          };
        },
        stream() {
          return (async function* () {
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      };
      const engine = new DingEngine(
        { logger: { warn: (m) => logs.push(String(m)), info: (m) => logs.push(String(m)), debug: () => {} }, llm },
        {},
        {
          readNotes: async () => '',
          summarize: async () => ({ summary: [{ type: 'text', text: dingProse }], unsupportedClaims: [], sectionSources: [] }),
          readRewrite: () => ({ enabled: true, provider: 'fake-provider', model: 'fake-model' }),
          ...deps,
        },
      );
      const result = await engine.summarize({ messages: dingSource }, dingAgent, undefined);
      return { logs, text: result.summary.map((b) => b.text).join('\n') };
    };

    // 状态一：清单从原文事件里抽（deps 没配判据 1）。同一文件换写法 → 放行。
    const sameFile = await runDing(dingGood);
    ok('丁端到端：同一文件换写法（`./` 前缀）被放行', sameFile.text === dingGood);
    ok('丁端到端：放行时不打退件日志', sameFile.logs.every((line) => !line.includes('keeping the original summary')));

    // 改写新引入了一个判据 1 证不出来的路径 → 退掉，用回原散文。
    const inventedText = `${dingGood}\n- path: diag/budget.rs`;
    const invented = await runDing(inventedText);
    ok('丁端到端：新引入的编造路径被退掉', invented.text === dingProse);
    ok(
      '丁端到端：退掉时说明了是哪个 token',
      invented.logs.some((line) => line.includes('diag/budget.rs') && line.includes('keeping the original summary')),
    );

    // 状态二：`deps.fileExists` 明确给 null → 判据 1 不接 → 一条都不拦（降级行为）。
    const off = await runDing(inventedText, { fileExists: null });
    ok('丁端到端：判据 1 不接时编造路径也不再退（降级）', off.text === inventedText);
    ok(
      '丁端到端：降级时留下可查的痕',
      off.logs.some((line) => line.includes('no file list to check them against')),
    );

    // 状态三：`deps.fileExists` 是函数 → 用它，覆盖从消息里抽的清单。
    const wired = await runDing(inventedText, { fileExists: () => 'exists' });
    ok('丁端到端：嵌入方给的判定器优先', wired.text === inventedText);

    // 回执是清单里唯一的来源：`ci/prewarm.sh` 只在回执里，正文里没有。改写把它写出来
    // 应该被放行；换一个只用正文造的清单就会被退——这一条证明回执那一支真的接上了。
    const receiptOnly = dingGood.split('./tools/prewarm.sh').join('ci/prewarm.sh');
    const fromReceipt = await runDing(receiptOnly);
    ok('丁端到端：只出现在工具回执里的真实文件被放行', fromReceipt.text === receiptOnly);
    const proseOnly = await runDing(receiptOnly, { fileExists: fileOracleFromList(['src/segment/roll_plan.rs']) });
    ok('丁端到端：清单里没有它时同一条改写被退', proseOnly.text === dingProse);

    // 折行切断路径：本批只从提示词治，**判据一条没放宽**。这四条把那个事实钉住——
    // 残片照样算「新引入」，护栏照样退它（没有为「已知路径的前缀」开后门）。
    const foldOriginal = '涉及的文件是 src/segment/roll_plan.rs，先不动它。';
    const foldBroken = '涉及的文件是 src/segment/roll_plan.r\ns，先不动它。';
    const foldOracle = fileOracleFromList(['src/segment/roll_plan.rs']);
    ok('折行残片不是原摘要里的 token', !pathTokensIn(foldOriginal).includes('src/segment/roll_plan.r'));
    ok('折行残片算「改写新引入」', introducedPaths(foldBroken, foldOriginal).includes('src/segment/roll_plan.r'));
    ok(
      '折行残片仍被退（没为「已知路径的前缀」放宽判据）',
      rewriteGuardBlocks(foldBroken, foldOriginal, foldOracle).includes('src/segment/roll_plan.r'),
    );
    ok('对照：同一份没折行的文本仍被放行', rewriteGuardBlocks(foldOriginal, foldOriginal, foldOracle).length === 0);

    // 首段含连字符的路径。正则的首段字符类原先不含 `-`，于是
    // `emberlog-index/src/offset.rs` 被切成 `index/src/offset.rs`：真路径漏掉，
    // 同时又凭空造出一条原文里没有的路径。D12。
    ok(
      '首段含连字符的路径不被截断',
      pathTokensIn('emberlog-index/src/offset.rs').includes('emberlog-index/src/offset.rs'),
    );
    ok(
      '截断残片不再冒充一条路径',
      !pathTokensIn('emberlog-index/src/offset.rs').includes('index/src/offset.rs'),
    );
    ok(
      '对照：首段无连字符时逐字不变',
      pathTokensIn('crates/emberlog-index/src/offset.rs').includes('crates/emberlog-index/src/offset.rs'),
    );
  }

  // -------------------------------------------------------------------------
  // 改写提示词：用户拍板的硬约束必须在提示词里写死
  //
  // 提示词是「只改格式」这条约束的唯一执行手段，所以它必须可审查、可断言。
  // 路径写法四条（禁 src/、禁 ./、禁统一、禁补全）加上折行那一条，都在这里钉住。
  // -------------------------------------------------------------------------
  {
    const instruction = buildRewriteInstruction('__SUMMARY_TEXT__ 出现在正文里也不该被二次替换');
    ok('提示词里带着五个小标题', SUMMARY_HEADINGS.every((heading) => instruction.includes(heading)));
    ok('提示词只准加小标题、折行、移段、调空白', instruction.includes('The ONLY changes you may make are these four'));
    ok('提示词明确禁止改写句子', instruction.includes('Do not re-word, re-phrase'));
    ok('提示词明确禁止补 src/ 前缀', instruction.includes('Do NOT add a `src/` prefix'));
    ok('提示词明确禁止补 ./ 或 ../ 前缀', instruction.includes('do NOT add a `./` or `../` prefix'));
    ok('提示词明确禁止补目录名', instruction.includes('do NOT add a missing directory'));
    ok('提示词明确禁止把裸名补成完整路径', instruction.includes('do NOT expand a bare file name into a full path'));
    ok('提示词明确禁止顺手统一两种写法', instruction.includes('keep both ways exactly as they are'));
    // 折行切断路径：前四条管的是**拼写**，这一条管的是**换行位置**。折一下不是
    // 拼写错误，但切出来的残片在护栏那边是一条「改写前没有的路径」，照退。
    ok('提示词禁止把路径折成两行', instruction.includes('Do NOT break a path across two lines'));
    ok('提示词写明路径含目录段与文件名', instruction.includes('its directory'));
    ok('提示词写了第一种替代做法：整条路径移到下一行', instruction.includes('move the whole path down to the'));
    ok('提示词写了第二种替代做法：那一行保持原样', instruction.includes('leave that line as it is'));
    const numbered = instruction.slice(
      instruction.indexOf('3. Break runs'),
      instruction.indexOf('4. Adjust blank lines'),
    );
    ok('折行禁令挂在第 3 条折行授权里，不是孤立一段', numbered.includes('Do NOT break a path across two lines'));
    ok('摘要原文被原样放进标记之间', instruction.includes('__SUMMARY_TEXT__ 出现在正文里也不该被二次替换'));
    ok('摘要里的 $& 不被当成替换模式', buildRewriteInstruction('a $& b').includes('a $& b'));
    ok('摘要里的 $` 不被当成替换模式', buildRewriteInstruction('a $` b').includes('a $` b'));
  }

  // -------------------------------------------------------------------------
  // 模型清单与探活：全用假的 llm
  // -------------------------------------------------------------------------
  {
    const makeFakeLlm = (options = {}) => {
      const calls = { streams: 0, lists: 0, resolves: 0, requests: [] };
      const llm = {
        listProviders: () => [
          { id: 'prov-a', name: 'Provider A' },
          { id: 'prov-broken', name: 'Provider Broken' },
        ],
        async listModels(provider) {
          calls.lists += 1;
          if (provider === 'prov-broken') throw new Error('this adapter is not configured');
          return [{ provider, id: 'model-1', name: 'Model One' }];
        },
        async resolveModelInfo(provider, model) {
          calls.resolves += 1;
          if (model === 'ghost') throw new Error('provider "prov-a" does not know model "ghost"');
          return { provider, id: model, name: model };
        },
        stream(request) {
          calls.streams += 1;
          calls.requests.push(request);
          const kind = options.kind ?? 'stop';
          return (async function* () {
            if (kind === 'error') {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: 'invalid api key', code: 'AUTH', status: 401 } } };
              return;
            }
            yield { type: 'text-delta', index: 0, text: 'ok' };
            yield { type: 'finish', reason: { kind } };
          })();
        },
      };
      return { calls, llm };
    };

    const fake = makeFakeLlm();
    const catalog = await readModelCatalog(fake.llm);
    is('清单按 provider 分组', catalog.providers.map((group) => group.id).join(','), 'prov-a');
    is('清单带上该 provider 的模型', catalog.providers[0].models.map((model) => model.id).join(','), 'model-1');
    is('坏掉的 provider 进 failures 而不是让整份清单塌掉', catalog.failures.map((entry) => entry.id).join(','), 'prov-broken');

    is('探活的输出上限是 8 token', PROBE_MAX_TOKENS, 8);
    const probed = await probeModel(fake.llm, 'prov-a', 'model-1');
    is('探通时终结原因是 stop', probed.finish, 'stop');
    is('探活真的发了一次请求', fake.calls.streams, 1);
    is('探活的输出上限被传下去', fake.calls.requests[0].maxTokens, PROBE_MAX_TOKENS);
    // 这条原先断言的是**反过来的**：探活不带会话号。那是修之前的写法，而修之前的
    // 写法在本机 provider 上根本不工作——`dsh-opencode-session` 只有在请求带
    // `sessionId` 时才会加上 `x-opencode-session` 头，不带就被上游吊住，探活永远
    // 等不到回应，于是把一个可用的模型判成不可用。
    //
    // 2026.09.19 的整树套件把这条抓了出来：断言停留在旧行为上，实现已经修好，两边
    // 不一致。**断言必须描述正确行为，不是当时碰巧的行为。**
    ok('探活请求带会话号（不带会被上游吊住）', typeof fake.calls.requests[0].sessionId === 'string' && fake.calls.requests[0].sessionId.length > 0);

    let unregistered = null;
    try {
      await probeModel(fake.llm, 'prov-nope', 'model-1');
    } catch (error) {
      unregistered = String(error?.message ?? error);
    }
    ok('未注册的 provider 被拒绝', unregistered !== null && unregistered.includes('not registered'));
    ok('拒绝时列出真正注册了的 provider', unregistered.includes('prov-a'));

    let ghost = null;
    try {
      await probeModel(fake.llm, 'prov-a', 'ghost');
    } catch (error) {
      ghost = String(error?.message ?? error);
    }
    ok('模型元数据取不到就拒绝', ghost !== null && ghost.includes('does not know model'));

    const broken = makeFakeLlm({ kind: 'error' });
    let badKey = null;
    try {
      await probeModel(broken.llm, 'prov-a', 'model-1');
    } catch (error) {
      badKey = String(error?.message ?? error);
    }
    ok('以 error 收尾的探活被拒绝', badKey !== null && badKey.includes('finished as error'));
    ok('拒绝时带出 provider 的原话', badKey.includes('invalid api key'));
    ok('拒绝时带出 HTTP 状态', badKey.includes('401'));

    let notRegistered = null;
    try {
      requireRegisteredProvider(fake.llm, 'prov-nope');
    } catch (error) {
      notRegistered = String(error?.message ?? error);
    }
    ok('注册检查单独可用', notRegistered !== null && notRegistered.includes('prov-a'));
  }

  // -------------------------------------------------------------------------
  // 设置补丁：新增字段不能顺手把别的字段抹掉
  //
  // 写路由走的是 `scope.replace`，所以补丁里没提到的字段必须显式带过去；否则
  // 「保存一次改写设置」会把机械兜底开关一起重置。
  // -------------------------------------------------------------------------
  {
    const current = {
      enabled: true,
      agents: {},
      retrieval: 'granular',
      retrievalAgents: {},
      throttle: true,
      fallbackEnabled: true,
      fallbackAfterFailures: 3,
      rewriteEnabled: false,
      rewriteProvider: '',
      rewriteModel: '',
      tracePath: '<tmp>/zip-trace.log',
    };
    const patched = applySettingsPatch(current, { rewriteModel: 'm2' });
    is('改模型不会抹掉兜底开关', patched.fallbackEnabled, true);
    is('改模型不会抹掉兜底次数', patched.fallbackAfterFailures, 3);
    is('改模型不会抹掉节流开关', patched.throttle, true);
    is('改模型不会抹掉 tracePath', patched.tracePath, '<tmp>/zip-trace.log');
    is('改模型真的改了模型', patched.rewriteModel, 'm2');
    const turnedOn = applySettingsPatch(current, { rewriteEnabled: true, rewriteProvider: 'p', rewriteModel: 'm' });
    is('打开改写会落到存储值里', turnedOn.rewriteEnabled, true);
    is('打开改写时来源也落下去', `${turnedOn.rewriteProvider}/${turnedOn.rewriteModel}`, 'p/m');
    const cleared = applySettingsPatch(current, { rewriteProvider: '', rewriteModel: '' });
    is('空串表示清掉选择', `${cleared.rewriteProvider}|${cleared.rewriteModel}`, '|');
    is('只改兜底开关不会动改写档位', applySettingsPatch(current, { fallbackEnabled: false }).rewriteModel, '');
    is('没提到任何已知字段就什么都不做', applySettingsPatch(current, { unknown: 1 }), null);
  }

  // -------------------------------------------------------------------------
  // `/dsh-context-zip/models`：面板的模型下拉框读它
  // -------------------------------------------------------------------------
  {
    const captured = [];
    const dispose = registerRoutes(
      { get: (name) => (name === 'webServer' ? { register: (spec) => { captured.push(spec); return () => {}; } } : undefined) },
      {
        readSettings: () => ({ enabled: false, agents: {} }),
        readEffectiveMode: () => ({ compaction: 'default', source: 'default' }),
        listSegments: () => [],
        readModeFor: () => null,
        listModels: async () => ({
          providers: [{ id: 'prov-a', name: 'Provider A', models: [{ id: 'model-1', name: 'Model One' }] }],
          failures: [{ id: 'prov-broken', name: 'Provider Broken', message: 'not configured' }],
        }),
      },
    );
    const route = captured.find((spec) => spec.path === '/dsh-context-zip/models');
    is('models route: registered', route !== undefined, true);
    is('models route: exact match', route?.kind, 'exact');
    // 这条路由要 await 清单，所以 handler 返回的是 Promise，必须等它写完响应。
    const call = async (method = 'GET', remote = '127.0.0.1') => {
      let status = 0;
      let body = '';
      await route.handler(
        { method, url: '/dsh-context-zip/models', socket: { remoteAddress: remote } },
        { writeHead: (code) => { status = code; }, end: (text) => { body = text; } },
      );
      return { status, body: body.length === 0 ? {} : JSON.parse(body) };
    };
    const listed = await call();
    is('models route: 200', listed.status, 200);
    is('models route: 带上 provider 分组', listed.body.providers[0].id, 'prov-a');
    is('models route: 带上 provider 的模型', listed.body.providers[0].models[0].id, 'model-1');
    is('models route: 带上读不到的 provider', listed.body.failures[0].id, 'prov-broken');
    is('models route: 非 GET 拒绝', (await call('POST')).status, 405);
    is('models route: 非回环调用者拒绝', (await call('GET', '10.0.0.7')).status, 405);
    is('models route: 一个注册一个 disposer', dispose.length, captured.length);
  }

  // -------------------------------------------------------------------------
  // `/dsh-context-zip/wire`：接线状态与接线动作
  //
  // 一条路由两个动词。GET 答「接了没有」，POST 真去写文件。写的是 profile 里的
  // `node_modules/@deepseek-ai/dsh-compaction-basic/`，所以它按写路由的口径设门：非回环
  // 一律 403、POST 必须带 JSON 内容类型（跨站表单发不出这个头）。动作失败不是 200 带
  // 一句 ok：状态码与 `error` 都要带上，面板照着显示。
  // -------------------------------------------------------------------------
  {
    const captured = [];
    let statusAnswer = { wired: false, version: null, copiedAt: null, stale: false, foreign: false };
    let statusThrows = null;
    let actionAnswer = { wired: true, version: '9.9.9-shipped', copiedAt: '2026-09-21T10:00:00.000Z', source: '/tmp/shipped' };
    let actionThrows = null;
    const dispose = registerRoutes(
      { get: (name) => (name === 'webServer' ? { register: (spec) => { captured.push(spec); return () => {}; } } : undefined) },
      {
        readWireStatus: async () => {
          if (statusThrows !== null) throw statusThrows;
          return statusAnswer;
        },
        wireRow: async () => {
          if (actionThrows !== null) throw actionThrows;
          return actionAnswer;
        },
      },
    );
    const route = captured.find((spec) => spec.path === '/dsh-context-zip/wire');
    is('wire route: registered', route !== undefined, true);
    is('wire route: exact match', route?.kind, 'exact');
    const call = async ({ method = 'GET', remote = '127.0.0.1', contentType = null, body = null } = {}) => {
      let status = 0;
      let text = '';
      const req = {
        method,
        url: '/dsh-context-zip/wire',
        headers: contentType === null ? {} : { 'content-type': contentType },
        socket: { remoteAddress: remote },
        on: () => {},
        destroy: () => {},
      };
      await route.handler(req, { writeHead: (code) => { status = code; }, end: (payload) => { text = payload; } });
      return { status, body: text.length === 0 ? {} : JSON.parse(text) };
    };

    const unwired = await call();
    is('wire route: GET 200', unwired.status, 200);
    is('wire route: 未接线时 GET 报未接线', unwired.body.wired, false);
    is('wire route: 未接线时不编造版本', unwired.body.version, null);
    is('wire route: GET 带 ok', unwired.body.ok, true);
    // 进程启动时间是路由现算的字段：未接线也要有，因为「等待重启」比的是它与戳，而不是
    // 接线状态；`readWireStatus` 的替身没有这个字段，所以这条同时钉住落点在路由这一层。
    is('wire route: 未接线时也带进程启动时间', typeof unwired.body.processStartedAt, 'string');
    ok('wire route: 进程启动时间可解析', Number.isFinite(Date.parse(unwired.body.processStartedAt)));
    ok('wire route: 进程启动时间不晚于此刻', Date.parse(unwired.body.processStartedAt) <= Date.now());

    statusAnswer = { wired: true, version: '0.1.5-rc.2', copiedAt: '2026-09-21T10:00:00.000Z', stale: true, foreign: false };
    const wired = await call();
    is('wire route: 已接线时 GET 报版本', wired.body.version, '0.1.5-rc.2');
    is('wire route: 已接线时 GET 报时间', wired.body.copiedAt, '2026-09-21T10:00:00.000Z');
    is('wire route: 已接线时 GET 带落后标记', wired.body.stale, true);
    is('wire route: 已接线时 GET 也带进程启动时间', typeof wired.body.processStartedAt, 'string');

    statusThrows = new Error('no profile');
    const unreadable = await call();
    is('wire route: 状态读不到时答 500，不假装未接线', unreadable.status, 500);
    is('wire route: 状态读不到时带上原因', unreadable.body.error, 'no profile');
    statusThrows = null;

    const wiredUp = await call({ method: 'POST', contentType: 'application/json', body: '{}' });
    is('wire route: POST 200', wiredUp.status, 200);
    // POST 的答复也要带进程启动时间：面板点完「接管」就是拿这一份载荷判定的，缺了它
    // 会把「等待重启」误判成「已生效」——刚写下的戳必然比本进程启动时间新。
    is('wire route: POST 也带进程启动时间', typeof wiredUp.body.processStartedAt, 'string');
    ok('wire route: POST 的进程启动时间可解析', Number.isFinite(Date.parse(wiredUp.body.processStartedAt)));
    ok('wire route: POST 的进程启动时间不晚于此刻', Date.parse(wiredUp.body.processStartedAt) <= Date.now());
    is('wire route: POST 回报已接线', wiredUp.body.wired, true);
    is('wire route: POST 回报包装的版本', wiredUp.body.version, '9.9.9-shipped');

    actionThrows = new Error('holds a real @deepseek-ai/dsh-compaction-basic');
    const refused = await call({ method: 'POST', contentType: 'application/json', body: '{}' });
    is('wire route: 动作被拒时答 500', refused.status, 500);
    is('wire route: 动作被拒时把原因原样带给面板', refused.body.error, 'holds a real @deepseek-ai/dsh-compaction-basic');
    is('wire route: 动作被拒时不报 ok', refused.body.ok, false);
    actionThrows = null;

    is('wire route: POST 不带 JSON 内容类型拒绝', (await call({ method: 'POST', contentType: 'text/plain' })).status, 415);
    is('wire route: PUT 拒绝', (await call({ method: 'PUT', contentType: 'application/json' })).status, 405);
    is('wire route: 非回环 GET 拒绝', (await call({ remote: '10.0.0.7' })).status, 403);
    is(
      'wire route: 非回环 POST 拒绝',
      (await call({ method: 'POST', remote: '10.0.0.7', contentType: 'application/json', body: '{}' })).status,
      403,
    );
    is('wire route: 一个注册一个 disposer', dispose.length, captured.length);
  }

  // -------------------------------------------------------------------------
  // 接线动作：真文件系统
  //
  // 这一段一个真机 profile 都不碰：全部在 /tmp 的临时目录里造一个 profile
  // （`home/profiles/web` 加上 `home/profiles/node_modules` 里的真实后端）和一个插件目录
  // （含 `redirect/`）。钉的是那颗按钮的全部承诺：未接线时读得出未接线、接线写出三个文件
  // 与戳、目标被真包占着时拒绝且一个字节都不动、第二次接线与第一次结果相同。守卫另有三条：
  // 软链把目标带出 profile 时拒绝、`node_modules` 整条指外时拒绝、插件自己的 `redirect/`
  // 文件缺失时拒绝且不把已接好的东西清掉（拒绝必须发生在清目录之前）。
  // -------------------------------------------------------------------------
  {
    const probe = await mkdtemp(join(tmpdir(), 'zc-wire-'));
    const priorHome = process.env.DSH_HOME;
    const setHome = (value) => {
      if (value === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = value;
    };
    try {
      const home = join(probe, 'home');
      const profileDir = join(home, 'profiles', 'web');
      const modulesRoot = join(profileDir, 'node_modules');
      const shippedDir = join(home, 'profiles', 'node_modules', REDIRECT_PACKAGE);
      const pluginDir = join(probe, 'plugin');
      const redirectDir = join(modulesRoot, REDIRECT_PACKAGE);
      const at = (dir) => pathToFileURL(dir).href;

      await mkdir(shippedDir, { recursive: true });
      await mkdir(join(profileDir, 'node_modules'), { recursive: true });
      await mkdir(join(pluginDir, 'redirect'), { recursive: true });
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }));
      await writeFile(
        join(shippedDir, 'package.json'),
        JSON.stringify({ name: REDIRECT_PACKAGE, version: '9.9.9-shipped', exports: { '.': { default: './index.js' } } }),
      );
      await writeFile(join(shippedDir, 'index.js'), 'export const BasicCompactionEngine = 1;\n');
      await writeFile(
        join(pluginDir, 'redirect', 'package.json'),
        JSON.stringify({ name: REDIRECT_PACKAGE, version: `0.1.0-${REDIRECT_MARKER}`, private: true, type: 'module', main: 'index.js' }),
      );
      await writeFile(
        join(pluginDir, 'redirect', 'index.js'),
        "import { BasicCompactionEngine } from './base.js';\nexport default BasicCompactionEngine;\n",
      );

      const options = { baseUrl: at(profileDir), pluginDir };

      const before = await readWireStatus(options);
      is('wire action: 未接线时状态报未接线', before.wired, false);
      is('wire action: 未接线时没有版本', before.version, null);
      is('wire action: 未接线时没有时间', before.copiedAt, null);
      is('wire action: 未接线时不报被占', before.foreign, false);
      is('wire action: 未接线时目标目录不存在', existsSyncSafe(redirectDir), false);

      const done = await wireCompactionRow(options);
      is('wire action: 接线回报已接线', done.wired, true);
      is('wire action: 接线回报包装的版本', done.version, '9.9.9-shipped');
      is('wire action: 写出 index.js', existsSyncSafe(join(redirectDir, 'index.js')), true);
      is('wire action: 写出 package.json', existsSyncSafe(join(redirectDir, 'package.json')), true);
      is('wire action: 写出 base.js', existsSyncSafe(join(redirectDir, 'base.js')), true);
      is('wire action: 写出戳', existsSyncSafe(join(redirectDir, STAMP_FILE)), true);
      is(
        'wire action: 没有多写出别的文件',
        (await readdir(redirectDir)).sort().join(','),
        ['base.js', STAMP_FILE, 'index.js', 'package.json'].sort().join(','),
      );
      is(
        'wire action: index.js 来自插件自己的 redirect/',
        await readFile(join(redirectDir, 'index.js'), 'utf8'),
        await readFile(join(pluginDir, 'redirect', 'index.js'), 'utf8'),
      );
      is(
        'wire action: package.json 来自插件自己的 redirect/',
        await readFile(join(redirectDir, 'package.json'), 'utf8'),
        await readFile(join(pluginDir, 'redirect', 'package.json'), 'utf8'),
      );
      is('wire action: base.js 是真实后端的入口内容', await readFile(join(redirectDir, 'base.js'), 'utf8'), 'export const BasicCompactionEngine = 1;\n');
      const stamp = JSON.parse(await readFile(join(redirectDir, STAMP_FILE), 'utf8'));
      is('wire action: 戳的键与 install.mjs 一致', Object.keys(stamp).sort().join(','), ['copiedAt', 'package', 'source', 'version'].sort().join(','));
      is('wire action: 戳点名被包装的包', stamp.package, REDIRECT_PACKAGE);
      is('wire action: 戳记下后端版本', stamp.version, '9.9.9-shipped');
      is('wire action: 戳记下后端目录', stamp.source, shippedDir);
      ok('wire action: 戳带一个可解析的时间', Number.isFinite(Date.parse(stamp.copiedAt)));

      const after = await readWireStatus(options);
      is('wire action: 接线后状态报已接线', after.wired, true);
      is('wire action: 接线后状态报版本', after.version, '9.9.9-shipped');
      is('wire action: 接线后状态报时间', after.copiedAt, stamp.copiedAt);
      is('wire action: 接线后状态同时报内置当前的版本', after.current, '9.9.9-shipped');
      is('wire action: 后端没换时不报落后', after.stale, false);

      // ── 幂等：第二次接线的结果与第一次逐字节相同（戳的时间除外） ────────────
      const firstSet = (await readdir(redirectDir)).sort().join(',');
      const firstIndex = await readFile(join(redirectDir, 'index.js'), 'utf8');
      const firstBase = await readFile(join(redirectDir, 'base.js'), 'utf8');
      const again = await wireCompactionRow(options);
      is('wire action: 第二次接线仍报同一版本', again.version, '9.9.9-shipped');
      is('wire action: 第二次接线文件集合不变', (await readdir(redirectDir)).sort().join(','), firstSet);
      is('wire action: 第二次接线 index.js 内容不变', await readFile(join(redirectDir, 'index.js'), 'utf8'), firstIndex);
      is('wire action: 第二次接线 base.js 内容不变', await readFile(join(redirectDir, 'base.js'), 'utf8'), firstBase);
      is('wire action: 第二次接线后仍是已接线', (await readWireStatus(options)).wired, true);

      // ── 内置后端换版：戳还是旧的，「待更新」那一态要把两个版本都拿到 ─────────
      await writeFile(
        join(shippedDir, 'package.json'),
        JSON.stringify({ name: REDIRECT_PACKAGE, version: '9.9.10-shipped', exports: { '.': { default: './index.js' } } }),
      );
      const upgraded = await readWireStatus(options);
      is('wire action: 后端换版时状态报落后', upgraded.stale, true);
      is('wire action: 后端换版时快照版本仍是戳里那个', upgraded.version, '9.9.9-shipped');
      is('wire action: 后端换版时另报内置当前版本', upgraded.current, '9.9.10-shipped');
      await writeFile(
        join(shippedDir, 'package.json'),
        JSON.stringify({ name: REDIRECT_PACKAGE, version: '9.9.9-shipped', exports: { '.': { default: './index.js' } } }),
      );

      // ── 目标被真包占着：拒绝，且原封不动 ────────────────────────────────────
      await rm(redirectDir, { recursive: true, force: true });
      await mkdir(redirectDir, { recursive: true });
      await writeFile(join(redirectDir, 'package.json'), JSON.stringify({ name: REDIRECT_PACKAGE, version: '9.9.9-real' }));
      await writeFile(join(redirectDir, 'index.js'), 'export default "somebody else";\n');
      const occupied = await readWireStatus(options);
      is('wire action: 被真包占着时状态报未接线', occupied.wired, false);
      is('wire action: 被真包占着时状态点名被占', occupied.foreign, true);
      let occupiedError = '';
      try {
        await wireCompactionRow(options);
      } catch (error) {
        occupiedError = String(error?.message ?? error);
      }
      ok('wire action: 目标被真包占着时拒绝', occupiedError.includes('refusing to overwrite'));
      ok('wire action: 拒绝的话点名那个真包', occupiedError.includes(REDIRECT_PACKAGE));
      is('wire action: 拒绝之后真包自己那个文件原封不动', await readFile(join(redirectDir, 'index.js'), 'utf8'), 'export default "somebody else";\n');
      is('wire action: 拒绝之后没有留下 base.js', existsSyncSafe(join(redirectDir, 'base.js')), false);
      is('wire action: 拒绝之后没有留下戳', existsSyncSafe(join(redirectDir, STAMP_FILE)), false);

      // ── 插件自己的 redirect/ 缺失：拒绝，且发生在清目录之前 ─────────────────
      await rm(redirectDir, { recursive: true, force: true });
      is('wire action: 清掉被占的目录后能重新接上', (await wireCompactionRow(options)).wired, true);
      const bare = join(probe, 'bare-plugin');
      await mkdir(bare, { recursive: true });
      let bareError = '';
      try {
        await wireCompactionRow({ baseUrl: at(profileDir), pluginDir: bare });
      } catch (error) {
        bareError = String(error?.message ?? error);
      }
      ok('wire action: 插件自己的 redirect/ 缺失时拒绝', bareError.includes('redirect files are missing'));
      is('wire action: 那次拒绝没有把已接好的 base.js 清掉', existsSyncSafe(join(redirectDir, 'base.js')), true);

      // ── 软链把目标带出 profile：拒绝，外面一个字节都不写 ────────────────────
      const outside = join(probe, 'outside', '@deepseek-ai');
      const escapeHome = join(probe, 'escape-home');
      const escapeProfile = join(escapeHome, 'profiles', 'web');
      await mkdir(outside, { recursive: true });
      await mkdir(join(escapeProfile, 'node_modules'), { recursive: true });
      await writeFile(join(escapeProfile, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }));
      await symlink(outside, join(escapeProfile, 'node_modules', '@deepseek-ai'));
      let escapeError = '';
      try {
        await wireCompactionRow({ baseUrl: at(escapeProfile), pluginDir });
      } catch (error) {
        escapeError = String(error?.message ?? error);
      }
      ok('wire action: 目标被软链带出 profile 时拒绝', escapeError.includes('outside the profile'));
      is('wire action: 被拒之后 profile 外没有被写进重定向', existsSyncSafe(join(outside, REDIRECT_PACKAGE)), false);

      // ── node_modules 整条指外：同样拒绝（容器那一道判据） ────────────────────
      const escapeTwo = join(probe, 'escape-home-two');
      const escapeTwoProfile = join(escapeTwo, 'profiles', 'web');
      const vendorOutside = join(probe, 'vendor-outside');
      await mkdir(escapeTwoProfile, { recursive: true });
      await mkdir(vendorOutside, { recursive: true });
      await writeFile(join(escapeTwoProfile, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }));
      await symlink(vendorOutside, join(escapeTwoProfile, 'node_modules'));
      let containerError = '';
      try {
        await wireCompactionRow({ baseUrl: at(escapeTwoProfile), pluginDir });
      } catch (error) {
        containerError = String(error?.message ?? error);
      }
      ok('wire action: node_modules 整条指外时拒绝', containerError.includes('outside the profile'));
      is('wire action: 容器被拒之后外面同样没有写入', existsSyncSafe(join(vendorOutside, '@deepseek-ai')), false);

      // ── profile 从哪儿来：上下文基址优先，绝不用插件自己的 realpath ──────────
      //
      // pnpm 软链陷阱的形状就是「基址等于插件自己所在目录」。那时写下去会把重定向塞进
      // 包管理器的存储，所以这里必须拒绝，而不是照着基址写。
      setHome(join(probe, 'no-such-home'));
      let trapError = '';
      try {
        await wireCompactionRow({ baseUrl: at(pluginDir), pluginDir });
      } catch (error) {
        trapError = String(error?.message ?? error);
      }
      ok('wire action: 基址是插件自己所在目录时拒绝而不是照写', trapError.includes('not a profile'));
      ok('wire action: 那句拒绝说清基址是插件自己的目录', trapError.includes('this plugin itself lives in'));

      // home 那条后备：只有 `<profile>/node_modules/dsh-context-zip` 真的就是这个插件时才算。
      const fbHome = join(probe, 'fallback-home');
      const fbProfile = join(fbHome, 'profiles', 'web');
      await mkdir(join(fbProfile, 'node_modules'), { recursive: true });
      await writeFile(join(fbProfile, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }));
      await symlink(pluginDir, join(fbProfile, 'node_modules', 'dsh-context-zip'));
      setHome(fbHome);
      is('wire action: 上下文没有基址时从 home 找出真正装了本插件的 profile', await resolveProfileDirectory(undefined, pluginDir), fbProfile);
      is('wire action: 基址指错时退回 home 找到的那个 profile', await resolveProfileDirectory(at(pluginDir), pluginDir), fbProfile);
    } finally {
      setHome(priorHome);
      await rm(probe, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 面板上的会话行印的是会话标题，而不是一串 session id。名字走
  // `sessionQuery.readTitleSnapshots`：面板列的是整张覆盖表，大多数行的会话此刻并没
  // 打开，而 `sessionTitle` 只认活会话（对不上的直接抛），走它等于大部分行印不出名
  // 字。`sessionQuery` 认活会话也认落过盘的持久化会话，一次批量读带回逐条状态。
  // 下面钉住新的边界——有标题取标题并 trim、没有标题或不是会话的键不进 map（面板回退
  // 印 id）、批次里一条 rejected 不牵连其它条、整次调用抛错只降级、服务没装或没这个
  // 方法返回空 map、非字符串键与重复键先过滤去重再发出去。
  {
    const titles = {
      'session-aaa': { title: '  写入要点的两处  ' },
      'session-ccc': { title: '关闭了也能读到的会话' },
      'session-ddd': { title: '' },
    };
    const observed = [];
    const withQuery = (result) => ({
      get: (name) => (name === 'sessionQuery'
        ? { readTitleSnapshots: async (ids) => { observed.push(ids); return result; } }
        : undefined),
    });
    const fulfilled = (id) => ({ sessionId: id, status: 'fulfilled', value: { session: { id }, title: titles[id] } });
    const both = [fulfilled('session-aaa'), fulfilled('session-bbb')];
    const query = withQuery(both);

    is(
      'session titles: 有标题的 id 取标题，并去掉首尾空白',
      (await sessionTitlesFor(query, ['session-aaa']))['session-aaa'],
      '写入要点的两处',
    );
    // session-bbb 有 fulfilled 结果但根本没带 title 投影。
    is(
      'session titles: 没有标题投影的 id 不放进 map（面板回退印 id）',
      'session-bbb' in (await sessionTitlesFor(query, ['session-bbb'])),
      false,
    );
    is(
      'session titles: 宿主报空的标题不放进 map（面板回退印 id）',
      'session-ddd' in (await sessionTitlesFor(withQuery([fulfilled('session-ddd')]), ['session-ddd'])),
      false,
    );
    is(
      'session titles: 不是会话的键（预设名）不放进 map',
      'code-review-preset' in (await sessionTitlesFor(withQuery([]), ['code-review-preset'])),
      false,
    );
    // 这一条是本轮的正题：那个会话此刻没有活会话，只有持久化来源的一份标题。
    is(
      'session titles: 会话没打开（只有持久化结果、没有活会话）也能拿到名字',
      (await sessionTitlesFor(withQuery([fulfilled('session-ccc')]), ['session-ccc']))['session-ccc'],
      '关闭了也能读到的会话',
    );
    // 逐条隔离：一条 rejected 只让它自己缺席，同批的 fulfilled 照常进 map。
    is(
      'session titles: 一条 rejected 不影响同批其它条',
      JSON.stringify(await sessionTitlesFor(
        withQuery([fulfilled('session-aaa'), { sessionId: 'session-bbb', status: 'rejected', reason: new Error('x') }]),
        ['session-aaa', 'session-bbb'],
      )),
      JSON.stringify({ 'session-aaa': '写入要点的两处' }),
    );
    is(
      'session titles: 整次调用抛错返回空 map，不抛',
      JSON.stringify(await sessionTitlesFor(
        { get: (name) => (name === 'sessionQuery' ? { readTitleSnapshots: async () => { throw new Error('boom'); } } : undefined) },
        ['session-aaa'],
      )),
      '{}',
    );
    is(
      'session titles: 服务没装时返回空 map，不抛',
      JSON.stringify(await sessionTitlesFor({ get: () => undefined }, ['session-aaa'])),
      '{}',
    );
    is(
      'session titles: 服务装了但没有这个方法时返回空 map，不抛',
      JSON.stringify(await sessionTitlesFor({ get: (name) => (name === 'sessionQuery' ? {} : undefined) }, ['session-aaa'])),
      '{}',
    );
    // 入参先过滤去重，再发一次批量调用：覆盖表里混着预设名，键也可能重复。
    observed.length = 0;
    const filtered = await sessionTitlesFor(query, ['session-aaa', 'session-aaa', '', 42, null, undefined, 'session-bbb']);
    is(
      'session titles: 非字符串与空串键先被过滤再发出去',
      JSON.stringify(observed[0]),
      JSON.stringify(['session-aaa', 'session-bbb']),
    );
    is(
      'session titles: 重复键只发一次，返回的 map 仍然按会话号索引',
      Object.keys(filtered).length,
      1,
    );
    observed.length = 0;
    is(
      'session titles: 空入参不发调用，直接返回空 map',
      JSON.stringify(await sessionTitlesFor(query, [])),
      '{}',
    );
    is('session titles: 空入参没有发起批量读', observed.length, 0);
  }

  // -------------------------------------------------------------------------
  // 会话号判据：`src/session-key.ts` 一处原文
  //
  // 两张覆盖表都收 agent 预设名，预设名不可能是会话、也就不可能有名。判据此前只写在
  // 客户端（面板不渲染预设名那一行），服务端仍然拿预设名去问标题，白跑一次日志折叠。
  // 抽成共享模块之后两侧问的是同一个答案，所以先把判据本身钉住。
  // -------------------------------------------------------------------------
  {
    is('会话号判据：会话号形态的键是会话', isSessionKey('session-aaa'), true);
    is('会话号判据：带连字符的会话号是会话', isSessionKey('session-11111111-2222-3333-4444-555555555555'), true);
    is('会话号判据：预设名不是会话', isSessionKey('code-review-preset'), false);
    is('会话号判据：空串不是会话', isSessionKey(''), false);
    is('会话号判据：非字符串不是会话', isSessionKey(42), false);
    is('会话号判据：共享正则仍是那一条', SESSION_KEY.source, '^session-[A-Za-z0-9-]{1,120}$');
  }

  // -------------------------------------------------------------------------
  // 标题备忘录：面板打开不再等日志折叠
  //
  // 实测 `GET /settings` 2.35 s，同一插件的 `/live` 0.0007 s；差的就是
  // `sessionQuery.readTitleSnapshots` 逐个会话折叠事件日志（7 个键里有一个 31 MB 的
  // 日志）。备忘录把这次折叠挪出请求路径：请求答备忘录里现有的名字（第一次可能是空
  // 的，面板照旧印会话号），冷/过期时在后台起一次刷新。下面钉住三条边界——路由层不等
  // 折叠、命中备忘录不再问宿主、并发只发一次；预设名在服务端就被剔掉，不进入取名调用。
  // -------------------------------------------------------------------------
  {
    const captured = [];
    const hostCalls = [];
    // 宿主读取端折一次日志要 2.35 秒，所以这里让它挂着不回来：请求路径若还 await 它，
    // 响应永远写不出来，判据会直接失败，而不是靠计时去猜。
    let release = null;
    const resolveTitles = (value) => {
      const settle = release;
      release = null;
      settle?.(value);
    };
    const settings = {
      enabled: true,
      agents: { 'session-aaa': true, 'code-review-preset': true },
      retrievalAgents: { 'session-bbb': 'batched' },
    };
    registerRoutes(
      {
        get: (name) =>
          name === 'webServer'
            ? { register: (spec) => { captured.push(spec); return () => {}; } }
            : undefined,
      },
      {
        readSettings: () => settings,
        readEffectiveMode: () => ({ compaction: 'plugin', source: 'settings' }),
        // 直接给备忘录的读取端，绕开 `ctx.get('sessionQuery')`：这里测的是路由与备忘录
        // 的边界，宿主读取端自己的降级行为在上面那组判据里。
        readSessionTitles: (keys) => {
          hostCalls.push([...keys]);
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        createTitles: (deps) => createTitleMemo({ read: deps.read }),
      },
    );
    const routeFor = (path) => captured.find((spec) => spec.path === path);
    const settingsRoute = routeFor('/dsh-context-zip/settings');
    const liveRoute = routeFor('/dsh-context-zip/live');
    is('title memo: /settings registered', settingsRoute !== undefined, true);
    is('title memo: /live registered', liveRoute !== undefined, true);

    const call = (route) => {
      let status = 0;
      let body = '';
      // The host read is left HANGING on purpose (see `resolveTitles`): the response
      // being written at all, with the fold still outstanding, is the proof that the
      // fold is off the request path.
      let callsAtEnd = 0;
      const returned = route.handler(
        { method: 'GET', url: `/dsh-context-zip${route.path.slice('/dsh-context-zip'.length)}`, socket: { remoteAddress: '127.0.0.1' } },
        {
          writeHead: (code) => { status = code; },
          end: (text) => {
            body = text;
            callsAtEnd = hostCalls.length;
          },
        },
      );
      // 路由层不许把折叠 await 进请求路径：handler 同步返回、响应当场写完。
      const thenable = returned !== null && typeof returned === 'object' && typeof returned.then === 'function';
      return { status, payload: JSON.parse(body), thenable, callsAtEnd };
    };

    const cold = call(settingsRoute);
    is('title memo: 冷启动 /settings 答 200', cold.status, 200);
    is('title memo: 冷启动 /settings 同步返回、不 await 折叠', cold.thenable, false);
    is('title memo: 冷启动那次响应里没有名字', JSON.stringify(cold.payload.titles), '{}');
    is(
      'title memo: 冷启动 /settings 仍带上设置值与模式',
      `${JSON.stringify(cold.payload.value)}|${cold.payload.effective?.compaction}`,
      `${JSON.stringify(settings)}|plugin`,
    );
    // 这一条是「路由层不等折叠」的正面证据：宿主那次折叠还挂着没回来，响应已经写完了。
    is('title memo: 冷启动时折叠还挂着，响应已写完', cold.callsAtEnd, 1);
    is('title memo: 冷启动那次答案是空表，不是折叠结果', JSON.stringify(cold.payload.titles), '{}');

    // 后台刷新读到之后，名字进备忘录；下一次读就能带上。
    is('title memo: 冷启动只发了一次取名调用', hostCalls.length, 1);
    is(
      'title memo: 取名调用只带会话号的键（预设名在服务端被剔掉）',
      JSON.stringify(hostCalls[0]),
      JSON.stringify(['session-aaa', 'session-bbb']),
    );
    resolveTitles({ 'session-aaa': '写入要点的两处', 'session-bbb': '检索覆盖的会话' });
    await flush();

    // 同一个键集从 `/live` 问：备忘录覆盖得住，带的就是刚拿到的名字。
    const warm = call(liveRoute);
    is(
      'title memo: /live 载荷带上晚到的 titles',
      JSON.stringify(warm.payload.titles),
      JSON.stringify({ 'session-aaa': '写入要点的两处', 'session-bbb': '检索覆盖的会话' }),
    );
    const again = call(settingsRoute);
    is('title memo: settings 命中备忘录时也带 titles', again.payload.titles['session-aaa'], '写入要点的两处');
    is('title memo: 命中备忘录时不再发起取名调用', again.callsAtEnd, 1);
    await flush();
    is('title memo: 命中备忘录不再调用宿主取名接口', hostCalls.length, 1);
  }

  // -------------------------------------------------------------------------
  // 并发只跑一次刷新
  //
  // 面板可能在同一 tick 里发两次读（打开面板与保存各一次 effect），每次都会发现备忘录
  // 没覆盖。防重入在「一次刷新」这一层：同一会话号在同一时刻只折叠一次，第二个请求
  // 只把键并进这次刷新的队列，不另起一个折叠。
  // -------------------------------------------------------------------------
  {
    const captured = [];
    const hostCalls = [];
    registerRoutes(
      {
        get: (name) =>
          name === 'webServer'
            ? { register: (spec) => { captured.push(spec); return () => {}; } }
            : undefined,
      },
      {
        readSettings: () => ({ enabled: true, agents: { 'session-aaa': true } }),
        readEffectiveMode: () => ({ compaction: 'plugin', source: 'settings' }),
        readSessionTitles: async (keys) => {
          hostCalls.push([...keys]);
          return { 'session-aaa': '写入要点的两处' };
        },
        // 让「一次刷新」真的跨越一段时间：宿主读取端在刷新过程中还挂在 await 上，
        // 第二次请求才有机会落在刷新进行中。
        createTitles: (deps) =>
          createTitleMemo({
            read: async (keys) => {
              await flush();
              return deps.read(keys);
            },
          }),
      },
    );
    const route = captured.find((spec) => spec.path === '/dsh-context-zip/settings');
    const call = () => {
      let body = '';
      route.handler(
        { method: 'GET', url: '/dsh-context-zip/settings', socket: { remoteAddress: '127.0.0.1' } },
        { writeHead: () => {}, end: (text) => { body = text; } },
      );
      return JSON.parse(body);
    };
    call();
    call();
    // 两次请求都答空表（第一次是冷的；第二次的键已经在同一次刷新里跑着，不会另起一次）。
    is('title memo: 并发的两次请求都没等折叠', hostCalls.length, 0);
    await flush();
    await flush();
    is('title memo: 同一个会话号只折叠一次', hostCalls.length, 1);
    is('title memo: 并发时只发了这一个会话号', JSON.stringify(hostCalls[0]), JSON.stringify(['session-aaa']));
    const answer = call();
    is('title memo: 并发之后备忘录已经有名字', answer.titles['session-aaa'], '写入要点的两处');
    await flush();
    is('title memo: 并发之后没有补发调用', hostCalls.length, 1);
  }

  // -------------------------------------------------------------------------
  // 备忘录自己的时钟：TTL 到了才重取，且重取覆盖整张表
  //
  // 路由无法测 TTL（60 秒），所以时钟由 `createTitleMemo` 注入。
  // -------------------------------------------------------------------------
  {
    let clock = 0;
    const calls = [];
    const memo = createTitleMemo({
      read: async (keys) => {
        calls.push([...keys]);
        return { 'session-aaa': '写入要点的两处', 'session-bbb': '检索覆盖的会话' };
      },
      now: () => clock,
    });
    is('title memo ttl: 公开的过期时间是 60 秒', TITLE_TTL_MS, 60_000);
    memo.titles(['session-aaa', 'session-bbb']);
    is('title memo ttl: 冷备忘录立刻答空表', JSON.stringify(memo.titles(['session-aaa'])), '{}');
    await flush();
    is('title memo ttl: 冷备忘录取一次', calls.length, 1);
    is(
      'title memo ttl: TTL 内第二次读命中备忘录',
      JSON.stringify(memo.titles(['session-aaa', 'session-bbb'])),
      JSON.stringify({ 'session-aaa': '写入要点的两处', 'session-bbb': '检索覆盖的会话' }),
    );
    is('title memo ttl: TTL 内没有再取', calls.length, 1);
    // 过期：闹钟一过，下一次读就要重取，而且重取的是整张表（`wanted`），不是只有这一
    // 次读到的那个键，否则另外几个名字会在过期那次刷新里被抹掉。
    clock = TITLE_TTL_MS;
    memo.titles(['session-aaa']);
    is('title memo ttl: 过期瞬间仍然答旧名字（不阻塞）', memo.titles(['session-aaa'])['session-aaa'], '写入要点的两处');
    await flush();
    is('title memo ttl: 过期后重取一次', calls.length, 2);
    is(
      'title memo ttl: 过期重取覆盖整张表，不只覆盖本次问到的键',
      JSON.stringify(calls[1]),
      JSON.stringify(['session-aaa', 'session-bbb']),
    );
  }

  // -------------------------------------------------------------------------
  // 面板重写（2026.09.20 落地，依据功能文档 §十二）。这一组钉的是「旧形态不会悄悄
  // 回来」：可编辑覆盖表的写路径与它的键形占位符必须彻底消失，新形态的几处标记必须
  // 在。列表形态、封顶步长、气泡定位这些行为判据不在这里，它们要么靠渲染 fixture，
  // 要么等真机验收。
  {
    const panel = await readFile(join(here, '..', 'client', 'index.ts'), 'utf8');
    for (const gone of ['updateRow', 'commitRows', 'setRows(', 'keyPlaceholder', 'agents-add']) {
      ok(`panel rewrite: 面板源码里不再出现旧表格编辑器的 ${gone}`, panel.includes(gone) === false);
    }
    for (const present of [
      "'复制会话 id'",
      'isSessionKey',
      '显示更多',
      '收起信息',
      'dsh-context-zip__srow-name',
      'dsh-context-zip__srow-name--id',
      'FALLBACK_ENABLED_COPY',
      'REWRITE_ENABLED_COPY',
    ]) {
      ok(`panel rewrite: 面板源码里必须有 ${present}`, panel.includes(present));
    }
    // 判据原文抽到 `src/session-key.ts` 之后，面板必须引那一处，并且自己只留一个
    // 会话号形态的字面量：`client/live.ts` 的 titles 清洗。面板里再写一份正则，两侧
    // 就又会各判各的。
    ok('panel rewrite: 面板从共享模块引会话号判据', panel.includes("from '../src/session-key.ts'"));
    is(
      'panel rewrite: 面板源码里不再自带一份会话号正则',
      (panel.match(/session-\[A-Za-z0-9-\]/g) ?? []).length,
      0,
    );
  }

  ok('and its neighbours are given up to make room', tightRendered.text.includes('Aaaa') === false);
  ok('a two-entry window one character short says it truncated', tightTwo.truncated === true);

  // The ordinary notice must still be what a multi-entry window gets.
  const manySmall = makeSession({ id: 'session-many' });
  for (let index = 0; index < 40; index += 1) {
    manySmall.append('user/message', { content: [{ type: 'text', text: `line ${index}` }] });
  }
  const manyText = renderTranscript(manySmall.snapshotEvents(), 1000);
  ok('a multi-entry window uses the ordinary truncation notice', manyText.text.includes('transcript truncated at 1000 characters'));
  ok('a multi-entry window is not described as clipped', !manyText.text.includes('exceeds the character budget'));

  // The mode record lives in the plugin's own store and never in the session
  // log. A session-log event would have to carry the harness's `ignorable`
  // marker, `Session.prototype.append` cannot set it, and the persistence read
  // path refuses to reconstruct a log carrying an unmarked type it does not
  // know — so the log route would make every session it touched unreopenable.
  // The export document: the spec fixes the file name and the header fields a
  // reader needs to find the same segment again.
  is('the export file is named after the session and segment', exportFileName('session-abc', 2), 'session-abc-seg-002.md');
  const surfaceOrdered = [
    { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'later' }] } } },
    { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'earlier' }] } },
    { seq: 8, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
  ];
  is('the export re-sorts surface order into event order', sortBySeq([...surfaceOrdered]).map((event) => event.seq).join(','), '3,8,11');
  const exportDoc = renderSegmentMarkdown(
    { id: 'session-abc' },
    {
      ordinal: 1,
      label: 'a label',
      compactionId: 'compaction-1',
      summarySeq: 42,
      shadowedRange: { start: 5, end: 3 },
      shadowedSeqs: [8, 3, 11],
      tokenCount: 900,
    },
    '## Goal and intent\nbody',
    sortBySeq([...surfaceOrdered]),
    { provider: 'deepseek-official', model: 'deepseek-flash', time: '2026-09-15T00:00:00.000Z' },
  );
  ok('the export names the replaced event range', exportDoc.includes('replaced event numbers: 3..11 (3 event(s))'));
  ok('the export names the compaction time', exportDoc.includes('compacted at: 2026-09-15T00:00:00.000Z'));
  ok('the export names the model', exportDoc.includes('model: deepseek-official/deepseek-flash'));
  // The fork boundary: `inheritedEventCount` is the durable answer and must win
  // over the persisted end-seed marker and the in-process construction fact.
  const seeded = { header: { isSeeded: true }, inheritedEventCount: 3, firstLiveSeq: 9 };
  is('a seeded session cuts at inheritedEventCount', ownHistoryStart(seeded, new Array(20).fill({ seq: 0 })), 3);
  is(
    'the end-seed marker answers when inheritedEventCount is absent',
    ownHistoryStart({ header: { isSeeded: true }, firstLiveSeq: 9 }, [
      { type: 'session/end-seed', seq: 4 },
      { type: 'user/message', seq: 5 },
    ]),
    5,
  );
  is(
    'firstLiveSeq answers when neither durable source is usable',
    ownHistoryStart({ header: { isSeeded: true }, firstLiveSeq: 6 }, [{ type: 'user/message', seq: 2 }].concat(new Array(6).fill({ type: 'x', seq: 3 }))),
    6,
  );
  is('an unseeded session owns its whole log', ownHistoryStart({ header: {} }, []), 0);

  // Notes search: every word must appear, in order, and the budget is honoured.
  const haystacks = [
    { label: 'draft', text: '- audit log is append-only\n- unrelated line\n' },
    { label: 'segment 0', text: '- next step: write the traceability test\n' },
  ];
  const noteHits = searchNoteLines(haystacks, 'audit append-only', 10);
  is('notes search finds a line containing every word in order', noteHits.length, 1);
  is('notes search labels the source', noteHits[0]?.label, 'draft');
  is('notes search spans the archive', searchNoteLines(haystacks, 'traceability', 10)[0]?.label, 'segment 0');
  is('notes search rejects out-of-order words', searchNoteLines(haystacks, 'append-only audit', 10).length, 0);
  is('notes search honours the budget', searchNoteLines(haystacks, 'the', 1).length, 1);
  is('an empty notes query matches nothing', searchNoteLines(haystacks, '   ', 10).length, 0);

  // The settings section's "mode in effect" line.
  const effective = effectiveMode({ on: 2, off: 1 });
  is('the effective mode reports the new-session answer', effective.compaction, 'default');
  is('the effective mode says it is the default', effective.source, 'default');
  process.env.DSH_HOME = root;
  is('an unset switch reports the default source', effectiveMode({ on: 0, off: 0 }).source, 'default');
  is('the effective mode carries the live snapshot counts', `${effective.live.on}/${effective.live.off}`, '2/1');
  is('the effective mode counts the override table', effective.overrides, 0);
  // The panel reports the global switch, so the override table must not leak
  // into it; the count is the only thing that crosses over.
  is('an override is counted for the panel hint', effective.overrides, 0);

  // The mode lookup itself. It is what decides which summarizer a session gets,
  // and it used to be reachable only through module-level state, so nothing
  // checked that the override table was consulted at all. It now takes the state
  // as an argument and can be driven directly.
  const state = (value, userEnabled, userAgents) => ({
    value,
    revision: 4,
    userEnabled,
    userAgents: new Set(userAgents ?? []),
  });
  const sessionWith = (id, agentPreset) => ({ id, header: agentPreset === undefined ? {} : { agentPreset } });

  const off = resolveModeFrom(state({ enabled: false, agents: {} }, true), sessionWith('session-a'));
  is('a bare session follows the global switch', off.compaction, 'default');
  is('an explicitly set global switch reports the settings source', off.source, 'settings');

  const on = resolveModeFrom(state({ enabled: true, agents: {} }, false), sessionWith('session-a'));
  is('the global switch turns the plugin on', on.compaction, 'plugin');
  is('a schema default reports the default source', on.source, 'default');

  const table = { enabled: false, agents: { standard: true, 'session-b': false } };
  const byPreset = resolveModeFrom(state(table, false, ['standard']), sessionWith('session-a', 'standard'));
  is('an agent preset overrides the global switch', byPreset.compaction, 'plugin');
  is('the preset override reports the settings source', byPreset.source, 'settings');
  is('the resolved mode carries the settings revision', byPreset.revision, 4);

  // Two sessions in one process, one state, opposite answers: this is the whole
  // point of the feature.
  const a = resolveModeFrom(state(table, false, ['standard', 'session-b']), sessionWith('session-a', 'standard'));
  const b = resolveModeFrom(state(table, false, ['standard', 'session-b']), sessionWith('session-b', 'standard'));
  is('the preset key wins for a session created under it', a.compaction, 'plugin');
  is('the session key wins over the preset the session shares', b.compaction, 'default');
  const c = resolveModeFrom(state(table, false, ['standard']), sessionWith('session-c', 'standard'));
  is('a session named by neither key falls through to the preset', c.compaction, 'plugin');
  const d = resolveModeFrom(state({ enabled: true, agents: {} }, false), sessionWith('session-d'));
  is('a session with no keys at all follows the global switch', d.compaction, 'plugin');
  is(
    'an unconfigured settings provider falls back to the shipped default',
    resolveModeFrom({ value: null }, sessionWith('session-e')).compaction,
    'default',
  );

  // The reader the engine consults must be handed the session, not just its id:
  // an id-only lookup cannot see the preset and would answer the wrong thing.
  let seen = null;
  const undoSeen = setSharedModeReader((session) => {
    seen = session;
    return 'plugin';
  });
  class ProbeBase {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config ?? {};
    }
    async summarize() {
      return { via: 'base' };
    }
  }
  const probe = new (createContextZipEngine(ProbeBase))({ logger: {} }, {}, { summarize: async () => ({ via: 'plugin' }) });
  await probe.summarize({ messages: [] }, { session: sessionWith('session-p', 'standard') }, undefined);
  is('the shared mode reader receives the session object', seen?.header?.agentPreset, 'standard');
  undoSeen();

  // The `/zip-export` registration itself. Two defects lived here and neither was
  // reachable from a pure-function test: a browser client only routes a slash
  // line WITH trailing input to a command that declares an `input` descriptor,
  // and the export path resolved the session through the live-only lookup.
  let registered = null;
  const exported = [];
  const disposeCommand = registerExportCommand({
    get: (service) => (service === 'commands' ? { register: (definition) => ((registered = definition), () => {}) } : void 0),
    contextZip: {
      export: async (sessionId) => {
        exported.push(sessionId);
        return ['<tmp>/fake-seg-000.md'];
      },
    },
  });
  is('the export command registers under the documented name', registered?.name, 'zip-export');
  ok('the export command declares free-form input', typeof registered?.input?.hint === 'string' && registered.input.hint.length > 0);
  is('the export command does not duplicate its input in the log', registered?.recordInput, false);
  const withArgument = await registered.handler({ rawInput: '  session-abc  ', agent: { session: { id: 'session-self' } } });
  is('the export command exports the named session', exported.at(-1), 'session-abc');
  is('the export command reports success', withArgument.kind, 'success');
  await registered.handler({ rawInput: '   ', agent: { session: { id: 'session-self' } } });
  is('a bare export command exports the calling session', exported.at(-1), 'session-self');
  typeof disposeCommand === 'function' ? disposeCommand() : null;

  // Pagination must not re-answer page 1. The cursor is an offset into a list
  // that is recomputed per call, and the seq bound moves on every request, so a
  // bound that is re-read for page 2 lets newly eligible events into the list;
  // ties then sort by newest seq and the window slides back over page 1. The
  // bound therefore has to be pinned to the cursor that was minted under it.
  {
    // A candidate list that grows between the two calls, exactly as a live
    // session does when page 1's own tool result lands in the log. The stub has
    // to HONOUR the seq filter: that filter is the whole mechanism under test,
    // and a stub that ignores it would pass whether or not the bound is pinned.
    const makeQuery = (extra) => ({
      filterEvents: async (_sessionId, filters) => {
        const ceiling = filters.find((filter) => filter.kind === 'seq')?.to ?? Number.POSITIVE_INFINITY;
        const needle = filters.find((filter) => filter.kind === 'text')?.text ?? '';
        return [
          ...[122, 109, 95, 82, 105, 89, 78, 72].map((seq) => ({
            seq,
            type: 'user/message',
            text: `short other ${seq}`,
          })),
          ...extra.map((seq) => ({ seq, type: 'user/message', text: 'short short short' })),
        ]
          .filter((hit) => hit.seq <= ceiling && (needle.length === 0 || hit.text.includes(needle)))
          .sort((left, right) => {
            const score = (hit) => hit.text.split(needle).length - 1;
            return score(right) - score(left) || right.seq - left.seq;
          });
      },
    });
    const session = { id: 'session-c6', seq: 200, snapshotEvents: () => [] };
    const exec = { agent: { session } };
    // The indexed page is what production uses, and it returns `seq` and `type` and NO
    // body. The mocks below provide only `filterEvents`, so every hit they hand back
    // carries text and the read-back branch never runs; the first version of the address
    // change passed all of them while producing no address in a real cell.
    {
      const bodyText = `开头一句。${'垫'.repeat(120)}NEEDLE 在这里。`;
      const indexed = {
        searchEvents: async () => ({ items: [{ seq: 40, type: 'user/message', snippet: 'service excerpt' }] }),
        filterEvents: async () => [{ seq: 40, type: 'user/message', text: bodyText }],
      };
      const indexedTool = historySearchTool({ get: () => indexed }, { historyBoundary: () => 129 });
      const indexedSession = { id: 'session-indexed-address', seq: 200, snapshotEvents: () => [] };
      const indexedOut = await indexedTool.execute({ query: 'NEEDLE' }, { agent: { session: indexedSession } });
      const wantAt = bodyText.indexOf('NEEDLE');
      is('history_search: an indexed hit with no body still gets an address', indexedOut.includes(`@${wantAt} of ${bodyText.length}`), true);
      is('history_search: and the address is the raw index, not a flattened one', wantAt > 0 && indexedOut.includes('@0 of'), false);
    }

    const tool = historySearchTool({ get: () => makeQuery([]) }, { historyBoundary: () => 129 });

    const page1 = await tool.execute({ query: 'short', limit: 3 }, exec);
    const cursor = /cursor=("?)([^".\s]+)\1/u.exec(page1)?.[2];
    is('page 1 offers a continuation cursor', typeof cursor === 'string' && cursor.length > 0, true);

    // Page 2 arrives after the bound moved forward and three new events landed.
    const movedTool = historySearchTool({ get: () => makeQuery([136, 149, 163]) }, { historyBoundary: () => 169 });
    const page2 = await movedTool.execute({ query: 'short', limit: 3, cursor }, exec);
    const seqsOf = (page) => [...page.matchAll(/#(\d+)/gu)].map((match) => Number(match[1]));
    const first = seqsOf(page1);
    const second = seqsOf(page2);
    is('page 2 is not empty', second.length > 0, true);
    is(
      'page 2 repeats nothing from page 1 even though the bound moved',
      second.some((seq) => first.includes(seq)),
      false,
    );

    // An unrelated search between the pages must not displace the pinned bound.
    // Keying it by session alone was enough to bring the slide back, so this
    // interleaved search has to MATCH and mint a cursor of its own — a search that
    // matches nothing never reaches the code that remembers a bound.
    const interleaved = await movedTool.execute({ query: 'other', limit: 3 }, exec);
    is('the interleaved search matched and minted a cursor', interleaved.includes('More matches exist'), true);
    const page2Again = await movedTool.execute({ query: 'short', limit: 3, cursor }, exec);
    is(
      'an interleaved search does not reintroduce the repeat',
      seqsOf(page2Again).some((seq) => first.includes(seq)),
      false,
    );

    // Page THREE. The bound has to travel with the cursor that page 2 mints, or a
    // session that grows between every pair of pages slides one page later each
    // time the hole is patched.
    const cursor2 = /cursor=("?)([^".\s]+)\1/u.exec(page2)?.[2];
    is('page 2 offers its own cursor', typeof cursor2 === 'string' && cursor2.length > 0, true);
    const grownMore = historySearchTool({ get: () => makeQuery([136, 149, 163, 175, 188]) }, { historyBoundary: () => 200 });
    const page3 = await grownMore.execute({ query: 'short', limit: 3, cursor: cursor2 }, exec);
    is(
      'page 3 repeats nothing from page 2 even though the bound moved again',
      seqsOf(page3).some((seq) => second.includes(seq)),
      false,
    );
    is(
      'page 3 repeats nothing from page 1 either',
      seqsOf(page3).some((seq) => first.includes(seq)),
      false,
    );

    // A cursor the tool never issued must not be answered with page 1. Serving
    // the wrong page as if it were the continuation is worse than refusing.
    {
      const refusing = historySearchTool({ get: () => makeQuery([]) }, { historyBoundary: () => 129 });
      const invented = await refusing.execute({ query: 'short', limit: 3, cursor: '10' }, exec);
      is('a bare numeric cursor is refused, not served as page 1', invented.startsWith('This cursor was not issued'), true);
      is('the refusal does not leak results', invented.includes('#122'), false);
      const fabricated = await refusing.execute({ query: 'short', limit: 3, cursor: 'not-a-cursor' }, exec);
      is('an unparseable cursor is refused too', fabricated.startsWith('This cursor was not issued'), true);
      // A cursor the tool really issued still works, so the refusal is not a wall.
      const real = await refusing.execute({ query: 'short', limit: 3 }, exec);
      const realCursor = /cursor=("?)([^".\s]+)\1/u.exec(real)?.[2];
      const continued = await refusing.execute({ query: 'short', limit: 3, cursor: realCursor }, exec);
      is('a cursor the tool issued is still accepted', continued.startsWith('This cursor was not issued'), false);
    }

    // A page with NO bound must stay unbounded on the next page. `undefined ??
    // live` made "this search carried no bound" indistinguishable from "no pin
    // found", so a bound appearing in between was silently adopted.
    {
      const wasUnbounded = historySearchTool({ get: () => makeQuery([]) }, { historyBoundary: () => undefined });
      const openFirst = await wasUnbounded.execute({ query: 'short', limit: 3 }, exec);
      const openCursor = /cursor=("?)([^".\s]+)\1/u.exec(openFirst)?.[2];
      is('an unbounded page still mints a cursor', typeof openCursor === 'string' && openCursor.length > 0, true);
      is('the cursor records that there was no bound', openCursor.endsWith('~'), true);
      // A bound now exists that is LOW enough to exclude several events the first
      // page already listed, and three new events sit above it. Adopting the bound
      // would renumber the window; staying unbounded keeps the search whole.
      const nowBounded = historySearchTool({ get: () => makeQuery([136, 149, 163]) }, { historyBoundary: () => 100 });
      const openSecond = await nowBounded.execute({ query: 'short', limit: 3, cursor: openCursor }, exec);
      is(
        'an unbounded continuation does not adopt a bound that appeared later',
        seqsOf(openSecond).join(','),
        '122,109,105',
      );
    }

    // A fresh mint of the same query must not overwrite an older cursor's bound:
    // the fallback cursor text used to be a bare offset, so two identical searches
    // collided on it.
    const remint = await movedTool.execute({ query: 'short', limit: 3 }, exec);
    const remintCursor = /cursor=("?)([^".\s]+)\1/u.exec(remint)?.[2];
    const afterRemint = await movedTool.execute({ query: 'short', limit: 3, cursor: remintCursor }, exec);
    is(
      'a re-minted cursor does not slide over its own first page',
      seqsOf(afterRemint).some((seq) => seqsOf(remint).includes(seq)),
      false,
    );
  }

  // The search bound: one below the assistant message that carried the call, so
  // neither that message nor the `tool/call` it produced can match the search.
  {
    const boundaryOf = (seq) => (typeof seq === 'number' && seq > 0 ? seq - 1 : undefined);
    is('the bound sits one below the carrier message', boundaryOf(15), 14);
    is('no carrier message means no bound', boundaryOf(undefined), undefined);
    is('the first event cannot produce a negative bound', boundaryOf(0), undefined);
  }

  // A forked (seeded) session must never be read through the query service:
  // rebuilding a seeded log through `Session.create` rejects it as soon as it
  // has grown past its inherited prefix, which killed every review tool in a
  // fork. The live snapshot has to win, and the query service is only a fallback.
  {
    const inherited = [{ seq: 0, type: 'session', data: {} }];
    const seeded = {
      id: 'session-forked',
      firstLiveSeq: 1,
      inheritedEventCount: 1,
      snapshotEvents: () => inherited,
    };
    let asked = 0;
    const queryCtx = {
      get: (service) => (service === 'sessionQuery' ? { readSession: async () => ((asked += 1), { events: [] }) } : void 0),
    };
    const fromLive = await readSessionEvents(queryCtx, seeded);
    is('a live session reads its own log rather than the query service', fromLive.length, 1);
    is('the query service is not consulted when the live log is readable', asked, 0);

    const broken = {
      id: 'session-broken',
      snapshotEvents: () => {
        throw new Error('seeded session constructor seed must equal its inherited prefix');
      },
    };
    const viaQuery = await readSessionEvents(queryCtx, broken);
    is('an unreadable live log falls back to the query service', Array.isArray(viaQuery), true);
    is('the fallback actually asked the query service', asked, 1);

    // ...but not for a seeded session: that path is exactly the one that throws
    // on a fork, so asking it would replace one failure with a more confusing one.
    const seededBroken = {
      id: 'session-forked-broken',
      header: { isSeeded: true },
      snapshotEvents: () => {
        throw new Error('seeded session constructor seed must equal its inherited prefix');
      },
    };
    const seededFallback = await readSessionEvents(queryCtx, seededBroken);
    is('a seeded session does not use the query fallback', seededFallback, []);
    is('the query service was left alone for the seeded session', asked, 1);
  }

  // The per-session compaction split. Two sessions in one process have to be
  // able to compact differently, so `summarize` must consult the session and
  // delegate to the shipped implementation without altering the call it passes
  // down. A stub base makes both the branch and the forwarded config observable.
  const baseCalls = [];
  class StubBase {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = { maxTokens: 8192, ...(config ?? {}) };
    }
    async summarize(input, agent, signal) {
      baseCalls.push({ input, agent, signal, maxTokens: this.config.maxTokens });
      return { summary: [{ type: 'text', text: 'shipped wording' }], routedTo: 'base' };
    }
  }
  const pluginCalls = [];
  const Engine = createContextZipEngine(StubBase);
  const engine = new Engine({ logger: {} }, {}, {
    readNotes: async () => 'draft',
    summarize: async (ctx, config, input, agent, signal) => {
      pluginCalls.push({ config, input, agent, signal });
      return { summary: [{ type: 'text', text: 'plugin wording' }], routedTo: 'plugin' };
    },
  });

  const agentFor = (id, mode) => ({ session: { id }, mode });
  setSharedModeReader((session) => (session.id === 'session-plugin' ? 'plugin' : 'default'));

  const defaultRun = await engine.summarize({ messages: ['m'] }, agentFor('session-default'), undefined);
  is('a default-mode session is handed to the shipped backend', defaultRun.routedTo, 'base');
  is(
    'the delegation keeps the shipped 8192-token cap rather than the plugin cap',
    baseCalls.at(-1).maxTokens,
    8192,
  );
  is('the plugin summarizer is not called for a default-mode session', pluginCalls.length, 0);

  const pluginRun = await engine.summarize({ messages: ['m'] }, agentFor('session-plugin'), undefined);
  is('a plugin-mode session uses the plugin summarizer', pluginRun.routedTo, 'plugin');
  is(
    'the plugin path pins the documented hard cap',
    pluginCalls.at(-1).config.maxTokens,
    SUMMARY_HARD_CAP_TOKENS,
  );
  {
    // Assert the structure the instruction must carry rather than one sentence of its
    // prose: the wording is tuned often, the five headings and the submission tool are
    // the contract. A rewrite that drops either is the regression worth catching.
    const instruction = JSON.stringify(pluginCalls.at(-1).input.messages[1]);
    ok(
      'the plugin path appends the handoff instruction to the replayed prefix',
      pluginCalls.at(-1).input.messages.length === 2,
    );
    ok(
      'the instruction names all five sections as headings',
      SUMMARY_HEADINGS.every((heading) => instruction.includes(`## ${heading}`)),
    );
    // Assert the framing rather than a number: the ceilings are tuned against
    // measurements, and a test pinned to "8 lines" fails every time one moves.
    ok('the instruction states per-section ceilings', (instruction.match(/ceiling:/gu) ?? []).length >= 3);
    ok('the instruction calls the numbers ceilings, not quotas', /CEILINGS, not targets/u.test(instruction));
    ok('the instruction warns against restating the material', /do not reproduce it/u.test(instruction));
    // The shipped engine's own instruction tells the summarizer what a prior
    // `<compacted-summary>` block is and that it must be merged rather than copied.
    // Replacing that instruction without carrying the rule over silently changes what
    // a SECOND compaction does: a verbatim copy spends the budget on old news, and
    // dropping it loses everything the earlier compaction chose to keep.
    ok('the instruction explains a prior checkpoint', instruction.includes('<compacted-summary>'));
    ok('the instruction says to merge it rather than copy it', /Fold it into this form/u.test(instruction));
    // The rest of the shipped engine's rule list, checked one by one. Replacing an
    // instruction means inheriting its rules or consciously dropping them; D19 was
    // dropped without a decision, and a line-by-line comparison found three more.
    ok('the instruction requires identifiers to be copied verbatim', /Copy paths, commands, error strings/u.test(instruction));
    ok('the instruction requires user corrections to be recorded', /what they corrected/u.test(instruction));
    ok('the instruction forbids mentioning the compaction', /Never mention that this is a summary/u.test(instruction));
    ok('the instruction forbids tool calls and extra prose', /Do not call a tool/u.test(instruction));
    // A one-off instruction recorded as a standing decision breaks the session that
    // follows it. Measured live: a summary listing "reply only 已读" as a decision made
    // the continuation answer 已读 to the next two questions.
    ok('the instruction separates one-off instructions from settled choices', /ONE-OFF instruction is not a settled choice/u.test(instruction));
  }
  ok('the plugin path carries the live notes draft', JSON.stringify(pluginCalls.at(-1).input.messages[1]).includes('draft'));
  ok(
    'a default-mode session never reads the notes draft',
    baseCalls.length === 1 && !JSON.stringify(baseCalls.at(-1).input).includes('draft'),
  );

  const rowEngine = new Engine({ logger: {} }, { maxTokens: 2048 }, { summarize: async (ctx, config) => ({ config }) });
  setSharedModeReader(() => 'plugin');
  const rowRun = await rowEngine.summarize({ messages: [] }, agentFor('session-x'), undefined);
  is('a row-level maxTokens still wins over the plugin cap', rowRun.config.maxTokens, 2048);

  setSharedModeReader(null);
  const unreadable = new Engine({ logger: {} }, {}, { summarize: async (ctx, config) => ({ config }) });
  const fallbackRun = await unreadable.summarize({ messages: [] }, agentFor('session-x'), undefined);
  is('a missing mode reader falls back to the plugin path', fallbackRun.config.maxTokens, SUMMARY_HARD_CAP_TOKENS);

  ok(
    'the export prints the originals in ascending seq order',
    exportDoc.indexOf('#3 user/message') < exportDoc.indexOf('#8 tool/call') &&
      exportDoc.indexOf('#8 tool/call') < exportDoc.indexOf('#11 assistant/message'),
  );

// ---------------------------------------------------------------------------
// The per-session mode route
//
// The toolbar chip reads this route on every session switch, so three answers
// matter: a session this process holds, a session it does not, and a malformed
// id. Driven through a captured handler rather than a listening server, because
// the route's own contract is the thing under test.
// ---------------------------------------------------------------------------
{
  const captured = [];
  const dispose = registerRoutes(
    {
      get: (name) =>
        name === 'webServer'
          ? { register: (spec) => { captured.push(spec); return () => {}; } }
          : undefined,
    },
    {
      readSettings: () => ({ enabled: false, agents: {} }),
      readEffectiveMode: () => ({ compaction: 'default', source: 'default' }),
      listSegments: () => [],
      readModeFor: (sessionId) =>
        sessionId === 'session-known'
          ? { compaction: 'plugin', source: 'settings', revision: 3 }
          : null,
    },
  );
  const route = captured.find((spec) => spec.path === '/dsh-context-zip/mode');
  is('mode route: registered', route !== undefined, true);
  is('mode route: exact match', route?.kind, 'exact');
  is('mode route: one disposer per registration', dispose.length, captured.length);

  const call = (url, method = 'GET', remote = '127.0.0.1') => {
    let status = 0;
    let body = '';
    route.handler(
      { method, url, socket: { remoteAddress: remote } },
      { writeHead: (code) => { status = code; }, end: (text) => { body = text; } },
    );
    return { status, body: JSON.parse(body) };
  };

  const known = call('/dsh-context-zip/mode?sessionId=session-known');
  is('mode route: known session answers 200', known.status, 200);
  is('mode route: known session reports its mode', known.body.mode?.compaction, 'plugin');
  is('mode route: known session reports the revision', known.body.mode?.revision, 3);

  const absent = call('/dsh-context-zip/mode?sessionId=session-absent');
  is('mode route: unknown session answers 404', absent.status, 404);
  is('mode route: unknown session names the reason', absent.body.error, 'session-not-found');

  is('mode route: a traversal id answers 400', call('/dsh-context-zip/mode?sessionId=../../etc/passwd').status, 400);
  is('mode route: a missing id answers 400', call('/dsh-context-zip/mode').status, 400);
  is('mode route: a write answers 405', call('/dsh-context-zip/mode?sessionId=session-known', 'POST').status, 405);
  is('mode route: a non-loopback caller is refused', call('/dsh-context-zip/mode?sessionId=session-known', 'GET', '10.0.0.7').status, 405);

  // A profile without a web server must not throw: `webServer` is optional, and
  // a headless profile is a supported composition.
  is('mode route: no web server yields no disposers', registerRoutes({ get: () => undefined }, {}).length, 0);
}

// ---------------------------------------------------------------------------
// The poll route
//
// The settings panel re-reads the live view every few seconds while it is open,
// and it merges `effective` and `titles`. This route is what that tick asks for.
// What matters: the same `effective` object the full read carries, no settings
// value in the payload, and the title memo handed to a panel that is already on
// screen.
// ---------------------------------------------------------------------------
{
  const captured = [];
  let settingsReads = 0;
  const readKeys = [];
  const effective = { compaction: 'plugin', source: 'settings', revision: 7, overrides: 2, live: { on: 1, off: 3 } };
  registerRoutes(
    {
      get: (name) =>
        name === 'webServer'
          ? { register: (spec) => { captured.push(spec); return () => {}; } }
          : undefined,
    },
    {
      readSettings: () => {
        settingsReads += 1;
        return { enabled: true, agents: { 'session-x': false } };
      },
      readEffectiveMode: () => effective,
      readSessionTitles: async (keys) => {
        readKeys.push([...keys]);
        return { 'session-x': '设置面板那一行的会话' };
      },
      createTitles: (deps) => createTitleMemo({ read: deps.read }),
    },
  );
  const route = captured.find((spec) => spec.path === '/dsh-context-zip/live');
  is('live route: registered', route !== undefined, true);
  is('live route: exact match', route?.kind, 'exact');

  const call = (url, method = 'GET', remote = '127.0.0.1') => {
    let status = 0;
    let body = '';
    route.handler(
      { method, url, socket: { remoteAddress: remote } },
      { writeHead: (code) => { status = code; }, end: (text) => { body = text; } },
    );
    return { status, body: JSON.parse(body) };
  };

  const answer = call('/dsh-context-zip/live');
  is('live route: answers 200', answer.status, 200);
  is('live route: carries the effective view', JSON.stringify(answer.body.effective), JSON.stringify(effective));
  is('live route: the payload has no settings value', 'value' in answer.body, false);
  // The poll threw `value` away, so serializing it would be work bought for
  // nobody. It DOES read the override tables for their session keys — that is how
  // the tick knows which names to carry — so this counts payload serialization,
  // not that read.
  is('live route: the read it does make is for the key list, not the payload', settingsReads > 0, true);
  is('live route: no settings value in the body text', JSON.stringify(answer.body).includes('"value"'), false);
  is('live route: a write answers 405', call('/dsh-context-zip/live', 'POST').status, 405);
  is('live route: a non-loopback caller is refused', call('/dsh-context-zip/live', 'GET', '10.0.0.7').status, 405);

  // Drift guard: the panel renders one "effective" line from two reads (the full
  // one at mount, this one afterwards), so the two must not answer differently.
  const full = captured.find((spec) => spec.path === '/dsh-context-zip/settings');
  let fullBody = '';
  const fullReturn = full.handler(
    { method: 'GET', url: '/dsh-context-zip/settings', socket: { remoteAddress: '127.0.0.1' } },
    { writeHead: () => {}, end: (text) => { fullBody = text; } },
  );
  // `/settings` no longer awaits the title fold; it must hand the response back
  // in the same turn.
  is(
    'live route: the full read no longer returns a promise',
    fullReturn !== null && typeof fullReturn === 'object' && typeof fullReturn.then === 'function',
    false,
  );
  await Promise.resolve();
  await Promise.resolve();
  // Second call: the memo now covers `session-x`, so the poll is answering names
  // the first read started fetching, which is exactly how a name reaches a panel
  // that is already open.
  const withTitles = call('/dsh-context-zip/live');
  is('live route: carries the title memo', withTitles.body.titles['session-x'], '设置面板那一行的会话');
  is('live route: asked the host only for session keys', JSON.stringify(readKeys[0]), JSON.stringify(['session-x']));
  is(
    'live route: same effective view as the full read',
    JSON.stringify(JSON.parse(fullBody).effective),
    JSON.stringify(answer.body.effective),
  );
}

// ---------------------------------------------------------------------------
// The poll's health bookkeeping
//
// The panel shows "these counts may be out of date" from this state, so the
// transitions are the user-visible contract: a failure keeps the last good
// reading's timestamp, a success clears the run, and staying healthy must not
// churn the state object (the panel re-renders every 5 s as it is).
// ---------------------------------------------------------------------------
{
  // The interval is a documented promise ("the live count follows every 5
  // seconds"), so it is asserted here rather than left to drift with the code.
  is('live poll: the interval the functional document states', LIVE_POLL_MS, 5000);

  const first = initialLiveHealth(1000);
  is('live health: an untouched poll is healthy', first.failures, 0);
  is('live health: the first reading is dated', first.lastOk, 1000);

  const once = liveHealthAfter(first, false, 6000);
  is('live health: a failure is remembered', once.failures, 1);
  is('live health: a failure does not re-date the last good read', once.lastOk, 1000);

  const twice = liveHealthAfter(once, false, 11000);
  is('live health: failures accumulate as a run', twice.failures, 2);

  const recovered = liveHealthAfter(twice, true, 16000);
  is('live health: one success clears the run', recovered.failures, 0);
  is('live health: a success re-dates the reading', recovered.lastOk, 16000);
  ok('live health: staying healthy keeps the same object', liveHealthAfter(recovered, true, 21000) === recovered);

  is('live clock: prints local time as 24-hour HH:MM:SS', clockText(new Date(2026, 8, 19, 9, 5, 7).getTime()), '09:05:07');
  is('live clock: pads a single-digit hour', clockText(new Date(2026, 8, 19, 0, 0, 0).getTime()), '00:00:00');
}

// ---------------------------------------------------------------------------
// 晚到的名字怎么进面板
//
// 首次 `/settings` 只答备忘录里已有的名字，折叠在响应之后才跑。面板开着时还在问的
// 只有 5 秒一跳的 `/live`，所以那一跳必须把 `titles` 也并进 state——此前名字只在装载
// 与保存后各读一次，于是面板开着时改的会话名要关掉重开才看得到。
// ---------------------------------------------------------------------------
{
  is('live titles: 清洗只留非空标题', JSON.stringify(titlesFrom({ a: ' x ', b: '', c: 3 })), JSON.stringify({ a: 'x' }));
  is('live titles: 不是表就当作空表', JSON.stringify(titlesFrom(null)), '{}');

  const state = { status: 'ready', value: {}, effective: { compaction: 'plugin' }, titles: {} };
  const first = mergeLivePayload(state, { effective: { compaction: 'default' }, titles: { 'session-a': '甲' } });
  is('live titles: /live 的 titles 并进 state', first.titles['session-a'], '甲');
  is('live titles: 同一跳的 effective 也并进去', first.effective.compaction, 'default');
  // 载荷没带 titles 的宿主不能把屏幕上的名字抹掉，那不是降级。
  const legacy = mergeLivePayload(first, { effective: { compaction: 'default' } });
  is('live titles: 载荷缺 titles 时保留已有名字', legacy.titles['session-a'], '甲');
  // 没有变化就返回同一个对象，5 秒一跳不会白触发一次重绘。
  ok('live titles: 一跳没有变化时返回原对象', mergeLivePayload(first, { effective: first.effective, titles: { 'session-a': '甲' } }) === first);
  // 名字变了则换新对象。
  const renamed = mergeLivePayload(first, { effective: first.effective, titles: { 'session-a': '乙' } });
  ok('live titles: 名字变了才换新对象', renamed !== first && renamed.titles['session-a'] === '乙');
}

// ---------------------------------------------------------------------------
// Which save may write over the table
//
// The panel saves the whole settings object from five controls, but only one of
// them is the table. A switch's save carries the last STORED value, so writing
// its answer over the rows deletes work the user has not saved yet — measured
// in a browser at `rowCount: 1` → `0` on a fallback-switch flip, with "saved"
// on screen. The rule is checked in both directions here: the switch save must
// leave the array alone, the table's own save must still refresh it.
// ---------------------------------------------------------------------------
{
  const typed = [
    { key: 'session-UNSAVED-PROBE', value: true },
    { key: '', value: true },
  ];

  const untouched = rowsAfterSave('main', typed, { enabled: true, agents: {} });
  ok('save rows: a switch save keeps the unsaved rows', untouched === typed);
  is('save rows: a switch save loses nothing even with no stored rows', untouched.length, 2);
  is(
    'save rows: a switch save keeps the probe key exactly as typed',
    untouched[0].key,
    'session-UNSAVED-PROBE',
  );
  ok('save rows: a rewrite save keeps the unsaved rows too', rowsAfterSave('rewrite', typed, { agents: {} }) === typed);

  const refreshed = rowsAfterSave('agents', typed, { agents: { 'session-kept': false } });
  is('save rows: the table save takes the stored rows', refreshed.length, 1);
  is('save rows: the table save takes the stored key', refreshed[0].key, 'session-kept');
  is('save rows: the table save takes the stored value', refreshed[0].value, false);
  is('save rows: an empty answer empties the table', rowsAfterSave('agents', typed, {}).length, 0);
  is('save rows: a missing answer empties the table', rowsAfterSave('agents', typed, undefined).length, 0);

  // The mount read uses the same conversion, so the two cannot drift apart.
  is('save rows: the mount read converts the same way', JSON.stringify(toRows({ a: true, b: false })), JSON.stringify([{ key: 'a', value: true }, { key: 'b', value: false }]));
}

// ---------------------------------------------------------------------------
// D5b：写入在飞时那颗唯一的保存按钮自己写着「保存中…」。
//
// 旧形态：每个分组一行 `state.message`，保存开始时把它设成 `strings.saving`——
// 那正是「控件全被 disabled、界面一个字都不变，读起来是点了没反应」的补丁（实测
// 1.5 秒往返里连点 5 次只有 1 个 POST）。本轮改成「整块草稿 + 一处保存」之后，分组
// message 的渲染点整体撤掉，写入在飞的反馈只剩标题行那颗按钮，所以 `strings.saving`
// 换了渲染点，这条判据跟着换。
// ---------------------------------------------------------------------------
{
  const clientSource = await readFile(join(here, '..', 'client', 'index.ts'), 'utf8');
  ok(
    'D5b: the one save button shows the saving line while the write is in flight',
    /saveFace === 'saving' \? strings\.saving/u.test(clientSource),
  );
  ok(
    'D5b: the saving line exists in both locales',
    /saving: '保存中…',/u.test(clientSource) && /saving: 'Saving…',/u.test(clientSource),
  );
}

// ---------------------------------------------------------------------------
// 整页保存：草稿、脏净与那颗唯一的保存按钮（用户 2026.09.20 的要求）
//
// 用户看完真机面板后定了四件事：控件一改就写盘改成整块草稿加一处保存；保存按钮进
// 标题行最右；成功变勾、失败红底，各停 1.5 秒；草稿与服务端相同时按钮置灰不可点。
// 脏净比较与可点性判定是纯函数，这里直接跑；按钮的位置走真渲染树（上面「显示名」
// 那一段加的判据），四个脸的源码形状在这里钉。
// ---------------------------------------------------------------------------
{
  const clientSource = await readFile(join(here, '..', 'client', 'index.ts'), 'utf8');

  // ── 脏净：内容相同就算干净，键序不算差别 ─────────────────────────────
  ok(
    'save draft: the same value is not dirty',
    sameSettings({ enabled: true, agents: {} }, { enabled: true, agents: {} }),
  );
  ok(
    'save draft: a moved key is not a difference',
    sameSettings({ enabled: true, throttle: false }, { throttle: false, enabled: true }),
  );
  is('save draft: a flipped boolean is dirty', sameSettings({ enabled: true }, { enabled: false }), false);
  is(
    'save draft: a changed nested table is dirty',
    sameSettings({ agents: { 'session-a': true } }, { agents: { 'session-a': false } }),
    false,
  );
  is('save draft: an added key is dirty', sameSettings({ enabled: true }, { enabled: true, throttle: true }), false);
  is('save draft: a dropped key is dirty', sameSettings({ enabled: true, throttle: true }, { enabled: true }), false);
  is('save draft: null and an empty value are dirty', sameSettings(null, {}), false);

  // ── 可点性：只有「有东西要存、没在存、已经读到」才可点 ────────────────
  is('save button: dirty and idle is clickable', saveButtonEnabled(true, 'idle', true), true);
  is('save button: a clean draft is not clickable', saveButtonEnabled(false, 'idle', true), false);
  is('save button: an in-flight save is not clickable', saveButtonEnabled(true, 'saving', true), false);
  is('save button: before the first read nothing is clickable', saveButtonEnabled(true, 'idle', false), false);
  is('save button: a failed save with a dirty draft stays clickable', saveButtonEnabled(true, 'failed', true), true);

  // ── 四个脸：成功的那一个是勾 ────────────────────────────────────────
  is('save button: idle wears the save face', saveButtonFace('idle'), 'save');
  is('save button: saving wears the saving face', saveButtonFace('saving'), 'saving');
  is('save button: a landed save wears the tick', saveButtonFace('saved'), 'check');
  is('save button: a rejected save wears the failure face', saveButtonFace('failed'), 'failed');
  is('save button: a stray phase reads as idle', saveButtonFace('nonsense'), 'save');
  is(
    'save button: the check face reuses the copy tick',
    /dangerouslySetInnerHTML: \{ __html: ICON_CHECK \}/u.test(clientSource),
    true,
  );

  // ── 1.5 秒收回 ─────────────────────────────────────────────────────
  is('save button: the confirmation window is 1.5 s', SAVE_FEEDBACK_MS, 1500);
  ok(
    'save button: only the transient faces are withdrawn on a timer',
    /saveTimer\.current = next === 'saving' \? null : setTimeout\(\(\) => setSavePhase\('idle'\), SAVE_FEEDBACK_MS\)/u.test(
      clientSource,
    ),
  );

  // ── 失败显红 ───────────────────────────────────────────────────────
  ok(
    'save button: the failure face is painted with the error token',
    /\.dsh-context-zip__save\[data-face="failed"\][^{]*\{[^}]*--dsw-alias-state-error-primary/u.test(clientSource),
  );

  // ── 控件只改草稿：面板源码里不再有即时写盘与分组 message ──────────────
  is(
    'save draft: the panel no longer renders a per-group message',
    /messageFor|dsh-context-zip__message/u.test(clientSource),
    false,
  );
  is('save draft: no control posts on its own any more', /\bsave\(\{ \.\.\.value/u.test(clientSource), false);
  is(
    'save draft: the trace field is controlled by the draft',
    /value: String\(value\.tracePath \?\? ''\)/u.test(clientSource),
    true,
  );
  ok('save draft: the one write sends the whole draft', /body: JSON\.stringify\(draft\)/u.test(clientSource));
  ok(
    'save draft: the title row calls the one save button',
    /className: 'dsh-context-zip__title-row'[\s\S]{0,200}saveButton\(\),/u.test(clientSource),
  );
  ok(
    'save draft: both locales name the save action',
    /saveAction: '保存',/u.test(clientSource) && /saveAction: 'Save',/u.test(clientSource),
  );
}

// ---------------------------------------------------------------------------
// 「压缩后端」这一行：九态判定、两行文案、状态点的脸
//
// 「接管」是把 profile 里的 `@deepseek-ai/dsh-compaction-basic` 换成 `redirect/` 那一
// 份，让压缩那一行解析到本插件。`dsh plugin add` 装出来的 profile 只有本体、没有这一
// 份，插件能启动但压缩不生效，所以面板必须自己把这件事说出来。
//
// 三个纯函数分工：`wireStatusFrom` 把读数与动作位判成九态之一（先命中先算）；`wireText`
// 给每一态一对主副行加一颗按钮的字；`wireFace` 给每一态一张状态点的脸。句子说状态、点说
// 有没有生效、按钮说还能不能做事，三者必须同步。
// ---------------------------------------------------------------------------
{
  const zh = {
    loading: 'LOAD',
    inactiveMain: '未生效',
    inactiveSub: '内置压缩正在工作',
    takeover: '接管',
    takingMain: '正在接管',
    takingSub: '请稍候',
    activeMain: '已生效',
    activeSubPrefix: '基于内置',
    versionUnknown: '版本未知',
    updateMain: '待更新',
    updateTpl: (current, snapshot) => `内置 ${current}，快照 ${snapshot}，重接一次即可`,
    reconnect: '重新接管',
    restartMain: '等待重启',
    restartSub: '下次启动时生效',
    takenSub: '该位置已有其他实现，保持不动',
    incompleteMain: '接管不完整',
    incompleteSub: '重试一次即可恢复',
    unknownMain: '状态未知',
    unknownSub: '刚才没有读到',
    failMain: '接管失败',
    retry: '重试',
  };
  const en = {
    loading: 'LOAD',
    inactiveMain: 'Inactive',
    inactiveSub: 'Built-in compaction is active',
    takeover: 'Take over',
    takingMain: 'Taking over',
    takingSub: 'One moment',
    activeMain: 'Active',
    activeSubPrefix: 'Based on built-in',
    versionUnknown: 'version unknown',
    updateMain: 'Update available',
    updateTpl: (current, snapshot) => `Built-in ${current}, snapshot ${snapshot}, reconnect to follow`,
    reconnect: 'Reconnect',
    restartMain: 'Restart required',
    restartSub: 'Takes effect on next launch',
    takenSub: 'That slot is already taken, left untouched',
    incompleteMain: 'Incomplete',
    incompleteSub: 'One retry restores it',
    unknownMain: 'Unknown',
    unknownSub: 'Could not read the status',
    failMain: 'Could not take over',
    retry: 'Retry',
  };
  const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  const when = '01-02 03:04';
  // 「等待重启」的两个参照时刻：`startedAfterStamp` 是这次进程启动晚于戳（重定向在进程
  // 开始之前就写好了，本进程加载得到），`startedBeforeStamp` 是戳落在进程开始之后（只有
  // 重启能加载）。判定不看 `/live` 的 `effective`，只看这一对时间戳。
  const startedAfterStamp = new Date(2026, 0, 3, 0, 0, 0).toISOString();
  const startedBeforeStamp = new Date(2026, 0, 1, 0, 0, 0).toISOString();
  const wired = { ok: true, wired: true, version: '0.1.5-rc.2', current: '0.1.5-rc.2', copiedAt: iso, processStartedAt: startedAfterStamp, stale: false, foreign: false };
  const restartPending = { ...wired, processStartedAt: startedBeforeStamp };
  const stale = { ...wired, current: '0.1.5-rc.3', stale: true };
  const unwired = { ok: true, wired: false, version: null, copiedAt: null, stale: false, foreign: false };

  is('stamp text: renders the local date and time', stampText(iso), when);
  is('stamp text: an empty stamp renders as nothing', stampText(''), '');
  is('stamp text: a non-string stamp renders as nothing', stampText(42), '');
  is('stamp text: an unparseable stamp renders as nothing', stampText('nonsense'), '');

  // ── 九态：一态一条；顺序本身就是判定的一部分 ─────────────────────────────
  is('wire status: a failed read is unknown', wireStatusFrom({ ok: false, error: 'no profile here' }, null), 'unknown');
  is('wire status: a foreign occupant is taken', wireStatusFrom({ ok: true, wired: false, foreign: true }, null), 'taken');
  is('wire status: a partial redirect is incomplete', wireStatusFrom({ ok: true, wired: false, partial: true }, null), 'incomplete');
  is('wire status: an unwired row is inactive', wireStatusFrom(unwired, null), 'inactive');
  is('wire status: a write in flight is taking', wireStatusFrom(wired, 'taking'), 'taking');
  is('wire status: a refused write is failed', wireStatusFrom(wired, 'failed'), 'failed');
  is('wire status: a stale redirect is update', wireStatusFrom(stale, null), 'update');
  is('wire status: a stamp newer than the process waits for a restart', wireStatusFrom(restartPending, null), 'restart');
  is('wire status: a stamp older than the process is active', wireStatusFrom(wired, null), 'active');

  // 先命中先算：读数失败压过一切；被占压过残缺；落后压过待重启；未生效压过接管中。
  is('wire status: a failed read outranks a foreign flag', wireStatusFrom({ ok: false, foreign: true }, null), 'unknown');
  is('wire status: a foreign occupant outranks an incomplete redirect', wireStatusFrom({ ok: true, wired: false, foreign: true, partial: true }, null), 'taken');
  is('wire status: a stale redirect outranks the restart branch', wireStatusFrom({ ...restartPending, current: '0.1.5-rc.3', stale: true }, null), 'update');
  is('wire status: an unwired row outranks the write in flight', wireStatusFrom(unwired, 'taking'), 'inactive');

  // 「等待重启」要有正向证据：`copiedAt` 或 `processStartedAt` 缺失、解析不出来、或两者
  // 相等，都不判重启，落回已生效；那比猜「等重启」更不容易骗人。
  is('wire status: a missing copied stamp is not a restart', wireStatusFrom({ ...restartPending, copiedAt: null }, null), 'active');
  is('wire status: a missing process start is not a restart', wireStatusFrom({ ...restartPending, processStartedAt: null }, null), 'active');
  is('wire status: an unparseable copied stamp is not a restart', wireStatusFrom({ ...restartPending, copiedAt: 'nonsense' }, null), 'active');
  is('wire status: an unparseable process start is not a restart', wireStatusFrom({ ...restartPending, processStartedAt: 'nonsense' }, null), 'active');
  is('wire status: an equal stamp and process start are not a restart', wireStatusFrom({ ...restartPending, processStartedAt: iso }, null), 'active');

  // ── 文案：九态各一对主副行；按钮只在还能做事时出现 ───────────────────────
  is('wire text: inactive offers the takeover', wireText('inactive', unwired, zh), { main: '未生效', sub: '内置压缩正在工作', action: '接管' });
  is('wire text: taking over disables itself', wireText('taking', wired, zh), { main: '正在接管', sub: '请稍候', action: '接管' });
  is('wire text: active names the wrapped version and time, no button', wireText('active', wired, zh), { main: '已生效', sub: '基于内置 0.1.5-rc.2，01-02 03:04', action: '' });
  is('wire text: update names both versions and offers a reconnect', wireText('update', stale, zh), { main: '待更新', sub: '内置 0.1.5-rc.3，快照 0.1.5-rc.2，重接一次即可', action: '重新接管' });
  is('wire text: restart waits and offers nothing', wireText('restart', wired, zh), { main: '等待重启', sub: '下次启动时生效', action: '' });
  is('wire text: taken leaves the other implementation alone', wireText('taken', { ok: true, wired: false, foreign: true }, zh), { main: '未生效', sub: '该位置已有其他实现，保持不动', action: '' });
  is('wire text: incomplete offers one retry', wireText('incomplete', { ok: true, wired: false, partial: true }, zh), { main: '接管不完整', sub: '重试一次即可恢复', action: '重试' });
  is('wire text: unknown offers one retry', wireText('unknown', { ok: false, error: 'no profile here' }, zh), { main: '状态未知', sub: '刚才没有读到', action: '重试' });
  is('wire text: failed prints the server reason bare', wireText('failed', { ok: true, wired: true, error: 'refusing to overwrite' }, zh), { main: '接管失败', sub: 'refusing to overwrite', action: '重试' });
  is('wire text: loading says it is reading and shows nothing else', wireText('loading', null, zh), { main: 'LOAD', sub: '', action: '' });

  // 版本兜底：副行要印版本而戳里没有 `version` 时印兜底句，不留空位（旧的
  // `基于内置 ，09-22 00:08` 就是空位露出来的样子）；active 与 update 两条印版本的
  // 副行都要走到。
  is('wire text: a missing stamp version prints the fallback sentence', wireText('active', { ...wired, version: null }, zh), { main: '已生效', sub: '基于内置 版本未知，01-02 03:04', action: '' });
  is('wire text: an empty stamp version prints the fallback too', wireText('active', { ...wired, version: '' }, zh), { main: '已生效', sub: '基于内置 版本未知，01-02 03:04', action: '' });
  is('wire text: the update line falls back for a missing snapshot version', wireText('update', { ...stale, version: null }, zh), { main: '待更新', sub: '内置 0.1.5-rc.3，快照 版本未知，重接一次即可', action: '重新接管' });

  // 英文表：同一套状态；只有 active 副行里版本与时间之间的逗号换成半角。
  is('wire text: the English inactive pair', wireText('inactive', unwired, en, 'en'), { main: 'Inactive', sub: 'Built-in compaction is active', action: 'Take over' });
  is('wire text: the English active pair uses a half-width comma', wireText('active', wired, en, 'en'), { main: 'Active', sub: 'Based on built-in 0.1.5-rc.2, 01-02 03:04', action: '' });
  is('wire text: the English update pair', wireText('update', stale, en, 'en'), { main: 'Update available', sub: 'Built-in 0.1.5-rc.3, snapshot 0.1.5-rc.2, reconnect to follow', action: 'Reconnect' });
  is('wire text: the English fallback sentence', wireText('active', { ...wired, version: null }, en, 'en'), { main: 'Active', sub: 'Based on built-in version unknown, 01-02 03:04', action: '' });
  is('wire text: the English failed pair leaves the reason bare', wireText('failed', { error: 'refusing to overwrite' }, en, 'en'), { main: 'Could not take over', sub: 'refusing to overwrite', action: 'Retry' });

  // ── 状态点的脸：空心=未生效与加载，实心主色=已生效，实心错误色=失败 ───────
  is('wire face: loading draws the open ring', wireFace('loading'), 'off');
  is('wire face: inactive draws the open ring', wireFace('inactive'), 'off');
  is('wire face: incomplete draws the open ring', wireFace('incomplete'), 'off');
  is('wire face: unknown draws the open ring', wireFace('unknown'), 'off');
  is('wire face: update draws the open ring', wireFace('update'), 'off');
  is('wire face: restart draws the open ring', wireFace('restart'), 'off');
  is('wire face: taken draws the open ring', wireFace('taken'), 'off');
  is('wire face: a stray status draws the open ring', wireFace('nonsense'), 'off');
  is('wire face: taking over draws the breathing ring', wireFace('taking'), 'busy');
  is('wire face: active draws the filled primary ring', wireFace('active'), 'on');
  is('wire face: failed draws the filled error ring', wireFace('failed'), 'error');
}

// ---------------------------------------------------------------------------
// 「压缩后端」这一行怎么渲染：真 bundle、真渲染
//
// 上一段证明的是九态判定与文案本身；这一段证明面板真的把那一行画出来——左标题（含问号
// 气泡）、中主副行、右按钮三样各就各位，九态里按钮该在的在哪、该缺席的缺席，接管在飞时
// 按钮禁用且行自报忙碌。走的仍是既有那套替身：加载 `lib/client.js`，用替身 react 展开
// 函数组件。
//
// 与模式芯片那一段的差别：设置面板挂载时会读设置，所以这里的替身是一个**带重渲染的小
// React**——`useState` 的格子跨渲染保留，`useEffect` 认依赖数组，读到答案后再渲染一轮。
// 只跑固定轮数，不等待任何真实计时器（`setInterval` 被换成空实现）。
// ---------------------------------------------------------------------------
{
  const effective = { compaction: 'plugin', source: 'global', revision: null };
  const settingsBody = {
    ok: true,
    value: { enabled: true, agents: {}, fallbackEnabled: false, fallbackAfterFailures: 5, rewriteEnabled: false, rewriteProvider: '', rewriteModel: '' },
    effective,
    titles: {},
  };
  const liveBody = { ok: true, effective, titles: {} };
  // 初值是「GET 还没回来」：第一段判据要停在读取中那一态上。
  const wireAnswer = { get: { pending: true }, post: null };
  let wireGets = 0;
  let wirePosts = 0;
  /** 本地时刻的 ISO 串，戳进载荷；面板再按本地 `MM-DD HH:mm` 印出来。 */
  const isoFor = (year, month, day, hours, minutes, seconds) => new Date(year, month, day, hours, minutes, seconds).toISOString();

  const calls = [];
  const makeElement = (type, props, ...children) => {
    calls.push({ type, props: props ?? {} });
    return { type, props: props ?? {}, children };
  };
  const cells = [];
  let cursor = 0;
  let pending = [];
  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const cellAt = (index, make) => {
    if (cells[index] === undefined) cells[index] = make();
    return cells[index];
  };
  const fakeReact = {
    createElement: makeElement,
    Fragment: 'Fragment',
    useState(initial) {
      const cell = cellAt(cursor++, () => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; cell.dirty = true; }];
    },
    useEffect(fn, deps) {
      const cell = cellAt(cursor++, () => ({}));
      pending.push({ cell, fn, deps });
    },
    useLayoutEffect(fn, deps) {
      const cell = cellAt(cursor++, () => ({}));
      pending.push({ cell, fn, deps });
    },
    useCallback(fn, deps) {
      const cell = cellAt(cursor++, () => ({}));
      if (cell.value === undefined || cell.deps === undefined || sameDeps(cell.deps, deps) === false) {
        cell.value = fn;
        cell.deps = deps;
      }
      return cell.value;
    },
    useMemo(fn, deps) {
      const cell = cellAt(cursor++, () => ({}));
      if (cell.value === undefined || cell.deps === undefined || sameDeps(cell.deps, deps) === false) {
        cell.value = fn();
        cell.deps = deps;
      }
      return cell.value;
    },
    useRef(initial) {
      return cellAt(cursor++, () => ({ current: initial }));
    },
    useContext: () => 'zh',
    createContext: (value) => ({ _value: value, Provider: 'LocaleProvider', Consumer: 'LocaleConsumer' }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };

  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorFetch = globalThis.fetch;
  const priorSetInterval = globalThis.setInterval;
  const priorClearInterval = globalThis.clearInterval;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.window = { __ModuleLoader__: { load(spec) { factory = spec.factory; } }, innerWidth: 1200, innerHeight: 900 };
  globalThis.document = {
    createElement: () => ({ id: '', textContent: '', append() {} }),
    head: { append() {} },
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options?.method ?? 'GET').toUpperCase();
    const answer = (body) => ({ status: 200, json: async () => body });
    if (url === '/dsh-context-zip/settings') return answer(settingsBody);
    if (url === '/dsh-context-zip/live') return answer(liveBody);
    if (url === '/dsh-context-zip/models') return answer({ ok: true, providers: [], failures: [] });
    if (url === '/dsh-context-zip/wire') {
      if (method === 'POST') {
        wirePosts += 1;
        const next = wireAnswer.post ?? {};
        // `pending: true` 是「请求还没回来」：接管中的那一组判据要停在飞行态上，
        // 所以这里给一个永不落地的 promise，而不是让响应在下一次 flush 就到。
        if (next.pending === true) return new Promise(() => {});
        if (next.throw === true) throw new Error('network down');
        return { status: next.status ?? 200, json: async () => next.body };
      }
      wireGets += 1;
      if (wireAnswer.get.pending === true) return new Promise(() => {});
      return answer({ ok: true, ...wireAnswer.get });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  let factory = null;
  try {
    // 带一个查询串，绕开前面已经导入过的同一份模块缓存：`window.__ModuleLoader__.load`
    // 只在模块顶层代码真的跑一次时才会被调用。
    await import(`${pathToFileURL(join(here, '..', 'lib', 'client.js')).href}?wire-row`);
    is('wire row: the client bundle registers itself with the loader', typeof factory, 'function');
    const client = factory((name) => {
      if (name === 'react' || name === 'react/jsx-runtime') return fakeReact;
      throw new Error(`the client bundle required an unexpected external: ${name}`);
    });
    const registrations = [];
    client.apply({
      locale: { register() {}, getLocale: () => ({ active: 'zh' }) },
      slots: {
        inject(name, fn) {
          fn();
        },
        register(spec, component) {
          registrations.push({ spec, component });
          return () => {};
        },
      },
    });
    const registered = registrations.find((one) => one.spec.id === 'context-zip');
    is('wire row: the settings section is registered', registered !== undefined, true);

    const expand = (element, depth = 0) => {
      if (element === null || element === undefined || typeof element !== 'object') return element;
      const isFunctionComponent = typeof element.type === 'function' && /^\s*class\b/u.test(String(element.type)) === false;
      if (isFunctionComponent && depth < 40) return expand(element.type(element.props ?? {}), depth + 1);
      return { type: element.type, props: element.props ?? {}, children: (element.children ?? []).map((child) => expand(child, depth + 1)) };
    };
    const findClass = (node, className) => {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (node.props?.className === className) return node;
      for (const child of node.children ?? []) {
        const found = findClass(child, className);
        if (found !== null) return found;
      }
      return null;
    };
    const textOf = (node) => {
      if (typeof node === 'string') return node;
      if (node === null || node === undefined || typeof node !== 'object') return '';
      return (node.children ?? []).map(textOf).join('');
    };
    const paint = async () => {
      let tree = null;
      for (let round = 0; round < 8; round += 1) {
        cursor = 0;
        pending = [];
        for (const cell of cells) if (cell !== undefined && cell.dirty === true) cell.dirty = false;
        tree = expand(registered.component({}));
        for (const effect of pending) {
          if (effect.deps !== undefined && sameDeps(effect.deps, effect.cell.deps)) continue;
          effect.cell.deps = effect.deps;
          effect.fn();
        }
        await flush();
        if (cells.some((cell) => cell !== undefined && cell.dirty === true) === false) break;
      }
      return tree;
    };
    const rowOf = (tree) => findClass(tree, 'dsh-context-zip__wire');
    // 三样各按类名找，不靠下标：左标题、中主副行、右按钮。
    const childOfClass = (node, className) =>
      (node?.children ?? []).find((child) => child?.props?.className === className);
    const titleOf = (row) => childOfClass(row, 'dsh-context-zip__wire-title');
    const bodyOf = (row) => childOfClass(row, 'dsh-context-zip__wire-body');
    const mainOf = (row) => childOfClass(bodyOf(row), 'dsh-context-zip__wire-main');
    const subOf = (row) => childOfClass(bodyOf(row), 'dsh-context-zip__wire-sub');
    const mainText = (row) => textOf(childOfClass(mainOf(row), 'dsh-context-zip__wire-main-text'));
    const subText = (row) => textOf(subOf(row));
    const dotOf = (row) => childOfClass(mainOf(row), 'dsh-context-zip__wire-dot');
    // 行自己的按钮是行的直接孩子；标题里那颗问号是按钮，但不是直接孩子，所以不会混进来。
    const buttonOf = (row) => (row?.children ?? []).find((child) => child?.type === 'button');
    const helpButtonOf = (row) => (titleOf(row)?.children ?? []).find((child) => child?.type === 'button');
    // 按钮不在或没挂 click 时记一条失败，而不是让这一行把整套判据打断：面板少画一颗按钮
    // 是「有判据要红」，不是「测试跑不下去」。
    const click = (target, label) => {
      if (target === undefined || typeof target.props?.onClick !== 'function') {
        ok(label, false);
        return false;
      }
      // 事件替身：问号那颗按钮的 click 会先 stopPropagation，再切换气泡。
      target.props.onClick({ stopPropagation() {} });
      return true;
    };
    const remount = () => {
      // 重挂载：面板关掉再打开就是这一件事，接管状态要重新从 GET 读一次。
      cells.length = 0;
    };

    // 读取中：GET 还没回来，行已经在位、结构已经是三样，但主行只说读取中、没有按钮。
    let tree = await paint();
    let row = rowOf(tree);
    is('wire row: the row renders before the read answers', row !== null, true);
    is('wire row: a pending read is the loading status', row?.props?.['data-status'], 'loading');
    is('wire row: a pending read says it is reading', mainText(row), '读取中…');
    is('wire row: a pending read shows no sub line', subText(row), '');
    is('wire row: a pending read offers no button', buttonOf(row), undefined);
    is('wire row: a pending read draws the open ring', dotOf(row)?.props?.['data-face'], 'off');
    is('wire row: a pending read is not announced as busy', row?.props?.['aria-busy'], 'false');

    // 未生效：标题、问号气泡、主副行、按钮四样都在，而且这一行是「压缩方式」组的第一行。
    wireAnswer.get = { ok: true, wired: false, version: null, copiedAt: null, stale: false, foreign: false };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: an unwired panel renders the row', row !== null, true);
    is('wire row: unwired is the inactive status', row?.props?.['data-status'], 'inactive');
    is('wire row: the row title is 压缩后端', textOf(titleOf(row)), '压缩后端');
    is('wire row: the title carries the question-mark bubble', helpButtonOf(row) !== undefined, true);
    is(
      'wire row: the bubble says takeover needs a restart',
      helpButtonOf(row)?.props?.['aria-label'],
      '插件接管压缩后才生效，接管后需重启一次 harness。',
    );
    is('wire row: the bubble is described by the wire help text', helpButtonOf(row)?.props?.['aria-describedby'], 'dsh-context-zip-help-wire');
    is('wire row: the main line is 未生效', mainText(row), '未生效');
    is('wire row: the sub line says the built-in backend is working', subText(row), '内置压缩正在工作');
    let button = buttonOf(row);
    is('wire row: the button is labelled 接管', textOf(button), '接管');
    is('wire row: the button is live', button?.props?.disabled, false);
    is('wire row: the row announces itself politely', bodyOf(row)?.props?.['aria-live'], 'polite');
    is('wire row: the dot is hidden from assistive technology', dotOf(row)?.props?.['aria-hidden'], 'true');
    is('wire row: an unwired row draws the open ring', dotOf(row)?.props?.['data-face'], 'off');
    is('wire row: an unwired row is not announced as busy', row?.props?.['aria-busy'], 'false');

    // 结构落点：左标题 → 中主副行 → 右按钮；点带在主行行首，副行跟在主行后面。
    is('wire row: the title leads the row', row?.children?.[0], titleOf(row));
    is('wire row: the main and sub lines sit in the middle', row?.children?.[1], bodyOf(row));
    is('wire row: the button closes the row on the right', row?.children?.[2], button);
    is('wire row: the dot leads the main line', mainOf(row)?.children?.[0], dotOf(row));
    is('wire row: the sub line follows the main line', bodyOf(row)?.children?.[1], subOf(row));

    // 位置：接管行在「压缩方式」组内排第一，分段控件那一行在它后面。
    const methodGroup = findClass(tree, 'dsh-context-zip__group');
    const methodRows = findClass(methodGroup, 'dsh-context-zip__rows');
    is('wire row: it is the first row inside the compaction-method group', methodRows?.children?.[0]?.props?.className, 'dsh-context-zip__wire');
    is('wire row: the method segment row follows it', methodRows?.children?.[1]?.props?.className, 'dsh-context-zip__row');

    // 接管在飞：乐观置真之后命中「接管中」，按钮禁用、行自报忙碌、点画呼吸环。
    wireAnswer.post = { pending: true };
    click(button, 'wire row: the takeover button has a click handler');
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: while the write is in flight the status is taking', row?.props?.['data-status'], 'taking');
    is('wire row: while the write is in flight the dot breathes', dotOf(row)?.props?.['data-face'], 'busy');
    is('wire row: while the write is in flight the row says so', row?.props?.['aria-busy'], 'true');
    is('wire row: while the write is in flight the main line is 正在接管', mainText(row), '正在接管');
    is('wire row: while the write is in flight the sub line asks to wait', subText(row), '请稍候');
    is('wire row: while the write is in flight the button is disabled', buttonOf(row)?.props?.disabled, true);
    is('wire row: while the write is in flight the button is still there', buttonOf(row) !== undefined, true);

    // 接管落地：九态走到已生效，按钮消失，主副行都在（所以行高与有按钮时相同）。
    wireAnswer.post = { body: { ok: true, wired: true, version: '9.9.9-shipped', copiedAt: isoFor(2026, 0, 2, 3, 4, 5) } };
    click(buttonOf(row), 'wire row: the landing write has a click handler');
    await flush();
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: after takeover the status is active', row?.props?.['data-status'], 'active');
    is('wire row: after takeover the button is gone', buttonOf(row), undefined);
    is('wire row: after takeover the dot is filled', dotOf(row)?.props?.['data-face'], 'on');
    is('wire row: after takeover the main line is 已生效', mainText(row), '已生效');
    is('wire row: after takeover the sub line names the wrapped version and time', subText(row), '基于内置 9.9.9-shipped，01-02 03:04');
    is('wire row: a no-button row keeps the main line, so its height cannot differ', mainOf(row) !== null, true);
    is('wire row: a no-button row keeps the sub line too', subText(row).length > 0, true);
    is('wire row: after takeover the row is not announced as busy', row?.props?.['aria-busy'], 'false');

    // 已接管且不落后：重新打开面板只有两行字，没有按钮，点的脸是实心。戳早于本进程的启动
    // 时间，所以这一行是「已生效」而不是「等待重启」。
    wireAnswer.get = { ok: true, wired: true, version: '0.1.5-rc.2', current: '0.1.5-rc.2', copiedAt: isoFor(2026, 0, 2, 3, 4, 5), processStartedAt: isoFor(2026, 0, 3, 0, 0, 0), stale: false };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a wired panel renders no button', buttonOf(row), undefined);
    is('wire row: a wired panel names the version and time', subText(row), '基于内置 0.1.5-rc.2，01-02 03:04');
    is('wire row: a wired panel draws the filled dot', dotOf(row)?.props?.['data-face'], 'on');

    // 这一行不再拿 `/live` 的 `effective` 当判据：把设置开关那侧说成内置后端，接管行依旧按
    // 时间戳读成已生效。旧实现会在这里说「等待重启」，说假话。
    effective.compaction = 'default';
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: the live effective no longer decides the restart state', row?.props?.['data-status'], 'active');
    effective.compaction = 'plugin';

    // 待更新：快照落后于现在包装的内置后端，按钮换字为「重新接管」。
    wireAnswer.get = { ok: true, wired: true, version: '0.1.5-rc.2', current: '0.1.5-rc.3', copiedAt: isoFor(2026, 0, 2, 3, 4, 5), processStartedAt: isoFor(2026, 0, 3, 0, 0, 0), stale: true };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a stale redirect is the update status', row?.props?.['data-status'], 'update');
    is('wire row: the update line names both versions', subText(row), '内置 0.1.5-rc.3，快照 0.1.5-rc.2，重接一次即可');
    is('wire row: the update offers a reconnect', textOf(buttonOf(row)), '重新接管');
    is('wire row: the update is not in effect yet', dotOf(row)?.props?.['data-face'], 'off');

    // 待重启：接管已写进 profile，但戳落在这个进程启动之后——只有重启能加载到它。
    wireAnswer.get = { ok: true, wired: true, version: '0.1.5-rc.2', current: '0.1.5-rc.2', copiedAt: isoFor(2026, 0, 2, 3, 4, 5), processStartedAt: isoFor(2026, 0, 1, 0, 0, 0), stale: false };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a stamp newer than the process waits for a restart', row?.props?.['data-status'], 'restart');
    is('wire row: the restart line says when it takes effect', subText(row), '下次启动时生效');
    is('wire row: the restart offers no button', buttonOf(row), undefined);
    is('wire row: the restart keeps the open ring', dotOf(row)?.props?.['data-face'], 'off');
    is('wire row: the restart is not announced as busy', row?.props?.['aria-busy'], 'false');
    is('wire row: the restart keeps the main line', mainText(row), '等待重启');

    // 被占用：那一格是别人的真包，本插件不动它，也没有按钮。
    wireAnswer.get = { ok: true, wired: false, foreign: true };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a foreign occupant is the taken status', row?.props?.['data-status'], 'taken');
    is('wire row: the taken line explains it is left untouched', subText(row), '该位置已有其他实现，保持不动');
    is('wire row: the taken row offers no button', buttonOf(row), undefined);
    is('wire row: the taken row keeps the main line', mainText(row), '未生效');

    // 不完整：本插件自己的重定向在、戳不在；「重试」重写一次就恢复。
    wireAnswer.get = { ok: true, wired: false, partial: true };
    wireAnswer.post = { body: { ok: true, wired: true, version: '9.9.9-shipped', copiedAt: isoFor(2026, 0, 2, 3, 4, 5) } };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a partial redirect is the incomplete status', row?.props?.['data-status'], 'incomplete');
    is('wire row: the incomplete line promises one retry', subText(row), '重试一次即可恢复');
    is('wire row: the incomplete row offers a retry', textOf(buttonOf(row)), '重试');
    click(buttonOf(row), 'wire row: the incomplete retry has a click handler');
    await flush();
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: the incomplete retry re-takes over', row?.props?.['data-status'], 'active');

    // 未知：状态读不到；「重试」是重读，不是重写，而且不印服务端原因（副行只说没读到）。
    wireAnswer.get = { ok: false, error: 'no profile here' };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: an unreadable status is the unknown status', row?.props?.['data-status'], 'unknown');
    is('wire row: the unknown line says it could not read', subText(row), '刚才没有读到');
    is('wire row: the unknown row does not print the server reason', subText(row).includes('no profile here'), false);
    is('wire row: the unknown row offers a retry', textOf(buttonOf(row)), '重试');
    const postsBeforeRead = wirePosts;
    const getsBeforeRead = wireGets;
    wireAnswer.get = { ok: true, wired: false, version: null, copiedAt: null, stale: false, foreign: false };
    click(buttonOf(row), 'wire row: the unknown retry has a click handler');
    await flush();
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: the unknown retry reads again instead of writing', wirePosts, postsBeforeRead);
    is('wire row: the unknown retry sent one more status read', wireGets, getsBeforeRead + 1);
    is('wire row: the unknown retry lands on the fresh reading', row?.props?.['data-status'], 'inactive');

    // 失败：服务端拒绝，副行只印原因原文（不加任何前缀），按钮还在（重试是同一颗）。
    wireAnswer.get = { ok: true, wired: false, version: null, copiedAt: null, stale: false, foreign: false };
    wireAnswer.post = { status: 500, body: { ok: false, error: 'refusing to overwrite a package this plugin did not put there' } };
    remount();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a refused takeover keeps the button for a retry', buttonOf(row) !== undefined, true);
    click(buttonOf(row), 'wire row: the retry button has a click handler');
    await flush();
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a refused takeover is the failed status', row?.props?.['data-status'], 'failed');
    is('wire row: the failed main line says the takeover failed', mainText(row), '接管失败');
    is(
      'wire row: the failed sub line is the server reason, bare',
      subText(row),
      'refusing to overwrite a package this plugin did not put there',
    );
    is('wire row: the failed reason carries no prefix', subText(row).startsWith('接管失败'), false);
    is('wire row: the failed row offers a retry', textOf(buttonOf(row)), '重试');
    is('wire row: the failed row draws the error ring', dotOf(row)?.props?.['data-face'], 'error');
    is('wire row: the failed row is not announced as busy', row?.props?.['aria-busy'], 'false');

    // 网络层抛错走同一态：原因换成异常消息，仍然是失败而不是未知。
    wireAnswer.post = { throw: true };
    remount();
    tree = await paint();
    row = rowOf(tree);
    click(buttonOf(row), 'wire row: the thrown write has a click handler');
    await flush();
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: a thrown write is the failed status', row?.props?.['data-status'], 'failed');
    is('wire row: a thrown write prints its own message', subText(row), 'network down');

    // 问号气泡：默认收起，点开之后展开，正文就是那一句定稿；状态怎么变它都在。
    is('wire row: the bubble starts closed', helpButtonOf(row)?.props?.['aria-expanded'], 'false');
    click(helpButtonOf(row), 'wire row: the bubble button has a click handler');
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: the bubble opens on click', helpButtonOf(row)?.props?.['aria-expanded'], 'true');
    is(
      'wire row: the bubble shows the takeover explanation',
      textOf(findClass(tree, 'dsh-context-zip__bubble')),
      '插件接管压缩后才生效，接管后需重启一次 harness。',
    );
    click(helpButtonOf(row), 'wire row: the bubble button can close it again');
    await flush();
    tree = await paint();
    row = rowOf(tree);
    is('wire row: the bubble closes on a second click', helpButtonOf(row)?.props?.['aria-expanded'], 'false');

    // 构建产物里也要有那两件事：同一路径的 POST，以及 JSON 内容类型。
    // esbuild 会把引号统一成双引号，所以这里按产物自己的写法查。
    const bundle = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8');
    ok('wire row: the bundle carries the wire route', bundle.includes('"/dsh-context-zip/wire"'));
    ok(
      'wire row: the wire POST declares a JSON body',
      /fetch\(WIRE_ROUTE, \{\s*method: "POST",\s*headers: \{ "content-type": "application\/json" \}/u.test(bundle),
    );

    // ── 技能包里的硬规则落到样式上 ─────────────────────────────────────────
    // 这两条来自 `ProjectSkills`：ui-ux-pro-max 的 AA 对比度与「> 300 ms 的等待必须
    // 有反馈」，taste-skill 的「状态点只在承载真实语义时用，且一节只一颗」与「动画
    // 必须有理由」。对比度本身算不出来（颜色由宿主令牌给，浅深两套都在宿主侧），
    // 所以这里钉的是它的前提：这一块的颜色全部来自宿主令牌，没有自造色值。
    const panelSource = await readFile(join(here, '..', 'client', 'index.ts'), 'utf8');
    const wireCss = panelSource.slice(
      panelSource.indexOf('.dsh-context-zip__wire{'),
      panelSource.indexOf('.dsh-context-zip__wire-btn{'),
    );
    is('wire row: the wire style block is present', wireCss.length > 0, true);
    is('wire row: the wire styles paint no raw colour', /#[0-9a-fA-F]{3,8}\b|rgba?\(/u.test(wireCss), false);
    is(
      'wire row: the open dot is drawn with the panel border token',
      /\.dsh-context-zip__wire-dot\{[^}]*border:1\.5px solid var\(--dsw-alias-label-tertiary\)/u.test(panelSource),
      true,
    );
    is(
      'wire row: shape carries the state, not colour alone (transparent centre)',
      /\.dsh-context-zip__wire-dot\{[^}]*background:transparent/u.test(panelSource),
      true,
    );
    is(
      'wire row: the wired dot is filled with the accent token',
      /\.dsh-context-zip__wire-dot\[data-face="on"\]\{[^}]*background:var\(--dsw-alias-button-primary-fill\)/u.test(panelSource),
      true,
    );
    is(
      'wire row: the failed dot is filled with the error token',
      /\.dsh-context-zip__wire-dot\[data-face="error"\]\{[^}]*background:var\(--dsw-alias-state-error-primary\)/u.test(panelSource),
      true,
    );
    is(
      'wire row: the dot transition uses the panel duration and easing tokens',
      /\.dsh-context-zip__wire-dot\{[^}]*transition:background-color var\(--cz-dur\) var\(--cz-ease\),border-color var\(--cz-dur\) var\(--cz-ease\)/u.test(
        panelSource,
      ),
      true,
    );
    is('wire row: the panel keeps its 200 ms transition token', /--cz-dur:200ms/u.test(panelSource), true);
    is(
      'wire row: the busy ring runs on its own token',
      /animation:cz-wire-pulse var\(--cz-pulse\) var\(--cz-ease\) infinite/u.test(panelSource),
      true,
    );
    is(
      'wire row: the pulse animates transform and opacity only',
      /@keyframes cz-wire-pulse\{0%\{transform:scale\(1\);opacity:\.5\}70%,100%\{transform:scale\(1\.9\);opacity:0\}\}/u.test(panelSource),
      true,
    );
    is('wire row: no raw time value is written in the wire styles', /\d+m?s\b/u.test(wireCss), false);
    const pulseMs = Number(/--cz-pulse:(\d+)ms/u.exec(panelSource)?.[1]);
    is('wire row: the pulse stays at or under two seconds', pulseMs > 0 && pulseMs <= 2000, true);
    is('wire row: the pulse runs at the documented 1.2 seconds', pulseMs, 1200);
    is(
      'wire row: reduced motion stops the pulse too',
      /@media \(prefers-reduced-motion:reduce\)\{\.dsh-context-zip \*,\.dsh-context-zip-mode \*\{transition:none!important;animation:none!important\}\}/u.test(
        panelSource,
      ),
      true,
    );
    is(
      'wire row: the action reuses the panel button instead of inventing a second style',
      /className: 'dsh-context-zip__btn dsh-context-zip__btn--outline dsh-context-zip__wire-btn'/u.test(panelSource),
      true,
    );
    is('wire row: the action keeps the panel control height', /\.dsh-context-zip__btn\{min-height:32px/u.test(panelSource), true);
    is(
      'wire row: the disabled action is greyed out, hover included',
      /\.dsh-context-zip__wire-btn:disabled,\.dsh-context-zip__wire-btn:disabled:hover\{[^}]*opacity:\.55[^}]*cursor:default/u.test(panelSource),
      true,
    );

    // ── 行高与对齐：三样横排，两条文字行正好填满 --cz-row-h ─────────────────
    is(
      'wire row: the row keeps the panel row height',
      /\.dsh-context-zip__wire\{display:flex;align-items:center;gap:16px;min-height:var\(--cz-row-h\)\}/u.test(panelSource),
      true,
    );
    is(
      'wire row: the title block does not stretch',
      /\.dsh-context-zip__wire-title\{flex:none;/u.test(panelSource),
      true,
    );
    is(
      'wire row: the middle block stacks the two lines',
      /\.dsh-context-zip__wire-body\{[^}]*flex-direction:column\}/u.test(panelSource),
      true,
    );
    is(
      'wire row: the main line uses the medium line token',
      /\.dsh-context-zip__wire-main\{[^}]*line-height:var\(--cz-line-md\)/u.test(panelSource),
      true,
    );
    is(
      'wire row: the sub line uses the small line token',
      /\.dsh-context-zip__wire-sub\{[^}]*line-height:var\(--cz-line-sm\)/u.test(panelSource),
      true,
    );
    is(
      'wire row: the two line tokens add up to the row height, so no button state is shorter',
      /--cz-line-sm:18px;--cz-line-md:22px;/u.test(panelSource) && /--cz-row-h:40px;/u.test(panelSource),
      true,
    );
    is(
      'wire row: the sub line is indented clear of the dot',
      /\.dsh-context-zip__wire-sub\{[^}]*padding-left:16px/u.test(panelSource),
      true,
    );
    is(
      'wire row: the button is the last flex item, so its right edge matches the segment control',
      /\.dsh-context-zip__wire-btn\{flex:none\}/u.test(panelSource) && /\.dsh-context-zip__row-ctl\{margin-left:auto;/u.test(panelSource),
      true,
    );
  } finally {
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
    globalThis.fetch = priorFetch;
    globalThis.setInterval = priorSetInterval;
    globalThis.clearInterval = priorClearInterval;
  }
}

// ---------------------------------------------------------------------------
// Reading besides the interval
//
// A hidden tab is throttled by the browser (measured: 22 023 / 36 942 /
// 60 003 ms gaps against a 5 000 ms interval), and during that window the panel
// shows stale counts with nothing on screen saying so. The documented answer is
// to read once more the moment the page is visible again — not to fight for the
// 5-second cadence in the background. Returning the timer's pending tick at the
// same moment is the browser's courtesy, so the two reads describe ONE
// transition and a time window drops the duplicate; the timer is never re-armed
// or skipped. The environment and the clock are injected here so the lifecycle
// is checked without a DOM and without waiting five seconds.
// ---------------------------------------------------------------------------
{
  const makeDoc = (visibilityState) => {
    const listeners = new Map();
    return {
      visibilityState,
      addEventListener: (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      removeEventListener: (type, listener) => {
        const list = listeners.get(type) ?? [];
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
      },
      fire: (type) => {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      },
      count: (type) => (listeners.get(type) ?? []).length,
    };
  };

  /** A poll with an injectable clock: `advance` moves time, nothing else does. */
  const harness = (visibilityState, overrides = {}) => {
    const doc = makeDoc(visibilityState);
    const polls = [];
    const reads = [];
    let clock = 100_000;
    const poll = startLivePoll({
      read: () => reads.push(polls.length),
      intervalMs: LIVE_POLL_MS,
      doc,
      now: () => clock,
      setTimer: (fn, ms) => {
        polls.push({ fn, ms });
        return polls.length;
      },
      clearTimer: (id) => {
        polls[id - 1] = null;
      },
      ...overrides,
    });
    return { doc, polls, reads, poll, advance: (ms) => (clock += ms) };
  };

  const first = harness('visible');
  is('live poll: arms one timer at the documented interval', first.polls.length, 1);
  is('live poll: the timer carries the 5-second interval', first.polls[0].ms, 5000);
  is('live poll: nothing is read before the timer or an event', first.reads.length, 0);

  const back = harness('visible');
  back.advance(LIVE_POLL_MS);
  back.polls[0].fn();
  is('live poll: the interval reads once', back.reads.length, 1);
  back.advance(LIVE_POLL_MS);
  back.doc.fire('visibilitychange');
  is('live poll: coming back to the foreground reads at once', back.reads.length, 2);

  const away = harness('hidden');
  away.advance(LIVE_POLL_MS);
  away.polls[0].fn();
  away.doc.fire('visibilitychange');
  is('live poll: going to the background does not read', away.reads.length, 1);

  const stopped = harness('visible');
  stopped.doc.fire('visibilitychange');
  const beforeStop = stopped.reads.length;
  stopped.poll();
  stopped.doc.fire('visibilitychange');
  is('live poll: stopping clears the timer', stopped.polls[0], null);
  is('live poll: stopping removes the visibility listener', stopped.doc.count('visibilitychange'), 0);
  is('live poll: a stopped poll ignores a late visibility event', stopped.reads.length, beforeStop);

  // The window itself, as a predicate: 999 ms after a read is a duplicate,
  // 1000 ms is the next read, and a poll that has never read is always due.
  is('live dedupe: the window the report argues for', LIVE_DEDUPE_MS, 1000);
  ok('live dedupe: the window stays well under the interval', LIVE_DEDUPE_MS < LIVE_POLL_MS);
  ok('live dedupe: before the first read there is nothing to collide with', liveReadDue(Number.NEGATIVE_INFINITY, 1000));
  ok('live dedupe: a read 999 ms after another is refused', !liveReadDue(1000, 1999));
  ok('live dedupe: the window boundary itself is due', liveReadDue(1000, 2000));

  // The burst: the released tick and the visibility read land in the same turn.
  // Chrome 153 was measured returning the pair 494 ms apart, so the window has
  // to cover more than a few milliseconds.
  const burst = harness('visible');
  burst.advance(LIVE_POLL_MS);
  burst.polls[0].fn();
  burst.advance(494);
  burst.doc.fire('visibilitychange');
  is('live dedupe: the tick and the return read become one request', burst.reads.length, 1);
  burst.advance(LIVE_DEDUPE_MS - 494);
  burst.doc.fire('visibilitychange');
  is('live dedupe: the window is measured from the read, not from the event', burst.reads.length, 2);

  // The rule that matters for the panel's promise: the window may not thin the
  // cadence, so consecutive ticks (one interval apart) always read.
  const cadence = harness('visible');
  cadence.advance(LIVE_POLL_MS);
  cadence.polls[0].fn();
  cadence.advance(LIVE_POLL_MS);
  cadence.polls[0].fn();
  cadence.advance(LIVE_POLL_MS);
  cadence.polls[0].fn();
  is('live dedupe: the timer is never suppressed by the window', cadence.reads.length, 3);

  // An unanswered read still counts. The tick that opens the burst has not
  // answered when the listener fires, so a rule keyed on the ANSWER would
  // suppress nothing at all; this pins the decision to the dispatch.
  const inFlightDoc = makeDoc('visible');
  let dispatched = 0;
  let tick = null;
  const inFlightPoll = startLivePoll({
    read: () => {
      dispatched += 1;
      return new Promise(() => {});
    },
    intervalMs: LIVE_POLL_MS,
    doc: inFlightDoc,
    now: () => 0,
    setTimer: (fn) => {
      tick = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  tick();
  inFlightDoc.fire('visibilitychange');
  is('live dedupe: an unanswered read still opens the window', dispatched, 1);
  inFlightPoll();
}


// ---------------------------------------------------------------------------
// The composer chip's read, when it does not land the first time
//
// The chip reads `/dsh-context-zip/mode` the moment the composer mounts, and
// that read races the host: the browser names a session the running process may
// not have registered yet, and the route answers 404 `session-not-found`.
//
// The shipped behavior treated that as final. Measured in Chrome 153 with the
// first read of a fresh load failed on purpose: the chip went
// `data-failed="true"` with a disabled checkbox, and in the next ten seconds it
// sent no further request. A real mouse click on it delivered pointerdown,
// mousedown, mouseup and click to the track span, none of them cancelled, and
// the checkbox never toggled and nothing was requested — "the switch does
// nothing", with no way back but a page reload.
//
// These checks pin the three decisions that fix it: the schedule, the retry
// loop, and what a click means while the chip cannot be read.
// ---------------------------------------------------------------------------
{
  /** A doc stub with the same shape the poll's checks use. */
  const makeDoc = (visibilityState) => {
    const listeners = new Map();
    return {
      visibilityState,
      addEventListener: (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      removeEventListener: (type, listener) => {
        const list = listeners.get(type) ?? [];
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
      },
      fire: (type) => {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      },
      count: (type) => (listeners.get(type) ?? []).length,
    };
  };

  // The schedule itself. 400 ms first because the condition waited out is the
  // host registering a session, and a 30 s floor so a host that never answers is
  // polled twice a minute and no more.
  is('mode retry: the schedule starts at 400 ms', MODE_RETRY_SCHEDULE_MS[0], 400);
  is('mode retry: the schedule ends at a 30 s floor', MODE_RETRY_SCHEDULE_MS[MODE_RETRY_SCHEDULE_MS.length - 1], 30000);
  ok('mode retry: the schedule only ever grows', MODE_RETRY_SCHEDULE_MS.every((ms, at) => at === 0 || ms >= MODE_RETRY_SCHEDULE_MS[at - 1]));
  is('mode retry: before the first failure the first step is used', modeRetryDelay(0), 400);
  is('mode retry: the first failure waits the first step', modeRetryDelay(1), 400);
  is('mode retry: the second failure waits the second step', modeRetryDelay(2), 1000);
  is(
    'mode retry: a long run settles on the floor rather than growing',
    modeRetryDelay(50),
    MODE_RETRY_SCHEDULE_MS[MODE_RETRY_SCHEDULE_MS.length - 1],
  );
  is('mode retry: a nonsense counter still answers a step', modeRetryDelay(Number.NaN), 400);

  // A click has two meanings and the reader decides which.
  is('mode click: a readable chip is flipped', modeClickIntent(true), 'flip');
  is('mode click: an unreadable chip is re-read', modeClickIntent(false), 'retry');

  /** A retry loop with an injectable clock and hand-cranked timers. */
  const harness = (visibilityState, outcomes) => {
    const doc = makeDoc(visibilityState);
    const timers = [];
    const attempts = [];
    let clock = 100_000;
    let call = 0;
    const stop = startModeReadRetry({
      read: () => Promise.resolve(outcomes[Math.min(call++, outcomes.length - 1)] === true),
      doc,
      now: () => clock,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: (id) => {
        timers[id - 1] = null;
      },
      onAttempt: (failures) => attempts.push(failures),
    });
    return {
      doc,
      timers,
      attempts,
      stop,
      calls: () => call,
      advance: (ms) => (clock += ms),
      /** Run the newest armed timer, if any. */
      tick: () => {
        const armed = timers.filter(Boolean).pop();
        if (armed) armed.fn();
      },
    };
  };

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // One failure may not be final: that is the whole defect.
  const retried = harness('visible', [false, false, true]);
  await settle();
  is('mode retry: the first read goes out at once', retried.calls(), 1);
  is('mode retry: a failure arms a timer instead of giving up', retried.timers.length, 1);
  is('mode retry: the first retry waits one step', retried.timers[0].ms, MODE_RETRY_SCHEDULE_MS[0]);

  retried.tick();
  await settle();
  is('mode retry: the armed timer reads again', retried.calls(), 2);
  is('mode retry: a second failure arms the second step', retried.timers[1].ms, MODE_RETRY_SCHEDULE_MS[1]);

  retried.tick();
  await settle();
  is('mode retry: the read that lands stops the loop', retried.calls(), 3);
  is('mode retry: two failures are reported once each', JSON.stringify(retried.attempts.slice(0, 2)), JSON.stringify([1, 2]));
  is('mode retry: a success reports the counter back to zero', retried.attempts[retried.attempts.length - 1], 0);
  is('mode retry: nothing is armed after the read lands', retried.timers.length, 2);

  // A read that throws is a failure like any other, not an unhandled rejection.
  const throwing = (() => {
    const doc = makeDoc('visible');
    const timers = [];
    let call = 0;
    const stop = startModeReadRetry({
      read: () => {
        call += 1;
        if (call === 1) throw new Error('fetch blew up');
        return Promise.resolve(true);
      },
      doc,
      now: () => 0,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    return { timers, calls: () => call, stop };
  })();
  await settle();
  is('mode retry: a throwing read retries instead of escaping', throwing.timers.length, 1);

  // Coming back to the tab reads at once, and the released tick is de-duplicated
  // against it with the same window the panel's poll uses.
  const back = harness('visible', [false, false, true]);
  await settle();
  back.advance(MODE_DEDUPE_MS);
  back.doc.fire('visibilitychange');
  await settle();
  is('mode retry: returning to the tab reads without waiting for the timer', back.calls(), 2);
  is('mode retry: the return trip clears the pending timer', back.timers[0], null);
  is('mode retry: the dedupe window matches the panel\u2019s', MODE_DEDUPE_MS, LIVE_DEDUPE_MS);

  const burst = harness('visible', [false, false, true]);
  await settle();
  burst.advance(494);
  burst.doc.fire('visibilitychange');
  await settle();
  is('mode retry: a return inside the window does not add a read', burst.calls(), 1);

  const hidden = harness('hidden', [false, true]);
  await settle();
  hidden.advance(MODE_DEDUPE_MS);
  hidden.doc.fire('visibilitychange');
  await settle();
  is('mode retry: a hidden page does not read on the transition', hidden.calls(), 1);

  const stopped = harness('visible', [false, true]);
  await settle();
  stopped.advance(MODE_DEDUPE_MS);
  stopped.stop();
  stopped.doc.fire('visibilitychange');
  await settle();
  is('mode retry: stopping clears the timer', stopped.timers[0], null);
  is('mode retry: stopping removes the visibility listener', stopped.doc.count('visibilitychange'), 0);
  is('mode retry: a stopped loop ignores a late visibility event', stopped.calls(), 1);
}


// ---------------------------------------------------------------------------
// `build.mjs` 在「删了声明却没能重新生成」时的退出码
//
// 2026.09.19 D7：交付树那次构建先 `rmSync` 掉 `lib/types` 与 `engine/lib/types`，
// 然后因为树里没有 typescript 而三趟全部走 `declarations: skipped`，删完一个都不补，
// `BUILD_EXIT` 仍是 0，而 `package.json` 的 `exports[*].types` 当场悬空。事后靠
// `plugloop.sh` 补一趟同步绕过去，但退出码不诚实会继续骗人。
//
// 现在的判据分三种情形，这一段把三种都钉住，判据是**真的跑一遍 build.mjs**：
//   1. 没有 typescript、声明文件在 → 一个字节都不删，退出码 0（交付树的正常路径）；
//   2. 没有 typescript、声明文件缺 → 非零退出，指名缺哪几个（本条的验收）；
//   3. 有 typescript、某一趟 tsc 没产出 → 非零退出，指名那一趟。
// 第 3 种用一份把 `include` 指到空文件的 tsconfig 造出来：tsc 会抛 TS18003，
// build.mjs 必须把「趟跑完了但文件不在」当成失败，而不是当成「这次不需要声明」。
// ---------------------------------------------------------------------------
{
  const pluginRoot = installedPluginDirectory();
  if (pluginRoot === null) {
    ok('build exit code: the plugin tree is reachable for the build probe', false);
  } else {
    const emitted = ['lib/types/index.d.ts', 'lib/types/client/index.d.ts', 'engine/lib/types/index.d.ts'];
    const probe = await mkdtemp(join(tmpdir(), 'zc-build-'));
    try {
      // 只拷构建真正读的东西：源码、构建脚本、tsconfig。node_modules 自己种。
      for (const entry of ['build.mjs', 'package.json', 'tsconfig.json', 'tsconfig.types.json', 'tsconfig.types.client.json', 'tsconfig.types.engine.json']) {
        await cp(join(pluginRoot, entry), join(probe, entry));
      }
      for (const directory of ['src', 'client', 'engine']) {
        await cp(join(pluginRoot, directory), join(probe, directory), { recursive: true });
        await rm(join(probe, directory, 'lib'), { recursive: true, force: true });
      }
      // 构建还会打一份测试入口（`test/entry.ts`），所以 test/ 也要在。
      await cp(join(pluginRoot, 'test'), join(probe, 'test'), { recursive: true });
      await rm(join(probe, 'test', 'build'), { recursive: true, force: true });
      await mkdir(join(probe, 'node_modules'), { recursive: true });
      // esbuild 从源码树的 node_modules 借；找不到就从 npm 缓存里找（与 build.mjs
      // 自己的搜索顺序一致）。typescript 与 @types 到第 3 种情形才接上。
      const esbuildSource = [join(pluginRoot, 'node_modules', 'esbuild'), join(dirname(here), 'node_modules', 'esbuild')].find(
        (candidate) => existsSyncSafe(candidate),
      );
      const cachedEsbuild = (() => {
        const cacheRoot = join(process.env.HOME ?? '/root', '.npm/_npx');
        if (!existsSyncSafe(cacheRoot)) return null;
        for (const name of readdirSync(cacheRoot)) {
          const candidate = join(cacheRoot, name, 'node_modules', 'esbuild');
          if (existsSyncSafe(candidate)) return candidate;
        }
        return null;
      })();
      const esbuildPath = esbuildSource ?? cachedEsbuild;
      ok('build exit code: esbuild is reachable for the probe', esbuildPath !== null && esbuildPath !== undefined);
      if (esbuildPath !== null && esbuildPath !== undefined) {
        await symlink(esbuildPath, join(probe, 'node_modules', 'esbuild'), 'dir');
      }
      const runBuild = () => {
        const result = spawnSync(process.execPath, [join(probe, 'build.mjs')], { cwd: probe, encoding: 'utf8' });
        return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
      };

      // 情形 1：没有 typescript，声明齐 → 不删、不红。
      await mkdir(join(probe, 'lib', 'types', 'client'), { recursive: true });
      await mkdir(join(probe, 'engine', 'lib', 'types'), { recursive: true });
      for (const file of emitted) await writeFile(join(probe, file), '// prebuilt declaration\n');
      const withoutTsc = runBuild();
      is('build exit code: a tree without typescript but with declarations still builds', withoutTsc.status, 0);
      is(
        'build exit code: it says it left them alone',
        withoutTsc.out.includes('already present and were left untouched'),
        true,
      );
      is(
        'build exit code: the declarations are still on disk',
        emitted.every((file) => existsSyncSafe(join(probe, file))),
        true,
      );

      // 情形 2：没有 typescript，声明缺 → 非零退出并指名。
      await rm(join(probe, 'lib', 'types'), { recursive: true, force: true });
      await rm(join(probe, 'engine', 'lib', 'types'), { recursive: true, force: true });
      const withoutTscMissing = runBuild();
      is('build exit code: a tree without typescript and without declarations fails', withoutTscMissing.status !== 0, true);
      is(
        'build exit code: the failure names the missing pointers',
        emitted.every((file) => withoutTscMissing.out.includes(file)),
        true,
      );
      is(
        'build exit code: the failure says why it cannot be honest',
        withoutTscMissing.out.includes('cannot honestly report success'),
        true,
      );

      // 情形 3：接上 typescript，但把一趟 tsc 指到空输入 → 非零退出并指名那一趟。
      const tscSource = join(dirname(here), 'node_modules', 'typescript');
      const typesSource = join(dirname(here), 'node_modules', '@types');
      ok('build exit code: typescript is reachable for the third case', existsSyncSafe(tscSource));
      if (existsSyncSafe(tscSource)) {
        await symlink(tscSource, join(probe, 'node_modules', 'typescript'), 'dir');
        if (existsSyncSafe(typesSource)) await symlink(typesSource, join(probe, 'node_modules', '@types'), 'dir');
        const healthy = runBuild();
        is('build exit code: with typescript the build still succeeds', healthy.status, 0);
        is(
          'build exit code: and every promised declaration exists again',
          emitted.every((file) => existsSyncSafe(join(probe, file))),
          true,
        );
        const broken = await readFile(join(probe, 'tsconfig.types.engine.json'), 'utf8');
        await writeFile(
          join(probe, 'tsconfig.types.engine.json'),
          broken.replace('"include": ["engine/**/*.ts"]', '"include": ["engine/nothing-here.ts"]'),
        );
        const failedPass = runBuild();
        is('build exit code: a declaration pass that produces nothing fails the build', failedPass.status !== 0, true);
        is(
          'build exit code: the failure names the pass and the file',
          failedPass.out.includes('tsconfig.types.engine.json') && failedPass.out.includes('engine/lib/types/index.d.ts'),
          true,
        );
      }
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// The installer's idea of "this profile's home"
//
// A destructively wrong answer here deletes another home's notes, which is the
// worst thing this plugin can do to a user. The rule is that `--profile-dir`
// decides, and the ambient `DSH_HOME` never does: during an isolated test the
// two are different by construction, and following the environment is exactly
// how the wrong home got targeted.
// ---------------------------------------------------------------------------
{
  const installer = join(dirname(here), 'install.mjs');
  const probe = await mkdtemp(join(tmpdir(), 'zc-installer-'));
  const profileHome = join(probe, 'profile-home');
  const otherHome = join(probe, 'other-home');
  const profileDir = join(profileHome, 'profiles', 'web');
  await mkdir(join(profileDir, 'node_modules', '@deepseek-ai'), { recursive: true });
  await mkdir(join(profileHome, 'context-zip', 'notes'), { recursive: true });
  await mkdir(join(otherHome, 'context-zip', 'notes'), { recursive: true });
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }));
  await writeFile(join(profileHome, 'context-zip', 'notes', 'mine.md'), 'belongs to this profile\n');
  await writeFile(join(otherHome, 'context-zip', 'notes', 'theirs.md'), 'belongs to another home\n');

  const runInstaller = (argv) => {
    const result = spawnSync(process.execPath, [installer, ...argv], {
      encoding: 'utf8',
      // The ambient home is the OTHER one on purpose. This is the arrangement
      // that used to send `--purge` into the wrong directory.
      env: { ...process.env, DSH_HOME: otherHome },
    });
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  const dry = runInstaller(['--profile-dir', profileDir, '--uninstall']);
  is('installer: uninstall succeeds on a bare profile', dry.status, 0);
  is('installer: reports the profile home, not DSH_HOME', dry.out.includes(join(profileHome, 'context-zip')), true);
  is('installer: never reports the ambient home as the target', dry.out.includes(`kept ${join(otherHome, 'context-zip')}`), false);
  is('installer: names the disagreement out loud', dry.out.includes('which is not this profile\'s home'), true);
  is('installer: a plain uninstall deletes nothing', existsSyncSafe(join(profileHome, 'context-zip', 'notes', 'mine.md')), true);

  const purged = runInstaller(['--profile-dir', profileDir, '--purge']);
  is('installer: purge succeeds', purged.status, 0);
  is('installer: purge removes the profile home store', existsSyncSafe(join(profileHome, 'context-zip')), false);
  is('installer: purge leaves the ambient home alone', existsSyncSafe(join(otherHome, 'context-zip', 'notes', 'theirs.md')), true);

  // `--home` may re-point the REPORT of where the data lives, but a purge that
  // would delete another home's store is refused: that is the same accident as
  // following DSH_HOME, just spelled on the command line. The duplicate store is
  // recreated because the purge above consumed it.
  await mkdir(join(otherHome, 'context-zip', 'notes'), { recursive: true });
  await writeFile(join(otherHome, 'context-zip', 'notes', 'theirs.md'), 'belongs to another home\n');
  const crossHome = runInstaller(['--profile-dir', profileDir, '--purge', '--home', otherHome]);
  is('installer: purge into another home is refused', crossHome.status === 0, false);
  is('installer: the refusal names the other home', crossHome.out.includes(otherHome), true);
  is('installer: the other home keeps its store', existsSyncSafe(join(otherHome, 'context-zip', 'notes', 'theirs.md')), true);
  const odd = join(probe, 'odd-profile');
  await mkdir(odd, { recursive: true });
  await writeFile(join(odd, 'package.json'), JSON.stringify({ name: 'odd', dsh: { profile: { bundles: [] } } }));
  const refused = runInstaller(['--profile-dir', odd, '--uninstall']);
  is('installer: an unrecognisable shape is refused', refused.status === 0, false);
  is('installer: the refusal says how to proceed', refused.out.includes('--home'), true);

  // `--home` reports where the data lives, and it is the only answer available
  // when the profile shape cannot be recognised. For a profile whose owning home
  // IS derivable, naming a different one is refused above, so the report follows
  // the profile: an `--home` that merely renames the owning home resolves to it,
  // and anything else has already been rejected before it can mislabel anything.
  const overridden = runInstaller(['--profile-dir', profileDir, '--uninstall', '--home', profileHome]);
  is('installer: --home naming the owning home reports it', overridden.out.includes(`${join(profileHome, 'context-zip')} (working notes and exports)`), true);

  // ── `profiles/` itself a symlink whose target is named something else ─────
  //
  // Measured gap (the one 2026.09.18 的修复报告留在「没查清的」第 1 条):
  // `owningHome` used to insist the CANONICAL level be spelled `profiles`, so
  // this layout derived nothing and `--purge` fell through to `--home` — which
  // meant `--purge --home <the home you typed>` deleted that home's store as an
  // unverified guess, and `--purge --home <the physical home>` deleted the other
  // tree's store. Install works in this layout (measured: the copy lands in the
  // real tree, EXIT=0), so it is not a theoretical shape. The spelling is real
  // evidence because the harness resolves a profile as
  // `join(resolveDshHome(), 'profiles', name)` LEXICALLY: a home spelled
  // `<home>/profiles/<name>` is a home that can run this profile, and
  // `<home>/context-zip` is where that run keeps its data. The physical home in
  // this layout cannot even see the profile — `<physical>/profiles/web` does not
  // exist — so deleting its store would destroy some other profile's notes.
  const linkedHome = join(probe, 'linked-home');
  const realHome = join(probe, 'real-home');
  const linkedProfile = join(linkedHome, 'profiles', 'web');
  await mkdir(join(realHome, 'profiles-real', 'web', 'node_modules'), { recursive: true });
  await mkdir(join(linkedHome, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic'), { recursive: true });
  await writeFile(
    join(linkedHome, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-compaction-basic', version: '9.9.9-shipped', main: 'index.js' }),
  );
  await writeFile(join(linkedHome, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'index.js'), 'module.exports = {};\n');
  await writeFile(
    join(realHome, 'profiles-real', 'web', 'package.json'),
    JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }),
  );
  await mkdir(join(linkedHome, 'context-zip', 'notes'), { recursive: true });
  await mkdir(join(realHome, 'context-zip', 'notes'), { recursive: true });
  await writeFile(join(linkedHome, 'context-zip', 'notes', 'mine.md'), 'the store of the home that can see this profile\n');
  await writeFile(join(realHome, 'context-zip', 'notes', 'theirs.md'), 'the store of a home that cannot\n');
  await symlink(join(realHome, 'profiles-real'), join(linkedHome, 'profiles'));

  const linkedInstall = runInstaller(['--profile-dir', linkedProfile]);
  is('installer: installs through a symlinked profiles level', linkedInstall.status, 0);

  const physicalHome = runInstaller(['--profile-dir', linkedProfile, '--purge', '--home', realHome]);
  is('installer: purge naming the physical home is refused', physicalHome.status === 0, false);
  is('installer: the refusal names the derived home', physicalHome.out.includes(join(linkedHome, 'context-zip')), true);
  is('installer: the refused purge leaves both stores alone', existsSyncSafe(join(realHome, 'context-zip', 'notes', 'theirs.md')) && existsSyncSafe(join(linkedHome, 'context-zip', 'notes', 'mine.md')), true);

  const spelledHome = runInstaller(['--profile-dir', linkedProfile, '--purge']);
  is('installer: purge derives the home the profile is spelled under', spelledHome.status, 0);
  is('installer: the derived store is the one removed', existsSyncSafe(join(linkedHome, 'context-zip')), false);
  is('installer: the unreachable home keeps its store', existsSyncSafe(join(realHome, 'context-zip', 'notes', 'theirs.md')), true);
  is('installer: the report calls that home derived, not named', spelledHome.out.includes(`${linkedHome} (--profile-dir)`), true);

  // ── `odd` + `--home` + `--purge` needs an explicit yes ───────────────────
  //
  // When NEITHER derivation clue names a home, `--home` is the only thing that
  // points at a store, and it is exactly as reliable as the caller's typing. The
  // old shape of that branch said so in a `note` line and deleted
  // `<--home>/context-zip` recursively anyway, which is the risk `--yes-unnamed-home`
  // now makes the caller acknowledge. These checks pin both directions of the
  // gate, and pin that the shapes where a home IS derivable (this profile, and
  // the linked `profiles/` layout above) still need no flag at all, so it cannot
  // quietly widen into a general force switch.
  const namedHome = join(probe, 'named-home');
  const bystanderHome = join(probe, 'bystander-home');
  await mkdir(join(namedHome, 'context-zip', 'notes'), { recursive: true });
  await mkdir(join(bystanderHome, 'context-zip', 'notes'), { recursive: true });
  await writeFile(join(namedHome, 'context-zip', 'notes', 'mine.md'), 'the store the caller named\n');
  await writeFile(join(bystanderHome, 'context-zip', 'notes', 'theirs.md'), 'a store nothing pointed at\n');

  // A real install first: the refusal has to be observable as "nothing was
  // deleted", and a bare profile cannot show that. The stub MUST sit one level
  // above the profile: at `<profile>/node_modules/@deepseek-ai/…` it occupies the
  // redirect path itself, and the installer reads it as somebody's real package
  // and refuses to install over it (measured while writing this block).
  const shippedStub = join(probe, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic');
  await mkdir(shippedStub, { recursive: true });
  await writeFile(
    join(shippedStub, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-compaction-basic', version: '9.9.9-shipped', main: 'index.js' }),
  );
  await writeFile(join(shippedStub, 'index.js'), 'module.exports = {};\n');
  const oddInstall = runInstaller(['--profile-dir', odd]);
  is('installer: the unrecognisable profile still takes a real install', oddInstall.status, 0);

  const unnamed = runInstaller(['--profile-dir', odd, '--purge', '--home', namedHome]);
  is('installer: an underived home needs the explicit yes', unnamed.status === 0, false);
  is('installer: the refusal names the store that --home would delete', unnamed.out.includes(join(namedHome, 'context-zip')), true);
  is('installer: the refusal says that delete is recursive', unnamed.out.includes('RECURSIVELY'), true);
  is('installer: the refusal names the switch to add', unnamed.out.includes('--yes-unnamed-home'), true);
  is('installer: the refused purge leaves the named store alone', existsSyncSafe(join(namedHome, 'context-zip', 'notes', 'mine.md')), true);
  is('installer: the refused purge leaves the other store alone', existsSyncSafe(join(bystanderHome, 'context-zip', 'notes', 'theirs.md')), true);
  is(
    'installer: the refused purge leaves the install standing',
    existsSyncSafe(join(odd, 'node_modules', 'dsh-context-zip', 'package.json')),
    true,
  );

  // The switch confirms a home the caller names; it cannot name one. With no
  // `--home` there is nothing to aim at, so the refusal survives the flag.
  const nameless = runInstaller(['--profile-dir', odd, '--purge', '--yes-unnamed-home']);
  is('installer: the switch does not stand in for --home', nameless.status === 0, false);
  is('installer: that refusal asks for --home', nameless.out.includes('--home'), true);
  is('installer: that refusal asks for the switch as well', nameless.out.includes('--yes-unnamed-home'), true);

  const confirmed = runInstaller(['--profile-dir', odd, '--purge', '--home', namedHome, '--yes-unnamed-home']);
  is('installer: the switch lets the named store go', confirmed.status, 0);
  is('installer: the named store is the one removed', existsSyncSafe(join(namedHome, 'context-zip')), false);
  is('installer: the other store survives the confirmed purge', existsSyncSafe(join(bystanderHome, 'context-zip', 'notes', 'theirs.md')), true);
  is('installer: the confirmed purge still says the home was used as given', confirmed.out.includes('used as given'), true);

  // `--uninstall` deletes no store, so it never needs the switch: the odd shape
  // still takes a plain `--home` for the report.
  await mkdir(join(namedHome, 'context-zip', 'notes'), { recursive: true });
  await writeFile(join(namedHome, 'context-zip', 'notes', 'mine.md'), 'still here\n');
  const oddDry = runInstaller(['--profile-dir', odd, '--uninstall', '--home', namedHome]);
  is('installer: an odd --uninstall still needs no switch', oddDry.status, 0);
  is('installer: an odd --uninstall keeps the store', existsSyncSafe(join(namedHome, 'context-zip', 'notes', 'mine.md')), true);

  // A derivable home needs no flag: `--home` is checked against the derived one
  // there and the switch decides nothing. The linked layout is that shape.
  await mkdir(join(linkedHome, 'context-zip', 'notes'), { recursive: true });
  await writeFile(join(linkedHome, 'context-zip', 'notes', 'mine.md'), 'recreated\n');
  const linkedNamed = runInstaller(['--profile-dir', linkedProfile, '--purge', '--home', linkedHome]);
  is('installer: a derivable home still purges without the switch', linkedNamed.status, 0);
  is('installer: and its store is the one removed', existsSyncSafe(join(linkedHome, 'context-zip')), false);

  // The switch acknowledges a home that could not be derived. It must not become
  // a general force flag: a `--home` that disagrees with a derivable home is
  // still refused, flag or no flag.
  await mkdir(join(otherHome, 'context-zip', 'notes'), { recursive: true });
  await writeFile(join(otherHome, 'context-zip', 'notes', 'theirs.md'), 'belongs to another home\n');
  const forced = runInstaller(['--profile-dir', profileDir, '--purge', '--home', otherHome, '--yes-unnamed-home']);
  is('installer: the switch does not unlock a cross-home purge', forced.status === 0, false);
  is('installer: the cross-home store survives the switch', existsSyncSafe(join(otherHome, 'context-zip', 'notes', 'theirs.md')), true);

  await rm(probe, { recursive: true, force: true });
}

  // ── locateAround: the offset a hit has to report to be usable ───────────
  {
    const body = `${'甲'.repeat(5000)}NEEDLE${'乙'.repeat(5000)}`;
    const located = locateAround(body, 'needle', 400);
    is('locateAround: finds the term case-insensitively', located.found, true);
    is('locateAround: reports the match offset', located.offset, 5000);
    is('locateAround: reports the true length, not the excerpt length', located.total, 10006);
    is('locateAround: centres the excerpt on the match', located.text.includes('NEEDLE'), true);
    is('locateAround: marks both clipped ends', located.text.startsWith('…') && located.text.endsWith('…'), true);

    // The defect this exists for: a window that does not contain the query must
    // still be distinguishable from one that does.
    const missed = locateAround(body, 'absent', 400);
    is('locateAround: a term that is not there is reported as not found', missed.found, false);
    is('locateAround: and its offset is -1', missed.offset, -1);

    const short = locateAround('tiny body', 'tiny', 400);
    is('locateAround: a body under the bound is returned whole', short.text, 'tiny body');

    // The offset must be a RAW index, because that is what `history_read`'s `offset`
    // addresses. Computing it after collapsing whitespace — which this did until
    // 2026.09.18 — put every offset past the first newline in the wrong place.
    // Measured on the 132,920-character dense seed the drift reaches 361 characters.
    const multiline = `line one\nline two\n\nNEEDLE here\n${'pad '.repeat(40)}`;
    const rawAt = multiline.indexOf('NEEDLE');
    const flatAt = multiline.replace(/\s+/gu, ' ').trim().indexOf('NEEDLE');
    ok('locateAround: the fixture really does separate the two coordinate spaces', rawAt !== flatAt);
    const locatedMulti = locateAround(multiline, 'NEEDLE', 60);
    is('locateAround: the offset is a raw index, not a flattened one', locatedMulti.offset, rawAt);
    is('locateAround: the total is the raw length', locatedMulti.total, multiline.length);
    is(
      'locateAround: slicing the raw body at the offset lands on the term',
      multiline.slice(locatedMulti.offset).toLowerCase().startsWith('needle'),
      true,
    );
    ok('locateAround: the excerpt still shows the term', locatedMulti.text.includes('NEEDLE'));
    is('locateAround: with no clipping marks', short.text.includes('…'), false);
  }

  // ── eventBody: what the extract pattern is allowed to see ───────────────
  {
    is(
      'eventBody: reads a user message',
      eventBody({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } }),
      'hello',
    );
    is(
      'eventBody: reads an assistant message through its wrapper',
      eventBody({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'said' }] } } }),
      'said',
    );
    is(
      'eventBody: reads a tool result through its wrapper',
      eventBody({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'out' }] } } }),
      'out',
    );
    is('eventBody: an unknown type yields nothing', eventBody({ type: 'other/thing', data: {} }), '');
    is('eventBody: a missing event yields nothing', eventBody(null), '');
    // The point of not bounding it: a stopping rule has to be able to reach the
    // end of an event. `renderEvent` bounds at EVENT_TEXT_CHARS; this must not.
    const long = 'x'.repeat(200000);
    is(
      'eventBody: does not truncate a long event',
      eventBody({ type: 'user/message', data: { content: [{ type: 'text', text: long }] } }).length,
      200000,
    );
  }

  // ── history_find: the schema the model is handed ────────────────────────
  {
    // `defineTool` normalizes the declaration into JSON Schema, so the checks read
    // the wire shape the model is actually handed rather than the input shape.
    const tool = historyFindTool({ get: () => ({}) }, {});
    is('history_find: is named as expected', tool.name, 'history_find');
    is('history_find: queries is required', tool.parameters.required, ['queries']);
    is('history_find: takes a list of terms', tool.parameters.properties.queries.type, 'array');
    is('history_find: the terms are strings', tool.parameters.properties.queries.items.type, 'string');
    is('history_find: offers the stopping rule', tool.parameters.properties.extract.type, 'string');
    is('history_find: offers a budget', tool.parameters.properties.budgetChars.type, 'integer');
    // The runtime validates the arguments first and reports `false` for anything
    // that does not parse, so the check has to pass a real call.
    is('history_find: a valid call is concurrency-safe', tool.isConcurrencySafe({ queries: ['x'] }), true);
    is('history_find: a call with no terms is not', tool.isConcurrencySafe({}), false);
    is('history_find: an unusable term list is not', tool.isConcurrencySafe({ queries: 'x' }), false);
    // The batch tool must not be reachable under the wrong name: `restrict` throws
    // on an unknown tool name, and the granular mode denies this exact string.
    is('history_find: the deny name matches the registered name', tool.name, 'history_find');
  }

  // ── history_find: the loop that used to cost a round trip per term ──────
  {
    /** Every query the tool ran, so the checks can prove they happened in ONE call. */
    const asked = [];
    const bodies = {
      8: `${'前'.repeat(3000)}MARKER-14-07${'后'.repeat(3000)}`,
      12: 'a short event with nothing of interest in it at all',
      30: 'another event mentioning 封口 but not the value',
    };
    const query = {
      searchEvents: async (request) => {
        asked.push(request.query);
        const table = {
          压缩: [8, 30],
          gzip: [12],
          zstd: [8],
          // A term that matches nothing at all must not abort the batch.
          不存在的词: [],
          // A term that is literally present, so the offset branch has a subject.
          封口: [30],
          // Enough hits that the smallest allowed budget cannot hold them all.
          很多: [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50],
        };
        const seqs = table[request.query] ?? [];
        return {
          items: seqs.map((seq, index) => ({
            seq,
            type: 'user/message',
            text: bodies[seq],
            snippet: `excerpt for ${seq}`,
            index,
          })),
        };
      },
      readEvent: async ({ seq }) => ({ target: { seq, type: 'user/message', data: { content: [{ type: 'text', text: bodies[seq] ?? '' }] } } }),
    };
    // `snapshotEvents` is the live session's own reader and is tried first; without
    // it `loadSegments` falls through to the query service, which this mock does not
    // implement. An empty log is fine: the point under test is what the tool does
    // with hits, not how segments are derived.
    const session = { id: 'session-find', seq: 200, snapshotEvents: () => [] };
    const exec = { agent: { session } };
    const tool = historyFindTool({ get: () => query }, { historyBoundary: () => 129 });

    // (1) Every term travels in one call, and success does not depend on order.
    const all = await tool.execute({ queries: ['压缩', 'gzip', 'zstd', '不存在的词'] }, exec);
    is('history_find: every term was tried', asked, ['压缩', 'gzip', 'zstd', '不存在的词']);
    is('history_find: reports how many terms it tried', all.includes('Tried 4 term(s) in one call.'), true);
    is('history_find: a term with no hits does not abort the batch', all.includes('#8'), true);
    is('history_find: hits are de-duplicated across terms', (all.match(/#8 /gu) ?? []).length, 1);

    // Per-term addresses. The count alone says how many places matched but not where any
    // of them is, and the archive shows what that costs: 239 reads with no offset, 187 at
    // round numbers the model invented (70000, 80000, 88000, 100000 …), and a supplied
    // offset used zero times. A term the text does not contain at all is named absent,
    // because the index matches through tokenisation and a hit can arrive whose text
    // lacks the query entirely.
    // The offset branch needs a term that is literally present; the fixture's other terms
    // are all index-side matches, which is its own case and asserted next.
    const presentAt = bodies[30].indexOf('封口');
    is('history_find: the fixture really does contain the literal term', presentAt >= 0, true);
    // Its own session: the `all` call above already served seq 30, and under incremental
    // returns a second sweep of the same turn drops it before the term tally runs — which
    // would leave these assertions reading an empty tally rather than the tool's answer.
    const locatedOut = await tool.execute(
      { queries: ['封口', '不存在的词'] },
      { agent: { session: { ...session, id: 'session-find-terms' } } },
    );
    is('history_find: a term is given its offset inside the event', locatedOut.includes(`封口@${presentAt}`), true);
    is('history_find: a term the text does not contain is named absent', locatedOut.includes('不存在的词 absent'), true);
    is('history_find: the zero branch still names the terms', all.includes('不存在的词 absent'), true);
    // The receipt answers a different question from the result line: not "where is it in
    // this event" but "does my wording exist anywhere". A caller told that stops rewording.
    is(
      'history_find: the receipt counts how many terms landed',
      /1 of 2 term\(s\) present/u.test(locatedOut),
      true,
    );
    is(
      'history_find: and names the ones that landed nowhere',
      locatedOut.includes('absent everywhere: 不存在的词'),
      true,
    );
    is(
      'history_find: a term present somewhere is not called absent',
      locatedOut.includes('absent everywhere: 封口'),
      false,
    );

    // (1a) The count has to answer "is this all of them", not "how many are on this
    //      page". The search page carries no total, so the number is what the ceiling
    //      allowed and the header says so rather than implying completeness.
    is('history_find: the header counts matches session-wide', all.includes('event(s) matched in this session'), true);
    is('history_find: a term under the ceiling is not reported as truncated', all.includes('true total may be higher'), false);

    // (1b) A batch WITHOUT a stopping rule must still return readable excerpts.
    //      This is the regression that mattered: `returned` used to be the raw search
    //      entries, which carry no `body`, so every line rendered as
    //      "matched at character 0 of 0" with nothing after it and the model had to
    //      search again. `history_find` must never print that line.
    is('history_find: a batch with no stopping rule never reports an empty match', all.includes('of 0'), false);
    is('history_find: and says nothing was matched at character 0', /character 0 of/u.test(all), false);
    is('history_find: each hit without a stopping rule carries text', /#8 [^\n]*: .+\S/u.test(all), true);

    // (2) The stopping rule: only the matching event comes back, and it carries
    //     the location, which is what the single-term tool never reported.
    const stopped = await tool.execute({ queries: ['压缩', 'gzip'], extract: 'MARKER-14-07' }, exec);
    is('history_find: the extract pattern keeps only the matching event', stopped.includes('#8'), true);
    is('history_find: and drops the ones that did not match', stopped.includes('#12'), false);
    // Computed rather than typed: hand-counting the marker's length is exactly the
    // mistake an assertion should not be able to make.
    const markerAt = bodies[8].indexOf('MARKER-14-07');
    const markerTotal = bodies[8].length;
    is(
      'history_find: the match position is reported',
      stopped.includes(`extract matched at ${markerAt + 1}`) && stopped.includes(`${markerTotal} chars`),
      true,
    );
    is('history_find: the search says it stopped early', stopped.includes('stopped at the first'), true);
    is('history_find: the excerpt is centred on the value', stopped.includes('MARKER-14-07'), true);

    // (3) A pattern that matches nothing is reported, not silently empty.
    const missed = await tool.execute({ queries: ['压缩'], extract: 'NOT-PRESENT-ANYWHERE' }, exec);
    is('history_find: a stopping rule that never fires says so', missed.includes('none matched the extract pattern'), true);

    // (4) An unusable pattern is refused without losing the rest of the call.
    const bad = await tool.execute({ queries: ['压缩'], extract: '([' }, exec);
    is('history_find: an unusable pattern reports the error', bad.includes('not a valid regular expression'), true);

    // (5) No usable terms is a message, not a crash.
    const empty = await tool.execute({ queries: ['', '   ', ''] }, exec);
    is('history_find: an empty term list is refused with advice', empty.includes('at least one non-empty query term'), true);

    // (6) The budget is a budget, and its footer only claims a drop when there was
    //     one. Without an extract pattern the loop returns every de-duplicated hit,
    //     so a wide term is what makes the budget bind.
    const squeezed = await tool.execute({ queries: ['很多'], budgetChars: 1000 }, exec);
    is('history_find: says how many were shown when the budget binds', /\d+ shown within the 1000-character budget/u.test(squeezed), true);
    is('history_find: and admits how many were dropped', squeezed.includes('omitted for budget'), true);
    const roomy = await tool.execute({ queries: ['压缩', 'gzip'], budgetChars: 24000 }, exec);
    is('history_find: claims no drop when everything fit', roomy.includes('omitted for budget'), false);

    // (6b) A term whose page still has a cursor means the count is a floor, and the
    //      header must say so instead of presenting a partial number as the total.
    {
      const wide = historyFindTool(
        {
          get: () => ({
            searchEvents: async () => ({
              items: [{ seq: 60, type: 'user/message', text: 'x', snippet: 'x' }],
              nextCursor: 'more',
            }),
            readEvent: async ({ seq }) => ({
              target: { seq, type: 'user/message', data: { content: [{ type: 'text', text: '很多事都发生过。' }] } },
            }),
          }),
        },
        {},
      );
      const clipped = await wide.execute({ queries: ['很多'] }, exec);
      is('history_find: a truncated term makes the count a floor', clipped.includes('true total may be higher'), true);
      is('history_find: an unreadable body is not rendered as an empty hit', clipped.includes('character 0 of 0'), false);
    }

    // (6c) A hit inside a compaction segment must SAY so, and name the summary that
    //      replaced it. Without this the caller reads a hit as "still current" whether
    //      it is live or was compressed away, which is the difference between "this is
    //      what the record says" and "this is what the record used to say".
    {
      const segTool = historyFindTool(
        {
          get: () => ({
            searchEvents: async () => ({
              items: [{ seq: 8, type: 'user/message', text: bodies[8], snippet: 'x' }],
            }),
            readEvent: async ({ seq }) => ({
              target: { seq, type: 'user/message', data: { content: [{ type: 'text', text: bodies[8] }] } },
            }),
          }),
        },
        {},
      );
      const segSession = {
        id: 'session-seg',
        seq: 200,
        snapshotEvents: () => [
          { seq: 17, type: 'compaction/summary', data: { compactionId: 'c1', shadowedRange: { start: 8, end: 9 }, shadowedSeqs: [8, 9], shadowedTokenCount: 33344, summary: [{ type: 'text', text: '# head' }] } },
        ],
      };
      const marked = await segTool.execute({ queries: ['压缩'] }, { agent: { session: segSession } });
      is('history_find: a hit names its owning segment', marked.includes('[segment 0,'), true);
      is('history_find: and names the summary that replaced it', marked.includes('replaced by summary #17]'), true);

      const liveSession = { id: 'session-live', seq: 200, snapshotEvents: () => [] };
      const plain = await segTool.execute({ queries: ['压缩'] }, { agent: { session: liveSession } });
      is('history_find: a hit outside every segment carries no marker', plain.includes('[segment'), false);
    }

    // (6d) The excerpt is quoted from the body verbatim and lands on sentence
    //      boundaries, so the caller can quote it without going back for the
    //      surrounding text. A fixed-width window cut mid-sentence is what made the
    //      model search again for a passage it had already been shown.
    {
      const para = ['开头一句。', '第二句在这里。', '含关键词的第三句。', '第四句收尾。'].join('\n');
      const docBody = `${para}\n${'垫'.repeat(600)}\n${para}`;
      const docTool = historyFindTool(
        {
          get: () => ({
            searchEvents: async () => ({ items: [{ seq: 8, type: 'user/message', text: docBody, snippet: 'x' }] }),
            // The extract path reads the body, so this mock has to serve one.
            readEvent: async ({ seq }) => ({
              target: { seq, type: 'user/message', data: { content: [{ type: 'text', text: docBody }] } },
            }),
          }),
        },
        {},
      );
      const docSession = { id: 'session-doc', seq: 200, snapshotEvents: () => [] };
      const out = await docTool.execute({ queries: ['关键词'], extract: '含关键词的第三句' }, { agent: { session: docSession } });
      is('history_find: the excerpt is not cut mid-unit', out.includes('extract matched at') || out.includes('literal hit'), true);
      is('history_find: the excerpt includes the whole matching sentence', out.includes('含关键词的第三句。'), true);
      // The excerpt is the containing sentence, so it does not grow into the
      // neighbouring sentences that share the paragraph.
      is('history_find: the excerpt stops at the sentence boundary', out.includes('含关键词的第三句。') && !out.includes('第四句收尾。'), true);
    }

    // (7) Nothing in the session matches is stated, with the bound named.
    const none = await tool.execute({ queries: ['不存在的词'] }, exec);
    is('history_find: no hits at all is stated plainly', none.includes('No event in this session matches'), true);
  }

  // ── history_read offset: the contract that makes a hit readable ─────────
  {
    // A body with one very long event, so offsets, boundaries and the ceiling all
    // get exercised against text whose shape is like the real corpus.
    // Longer than the 1000-character floor `clampChars` enforces, so a slice can be
    // taken without running off the end.
    const body = `${'前'.repeat(40)}。${'中'.repeat(60)}。目标值 41217。${'后'.repeat(1500)}。`;
    const readQuery = {
      readEvent: async ({ seq, before, after }) => ({
        target: { seq, type: 'user/message', data: { content: [{ type: 'text', text: body }] } },
        events: [{ seq, type: 'user/message', data: { content: [{ type: 'text', text: body }] } }],
        startSeq: seq,
        endSeq: seq,
        before,
        after,
      }),
    };
    const readSession = { id: 'session-offset', seq: 300, snapshotEvents: () => [] };
    const readExec = { agent: { session: readSession } };
    const tool = historyReadTool({ get: () => readQuery }, {});

    const mark = body.indexOf('41217');

    // (1) The offset is absolute and honoured exactly: what comes back starts at the
    //     character that was asked for, not at a nearby sentence boundary.
    const slice = await tool.execute({ seq: 8, offset: mark, maxChars: 1000 }, readExec);
    is('history_read: the slice starts exactly at the offset asked for', slice.includes(body.slice(mark, mark + 1000)), true);
    is('history_read: the header states the exact range', slice.includes(`characters ${mark}..${mark + 1000} of ${body.length}`), true);
    is('history_read: and hands back the next offset to use', slice.includes(`continue with offset ${mark + 1000}`), true);
    is('history_read: the slice stops before the end so more remains', slice.includes('end of event'), false);

    // (2) At the end of the event there is no next offset to give.
    const tail = await tool.execute({ seq: 8, offset: body.length - 5, maxChars: 999 }, readExec);
    is('history_read: the last slice says it is the end', tail.includes('end of event'), true);

    // (3) An offset past the end is refused WITH the true length, because the usual
    //     cause is coordinates that came from somewhere else.
    const past = await tool.execute({ seq: 8, offset: body.length + 1 }, readExec);
    is('history_read: an offset past the end reports the real length', past.includes(`is ${body.length} characters`), true);
    is('history_read: and does not return the tail anyway', past.includes('前前前'), false);

    // (4) Ambiguous combinations are refused rather than resolved silently.
    const mixed = await tool.execute({ seq: 8, offset: 3, before: 2 }, readExec);
    is('history_read: offset with before is refused', mixed.includes('cannot be combined with'), true);
    const noSeq = await tool.execute({ offset: 3 }, readExec);
    is('history_read: offset without seq is refused', noSeq.includes('needs "seq"'), true);
    const negative = await tool.execute({ seq: 8, offset: -1 }, readExec);
    is('history_read: a negative offset is refused', negative.includes('non-negative integer'), true);

    // (5) Without "offset" nothing changed: the whole event still comes back with its
    //     old header, so existing callers are untouched.
    const whole = await tool.execute({ seq: 8, maxChars: 100000 }, readExec);
    is('history_read: reading without an offset is unchanged', whole.includes('not inside any compaction segment'), true);
    is('history_read: and does not claim a character range', whole.includes('characters 0..'), false);
  }

  // ── the retrieval ledger: a search says whether it returned anything new ──
  //
  // Measured over the dense matrix: 37.3% of adjacent retrieval pairs returned the
  // IDENTICAL event set and 51.1% of all retrievals happened after the turn already
  // held every event it would ever see. The receipt is what makes that visible.
  {
    const ledgerQuery = (hits) => ({
      filterEvents: async () => hits.map((seq) => ({ seq, type: 'user/message', text: `alpha beta ${seq}` })),
    });
    const ledgerSession = (id) => ({
      id,
      seq: 40,
      snapshotEvents: () => [
        { type: 'user/message', seq: 0, time: 1, data: { message: { content: [{ type: 'text', text: '第一问' }] } } },
      ],
    });
    // ── 开关默认关：不打开时，模型看到的东西和没有节流时一样 ──────────────
    //
    // This has to run before anything turns the switch on, which is why it sits here
    // rather than in its own section: the default is a property of a fresh process, and
    // once `setThrottleEnabled(true)` runs there is no way back to observing it.
    {
      const offHits = [20, 21];
      const offExec = { agent: { session: ledgerSession('session-throttle-off') } };
      const offTool = historySearchTool({ get: () => ledgerQuery(offHits) }, { historyBoundary: () => 39 });
      const offFirst = await offTool.execute({ query: 'alpha' }, offExec);
      const offSecond = await offTool.execute({ query: 'alpha' }, offExec);
      ok('throttle off: no receipt is added', offFirst.includes('[retrieval #') === false);
      ok('throttle off: nothing is withheld as already held', offFirst === offSecond);
      const offLong = { seq: 20, type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } };
      const offReader = historyReadTool({
        get: () => ({ readEvent: async () => ({ target: offLong, events: [offLong] }), filterEvents: async () => [] }),
      });
      const offRead = await offReader.execute({ seq: 20, offset: 0, maxChars: 6000 }, offExec);
      ok('throttle off: a read is not capped', offRead.includes('Narrowing is in force') === false);
    }

    // 以下测的是节流打开时的行为。
    setThrottleEnabled(true);

    const hitsA = [20, 21];
    const execA = { agent: { session: ledgerSession('session-ledger-a') } };
    const toolA = historySearchTool({ get: () => ledgerQuery(hitsA) }, { historyBoundary: () => 39 });

    const first = await toolA.execute({ query: 'alpha' }, execA);
    ok('receipt: the first retrieval of a turn reports every event as new', first.includes('[retrieval #1 this turn: 2 events, all new]'));
    ok('incremental: the first retrieval shows its content', first.includes('#20 ') && first.includes('#21 '));

    const again = await toolA.execute({ query: 'alpha' }, execA);
    ok(
      'incremental: the same page again returns no content',
      again.includes('[retrieval #2 this turn: nothing new; 2 match(es) were already returned earlier this turn and are left out]'),
    );
    ok('incremental: and the repeated event text is not sent a second time', again.includes('#20 ') === false && again.includes('#21 ') === false);
    // The dangerous shape: an empty result reads as "this session does not have it",
    // so a page whose matches are all held has to say which events they are.
    ok('incremental: an all-held page points at the events instead of returning nothing', again.includes('every match is already in this turn'));
    ok('incremental: one repeat alone does not yet narrow', again.includes('are paused') === false);

    const third = await toolA.execute({ query: 'alpha' }, execA);
    ok('narrowing: a second consecutive zero-novelty page announces the pause', third.includes('history_search and history_find are paused'));
    ok(
      'narrowing: the notice names the escape that stays open',
      third.includes('history_read still works') && third.includes('one read gives you one more search'),
    );
    ok('receipt: retrieval numbering keeps counting', third.includes('[retrieval #3 this turn:'));

    // A page that is part new and part seen must say both numbers, because "all new"
    // and "nothing new" are the two answers a caller actually branches on.
    let pageB = [20, 22];
    const toolB = historySearchTool({ get: () => ledgerQuery(pageB) }, { historyBoundary: () => 39 });
    const execB = { agent: { session: ledgerSession('session-ledger-b') } };
    await toolB.execute({ query: 'alpha' }, execB);
    pageB = [20, 23];
    const mixed = await toolB.execute({ query: 'alpha' }, execB);
    ok('incremental: a partly-new page reports the split', mixed.includes('[retrieval #2 this turn: 1 event shown; 1 more were already returned earlier this turn and are left out]'));
    ok('incremental: and only the new event is rendered', mixed.includes('#23 ') && mixed.includes('#20 ') === false);

    // A read is an explicit address, so it feeds the ledger but must NOT drive the
    // streak: re-reading a known event for its full text is the intended use.
    const readExec = { agent: { session: ledgerSession('session-ledger-read') } };
    // `user/message` carries its text at `data.content`; `renderEvent` reads the
    // assistant/tool shapes from `data.message.content` instead. The two are read
    // differently on purpose, so a mock written in the wrong one renders "(empty)".
    const readTarget = { seq: 20, type: 'user/message', data: { content: [{ type: 'text', text: 'alpha beta 20' }] } };
    const reader = historyReadTool({
      get: () => ({
        readEvent: async () => ({ target: readTarget, events: [readTarget] }),
        filterEvents: async () => [],
      }),
    });
    const readOne = await reader.execute({ seq: 20 }, readExec);
    ok('receipt: a read records its event', readOne.includes('[retrieval #1 this turn: 1 event, all new]'));
    const readTwo = await reader.execute({ seq: 20 }, readExec);
    ok('receipt: re-reading the same event is reported as not new', readTwo.includes('none of them new'));
    // Reads are never filtered: an explicit address always returns its content, which
    // is what makes history_read the instrument narrowing leaves in the model's hands.
    ok('incremental: a read still returns its content the second time', readTwo.includes('alpha beta 20'));
    ok('receipt: a read never narrows', readTwo.includes('are paused') === false);

    // ── 收窄与「一次读换一次搜索」 ────────────────────────────────────────────
    //
    // The mask itself lives in the plugin layer (it has to be per agent), so what this
    // block pins is the decision it consumes: when the listener is told to hide the
    // sweep tools, and when it is told to put them back. Getting either edge wrong
    // leaves a session either permanently narrowed or never narrowed at all.
    const seen = [];
    setThrottleListener((session, narrowed) => seen.push([session.id, narrowed]));
    const throttleSession = (id) => ({
      id,
      seq: 60,
      snapshotEvents: () => [
        { type: 'user/message', seq: 0, time: 1, data: { message: { content: [{ type: 'text', text: '第一问' }] } } },
      ],
    });
    const sweepHits = [70, 71];
    const sweepExec = { agent: { session: throttleSession('session-throttle') } };
    const sweepTool = historySearchTool({ get: () => ledgerQuery(sweepHits) }, { historyBoundary: () => 59 });

    await sweepTool.execute({ query: 'alpha' }, sweepExec);
    is('throttle: the first productive search does not narrow', seen.at(-1)[1], false);
    await sweepTool.execute({ query: 'alpha' }, sweepExec);
    is('throttle: one zero-novelty sweep does not narrow', seen.at(-1)[1], false);
    await sweepTool.execute({ query: 'alpha' }, sweepExec);
    is('throttle: the second consecutive one narrows', seen.at(-1)[1], true);

    // The read is what keeps narrowing from being a dead end: it is never filtered, and
    // it hands back one search.
    const creditTarget = { seq: 70, type: 'user/message', data: { content: [{ type: 'text', text: 'alpha beta 70' }] } };
    const creditReader = historyReadTool({
      get: () => ({ readEvent: async () => ({ target: creditTarget, events: [creditTarget] }), filterEvents: async () => [] }),
    });
    const creditExec = { agent: { session: throttleSession('session-throttle') } };
    await creditReader.execute({ seq: 70 }, creditExec);
    is('throttle: a read while narrowed buys the sweep tools back', seen.at(-1)[1], false);
    await sweepTool.execute({ query: 'alpha' }, sweepExec);
    is('throttle: the bought search is spent, so the next state is narrowed again', seen.at(-1)[1], true);

    // A search that finally lands something lifts the narrowing by itself. Without this
    // the model would stay locked out for the rest of the turn after one good hit.
    const recovered = [80, 81];
    const recoverExec = { agent: { session: throttleSession('session-throttle-recover') } };
    const recoverTool = historySearchTool({ get: () => ledgerQuery(recovered) }, { historyBoundary: () => 59 });
    await recoverTool.execute({ query: 'alpha' }, recoverExec);
    await recoverTool.execute({ query: 'alpha' }, recoverExec);
    await recoverTool.execute({ query: 'alpha' }, recoverExec);
    is('throttle: narrowing is in force', seen.at(-1)[1], true);
    recovered.push(82);
    await recoverTool.execute({ query: 'alpha' }, recoverExec);
    is('throttle: a search that adds something new lifts the narrowing', seen.at(-1)[1], false);

    // The credit cap. Uncapped, reading is a way to buy unlimited sweeps and narrowing
    // stops meaning anything; `A2-A2` ran 19 consecutive reads live.
    const capExec = { agent: { session: throttleSession('session-throttle-cap') } };
    const capHits = [90, 91];
    const capTool = historySearchTool({ get: () => ledgerQuery(capHits) }, { historyBoundary: () => 59 });
    const capReader = historyReadTool({
      // `events` must carry the event: the window branch renders from it and records
      // from it, so an empty list would be a read that returned nothing.
      get: () => ({ readEvent: async ({ seq }) => {
        const target = { seq, type: 'user/message', data: { content: [{ type: 'text', text: `alpha beta ${seq}` }] } };
        return { target, events: [target] };
      }, filterEvents: async () => [] }),
    });
    await capTool.execute({ query: 'alpha' }, capExec);
    await capTool.execute({ query: 'alpha' }, capExec);
    await capTool.execute({ query: 'alpha' }, capExec);
    is('throttle: narrowed before the reads', seen.at(-1)[1], true);
    await capReader.execute({ seq: 90 }, capExec);
    is('throttle: one read lifts it', seen.at(-1)[1], false);
    await capReader.execute({ seq: 91 }, capExec);
    await capReader.execute({ seq: 90 }, capExec);
    await capReader.execute({ seq: 91 }, capExec);
    // Four reads after the first, and the tool is still there: credits did not stack.
    await capTool.execute({ query: 'alpha' }, capExec);
    is('throttle: extra reads do not bank extra searches', seen.at(-1)[1], true);

    // ── 覆盖区间：部分读取不等于「已持有」 ────────────────────────────────────
    //
    // The defect this replaced: `history_read {seq, offset: 0, maxChars: 1000}` on a
    // 5,000-character event marked the whole event held, and every later search for the
    // rest of the turn then withheld it. Searches were the one instrument that could
    // still say where in that event the terms appear.
    const LONG = 5000;
    const longBody = 'x'.repeat(LONG - 12) + ' needle here';
    const partialSession = {
      id: 'session-partial',
      seq: 70,
      snapshotEvents: () => [
        { type: 'user/message', seq: 0, time: 1, data: { message: { content: [{ type: 'text', text: '第一问' }] } } },
      ],
    };
    const partialExec = { agent: { session: partialSession } };
    const longTarget = { seq: 40, type: 'user/message', data: { content: [{ type: 'text', text: longBody }] } };
    const partialReader = historyReadTool({
      get: () => ({ readEvent: async () => ({ target: longTarget, events: [longTarget] }), filterEvents: async () => [] }),
    });
    const partialSearch = historySearchTool(
      { get: () => ledgerQuery([40]) },
      { historyBoundary: () => 69 },
    );

    // Reading with no address at all read the tail and crashed: the branch destructured
    // `turnStart` inside the `seq` branch above and then used it here, so the call threw
    // `turnStart is not defined` instead of returning anything. An acceptance run hit it
    // on the real tool; nothing in the suite called this path, which is why it survived.
    const tailRead = await partialReader.execute({}, partialExec);
    ok('read with no address returns text rather than throwing', typeof tailRead === 'string' && tailRead.length > 0);
    ok('read with no address says what it read', tailRead.includes('no address given'));
    ok('read with no address does not throw a reference error', tailRead.includes('is not defined') === false);

    const headRead = await partialReader.execute({ seq: 40, offset: 0, maxChars: 1000 }, partialExec);
    ok('coverage: the head read reports its range', headRead.includes('characters 0..1000 of 5000'));
    const afterHead = await partialSearch.execute({ query: 'needle' }, partialExec);
    ok('coverage: a partial read does not hide the event from a later search', afterHead.includes('#40 '));

    // Reading the rest completes the union, and only then is the event withheld.
    await partialReader.execute({ seq: 40, offset: 1000, maxChars: 6000 }, partialExec);
    const afterTail = await partialSearch.execute({ query: 'needle' }, partialExec);
    ok('coverage: the chunks together do mark it held', afterTail.includes('Nothing new was returned') && afterTail.includes('user/message: ') === false);

    // A read with no offset returns the event whole and settles it in one call.
    const wholeSession = { ...partialSession, id: 'session-whole-read' };
    const wholeExec = { agent: { session: wholeSession } };
    const wholeReader = historyReadTool({
      get: () => ({ readEvent: async () => ({ target: longTarget, events: [longTarget] }), filterEvents: async () => [] }),
    });
    const wholeSearch = historySearchTool({ get: () => ledgerQuery([40]) }, { historyBoundary: () => 69 });
    // `maxChars` has to cover the event, or the read is a truncated one and correctly
    // stays outstanding. The default budget is smaller than this fixture on purpose: it
    // is what makes the truncated branch reachable in the first place.
    const smallRead = await wholeReader.execute({ seq: 40 }, wholeExec);
    ok('coverage: the default budget truncates this fixture', smallRead.length < longBody.length);
    const afterSmall = await wholeSearch.execute({ query: 'needle' }, wholeExec);
    ok(
      'coverage: a truncated whole-event read is not treated as held',
      afterSmall.includes('#40 ') && afterSmall.includes('Nothing new was returned') === false,
    );
    await wholeReader.execute({ seq: 40, maxChars: 6000 }, wholeExec);
    const afterWhole = await wholeSearch.execute({ query: 'needle' }, wholeExec);
    ok('coverage: a read that fits withholds the event straight away', afterWhole.includes('Nothing new was returned'));

    // ── 空结果必须点名 ──────────────────────────────────────────────────────
    //
    // "You already have them" asks the caller to trust a claim about its own context.
    // "#40" hands it a call it can make right now. Both sweep tools name now.
    ok('empty-result notice names the events it withheld', afterWhole.includes('#40'));
    const findHeld = await historyFindTool(
      { get: () => ledgerQuery([40]) },
      { historyBoundary: () => 69 },
    ).execute({ queries: ['needle'] }, wholeExec);
    ok('history_find names them too', findHeld.includes('#40'));

    // ── 收窄期间读取也被压住 ────────────────────────────────────────────────
    //
    // Withholding only the sweep tools left `history_read` as the one way to get
    // material, and a read returns an event whole. Measured live, that turned a
    // sweep-shaped question into whole documents entering context: reads went from
    // 11 calls / 24,159 characters to 51 calls / 259,182, and tokens rose 3.69x. So the
    // read is capped too, and says so.
    const capSession = { ...partialSession, id: 'session-narrowed-read' };
    const capExec2 = { agent: { session: capSession } };
    const capSweep = historySearchTool({ get: () => ledgerQuery([40]) }, { historyBoundary: () => 69 });
    await capSweep.execute({ query: 'needle' }, capExec2);
    await capSweep.execute({ query: 'needle' }, capExec2);
    await capSweep.execute({ query: 'needle' }, capExec2);

    const bigReader = historyReadTool({
      get: () => ({ readEvent: async () => ({ target: longTarget, events: [longTarget] }), filterEvents: async () => [] }),
    });
    // The offset branch is the one that states its range, so it is the one where the
    // refusal is checkable as a number rather than inferred from a shorter window.
    const cappedRead = await bigReader.execute({ seq: 40, offset: 0, maxChars: 6000 }, capExec2);
    ok('narrowed read: the requested budget is refused', cappedRead.includes('characters 0..1500 of 5000'));
    ok('narrowed read: and the reason travels with it', cappedRead.includes('Narrowing is in force, so this read is capped'));
    ok('narrowed read: the notice is at the very top', cappedRead.indexOf('Narrowing is in force') < cappedRead.indexOf('#40 '));

    // Bounding one read bounds nothing if the caller can issue more. Measured live, that
    // is exactly what happened: the sweep tools were withheld and reads went from 11 calls
    // to 51, so the count is bounded as well as the length. Its own session, so the reads
    // above do not consume this budget.
    {
      const budgetSession = { ...partialSession, id: 'session-narrowed-budget' };
      const budgetExec = { agent: { session: budgetSession } };
      const budgetSweep = historySearchTool({ get: () => ledgerQuery([40]) }, { historyBoundary: () => 69 });
      await budgetSweep.execute({ query: 'needle' }, budgetExec);
      await budgetSweep.execute({ query: 'needle' }, budgetExec);
      await budgetSweep.execute({ query: 'needle' }, budgetExec);
      const budgetReader = historyReadTool({
        get: () => ({ readEvent: async () => ({ target: longTarget, events: [longTarget] }), filterEvents: async () => [] }),
      });
      const firstThree = [];
      for (let i = 0; i < 3; i += 1) {
        firstThree.push(await budgetReader.execute({ seq: 40, offset: 0, maxChars: 6000 }, budgetExec));
      }
      ok('narrowed budget: the first reads are capped, not refused', firstThree.every((one) => one.includes('characters 0..1500 of 5000')));
      const fourthRead = await budgetReader.execute({ seq: 40, offset: 0, maxChars: 6000 }, budgetExec);
      ok('narrowed budget: the read after the budget is refused', fourthRead.includes('Reads are exhausted for this turn'));
      ok('narrowed budget: the refusal carries a next action', fourthRead.includes('Answer from what you already have'));
      ok('narrowed budget: the refusal does not return the event anyway', fourthRead.includes('#40 ') === false);
    }

    // The cap lifts when the NARROWING lifts, which is a productive sweep and not a read.
    // The earlier version of this test spent a read's search credit and read again, which
    // only passed because a read was lifting its own cap — the hole the read budget closes.
    {
      const liftSession = { ...partialSession, id: 'session-narrowed-lift' };
      const liftExec = { agent: { session: liftSession } };
      let sweepRound = 0;
      // The first sweeps return only what the caller already has, so the streak trips; a
      // later one returns an event it has never seen, which is what clears `narrowed`.
      const liftQuery = {
        searchEvents: async () => ({ items: [{ seq: sweepRound < 3 ? 40 : 88, type: 'user/message', text: 'needle' }] }),
        filterEvents: async () => [{ seq: sweepRound < 3 ? 40 : 88, type: 'user/message', text: 'needle here' }],
      };
      const liftSweep = historySearchTool({ get: () => liftQuery }, { historyBoundary: () => 69 });
      const liftReader = historyReadTool({
        get: () => ({ readEvent: async () => ({ target: longTarget, events: [longTarget] }), filterEvents: async () => [] }),
      });
      sweepRound = 0;
      for (let i = 0; i < 3; i += 1) await liftSweep.execute({ query: 'needle' }, liftExec);
      const cappedWhileNarrowed = await liftReader.execute({ seq: 40, offset: 0, maxChars: 6000 }, liftExec);
      ok('narrowed read: a read is capped while narrowing holds', cappedWhileNarrowed.includes('characters 0..1500 of 5000'));
      sweepRound = 3;
      await liftSweep.execute({ query: 'needle' }, liftExec);
      const afterLift = await liftReader.execute({ seq: 40, offset: 1500, maxChars: 6000 }, liftExec);
      ok(
        'narrowed read: the cap lifts once the narrowing does',
        afterLift.includes('characters 1500..3500 of 5000') || afterLift.includes('characters 1500..5000 of 5000'),
      );
    }

    // ── 打点 ────────────────────────────────────────────────────────────────
    const traceFile = join(tmpdir(), `context-zip-trace-${process.pid}-${Date.now()}.jsonl`);
    setTracePath(traceFile);
    const traceExec = { agent: { session: throttleSession('session-trace') } };
    const traceHits = [95, 96];
    const traceTool = historySearchTool({ get: () => ledgerQuery(traceHits) }, { historyBoundary: () => 59 });
    await traceTool.execute({ query: 'alpha' }, traceExec);
    await traceTool.execute({ query: 'alpha' }, traceExec);
    await traceTool.execute({ query: 'alpha' }, traceExec);
    setTracePath(null);
    const traceLines = readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    is('trace: one line per retrieval', traceLines.length, 3);
    is('trace: the first line reports its novelty', traceLines[0].fresh, 2);
    is('trace: the second line is all withheld', traceLines[1].fresh === 0 && traceLines[1].omitted === 2, true);
    is('trace: the third line shows narrowing in force', traceLines[2].narrowed, true);
    is('trace: the streak is visible', traceLines[2].zeroStreak >= 2, true);
    is('trace: kind separates sweeps from reads', traceLines[0].kind, 'sweep');
    is('trace: the turn is recorded', traceLines[0].turn !== null && traceLines[0].turn !== undefined, true);
    // Turning it off writes nothing more.
    const before = readFileSync(traceFile, 'utf8').length;
    await traceTool.execute({ query: 'alpha' }, traceExec);
    is('trace: an empty path stops writing', readFileSync(traceFile, 'utf8').length, before);
    rmSync(traceFile, { force: true });

    // A new turn is a new ledger. The old key must not leak its "already served" set
    // into the next turn, or the first search of every later turn would look like a
    // repeat.
    let turnSeq = 0;
    const movingSession = {
      id: 'session-ledger-turn',
      seq: 80,
      snapshotEvents: () => [
        { type: 'user/message', seq: turnSeq, time: 1, data: { message: { content: [{ type: 'text', text: '问' }] } } },
      ],
    };
    const turnExec = { agent: { session: movingSession } };
    const turnTool = historySearchTool({ get: () => ledgerQuery(hitsA) }, { historyBoundary: () => 79 });
    await turnTool.execute({ query: 'alpha' }, turnExec);
    turnSeq = 10;
    const nextTurn = await turnTool.execute({ query: 'alpha' }, turnExec);
    ok('receipt: a new turn starts a fresh ledger at #1', nextTurn.includes('[retrieval #1 this turn: 2 events, all new]'));
  }

  // ── the store ceiling: no tool may promise more than the harness keeps ──
  {
    // Measured, not assumed: a 45,000-character read came back stored as 18,200 with
    // no marker. A tool that prints "characters 0..45000" and delivers 18,000 has
    // told the model it read text it never saw, which is worse than returning less.
    // These assertions hold every tool under the ceiling at its LARGEST arguments.
    const huge = '甲'.repeat(200000);
    const bigSession = { id: 'session-ceiling', seq: 900, snapshotEvents: () => [] };
    const bigExec = { agent: { session: bigSession } };
    const bigQuery = {
      readEvent: async ({ seq, before, after }) => {
        const node = { seq, type: 'user/message', data: { content: [{ type: 'text', text: huge }] } };
        const events = [];
        for (let i = Math.max(0, seq - (before ?? 0)); i <= seq + (after ?? 0); i += 1) {
          events.push({ seq: i, type: 'user/message', data: { content: [{ type: 'text', text: huge }] } });
        }
        return { target: node, events, startSeq: events[0]?.seq ?? seq, endSeq: events.at(-1)?.seq ?? seq };
      },
      searchEvents: async () => ({
        items: Array.from({ length: 100 }, (_v, i) => ({ seq: i, type: 'user/message', text: huge, snippet: huge.slice(0, 4000) })),
        nextCursor: 'more',
      }),
      filterEvents: async () => [],
    };
    const tools = [
      ['history_read seq', historyReadTool, { seq: 8, maxChars: 999999 }],
      ['history_read segment', historyReadTool, { segment: 0, maxChars: 999999 }],
      ['history_read offset', historyReadTool, { seq: 8, offset: 0, maxChars: 999999 }],
      ['history_find', historyFindTool, { queries: ['甲'], budgetChars: 999999, limit: 100 }],
      ['history_find extract', historyFindTool, { queries: ['甲'], extract: '甲', budgetChars: 999999, limit: 100 }],
      ['history_search', historySearchTool, { query: '甲', limit: 100 }],
    ];
    for (const [label, factory, args] of tools) {
      const out = await factory({ get: () => bigQuery }, { historyBoundary: () => 900 }).execute(args, bigExec);
      // The byte ceiling is the one the harness enforces, so it is the one asserted;
      // the character ceiling is a token-budget guard that the rendered header may
      // push a few characters past, which costs nothing.
      const bytes = Buffer.byteLength(out, 'utf8');
      const chars = [...out].length;
      is(`store ceiling: ${label} fits the byte ceiling (${bytes} B)`, bytes < TOOL_RESULT_STORE_CEILING_BYTES, true);
      is(`store ceiling: ${label} fits the character ceiling (${chars})`, chars <= TOOL_RESULT_STORE_CEILING_CHARS + 200, true);
    }
  }

  // ── the asker's own words are not a source ──────────────────────────────
  {
    // Real data made this concrete: on a live run two of three reported events were
    // the question itself and a tool result that echoed it, so the caller's attention
    // went to text it had written itself.
    is('deriveTurnStart: the newest user message is the turn boundary', deriveTurnStart([
      { seq: 8, type: 'user/message' },
      { seq: 9, type: 'tool/result' },
      { seq: 24, type: 'user/message' },
      { seq: 29, type: 'tool/result' },
    ]), 24);
    is('deriveTurnStart: a session with no user message has no boundary', deriveTurnStart([{ seq: 3, type: 'tool/result' }]), null);

    const ownBody = '这道题问的是 41217 和扩展名。';
    const srcBody = '材料里 41217 只是开发默认值，扩展名是 .seglog。';
    const ownQuery = {
      searchEvents: async () => ({
        items: [
          { seq: 24, type: 'user/message', text: ownBody, snippet: ownBody },
          { seq: 8, type: 'user/message', text: srcBody, snippet: srcBody },
        ],
      }),
      readEvent: async ({ seq }) => ({
        target: { seq, type: 'user/message', data: { content: [{ type: 'text', text: seq === 24 ? ownBody : srcBody }] } },
      }),
      filterEvents: async () => [],
    };
    // The log has to carry the question, or there is no boundary to find.
    const ownSession = {
      id: 'session-own',
      seq: 300,
      snapshotEvents: () => [
        { seq: 8, type: 'user/message', data: { content: [{ type: 'text', text: srcBody }] } },
        { seq: 24, type: 'user/message', data: { content: [{ type: 'text', text: ownBody }] } },
      ],
    };
    const out = await historyFindTool({ get: () => ownQuery }, {})
      .execute({ queries: ['41217'] }, { agent: { session: ownSession } });
    is('history_find: a hit from this turn is labelled', out.includes('[this turn, not a source]'), true);
    is('history_find: the header counts them', /1 of them are this turn's own messages/u.test(out), true);
    is('history_find: the real source is listed before it', out.indexOf('#8 ') < out.indexOf('#24 '), true);
    is('history_find: the turn\'s own hit is not dropped', out.includes('#24 '), true);

    // Its own session, because the `history_find` call above already served both events
    // in `session-own`. Under incremental returns a second sweep of the same turn would
    // correctly come back empty, which would leave these three checks asserting the
    // labelling of hits that are no longer sent.
    const searchSession = { ...ownSession, id: 'session-own-search' };
    const searched = await historySearchTool({ get: () => ownQuery }, { historyBoundary: () => 300 })
      .execute({ query: '41217' }, { agent: { session: searchSession } });
    is('history_search: a hit from this turn is labelled', searched.includes('[this turn, not a source]'), true);
    is('history_search: and the header says how many', /1 are this turn's own messages/u.test(searched), true);
    // Asserted on the line rather than on a fixed prefix: the result line now carries
    // an address between the type and the colon, and a probe spelled as
    // `'#8 user/message: '` would have gone on passing only while the format never
    // changed — the opposite of what a labelling test is for.
    const searchLine = (seq) => searched.split('\n').find((one) => one.startsWith(`#${seq} `)) ?? '';
    ok(
      'history_search: a hit outside this turn is not labelled',
      searchLine(8).length > 0 && searchLine(8).includes('[this turn, not a source]') === false,
    );
    const address = /@(\d+) of (\d+)/u.exec(searchLine(8));
    ok('history_search: the hit line carries an address', address !== null);
    ok('history_search: the offset lies inside the event', address !== null && Number(address[1]) < Number(address[2]));
  }

  // ── the heading gate must reject markup, not wording ────────────────────
  {
    const en = ['Goal and intent', 'Decisions', 'Current state', 'Next steps', 'Anchors']
      .map((h) => `## ${h}\nbody`).join('\n');
    // The shape gate answers "is this a handoff summary"; it cannot answer "is it true".
    // The failure that motivated this check is a summary that reads perfectly and states
    // a rule nobody wrote down — the recursion cell answered both questions with a
    // decision the material never made.
    {
      const source =
        '我们用 planCompactionWindow 挑选待压缩段。\n保留期由 segment_retention_days 控制，默认 7 天。\n端口 41217 只是开发默认值。';
      const honest = '## Anchors\n- `planCompactionWindow`\n- `segment_retention_days`（默认 7 天）\n- 端口 41217';
      is('claims: a summary built from its source reports nothing', findUnsupportedClaims(honest, source).length, 0);

      // The default scope is paths, because that is the only class with evidence behind
      // it: on a 30-token sample the flagged file paths were fabrication 7 times out of 7,
      // while `io_uring`, `POSIX` and `3900` were mostly noise. The wider scan stays
      // available and is what the measurement used.
      is(
        'claims: the default scope checks paths, not general vocabulary',
        findUnsupportedClaims('it uses POSIX and io_uring', 'nothing here').length,
        0,
      );
      is(
        'claims: the wider scope does report general vocabulary',
        findUnsupportedClaims('it uses POSIX and io_uring', 'nothing here', { scope: 'all' }).length > 0,
        true,
      );
      is(
        'claims: a bare number is not reported by default',
        findUnsupportedClaims('the limit is 3900', 'nothing here').length,
        0,
      );

      const invented = '## Anchors\n- `planCompactionWindow`\n- `segment_retention_days`\n- `retention_sweep_interval_ms`';
      const flagged = findUnsupportedClaims(invented, source, { scope: 'all' });
      is('claims: an identifier the source never contains is reported', flagged.includes('retention_sweep_interval_ms'), true);
      is('claims: and a token the source does contain is not', flagged.includes('planCompactionWindow'), false);

      is(
        'claims: ordinary words in backticks are not treated as identifiers',
        findUnsupportedClaims('`the retry policy` is what matters', 'unrelated source text', { scope: 'all' }).length,
        0,
      );
      is(
        'claims: a small count the summarizer made is not reported',
        findUnsupportedClaims('it read the file 3 times', 'nothing here', { scope: 'all' }).length,
        0,
      );
      is(
        'claims: a large number that is absent is reported',
        findUnsupportedClaims('the limit is 132920 characters', 'nothing here', { scope: 'all' }).includes('132920'),
        true,
      );
      is(
        'claims: a path absent from the source is reported',
        findUnsupportedClaims('see `src/segment/window_planner.rs`', 'nothing here').includes('src/segment/window_planner.rs'),
        true,
      );
      is('claims: an empty source does not crash the check', Array.isArray(findUnsupportedClaims(honest, '')), true);

      // Two false-positive classes the first measurement over 522 archived summaries
      // exposed. Both are asserted because each one, left in, made a real summary look
      // like a fabrication.
      is(
        'claims: a wildcard pattern is not a literal',
        findUnsupportedClaims('errors `E_LOCK_*` and `E_DIAG_*` fire', 'the source lists E_LOCK_ and E_DIAG_').length,
        0,
      );
      is(
        'claims: separator style is not invention',
        findUnsupportedClaims('`segment.retention_days` controls it', 'the config key is segment_retention_days').length,
        0,
      );
      is(
        'claims: a sentence-ending full stop is not part of the token',
        findUnsupportedClaims('the key is `.segment_retention_days`', 'the config key is segment_retention_days').length,
        0,
      );
      // Prose written with slashes is the class that made the check fire on 93.7% of
      // summaries before the path rule was narrowed.
      is(
        'claims: a slash list of concepts is not a path',
        findUnsupportedClaims('covers ingestion/storage/query/export', 'nothing here', { scope: 'all' }).length,
        0,
      );
      is(
        'claims: a real-looking file under a real directory is still checked',
        findUnsupportedClaims('see `src/diag/breadcrumb.rs`', 'the tree contains src/diag/tailwatch.rs').includes('src/diag/breadcrumb.rs'),
        true,
      );

      // ── 待办 17：路径写法归一化 ──────────────────────────────────────────
      //
      // 误杀的主因是「同一份原文自己就混用多种写法」：同一份 seed 里
      // `diag/breadcrumb.rs`（只带目录）与 `src/diag/tailwatch.rs`（带 `src/`）并存，
      // 连目录都不给的裸名也有一批，而摘要统一写成 `src/<目录>/<文件>`。检测器只认
      // 字面相等，于是 432 个路径标记里 411 个落在这一档。下面每一条对应一个实测子类，
      // 括号里的数字是语料里的总数。
      {
        const seed = [
          '修法是在 diag/breadcrumb.rs 里改成按行截断；',
          '同一批还有 src/diag/tailwatch.rs、text_sniff.rs 与 src/segment/window_planner.rs；',
          '索引在 crates/emberlog-index/src/offset.rs；',
          '脚本是 ci/secrets-audit.sh，预热脚本在 ci/prewarm.sh；',
          '许可检查在 tools/check-licenses.py；',
          '导出用 src/export/redact_fields.rs，摘要落 diag/digest.rs；',
          '锁文件是 runtime/.emberlog.lock，打包配置在 packaging/macos/bundle.toml；',
          '保留期与预算由配置键 diag.ledger_flush_ms、diag.budget_ms 控制。',
        ].join('\n');
        const claims = (summary) => findUnsupportedClaims(summary, seed);
        is('归一化：补前导段（`src/`）不再算编造', claims('见 `src/diag/breadcrumb.rs`').length, 0); // 268 个
        is('归一化：补目录不再算编造', claims('见 `src/import/text_sniff.rs`').length, 0); // 143 个
        is('归一化：长路径缩写不再算编造', claims('见 `index/offset.rs`').length, 0); // 3 个
        is('归一化：单复数不再算编造', claims('见 `ci/secret-audit.sh`').length, 0); // 2 个
        is('归一化：点文件去点不再算编造', claims('见 `runtime/emberlog.lock`').length, 0); // 1 个
        is('归一化：`./` 前缀不是差异', claims('见 `./ci/secrets-audit.sh`').length, 0);
        is('归一化：绝对路径与相对路径不是差异', claims('见 `/srv/app/diag/tailwatch.rs`').length, 0);
        is('归一化：补目录时目录在原文里另有文件为证', claims('见 `src/export/length_prefixed_write.rs`').length, 1);
        // 归一化**不该救**的：这 12 个是真编造，逐条核对过。放宽判据最容易在这里翻车。
        is('归一化：真实文件换目录照样报（6 个里的第 1 类）', claims('见 `tools/prewarm.sh`').includes('tools/prewarm.sh'), true);
        is('归一化：换目录的另一个写法照样报', claims('见 `ci/check-licenses.py`').includes('ci/check-licenses.py'), true);
        is('归一化：同名不同目录不因文件名对上而放过', claims('见 `src/import/redact_fields.rs`').includes('src/import/redact_fields.rs'), true);
        is('归一化：缩写后仍指向别的目录时照样报', claims('见 `crates/emberlog-index/src/digest.rs`').includes('crates/emberlog-index/src/digest.rs'), true);
        // 编造文件名：`diag.ledger_flush_ms` 是配置键，不是 `diag/ledger.rs` 这个文件。
        is('归一化：编造文件名照样报（`diag/ledger.rs`）', claims('`diag/ledger.rs` 管落盘').includes('diag/ledger.rs'), true);
        is('归一化：编造文件名照样报（`diag/budget.rs`）', claims('`diag/budget.rs` 管预算').includes('diag/budget.rs'), true);
        is('归一化：真实目录下编造的文件名照样报', claims('见 `src/segment/segment.rs`').includes('src/segment/segment.rs'), true);
        // 同句并列两种写法这一类归一化**不覆盖**：它靠的是上下文（同一行另给了正确
        // 形式），不是写法规则。留着这条是为了让「没做到」有据可查。
        is(
          '归一化：同句并列的另一种写法仍会被报（已知未覆盖）',
          findUnsupportedClaims('见 `src/export/scrub.rs` 与 `diag/scrub.rs`', '原文只有 diag/scrub.rs').includes('src/export/scrub.rs'),
          true,
        );
        // 开关：关掉即回到加归一化之前的行为。测量要能复现旧数字，靠的就是它。
        is(
          '归一化可以关掉：关掉后补前导段重新被报',
          findUnsupportedClaims('见 `src/diag/breadcrumb.rs`', seed, { normalizePaths: false }).length,
          1,
        );
      }

      // ── S8 形状（两个「已知红」，把真机漏点钉住）──────────────────────────
      //
      // 七形状探针（S1–S7，跑在 522 格语料上）覆盖不到真机上的真漏点：S6 用的是
      // **凭空目录名** `zzzcache/`，而真机漏的那条用的是「**真实目录 + 真实文件名 +
      // 组合不存在**」。追加的第二个形状是「**文件名只出现在非 ASCII 路径里 + 摘要配
      // 另一个目录**」，它是唯一会被「放开非 ASCII 盲区」改变的形状。下面把两个形状
      // 按各自的构造钉在这里。
      //
      // **两条在当前树里都是「已知红」（漏）**：修 S8a 要加存在性前置，而那条修法
      // **已判定「现在不实施」——判据 1 今天没有数据源，落地即等于删归一化规则 2**。
      // 所以下面写的是「**当前预期是漏**」，与本文件里 `B10投影：……（已知洞）` 那一
      // 条是同一个模式：断言钉的是现状这个洞本身，不是「这个形状拦不住也没关系」。
      // 为了让探针不恒真，每个形状都配一条「洞的边界」：把构造改回能被拦住的形状，
      // 那条 `.length === 0` 立刻会红。
      //
      // **第 46 项落地时，下面两组里的 `.length` 期望值都要从 0 改成正向断言**；
      // S8b 另有第 43 项放开非 ASCII 盲区也会让它翻面。改法与逐条清单见同文档 §六。
      {
        const rowOf = (audit, token) => audit.find((row) => row.token === token);

        // S8a：真实目录 + 真实裸名 + 组合不存在。真机漏的那条就是这个形状。
        //   真实目录 `ci/`：原文里有 `ci/prewarm.sh`；
        //   真名 `Sample-App-icon.svg`：原文里以裸名出现，另有一份在 `dist/` 里
        //   （量测特别点明「裸名可能出现，也可能出现在别的目录里」，所以两个都放上）；
        //   组合 `ci/Sample-App-icon.svg`：原文里没有，盘上也没有。
        // 构造与第 46 项量测的 `shapesOf` 同一套：真实目录取自原文某条路径的目录，
        // 裸名取自原文里以裸名出现的另一个文件名。
        const s8aSource = [
          '预热脚本是 ci/prewarm.sh，索引在 crates/emberlog-index/src/offset.rs；',
          '打包产物 dist/Sample-App-icon.svg 已生成，附件里也贴了一份 Sample-App-icon.svg。',
        ].join('\n');
        const s8aToken = 'ci/Sample-App-icon.svg';
        const s8aClaim = `见 \`${s8aToken}\``;
        const s8aRow = rowOf(auditUnsupportedClaims(s8aClaim, s8aSource), s8aToken);
        // 已知红：现状一条都不拦（第 46 项量测：这个形状 520 格构造得出来、现状 0%）。
        is(
          'S8a 已知红：真实目录+真裸名+组合不存在，现状一条不拦（第 46 项要修的洞）',
          findUnsupportedClaims(s8aClaim, s8aSource).length,
          0,
        );
        // 机制：救它的是规则 2「补目录」——只要这个文件名在原文里以裸名出现过，
        // 前面接什么目录都无条件接住。这正是第 46 项要给救援加前置的那一处。
        is('S8a 现状的救法是规则 2「补目录」：判成 spelling 而不是 missing', s8aRow?.source, 'spelling');
        is('S8a 救法是拿原文里那个裸名接的：spelling 记的就是那个裸名', s8aRow?.spelling, 'sample_app_icon_svg');
        // 接上判据 1 也不动它：规则 2 的救援发生在判据 1 之前，所以「把判据 1 接上」
        // 不等于第 46 项落地。这一条把「洞在救援里，不在判定器里」钉住。
        is(
          'S8a 接上判据 1（全判不存在）也拦不住：救援发生在判据 1 之前',
          findUnsupportedClaims(s8aClaim, s8aSource, { fileExists: fileOracleFromList([]) }).length,
          0,
        );
        // 洞的边界（非恒真）：把裸名那份去掉，只留 `dist/` 里的真写法，规则 2 就不成立，
        // 这条立刻被拦——S8a 的「0」是构造出来的，不是探针坏了。
        const s8aNoBare = s8aSource.replace('附件里也贴了一份 Sample-App-icon.svg。', '附件里没有再贴别的。');
        is(
          'S8a 洞的边界：真名只在别的目录里出现时照样拦',
          findUnsupportedClaims(s8aClaim, s8aNoBare).join(','),
          s8aToken,
        );

        // S8b：文件名只出现在非 ASCII 路径里 + 摘要配另一个目录。构造逐字照
        // 探针里的 R1（原文与 token 都一样），不另造一套。
        const s8bSource = '安装包在 /home/user/Desktop/示例项目/示例插件/app-builder.zip';
        const s8bToken = 'zzzcache/app-builder.zip';
        const s8bClaim = `见 \`${s8bToken}\``;
        const s8bRow = rowOf(auditUnsupportedClaims(s8bClaim, s8bSource), s8bToken);
        // 已知红：非 ASCII 目录段把窄正则的匹配切断，`app-builder.zip` 于是以**裸名**
        // 进索引，规则 2 照样把它救走。第 43 项量测：这个形状是放开唯一会改变的一个。
        is(
          'S8b 已知红：文件名只在非 ASCII 路径里 + 摘要配另一个目录，现状一条不拦',
          findUnsupportedClaims(s8bClaim, s8bSource).length,
          0,
        );
        is('S8b 现状的救法同样是规则 2「补目录」：判成 spelling 而不是 missing', s8bRow?.source, 'spelling');
        is('S8b 救法是拿被切断后剩下的那个裸名接的', s8bRow?.spelling, 'app_builder_zip');
        // 洞的边界（非恒真）：同一句、同一个 token，只把非 ASCII 段换成 ASCII，文件名就
        // 不再以裸名进索引，规则 2 不成立 → 立刻被拦。S8b 的「0」确实来自非 ASCII 盲区，
        // 不是这条断言恒真。
        const s8bAscii = '安装包在 /home/user/Desktop/example-project/plugins/app-builder.zip';
        is(
          'S8b 洞的边界：同一目录深度换成 ASCII 段后照样拦',
          findUnsupportedClaims(s8bClaim, s8bAscii).join(','),
          s8bToken,
        );
      }

      // ── 待办 16：判据 1（文件是否真存在于工作区），可选、默认不接 ────────
      //
      // 判据 1 问的是「这个文件真的存在吗」，它需要一个数据源（真工作区扫描，或工具
      // 回执带回的文件列表）。这批测试语料是散文体、全工作区没有 `.rs` 文件，所以
      // 它在那里没有对象；真机上才有。因此接口接好、**默认不接**，并且只在「文件真的
      // 存在」时救——判不了与判定不存在都照旧报出来。
      {
        const oracle = fileOracleFromList(['tools/prewarm.sh', './diag/breadcrumb.rs']);
        is('判据1：清单里按整条路径对上时报存在', oracle('tools/prewarm.sh'), 'exists');
        is('判据1：`./` 与大小写不影响判定', oracle('./TOOLS/Prewarm.sh'), 'exists');
        is('判据1：只对上文件名时判不了（换目录那一类靠它挡住）', oracle('ci/prewarm.sh'), 'unknown');
        is('判据1：清单里没有的文件报不存在', oracle('diag/ledger.rs'), 'absent');
        is('判据1：不接判定器时不生效', findUnsupportedClaims('见 `tools/prewarm.sh`', '原文里没有这个路径').length, 1);
        is(
          '判据1：文件真的存在时不再算编造',
          findUnsupportedClaims('见 `tools/prewarm.sh`', '原文里没有这个路径', { fileExists: oracle }).length,
          0,
        );
        is(
          '判据1：判不了时保守留下',
          findUnsupportedClaims('见 `ci/prewarm.sh`', '原文里没有这个路径', { fileExists: oracle }).includes('ci/prewarm.sh'),
          true,
        );
        is(
          '判据1：判定为不存在时留下',
          findUnsupportedClaims('见 `diag/ledger.rs`', '原文里没有这个路径', { fileExists: oracle }).includes('diag/ledger.rs'),
          true,
        );
        // 明细要能分辨四种来路：原文里真有 / 归一化救回 / 判据 1 救回 / 真没有。
        {
          const audit = auditUnsupportedClaims(
            '`diag/breadcrumb.rs`、`ci/secret-audit.sh`、`tools/prewarm.sh`、`diag/ledger.rs`',
            '原文里有 diag/breadcrumb.rs 与 ci/secrets-audit.sh。',
            { fileExists: oracle },
          );
          const rowOf = (token) => audit.find((row) => row.token === token);
          is('判据1：明细记下原文里真有的写法', rowOf('diag/breadcrumb.rs').source, 'present');
          is('判据1：明细记下归一化救回的是哪种写法', rowOf('ci/secret-audit.sh').spelling, 'ci/secrets_audit_sh');
          is('判据1：明细记下判据 1 的结论', rowOf('diag/ledger.rs').existence, 'absent');
          is('判据1：判据 1 救回的那条不再上报', rowOf('tools/prewarm.sh').unsupported, false);
          is('判据1：真没有的那条上报', rowOf('diag/ledger.rs').unsupported, true);
        }
        // 非路径 token 不拿判据 1 去问：`retention_sweep_interval_ms` 不是一个文件。
        is(
          '判据1：非路径 token 不问判定器',
          findUnsupportedClaims('`retention_sweep_interval_ms`', 'nothing here', {
            scope: 'all',
            fileExists: () => 'exists',
          }).includes('retention_sweep_interval_ms'),
          true,
        );
      }

      // 判据 1 的接线：引擎的 `deps.fileExists` 一路传到 B10。默认不传即不生效。
      {
        const FakeBase = class {
          constructor(ctx, config) {
            this.ctx = ctx;
            this.config = config;
          }
          async summarize() {
            throw new Error('the plugin arm must not reach the shipped backend');
          }
        };
        const Engine = createContextZipEngine(FakeBase);
        const summaryText = [
          '## Anchors',
          '- `tools/prewarm.sh`',
          '- `diag/breadcrumb.rs`',
          '',
          '这一段是散文形态的摘要正文，必须过得了尺寸门，否则压缩会被判成 too-short 而抛错，',
          '判据 1 的接线就测不到。它同时证明形态门对散文是放行的，走的是',
          'unrecognised-sections 那一支，而不是 sections 那一支。',
          // 长度由重复的句子保证：门槛往上调时这里跟着变，而不是刚好卡在边上无声失效。
          '判据 1 只该救清单里查得到的那一条。'.repeat(12),
        ].join('\n');
        const makeCtx = () => ({
          logger: { warn: () => {}, info: () => {}, debug: () => {} },
          llm: {
            stream() {
              return (async function* () {
                yield { type: 'text-delta', index: 0, text: summaryText };
                yield { type: 'finish', reason: { kind: 'stop' } };
              })();
            },
          },
        });
        const input = { messages: ['原文里这两个路径都没有'], system: 'x' };
        const agent = { session: { id: 'judgement-1' }, options: { provider: 'p', model: 'm' } };
        const deps = (extra) => ({ readMode: () => 'plugin', readNotes: async () => '', readRewrite: () => null, ...extra });
        const plain = await new Engine(makeCtx(), {}, deps({})).summarize(input, agent);
        is('判据1 接线：默认不接时两条都报出来', plain.unsupportedClaims.length, 2);
        const wired = await new Engine(makeCtx(), {}, deps({ fileExists: fileOracleFromList(['tools/prewarm.sh']) })).summarize(
          input,
          agent,
        );
        is(
          '判据1 接线：接上后清单里那一条不再报，另一条照旧',
          wired.unsupportedClaims.includes('tools/prewarm.sh') === false && wired.unsupportedClaims.includes('diag/breadcrumb.rs') === true,
          true,
        );
      }

      // ── B10 的原文投影：工具回执正文与工具调用 arguments 必须进原文 ──────
      //
      // 实测病根：生产里 B10 的原文来自一个
      // 只读 `block.text` 的投影，而真机上工具回执的正文在嵌套 `content` 里、工具调用
      // 写下的路径在 `arguments` 里，两样都读不到。真机 31 次压缩上窄投影的原文中位
      // 304,281 字符，模型实际看到 643,287 字符；A 臂 49 个「原文里没有」的标记里 42 个
      // 的路径明明白白就在这两样材料里。下面每一条都对着这个病根。
      {
        const receipt = {
          role: 'user',
          source: { kind: 'tool' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              isError: false,
              content: [{ type: 'text', text: '打包产物：<tmp>/zc.jar（12,345 字节）' }],
            },
          ],
        };
        const call = {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"cat tmp/main/matrix-24.json"}' }],
        };
        is('B10投影：工具回执的嵌套正文进原文', messageVisibleText(receipt).includes('<tmp>/zc.jar'), true);
        is('B10投影：工具调用的 arguments 进原文', messageVisibleText(call).includes('tmp/main/matrix-24.json'), true);
        is(
          'B10投影：只有 text 块时与窄投影逐字相同',
          messageVisibleText({ content: [{ type: 'text', text: '见 src/routes.ts' }] }),
          '见 src/routes.ts',
        );
        is('B10投影：没有可读文本时是空串', messageVisibleText({ content: [{ type: 'image', attachment: {} }] }), '');
        // 量测装置与任何嵌入方从**引擎包**取这条投影，不再各自复写一份判据（见驱动脚本）。
        is('B10投影：引擎包导出这条投影', typeof packageMessageVisibleText, 'function');

        // 端到端：走 `summarize()` 那条生产路径，摘要写了只在工具回执里出现过的路径。
        const FakeBase = class {
          constructor(ctx, config) {
            this.ctx = ctx;
            this.config = config;
          }
          async summarize() {
            throw new Error('the plugin arm must not reach the shipped backend');
          }
        };
        const Engine = createContextZipEngine(FakeBase);
        const receiptPath = '<tmp>/zc.jar';
        const summaryText = [
          '## Anchors',
          `- \`${receiptPath}\``,
          '',
          '## 当前状态',
          '这一段是散文形态的摘要正文，只要够长就过得了尺寸门，走的是 unrecognised-sections 那一支。'.repeat(12),
        ].join('\n');
        const makeCtx = () => ({
          logger: { warn: () => {}, info: () => {}, debug: () => {} },
          llm: {
            stream() {
              return (async function* () {
                yield { type: 'text-delta', index: 0, text: summaryText };
                yield { type: 'finish', reason: { kind: 'stop' } };
              })();
            },
          },
        });
        const agent = { session: { id: 'session-<示例>' }, options: { provider: 'p', model: 'm' } };
        const deps = { readMode: () => 'plugin', readNotes: async () => '', readRewrite: () => null };
        const withReceipt = await new Engine(makeCtx(), {}, deps).summarize(
          { messages: [receipt, call, '这一轮里没有别的路径。'], system: 'x' },
          agent,
        );
        is('B10投影：只在工具回执里出现过的路径不再算编造', withReceipt.unsupportedClaims.includes(receiptPath), false);
        const withoutReceipt = await new Engine(makeCtx(), {}, deps).summarize(
          { messages: ['这一轮里没有别的路径。'], system: 'x' },
          agent,
        );
        is('B10投影：原文里真的没有时照样报出来', withoutReceipt.unsupportedClaims.includes(receiptPath), true);

        // 另两个调用方仍是窄投影：这次改动只动 B10 的原文位，不动它们的行为。
        const attributed = attributeSummarySections('## Anchors\n`tmp/main/matrix-24.json`', [call]);
        is('B10投影：分节归属仍走窄投影（arguments 不参与）', attributed[0].from, -1);
        is('B10投影：机械摘要的字数与路径也仍走窄投影', buildMechanicalSummary([receipt, call]).includes('<tmp>/zc.jar'), false);

        // 已知洞，第 37 项报告 §七要解释的那一条：补投影之后召回 9→8，漏掉的是一个
        // 「真实文件名 + 编造目录」。机制在这里钉住——原文（补全后）只给了裸文件名时，
        // 归一化的「补目录」规则会把它救走；原文里连裸名都没有时照样报。
        const crossDir = 'Desktop/示例项目/vendor/Sample-App-icon.svg';
        const claim = `见 \`${crossDir}\``;
        is(
          'B10投影：裸名进原文后换目录型编造被归一化救走（已知洞）',
          findUnsupportedClaims(claim, '打包产物 Sample-App-icon.svg 在附件里。').length,
          0,
        );
        is(
          'B10投影：原文里连裸名都没有时照样报（洞的边界）',
          findUnsupportedClaims(claim, '打包产物在附件里。').includes(crossDir),
          true,
        );
      }

      // Attribution is derived, never asked for: the five-section template already costs
      // 16.1% of compactions, and every extra required field is another way to miss the
      // shape gate. This asserts only that a section points at the message it is about.
      const sourceMessages = [
        '我们讨论导出格式：ndjson 与 jsonl 的区别，以及 length_prefixed_write 的写法。',
        '接着讨论保留期：segment_retention_days 默认 7 天，rollover 由 sealed_segments 触发。',
        '最后确认端口 41217 只是开发默认值，正式环境走白名单。',
      ];
      const attributed = attributeSummarySections(
        '## Decisions\n采用 ndjson，length_prefixed_write 负责写。\n## Anchors\nsegment_retention_days 与 sealed_segments。',
        sourceMessages,
      );
      is('trace: one entry per summary section', attributed.length, 2);
      is('trace: the decisions section points at the export message', attributed[0].from, 0);
      is('trace: the anchors section points at the retention message', attributed[1].from, 1);
      is('trace: each entry reports how much it shares', attributed[0].shared > 0, true);
      is(
        'trace: a heading-free summary is attributed as one section',
        attributeSummarySections('no headings at all', sourceMessages).length,
        1,
      );
      is('trace: an empty source does not crash', attributeSummarySections('## A\nx', []).length, 1);
      // Prose with no distinctive token is not a failure to trace; it is untraceable by
      // this method, and reporting the two as the same number was the first thing the
      // measurement over 522 archived summaries got wrong.
      const prose = attributeSummarySections('## Next steps\nkeep going and check things', sourceMessages);
      is('trace: a prose-only section is marked untraceable', prose[0].traceable, false);
      is('trace: and reports no shared fraction', prose[0].shared, null);
      is('trace: a section with tokens is marked traceable', attributed[0].traceable, true);
    }

    is('summary gate: the exact English template is accepted', classifySummary(en).accept, true);
    is('summary gate: and is recognised as the full shape', classifySummary(en).sections, 5);

    // The measured failure: a normal-length summary whose headings are worded
    // differently. All five present, none of them the exact strings.
    const zh = ['## 目标与意图', '## 决策', '## 当前状态', '## 下一步', '## 关键标识']
      .map((h) => `${h}\n正文`.repeat(1)).join('\n');
    is('summary gate: Chinese headings are recognised', classifySummary(zh).sections, 5);
    is('summary gate: Chinese headings are accepted', classifySummary(zh).accept, true);

    const bold = '## **Goal and intent**\n## **Decisions**\n## **Current state**\n';
    is('summary gate: bold headings are recognised', classifySummary(bold).sections >= 3, true);

    const threeHash = '### Goal and intent\n### Decisions\n### Current state\n';
    is('summary gate: deeper heading levels are recognised', classifySummary(threeHash).sections >= 3, true);

    // The failure the gate was written for, and it must still be refused.
    const markup = '<tool_call>{"name":"bash","arguments":{}}</tool_call>'.repeat(20);
    is('summary gate: tool-call markup is refused', classifySummary(markup).accept, false);
    is('summary gate: and is named as markup', classifySummary(markup).reason, 'tool-call-markup');
    const jsonish = '{"tool_calls":[{"function":{"name":"read"}}]}'.repeat(20);
    is('summary gate: a tool-call JSON payload is refused', classifySummary(jsonish).accept, false);

    // Too little to be a summary at all.
    is('summary gate: a stub is refused', classifySummary('done').accept, false);
    is('summary gate: and is named as too short', classifySummary('done').reason, 'too-short');

    // A substantial summary in a shape this file does not match survives, and says so.
    const odd = `${'这是一份内容详实的交接说明，只是小标题的写法不在匹配表里。'.repeat(20)}`;
    const verdict = classifySummary(odd);
    is('summary gate: a substantial unrecognised shape is accepted', verdict.accept, true);
    is('summary gate: and is reported rather than swallowed', verdict.reason, 'unrecognised-sections');
    is('summary gate: the report names the section count', /0 of 5 required sections/u.test(verdict.detail), true);
  }

  // ── resolveRetrievalFrom: the toggle the user owns ──────────────────────
  {
    const session = { id: 'session-1', header: { agentPreset: 'web' } };
    const state = (value, extra = {}) => ({
      value,
      revision: 7,
      userRetrieval: false,
      userRetrievalAgents: new Set(),
      ...extra,
    });

    is(
      'retrieval: no settings provider means the released behavior',
      resolveRetrievalFrom(null, session).retrieval,
      'granular',
    );
    is(
      'retrieval: an empty section means the released behavior',
      resolveRetrievalFrom(state({}), session).retrieval,
      'granular',
    );
    is(
      'retrieval: the global value is honoured',
      resolveRetrievalFrom(state({ retrieval: 'batched' }), session).retrieval,
      'batched',
    );
    is(
      'retrieval: a session id row wins over the preset row',
      resolveRetrievalFrom(
        state({ retrieval: 'granular', retrievalAgents: { web: 'granular', 'session-1': 'batched-only' } }),
        session,
      ).retrieval,
      'batched-only',
    );
    is(
      'retrieval: the preset row applies when no id row exists',
      resolveRetrievalFrom(state({ retrieval: 'granular', retrievalAgents: { web: 'batched' } }), session).retrieval,
      'batched',
    );
    is(
      'retrieval: an unusable row falls through to the global value',
      resolveRetrievalFrom(state({ retrieval: 'batched', retrievalAgents: { 'session-1': 'nonsense' } }), session)
        .retrieval,
      'batched',
    );
    is(
      'retrieval: an unusable global value falls back to granular',
      resolveRetrievalFrom(state({ retrieval: 'nonsense' }), session).retrieval,
      'granular',
    );
    is(
      'retrieval: the source names settings when the user set it',
      resolveRetrievalFrom(state({ retrieval: 'batched' }, { userRetrieval: true }), session).source,
      'settings',
    );
  }

  // ── applySettingsPatch: the new fields round-trip, and omit means delete ─
  {
    const base = { enabled: true, agents: { web: true }, retrieval: 'granular', retrievalAgents: {} };
    is(
      'settings: retrieval can be turned on',
      applySettingsPatch(base, { retrieval: 'batched' }).retrieval,
      'batched',
    );
    is(
      'settings: retrieval survives a patch that does not name it',
      applySettingsPatch({ ...base, retrieval: 'batched-only' }, { enabled: false }).retrieval,
      'batched-only',
    );
    // Same contract as `enabled`: an unusable value is not a value, so a patch that
    // names only unusable things asks for nothing and comes back null.
    is(
      'settings: an unusable retrieval value counts as asking for nothing',
      applySettingsPatch(base, { retrieval: 'nonsense' }),
      null,
    );
    is(
      'settings: retrieval rows are kept',
      applySettingsPatch(base, { retrievalAgents: { 'session-1': 'batched' } }).retrievalAgents['session-1'],
      'batched',
    );
    // Same contract as `agents`: a patch that does not name the table leaves it
    // alone. Deletion happens at the `replace` step, where the written value
    // omits the key entirely.
    is(
      'settings: a patch that omits retrievalAgents preserves the table',
      applySettingsPatch({ ...base, retrievalAgents: { 'session-1': 'batched' } }, { enabled: true }).retrievalAgents,
      { 'session-1': 'batched' },
    );
    is(
      'settings: naming retrievalAgents replaces it wholesale',
      applySettingsPatch(
        { ...base, retrievalAgents: { 'session-1': 'batched' } },
        { retrievalAgents: { 'session-2': 'batched-only' } },
      ).retrievalAgents,
      { 'session-2': 'batched-only' },
    );
    is('settings: a patch that asks for nothing returns null', applySettingsPatch(base, {}), null);
    is(
      'settings: an all-unusable retrievalAgents patch is refused rather than clearing',
      (() => {
        try {
          applySettingsPatch(base, { retrievalAgents: { 'session-1': 'nonsense' } });
          return 'no error';
        } catch {
          return 'refused';
        }
      })(),
      'refused',
    );
  }

  // ── 手动压缩：区间预测、确认文案、命令与两条路由 ──────────────────────────
  //
  // 这一段的判据是「确认框里的数字就是执行时会换掉的数量」。区间选择是压缩后端
  // `selectCompactableRange` 的移植（那个函数是模块私有的，取不到，只能镜像），
  // 所以这里逐个对齐它的分支：系统头不进区间、整个表面除最后一切点、切点必须不
  // 拆开工具调用对。**下面不碰任何真模型**：会话是假的，测的是选段与文案。
  {
    /**
     * 一个够真的假会话表面。
     *
     * `toolPairingBalancedBefore` 会走 `session.surface.nodes` / `replaceGeneration`
     * 和 `session.eventAt(seq)`，并且按事件类型算未闭合的工具调用数，所以假的必须
     * 提供这三样、且 assistant/message 的 `data.message.content` 要真的带 tool-call
     * 块，否则「切点回退」这条分支根本走不到。
     */
    const surfaceSession = (events) => {
      const bySeq = new Map(events.map((event) => [event.seq, event]));
      const nodes = events.map((event) => event.seq);
      return {
        id: 'session-manual',
        surface: { nodes, replaceGeneration: 0 },
        eventAt(seq) {
          const event = bySeq.get(seq);
          if (event === undefined) return undefined;
          return {
            seq: event.seq,
            type: event.type,
            data:
              event.type === 'assistant/message'
                ? { message: { content: Array.from({ length: event.calls ?? 0 }, () => ({ type: 'tool-call' })) } }
                : {},
          };
        },
      };
    };
    const measurementOf = (events, tokens = 10) => ({
      nodes: events.map((event) => ({ seq: event.seq, tokens, heuristicTokens: tokens })),
    });

    {
      // 系统头 + 两轮对话：区间是节点 1..倒数第二，最后一切点保留。
      const events = [
        { seq: 1, type: 'system/message' },
        { seq: 2, type: 'user/message' },
        { seq: 3, type: 'assistant/message' },
        { seq: 4, type: 'user/message' },
        { seq: 5, type: 'assistant/message' },
      ];
      const session = surfaceSession(events);
      const measurement = measurementOf(events, 7);
      const range = selectManualRange(session, measurement, 0);
      is('manual range: the span starts after the system head', range?.startIdx, 1);
      is('manual range: the span stops before the last surface node', range?.endIdx, 3);
      const plan = planManualCompaction('session-manual', session, measurement);
      is('manual plan: the event count is the measured span length', plan.events, 3);
      is('manual plan: the token figure is the span sum', plan.tokens, 21);
      is('manual plan: the span names its first surface seq', plan.start, 2);
      is('manual plan: the span names its last surface seq', plan.end, 4);
    }

    {
      // 没有系统头时区间从节点 0 开始。
      const events = [
        { seq: 1, type: 'user/message' },
        { seq: 2, type: 'assistant/message' },
        { seq: 3, type: 'user/message' },
      ];
      const plan = planManualCompaction('session-manual', surfaceSession(events), measurementOf(events));
      is('manual plan: without a system head the span starts at node 0', plan.start, 1);
      is('manual plan: and it still keeps the cut', plan.events, 2);
    }

    {
      // 只剩一个可压节点时没有安全区间：不能报一个会换掉 0 个事件的「成功」。
      const events = [
        { seq: 1, type: 'system/message' },
        { seq: 2, type: 'user/message' },
      ];
      const plan = planManualCompaction('session-manual', surfaceSession(events), measurementOf(events));
      is('manual plan: a single compactable node yields an empty plan', plan.events, 0);
      is('manual plan: an empty plan names no span', plan.start, null);
    }

    {
      // 切点回退：表面以 tool/result 结尾时，最后一切点会把「调用 + 结果」拆开，
      // 后端会往前退到平衡切点。不做这一步就会把数字报大一位。
      const events = [
        { seq: 1, type: 'system/message' },
        { seq: 2, type: 'user/message' },
        { seq: 3, type: 'assistant/message', calls: 1 },
        { seq: 4, type: 'tool/result' },
      ];
      const plan = planManualCompaction('session-manual', surfaceSession(events), measurementOf(events));
      is('manual plan: an unbalanced trailing cut walks back', plan.end, 2);
      is('manual plan: so the tool pair stays whole', plan.events, 1);
    }

    {
      // 度量与表面不一致时必须报错，不能悄悄按对不上的两个列表算数字。
      const events = [
        { seq: 1, type: 'system/message' },
        { seq: 2, type: 'user/message' },
        { seq: 3, type: 'assistant/message' },
      ];
      const stale = { nodes: [{ seq: 1, tokens: 1, heuristicTokens: 1 }, { seq: 9, tokens: 1, heuristicTokens: 1 }] };
      const outcome = (() => {
        try {
          selectManualRange(surfaceSession(events), stale, 0);
          return 'no error';
        } catch {
          return 'refused';
        }
      })();
      is('manual range: a measurement from another surface is refused', outcome, 'refused');
    }

    // ── 选段算法的上游守卫：拿运行中的 shipped 后端逐例比对区间 ──────────────
    //
    // `selectManualRange` 是 shipped 后端 `selectCompactableRange` 的**移植**，不是
    // 调用：那个函数在 `@deepseek-ai/dsh-compaction-basic` 里是模块私有的，`import`
    // 拿不到。移植的失效方式是**静默**的——上游改了选段算法，这边照旧算，二次确认
    // 预报的数字就与执行结果不符，而没有任何东西会报错。
    //
    // 所以这里不冻结「上游当时的行为」（那只能证明写测试那天对得上），而是把**这一刻
    // profile 真的会加载的那份后端源码**取出来，只追加一行导出，放进 profile 自己的
    // `node_modules` 下动态 import，对同一份会话逐例比对两个函数选出的区间：
    //
    //   装上插件后，`@deepseek-ai/dsh-compaction-basic` 指向 install.mjs 写的 redirect，
    //   它的 `index.js` 从 `./base.js` 取 `BasicCompactionEngine`，而 `base.js` 是
    //   shipped `lib/index.js` 的逐字节副本（下面有一条断言把这条链钉住）。探针读的
    //   就是这一份，所以对比的是**运行中那份代码**，不是我们抄下来的行为。
    //
    // 上游升级、重装插件后 `base.js` 会跟着刷新，比对自动跟着新算法走，测试不用改。
    // 上游把那个函数改名、改签名、或改掉任何一条选段规则，这里就会响。
    //
    // 边界如实写在报告里：具体哪一条规则变了，靠的是下面这组会话形状覆盖到没有。
    {
      const pluginDir = installedPluginDirectory();
      const modulesRoot = pluginDir === null ? null : dirname(pluginDir);
      const backendDir = modulesRoot === null ? null : join(modulesRoot, '@deepseek-ai', 'dsh-compaction-basic');
      const redirectCopy = backendDir === null ? null : join(backendDir, 'base.js');
      const shippedCopy = backendDir === null ? null : join(backendDir, 'lib', 'index.js');
      const sourceKind =
        redirectCopy !== null && existsSyncSafe(redirectCopy)
          ? 'redirect-base'
          : shippedCopy !== null && existsSyncSafe(shippedCopy)
            ? 'shipped-lib'
            : null;
      const backendSource =
        sourceKind === 'redirect-base' ? redirectCopy : sourceKind === 'shipped-lib' ? shippedCopy : null;

      ok(
        `manual guard: the shipped backend is on disk to compare against${backendSource === null ? ` (looked for ${String(redirectCopy)} and ${String(shippedCopy)})` : ''}`,
        backendSource !== null,
      );

      // 只有 redirect 那条路有间接：它必须还在从 `./base.js` 取引擎，否则探针读的
      // 就不是运行时加载的那一份（`shipped-lib` 那条路没有间接，探针读的就是本体）。
      let loadsProbedCopy = sourceKind !== 'redirect-base';
      if (sourceKind === 'redirect-base') {
        loadsProbedCopy = (await readFile(join(backendDir, 'index.js'), 'utf8')).includes("'./base.js'");
      }
      ok('manual guard: the profile loads the very copy this guard probes', loadsProbedCopy);

      let upstream = null;
      let probeFailure = '';
      if (backendSource !== null) {
        const source = await readFile(backendSource, 'utf8');
        if (!/\bfunction\s+selectCompactableRange\s*\(/u.test(source)) {
          probeFailure = `${backendSource} declares no selectCompactableRange function`;
        } else {
          const probeDir = await mkdtemp(join(modulesRoot, '.cz-upstream-guard-'));
          try {
            const probe = join(probeDir, 'backend.mjs');
            // 只加一行导出，函数体一个字不动。探针目录在 profile 的 node_modules 下，
            // 所以这份源码自己的 `@deepseek-ai/*` 依赖照常解析得到。
            await writeFile(probe, `${source}\nexport { selectCompactableRange };\n`, 'utf8');
            const probed = await import(pathToFileURL(probe).href);
            if (typeof probed.selectCompactableRange === 'function') upstream = probed.selectCompactableRange;
            else probeFailure = `${backendSource} exports no callable selectCompactableRange`;
          } catch (error) {
            probeFailure = `probing ${backendSource} failed: ${String(error?.message ?? error)}`;
          } finally {
            await rm(probeDir, { recursive: true, force: true });
          }
        }
      } else {
        probeFailure =
          pluginDir === null ? 'no --installed profile was named' : `${String(backendDir)} holds no shipped backend`;
      }
      ok(
        `manual guard: the shipped selectCompactableRange was called directly (${backendSource === null ? probeFailure : `${sourceKind}: ${backendSource}`}${probeFailure.length === 0 ? '' : ` — ${probeFailure}`})`,
        upstream !== null,
      );

      /** 逐节点给不同 token 数的度量，用来把切点推到不同位置。 */
      const measurementWith = (events, tokens) => ({
        nodes: events.map((event, index) => {
          const value = Array.isArray(tokens) ? (tokens[index] ?? 0) : tokens;
          return { seq: event.seq, tokens: value, heuristicTokens: value };
        }),
      });
      /**
       * 把一次调用归一到「选了哪一段表面 seq」。
       *
       * 两个函数返回的形状不同（shipped 给 seq，移植给下标），语义是同一个：区间端点的
       * 表面 seq。只比 end/start 是否相同，**不比异常文案**——文案是措辞，不是行为，
       * 拿它当判据会让上游改一句话就误报。
       */
      const outcomeOf = (fn, session, measurement, retainTokens) => {
        try {
          const result = fn(session, measurement, retainTokens);
          if (result === null || result === undefined) return { kind: 'none' };
          if (typeof result.startIdx === 'number') {
            return { kind: 'span', start: session.surface.nodes[result.startIdx], end: session.surface.nodes[result.endIdx] };
          }
          return { kind: 'span', start: result.start, end: result.end };
        } catch {
          return { kind: 'threw' };
        }
      };
      /** 两边不一致时回一句能直接读的差异，一致时回 null。 */
      const compare = (label, events, tokens, retainTokens) => {
        const session = surfaceSession(events);
        const measurement = measurementWith(events, tokens);
        const mine = outcomeOf(selectManualRange, session, measurement, retainTokens);
        const theirs = upstream === null ? { kind: 'unprobed' } : outcomeOf(upstream, session, measurement, retainTokens);
        return JSON.stringify(mine) === JSON.stringify(theirs)
          ? null
          : `${label}: port ${JSON.stringify(mine)} vs shipped ${JSON.stringify(theirs)}`;
      };
      /** 跑一组例子，只回第一条差异。 */
      const sweep = (cases) =>
        upstream === null
          ? ['the shipped backend could not be probed, so nothing was compared']
          : cases.map(([label, events, tokens, retain]) => compare(label, events, tokens, retain)).filter((entry) => entry !== null);

      const handWritten = sweep([
        [
          'a system head followed by two turns',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'assistant/message' },
            { seq: 4, type: 'user/message' },
            { seq: 5, type: 'assistant/message' },
          ],
          7,
          0,
        ],
        [
          'no system head',
          [
            { seq: 1, type: 'user/message' },
            { seq: 2, type: 'assistant/message' },
            { seq: 3, type: 'user/message' },
          ],
          10,
          0,
        ],
        [
          'a single compactable node',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
          ],
          10,
          0,
        ],
        [
          'an unbalanced trailing cut walks back',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'assistant/message', calls: 1 },
            { seq: 4, type: 'tool/result' },
          ],
          10,
          0,
        ],
        [
          'two tool pairs in a row walk back further',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'assistant/message', calls: 1 },
            { seq: 4, type: 'tool/result' },
            { seq: 5, type: 'assistant/message', calls: 1 },
            { seq: 6, type: 'tool/result' },
            { seq: 7, type: 'user/message' },
          ],
          4,
          0,
        ],
        [
          'per-node token counts move the cut',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'assistant/message' },
            { seq: 4, type: 'user/message' },
            { seq: 5, type: 'assistant/message' },
            { seq: 6, type: 'user/message' },
          ],
          [3, 40, 5, 60, 7, 2],
          0,
        ],
        [
          'a retained tail pushes the cut forward',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'assistant/message' },
            { seq: 4, type: 'user/message' },
            { seq: 5, type: 'assistant/message' },
            { seq: 6, type: 'user/message' },
          ],
          [3, 40, 5, 60, 7, 2],
          50,
        ],
        [
          'a retained tail larger than the whole surface',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'assistant/message' },
          ],
          [3, 4, 5],
          1000,
        ],
        [
          'a retained tail that lands exactly on the accumulation boundary',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
            { seq: 3, type: 'assistant/message' },
            { seq: 4, type: 'user/message' },
          ],
          [10, 10, 10, 10],
          20,
        ],
        ['an empty surface', [], 0, 0],
        [
          'a zero-token surface',
          [
            { seq: 1, type: 'system/message' },
            { seq: 2, type: 'user/message' },
          ],
          [0, 0],
          0,
        ],
      ]);
      is('manual guard: the hand-written session shapes select the same span in both implementations', handWritten.length, 0);
      is('manual guard: the first hand-written disagreement', handWritten[0] ?? null, null);

      // 手写的形状是我想到的那些；上游可能栽在我没想到的形状上。再跑一批固定种子的
      // 随机表面（系统头、工具对、零 token、各种保留尾巴都掺进去），把覆盖面拉开。
      let seed = 0x2f6e2b1;
      const next = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed;
      };
      const generated = [];
      for (let index = 0; index < 240; index += 1) {
        const length = 1 + (next() % 9);
        const events = [];
        for (let position = 0; position < length; position += 1) {
          const seq = position + 1;
          if (position === 0 && next() % 3 === 0) {
            events.push({ seq, type: 'system/message' });
            continue;
          }
          const roll = next() % 4;
          if (roll === 0) events.push({ seq, type: 'user/message' });
          else if (roll === 1) events.push({ seq, type: 'assistant/message', calls: next() % 3 });
          else if (roll === 2) events.push({ seq, type: 'tool/result' });
          else events.push({ seq, type: 'assistant/message' });
        }
        generated.push([
          `generated #${index} (${events.map((event) => event.type.replace('/message', '').replace('assistant', 'a').replace('tool/result', 't')).join(',')})`,
          events,
          events.map(() => next() % 40),
          next() % 120,
        ]);
      }
      const randomDisagreements = sweep(generated);
      is('manual guard: 240 generated surfaces keep the two selections identical', randomDisagreements.length, 0);
      is('manual guard: the first generated disagreement', randomDisagreements[0] ?? null, null);
    }

    // 失败文案：原因 + 次数 + 下一个分支，三样都要在。
    is(
      'manual text: a zero count explains why it can be zero',
      failureCountText({ failures: 0 }).includes('still 0'),
      true,
    );
    is(
      'manual text: with the fallback on the threshold names the attempt',
      failureCountText({ failures: 3, fallbackAfter: 5, fallbackEnabled: true }).includes('attempt 6'),
      true,
    );
    is(
      'manual text: with the fallback off the next failure reports the same way',
      failureCountText({ failures: 3, fallbackAfter: 5, fallbackEnabled: false }).includes('fallback is off'),
      true,
    );
    {
      const error = new Error('manual compaction requires an idle agent with no waking queued work');
      error.code = 'busy';
      const text = manualFailureText('session-busy', error, { failures: 4, fallbackAfter: 5, fallbackEnabled: true });
      is('manual text: a failure names the reason class', text.includes('the session is busy'), true);
      is('manual text: a failure keeps the backend diagnostic', text.includes('idle agent'), true);
      is('manual text: a failure names the consecutive count', text.includes('4 consecutive attempt(s)'), true);
      is('manual text: a failure names the next branch', text.includes('attempt 6'), true);
    }

    // `/zip-compact` 命令本身。它跟 `/zip-export` 一样必须声明 input：不声明的话
    // 浏览器客户端会把带参数的那一行当成普通消息发出去，`--yes` 永远到不了处理函数。
    {
      let registered = null;
      const calls = [];
      const actions = {
        plan: async (sessionId) => ({
          sessionId,
          events: 12,
          tokens: 3456,
          routeTokens: 3456,
          start: 2,
          end: 13,
        }),
        run: async (sessionId, _signal, commandId) => {
          calls.push({ sessionId, commandId });
          return { sessionId, events: 12, tokens: 3456, summarySeq: 99 };
        },
        failure: () => ({ failures: 0, fallbackAfter: 5, fallbackEnabled: false }),
      };
      const dispose = registerManualCompactCommand(
        { get: (name) => (name === 'commands' ? { register: (definition) => ((registered = definition), () => {}) } : undefined) },
        actions,
      );
      is('manual command: registers under the documented name', registered?.name, 'zip-compact');
      ok(
        'manual command: declares free-form input',
        typeof registered?.input?.hint === 'string' && registered.input.hint.length > 0,
      );
      is('manual command: does not duplicate its input in the log', registered?.recordInput, false);
      // 用户拍板：命令是逃生口，不受插件开关约束（见 待决策-S10与T25.md 第三条）。
      // 注册点是否带开关判断在 src/index.ts，这里测不到，所以只把「帮助文字必须
      // 说清」这一条钉住，免得下次有人顺手把它删了。
      ok(
        'manual command: the description says the switch does not gate it',
        /plugin switch/u.test(String(registered?.description ?? '')),
      );

      const bare = await registered.handler({ rawInput: '   ', agent: { session: { id: 'session-self' } } });
      is('manual command: a bare invocation reports instead of compacting', bare.kind, 'success');
      is('manual command: the report states the measured event count', bare.text.includes('12 event(s)'), true);
      is('manual command: the report states the token figure', bare.text.includes('~3456 tokens'), true);
      is('manual command: the report asks for the confirmation flag', bare.text.includes('--yes'), true);
      is('manual command: nothing runs before the confirmation', calls.length, 0);

      const confirmed = await registered.handler({
        rawInput: '--yes',
        agent: { session: { id: 'session-self' } },
        commandId: 'command-1',
        signal: undefined,
      });
      is('manual command: the confirmed run targets the calling session', calls.at(-1)?.sessionId, 'session-self');
      is('manual command: the confirmed run carries the command identity', calls.at(-1)?.commandId, 'command-1');
      is('manual command: the completion reports the actual count', confirmed.text.includes('Compacted 12 event(s)'), true);
      is('manual command: the completion names the summary event', confirmed.text.includes('#99'), true);

      const named = await registered.handler({
        rawInput: ' session-abc --yes ',
        agent: { session: { id: 'session-self' } },
      });
      is('manual command: a named session wins over the calling session', calls.at(-1)?.sessionId, 'session-abc');
      is('manual command: a named run still reports success', named.kind, 'success');

      const unknown = await registered.handler({ rawInput: '--nope', agent: { session: { id: 'session-self' } } });
      is('manual command: an unknown option is refused', unknown.kind, 'error');
      is('manual command: the refusal prints the usage', unknown.text.includes('Usage: /zip-compact'), true);

      // 失败路径。计数是在失败之后读的：引擎是在尝试收尾时加一，先读会少一位。
      actions.run = async () => {
        const error = new Error('summarization returned no handoff summary (too-short)');
        error.code = 'summary';
        throw error;
      };
      actions.failure = () => ({ failures: 3, fallbackAfter: 5, fallbackEnabled: true });
      const failed = await registered.handler({ rawInput: '--yes', agent: { session: { id: 'session-self' } } });
      is('manual command: a failed run reports an error', failed.kind, 'error');
      is(
        'manual command: the failure names the reason class',
        failed.text.includes('could not produce a usable handoff summary'),
        true,
      );
      is('manual command: the failure keeps the backend diagnostic', failed.text.includes('too-short'), true);
      is('manual command: the failure carries the consecutive count', failed.text.includes('3 consecutive attempt(s)'), true);
      is('manual command: the failure carries the fallback threshold', failed.text.includes('attempt 6'), true);
      typeof dispose === 'function' ? dispose() : null;
    }

    // 引擎里的失败计数：成功会清零，所以「读到几」这件事本身要有一条。
    {
      resetFailureStreaks();
      is('manual counters: an untouched session reads zero', failureCount('session-never'), 0);
      is('manual counters: an unknown id is not an error', failureCount(''), 0);
    }

    // ── 「区间太小」这一失败类：复现、判据、文案 ──────────────────────────────
    //
    // 2026.09.19 D3。用户实测：区间偏小时手动压缩连跑 7 次，计数始终是 0，兜底永远
    // 到不了第 6 次。这里的判据分两层：
    //
    // 1. **机械层**：这一类确实**不涨计数**，因为模型调用本身成功了——shipped 后端
    //    是在 `summarize()` 返回**之后**，拿 framed checkpoint 的估价与被替换区间的
    //    估价相比才抛的（`summary is not smaller than the shadowed content (655 >=
    //    357)`）。而插件那本账在成功返回时已经清零（`summarize()` 里
    //    `failureStreaks.delete` 的位置就在 `run(...)` 成功之后）。所以这不是
    //    「计数漏了一类」，是「这一类按定义不属于那本账」。
    // 2. **语义层**：它也不该计入。机械摘要是按事件拼的流水账（实测 3 条事件就
    //    635 字符），比模型摘要长，换上只会让「摘要必须比区间小」这道判决更过不去。
    //    所以判定：**不该计入**。改的是文案与分类，不改计数口径。
    //
    // 用法与真机复现脚本一致：真 shipped 后端（redirect 里那份 base）+ 真引擎，
    // 只有会话与 token 度量是替身。真机记录见发布包 `evidence/验收台账.md`。
    {
      const makeLlmMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
      const d3Session = (id, events) => {
        let log = [...events];
        let bySeq = new Map(log.map((event) => [event.seq, event]));
        let surface = { nodes: log.map((event) => event.seq), replaceGeneration: 0 };
        return {
          id,
          get seq() {
            return log.length;
          },
          get surface() {
            return surface;
          },
          eventAt(seq) {
            return bySeq.get(seq);
          },
          requestHeader() {
            return { tools: [], config: { provider: 'example-provider', model: 'deepseek-v4.1-flash' } };
          },
          deriveEventMessage(event) {
            if (event.type === 'system/message') return { role: 'system', content: [{ type: 'text', text: 'sys' }] };
            return makeLlmMessage(String(event.data?.text ?? 'x'));
          },
          append(type, data, options) {
            const event = { type, seq: log.length, time: 1_700_000_000_000 + log.length, data: data ?? {} };
            log = [...log, event];
            bySeq = new Map([...bySeq, [event.seq, event]]);
            const op = options?.surfaceOp;
            if (op?.op === 'replace') {
              surface = {
                nodes: surface.nodes.filter((seq) => seq < op.startSeq || seq > op.endSeq),
                replaceGeneration: surface.replaceGeneration + 1,
              };
            } else {
              surface = { nodes: [...surface.nodes, event.seq], replaceGeneration: surface.replaceGeneration + 1 };
            }
            return event;
          },
        };
      };
      const d3Events = () => [
        { seq: 0, type: 'system/message', data: {} },
        { seq: 1, type: 'user/message', data: { text: 'one' } },
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'two' }] } } },
        { seq: 3, type: 'user/message', data: { text: 'three' } },
      ];
      // 真实 shipped 后端：`install.mjs` 把它拷成 redirect 包自己的 `base.js`，那是
      // 真机上真正在跑的那份字节。profile 在 `--installed` 给了才有；没给就跳过这一组
      // （仍然跑文案那几条纯函数判据）。
      const d3Base = installedPluginDirectory();
      const baseModule =
        d3Base === null
          ? null
          : await import(
              pathToFileURL(join(dirname(d3Base), '@deepseek-ai', 'dsh-compaction-basic', 'base.js')).href
            ).catch(() => null);

      if (baseModule?.BasicCompactionEngine !== undefined) {
        const D3Engine = createContextZipEngine(baseModule.BasicCompactionEngine);
        const d3Run = async (session, options) => {
          const meter = {
            measure(target) {
              const nodes = target.surface.nodes.map((seq) => ({
                seq,
                tokens: options.perNode,
                heuristicTokens: options.perNode,
              }));
              return { nodes, totalTokens: nodes.length * options.perNode };
            },
            estimateMessage() {
              return options.framed;
            },
          };
          const context = {
            tokenMeter: meter,
            sessions: { flush: async () => {} },
            logger: { warn() {}, debug() {}, info() {} },
            reflect: { provide() {}, set() {}, get() {} },
            on() {
              return () => {};
            },
            effect() {
              return () => {};
            },
            get() {
              return undefined;
            },
          };
          const engine = new D3Engine(context, {});
          engine.deps = options.deps ?? {};
          if (typeof options.summarize === 'function') engine.summarize = options.summarize;
          const agent = {
            session,
            async runMaintenance(work) {
              return await work(new AbortController().signal);
            },
          };
          try {
            return { ok: true, result: await engine.compactNow(agent, new AbortController().signal, undefined) };
          } catch (error) {
            return { ok: false, error };
          }
        };

        // 第一层：真 shipped 后端 + 合格摘要 + 区间太小 → 失败，计数不动。
        resetFailureStreaks();
        const tooSmall = d3Session('session-d3-small', d3Events());
        const outcomeA = await d3Run(tooSmall, {
          perNode: 50,
          framed: 100,
          summarize: async () => ({
            summary: [{ type: 'text', text: '## Goal\nbuild it\n## State\nx\n## Decisions\ny\n## Next\nz\n## Notes\n-' }],
            provider: 'example-provider',
            model: 'deepseek-v4.1-flash',
          }),
        });
        is('range-too-small: the attempt fails', outcomeA.ok, false);
        is(
          'range-too-small: the backend names the size judgement',
          String(outcomeA.error?.cause?.message ?? outcomeA.error?.message ?? '').includes(
            'summary is not smaller than the shadowed content',
          ),
          true,
        );
        is('range-too-small: the failure is classified as a summary failure', outcomeA.error?.code, 'summary');
        is('range-too-small: the consecutive-failure count does not move', failureCount('session-d3-small'), 0);

        // 反向对照：真 summarizer 失败（模型调用本身抛）→ 计数必须动，且到第 6 次
        // 改机械摘要。两组放在一起才说明「不是计数坏了，是这一类不进那本账」。
        resetFailureStreaks();
        const realFailure = d3Session('session-d3-real', d3Events());
        const attempts = [];
        for (let index = 1; index <= 6; index += 1) {
          const outcome = await d3Run(realFailure, {
            perNode: 50,
            framed: 100,
            deps: {
              readFallback: async () => ({ enabled: true, after: 5 }),
              summarize: async () => {
                throw new Error('summarization returned no handoff summary (too-short)');
              },
            },
          });
          attempts.push({
            ok: outcome.ok,
            count: failureCount('session-d3-real'),
            text: String((outcome.result?.summary ?? []).map((block) => block.text).join('\n')),
          });
        }
        is('real summarizer failures: the count moves on every attempt', attempts.slice(0, 5).map((one) => one.count).join(','), '1,2,3,4,5');
        is('real summarizer failures: attempt 6 is the mechanical fallback', attempts[5].ok && attempts[5].text.includes('mechanical fallback'), true);
        is('real summarizer failures: the count keeps the same account', attempts[5].count, 6);

        // 机械摘要比小区间更长：这就是「它救不了这一类」的机械依据。
        const mechanicalText = String(
          buildMechanicalSummary([
            { role: 'user', content: [{ type: 'text', text: 'one' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
          ]),
        );
        is(
          'range-too-small: the mechanical summary is longer than the span it would replace',
          mechanicalText.length >= 50,
          true,
        );

        // D4：调用方交给机械摘要的是「发给模型的那份消息数组」，末尾挂着插件自己拼的
        // 摘要指令。它必须按 `source.plugin` 滤掉——事件数与字符数都得对，因为这条摘要
        // 存在的理由就是「不可能编造」，里面唯一的两个数字错不起。
        const withInstruction = buildMechanicalSummary([
          { role: 'user', content: [{ type: 'text', text: 'one' }] },
          buildSummarizationInstruction(''),
        ]);
        ok('D4：插件自己的指令消息不计入事件数', withInstruction.includes('- 1 event(s)'));
        ok('D4：插件自己的指令消息不计入事件种类', withInstruction.includes('Event kinds: user 1'));
        ok('D4：指令消息那几千字也不计入字符数', !/about \d{4,} characters/.test(withInstruction));
      } else {
        ok('range-too-small: the shipped backend is reachable for the mechanical check', false);
      }

      // 第二层：判据与文案，纯函数，不依赖 profile。
      const backendError = new Error('manual compaction could not produce a smaller summary');
      backendError.code = 'summary';
      backendError.cause = new Error('summary is not smaller than the shadowed content (655 estimated framed tokens >= 357)');
      is('range-too-small: the class is recognized from the wrapped manual error', isRangeTooSmallFailure(backendError), true);
      is(
        'range-too-small: the class is recognized from the bare size sentence',
        isRangeTooSmallFailure(new Error('summary is not smaller than the shadowed content (655 >= 357)')),
        true,
      );
      // 浏览器那条路只带回外层的 message（`data.message`），cause 链到不了客户端，
      // 所以这两层都得能单独认出来。只把外层那句喂进去，判据也必须成立——这正是
      // 面板上那句话能不能改对的前提。
      is(
        'range-too-small: the outer message alone is recognized (the browser route only carries this)',
        isRangeTooSmallFailure('manual compaction could not produce a smaller summary'),
        true,
      );
      is(
        'range-too-small: the inner size sentence alone is recognized',
        isRangeTooSmallFailure('summary is not smaller than the shadowed content (655 estimated framed tokens >= 357)'),
        true,
      );
      is(
        'range-too-small: a plain summarizer failure is not this class',
        isRangeTooSmallFailure(new Error('summarization returned no handoff summary (too-short)')),
        false,
      );
      is(
        'range-too-small: a busy session is not this class',
        isRangeTooSmallFailure(new Error('manual compaction: the session already has an open turn')),
        false,
      );
      is('range-too-small: a non-error is not this class', isRangeTooSmallFailure(undefined), false);

      const smallText = failureCountText({ failures: 0, fallbackAfter: 5, fallbackEnabled: true }, true);
      is(
        'range-too-small: the count line says the fallback cannot rescue this class',
        smallText.includes('not counted towards the mechanical fallback') && smallText.includes('longer than a model one'),
        true,
      );
      is(
        'range-too-small: the count line does not blame the shipped-backend bookkeeping',
        /shipped backend/.test(smallText),
        false,
      );
      is(
        'range-too-small: the ordinary zero line still names the shipped-backend case',
        failureCountText({ failures: 0 }).includes('shipped backend'),
        true,
      );
      const smallLine = manualFailureText('session-d3', backendError, { failures: 0, fallbackAfter: 5, fallbackEnabled: true });
      is(
        'range-too-small: the manual failure line carries the class-specific count text',
        smallLine.includes('not counted towards the mechanical fallback'),
        true,
      );
      is(
        'range-too-small: the manual failure line still carries the backend diagnostic',
        smallLine.includes('could not produce a smaller summary'),
        true,
      );
    }

    // 两条手动路由。它们跟其它路由一样只认回环、只认规定的动词，POST 还要求 JSON。
    {
      const captured = [];
      const dispose = registerRoutes(
        {
          get: (name) =>
            name === 'webServer'
              ? { register: (spec) => { captured.push(spec); return () => {}; } }
              : undefined,
        },
        {
          readSettings: () => ({ enabled: true, agents: {} }),
          readEffectiveMode: () => ({ compaction: 'plugin', source: 'settings' }),
          listSegments: () => [],
          readModeFor: () => null,
          readManualPlan: async (sessionId) => {
            if (sessionId === 'session-many') throw new ManualTargetError('session-required', 'this process holds 2 live sessions');
            if (sessionId === 'session-two') {
              return { sessionId, events: 0, tokens: 0, routeTokens: 0, start: null, end: null };
            }
            return { sessionId: sessionId ?? 'session-only', events: 12, tokens: 3456, routeTokens: 3456, start: 2, end: 13 };
          },
          runManualCompaction: async (sessionId) => {
            if (sessionId === 'session-busy') {
              const error = new Error('manual compaction requires an idle agent with no waking queued work');
              error.code = 'busy';
              throw error;
            }
            return { sessionId: sessionId ?? 'session-only', events: 12, tokens: 3456, summarySeq: 99 };
          },
          readManualFailure: (sessionId) => ({
            failures: sessionId === 'session-busy' ? 4 : 0,
            fallbackAfter: 5,
            fallbackEnabled: true,
          }),
        },
      );
      const planRoute = captured.find((spec) => spec.path === '/dsh-context-zip/compact/plan');
      const runRoute = captured.find((spec) => spec.path === '/dsh-context-zip/compact');
      is('manual routes: the plan route is registered', planRoute !== undefined, true);
      is('manual routes: the run route is registered', runRoute !== undefined, true);
      is('manual routes: one disposer per registration', dispose.length, captured.length);

      const get = async (url, remote = '127.0.0.1') => {
        let status = 0;
        let body = '';
        // 处理函数是 async：成功分支在 `await` 之后才写响应，所以这里必须等它落地，
        // 同步读会永远读到 0/空串。
        await planRoute.handler(
          { method: 'GET', url, socket: { remoteAddress: remote } },
          { writeHead: (code) => { status = code; }, end: (text) => { body = text; } },
        );
        return { status, body: JSON.parse(body) };
      };
      const post = (payload, remote = '127.0.0.1', contentType = 'application/json') => {
        let status = 0;
        let text = '';
        const listeners = {};
        const req = {
          method: 'POST',
          url: '/dsh-context-zip/compact',
          headers: contentType === null ? {} : { 'content-type': contentType },
          socket: { remoteAddress: remote },
          on: (name, handler) => { listeners[name] = handler; },
          destroy: () => {},
        };
        const res = { writeHead: (code) => { status = code; }, end: (payloadText) => { text = payloadText; } };
        const settled = runRoute.handler(req, res);
        listeners.data?.(JSON.stringify(payload));
        listeners.end?.();
        return settled.then(() => ({ status, body: JSON.parse(text) }));
      };

      const planned = await get('/dsh-context-zip/compact/plan?sessionId=session-live');
      is('manual plan route: a live session answers 200', planned.status, 200);
      is('manual plan route: the plan carries the measured count', planned.body.events, 12);
      is('manual plan route: the plan names its session', planned.body.sessionId, 'session-live');
      is('manual plan route: the plan carries the failure bookkeeping', planned.body.failure?.fallbackAfter, 5);

      const empty = await get('/dsh-context-zip/compact/plan?sessionId=session-two');
      is('manual plan route: an empty span answers 200 with zero', empty.body.events, 0);

      const defaulted = await get('/dsh-context-zip/compact/plan');
      is('manual plan route: no session id lets the host choose', defaulted.body.sessionId, 'session-only');

      const ambiguous = await get('/dsh-context-zip/compact/plan?sessionId=session-many');
      is('manual plan route: an ambiguous host answers 409', ambiguous.status, 409);
      is('manual plan route: and names the reason code', ambiguous.body.error, 'session-required');

      is(
        'manual plan route: a traversal id answers 400',
        (await get('/dsh-context-zip/compact/plan?sessionId=../etc')).status,
        400,
      );
      is(
        'manual plan route: a non-loopback caller is refused',
        (await get('/dsh-context-zip/compact/plan', '10.0.0.7')).status,
        405,
      );
      is(
        'manual plan route: a write answers 405',
        (
          await (async () => {
            let status = 0;
            await planRoute.handler(
              { method: 'POST', url: '/dsh-context-zip/compact/plan', socket: { remoteAddress: '127.0.0.1' } },
              { writeHead: (code) => { status = code; }, end: () => {} },
            );
            return { status };
          })()
        ).status,
        405,
      );

      const ran = await post({ sessionId: 'session-live' });
      is('manual run route: a successful run answers 200', ran.status, 200);
      is('manual run route: the result reports the replaced count', ran.body.events, 12);
      is('manual run route: the result names the summary event', ran.body.summarySeq, 99);

      const busy = await post({ sessionId: 'session-busy' });
      is('manual run route: a failure answers 500', busy.status, 500);
      is('manual run route: the failure names its class', busy.body.code, 'busy');
      is('manual run route: the failure keeps the diagnostic', busy.body.message.includes('idle agent'), true);
      is('manual run route: the failure carries the consecutive count', busy.body.failure?.failures, 4);

      const defaultRun = await post({});
      is('manual run route: no session id lets the host choose', defaultRun.body.sessionId, 'session-only');
      is('manual run route: a non-JSON body is refused', (await post({}, '127.0.0.1', 'text/plain')).status, 415);
      is('manual run route: a non-loopback caller is refused', (await post({}, '10.0.0.7')).status, 403);
    }
  }

  // The pressure reminder divides by the routed context window, and the route can
  // change mid-session. The agent's own `options` keep naming the route the session
  // STARTED on, so the window comes from the session's last `request/context` event
  // instead. Measured on a session that switched routes, those two disagreed by
  // 400,000 against 1,000,000, and the reminder fired at 320,000 tokens because it
  // was still dividing by the old window.
  {
    const route = (window) => ({ type: 'request/context', data: { contextWindow: window } });
    is(
      'context window: the last request/context event wins',
      latestContextWindow([route(400000), route(1000000)]),
      1000000,
    );
    is(
      'context window: a non-positive window is skipped, not returned',
      latestContextWindow([route(400000), route(0)]),
      400000,
    );
    is(
      'context window: a session with no request/context has no window',
      latestContextWindow([{ type: 'step/end', data: {} }]),
      null,
    );
    is('context window: a non-array reads as no window', latestContextWindow(undefined), null);
  }

  await checkDeclaredTypes(resolve(here, '..'));

  // The delivered tree makes the same promise and is the copy that actually ships,
  // so it gets the same guard pointed at it whenever the pipeline names one.
  const delivered = deliverableDirectory();
  if (delivered !== null) await checkDeclaredTypes(delivered, 'deliverable exports');

} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures.length === 0) {
  process.stdout.write(`context-zip: ${checks} checks passed\n`);
  process.exit(0);
}
process.stdout.write(`context-zip: ${failures.length} of ${checks} checks FAILED\n`);
for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
process.exit(1);
