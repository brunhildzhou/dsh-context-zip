/**
 * Browser half of dsh-context-zip.
 *
 * Registers one independent settings section beside the built-in ones. The
 * section reads and writes the `context-zip` settings namespace through the
 * plugin's own host routes, so it never needs a core change and never guesses at
 * another plugin's storage.
 *
 * @module dsh-context-zip/client
 */

import * as React from 'react';
import { LIVE_POLL_MS, SAVE_FEEDBACK_MS, clockText, helpBubblePlacement, initialLiveHealth, liveHealthAfter, mergeLivePayload, modeClickIntent, sameSettings, saveButtonEnabled, saveButtonFace, startLivePoll, startModeReadRetry, titlesFrom, toRows, wireFace, wireStatusFrom, wireText } from './live.ts';
// 两条长说明只有一处原文：`src/panel-copy.ts`，schema 的 `description` 也引它。面板与
// `settings.yaml` 里读到的那段话因此不可能各说各话（台账 B3 的口径）。
import { FALLBACK_ENABLED_COPY, REWRITE_ENABLED_COPY } from '../src/panel-copy.ts';
// 会话号判据只有一处原文：`src/session-key.ts`。服务端在取名之前先用它过滤，面板在
// 渲染之前用同一处过滤，于是「哪些键是会话」不可能两边各判各的。
import { isSessionKey } from '../src/session-key.ts';

/** Client entry name, as the loader mounts it. */
export const name = 'dsh-context-zip/client';

/** Services the section needs before it renders. */
export const inject = ['slots', 'locale'];

/** Locale namespace used for the section's strings. */
export const NS = 'context-zip';

/** Host route serving the current settings section. */
const SETTINGS_ROUTE = '/dsh-context-zip/settings';

/**
 * Host route serving only the effective view, for the poll.
 *
 * The panel polls this one while it is open. It exists so a 5-second tick does
 * not serialize the settings value the poll never reads; see `src/routes.ts`.
 */
const LIVE_ROUTE = '/dsh-context-zip/live';

/** Host route applying one settings patch. */
const UPDATE_ROUTE = '/dsh-context-zip/settings/update';

/** Host route listing one session's compaction segments. */
const SEGMENTS_ROUTE = '/dsh-context-zip/segments';

/** Route reporting which compaction backend one session will use next. */
const MODE_ROUTE = '/dsh-context-zip/mode';

/** Host route listing the models registered with DSH right now. */
const MODELS_ROUTE = '/dsh-context-zip/models';

/**
 * Host route reporting — and performing — the wiring of the compaction row.
 *
 * The read is a `GET`, the action a `POST` on the same path: one route, one
 * subject, and the panel never has to reason about two.
 */
const WIRE_ROUTE = '/dsh-context-zip/wire';

/**
 * Where this browser remembers, per session, the mode it last read.
 *
 * The chip is remounted every time the page switches sessions, and `mode` started
 * at `undefined` — which renders as an UNCHECKED chip. So every switch first drew
 * an "off" frame and then slid to the truth: even plugin-to-plugin switches played
 * the open animation although nothing had changed (user report, 2026.09.19).
 *
 * Remembering the answer fixes that at the source instead of muting the
 * animation: a chip that opens on the value it showed last time has no change to
 * animate, while a switch that really does cross from off to on (or on to off)
 * still animates exactly like the switch does anywhere else.
 *
 * Deliberately NOT the host's own per-session table. `settings.yaml` keeps an
 * OVERRIDE table (only sessions somebody flipped by hand), while this chip shows
 * the RESOLVED mode, which layers the global switch and the agent preset on top.
 * Re-deriving that here would be a second implementation of the host's precedence
 * rule, which is the thing this file already refuses to do.
 */
const MODE_MEMORY_KEY = 'dsh-context-zip:modes';

/**
 * The whole remembered table.
 *
 * Every failure mode reads as "nothing remembered": a store the browser refuses
 * (private windows, disabled storage), a value some other tab or hand edit left
 * unparsable, or a table that is not an object. Forgetting costs one extra read;
 * throwing here would cost the chip.
 *
 * @returns session id → mode, possibly empty.
 */
function readModeMemory() {
  try {
    const raw = window.localStorage.getItem(MODE_MEMORY_KEY);
    if (raw === null) return {};
    const table = JSON.parse(raw);
    return table !== null && typeof table === 'object' ? table : {};
  } catch {
    return {};
  }
}

/**
 * The remembered mode for one session, or `undefined` when this page has never
 * read it.
 *
 * @param sessionId - session to look up.
 * @returns the mode object read earlier, or `undefined`.
 */
function rememberedMode(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return void 0;
  const table = readModeMemory();
  return Object.hasOwn(table, sessionId) ? table[sessionId] : void 0;
}

/**
 * Remember one session's answer, replacing whatever was there.
 *
 * Both answers are stored: a session that resolves to the shipped backend is
 * remembered as such, so switching to it is just as flicker-free as switching to
 * a plugin one. A store that refuses the write is not an error — the chip keeps
 * working, it just forgets across reloads.
 *
 * @param sessionId - session the answer belongs to.
 * @param mode - the mode object the host returned, or the optimistic one a click
 *   wrote.
 */
function writeModeMemory(sessionId, mode) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;
  try {
    const table = readModeMemory();
    table[sessionId] = mode;
    window.localStorage.setItem(MODE_MEMORY_KEY, JSON.stringify(table));
  } catch {
    // Nothing to do: the answer is already on screen.
  }
}

/**
 * The look the chip last painted: `true` for the plugin side, `false` for the
 * shipped backend, `undefined` while this page has never painted a chip.
 *
 * It exists because the host REMOUNTS this component on every session switch.
 * The composer's `conversation.input.left` slot is declared `scope: 'session'`,
 * and the renderer keys the strict-session boundary by the session id
 * (`StrictSessionEntry` renders its boundary with `key={binding.key}`, where the
 * binding key is the session), so switching sessions tears the old chip out of
 * the DOM and builds a new one. A brand-new element has no previous computed
 * style, so there is nothing for its first frame to interpolate FROM: whatever
 * it draws first is what the eye gets, with no transition.
 *
 * Remembering the per-session answer (see `MODE_MEMORY_KEY`) fixed the other
 * half of this — a chip that opens on the value it showed last time has no
 * change to animate — but it also removed the only animation a mode-crossing
 * switch had, because the new element drew its final value on frame one. This
 * value is the missing starting point: the new chip draws the look that was on
 * screen, then moves to its own answer, which is the same computed-style change
 * the switch already animates when it happens inside one session.
 *
 * Module scope, not component state: the point is to survive the remount that
 * component state does not survive. Booleans only, and deliberately not the mode
 * object — the tint of a failed or still-reading chip is not a mode, and the
 * next chip should not claim one.
 */
let lastLookOn: boolean | undefined;

const ZH = {
  nav: 'ContextZip',
  title: 'ContextZip',
  // ── 分组标题：面板不写说明段落，可见文字只有分组名、控件与两条问号说明（E 轮定）
  groupMethod: '压缩方式',
  groupFallback: '摘要兜底',
  groupRewrite: '摘要重排',
  groupExperiment: '实验与排障',
  groupExperimentTag: '未验证',
  groupSegments: '压缩分段',
  // ── 压缩方式：一行分段控件，值仍是 `enabled` 布尔
  methodLabel: '新建会话默认压缩方式',
  methodPlugin: 'ContextZip',
  methodDefault: '内置后端',
  // ── 压缩后端：压缩那一行由谁接管（`dsh plugin add` 装的人默认没有接管）。
  // 一行标题加一颗问号，中间是主行加副行，右端按钮只在还能做事时出现。九态各有一套
  // 主副行，判定顺序在 `client/live.ts` 的 `wireStatusFrom`；这里只有文字。
  rowTitle: '压缩后端',
  help: '插件接管压缩后才生效，接管后需重启一次 harness。',
  inactiveMain: '未生效',
  inactiveSub: '内置压缩正在工作',
  takeover: '接管',
  takingMain: '正在接管',
  takingSub: '请稍候',
  activeMain: '已生效',
  activeSubPrefix: '基于内置',
  // 戳里没有版本时的兜底句：副行要印版本，缺字段就用这一句，不留空位。
  versionUnknown: '版本未知',
  updateMain: '待更新',
  // 两个版本都可能缺席：快照由 `wireText` 兜成「版本未知」，当前版本没有兜底句，所以这里
  // 把空的那一段连同它的分隔符一起去掉，而不是印出 `内置 ，快照 …` 或尾随的逗号。
  updateTpl: (current, snapshot) => {
    const parts = [current.length > 0 ? `内置 ${current}` : '', snapshot.length > 0 ? `快照 ${snapshot}` : '', '重接一次即可'];
    return parts.filter((part) => part.length > 0).join('，');
  },
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
  // ── 已生效会话（只读）
  agentsSection: '已生效会话',
  showMore: '显示更多',
  emptyList: '无',
  copySessionId: '复制会话 id',
  copied: '已复制',
  copyFailed: '复制失败',
  // ── 摘要兜底
  fallbackRowLabel: '机械摘要兜底',
  fallbackAfterLabel: '失败几次后兜底',
  fallbackHintLabel: '查看机械摘要兜底说明',
  fallbackHint: FALLBACK_ENABLED_COPY.zh,
  // ── 摘要重排
  rewriteRowLabel: '摘要排版重排',
  rewriteModelRowLabel: '重排用的模型',
  rewriteHintLabel: '查看摘要排版重排说明',
  rewriteHint: REWRITE_ENABLED_COPY.zh,
  // ── 实验与排障：此前只在 schema 里、面板没有控件的四个键收在这里
  retrievalLabel: '历史工具呈现',
  retrievalGranular: '逐条',
  retrievalBatched: '加查找',
  retrievalBatchedOnly: '仅查找',
  retrievalSection: '检索覆盖',
  throttleLabel: '检索节流',
  traceLabel: '检索打点文件',
  tracePlaceholder: '/path/to/retrieval.jsonl',
  // ── 压缩分段
  segmentsSessionLabel: '会话号',
  segmentsPlaceholder: 'session-…',
  segmentsQuery: '列出分段',
  segmentsCollapse: '收起信息',
  segmentsEmpty: '这个会话还没有分段。',
  segmentsNoCurrent: '页面上还没有选中的会话，先开一个会话再来。',
  segmentsFailed: '读取失败',
  // ── 重排用的模型清单
  rewriteProvider: '来源',
  rewriteModel: '模型',
  rewriteUnset: '（未选择）',
  rewriteGone: '（不在注册表里）',
  rewriteCatalogLoading: '读取模型清单…',
  rewriteCatalogEmpty: '没有读到任何已注册的模型。',
  rewriteCatalogFailed: '读取模型清单失败',
  rewriteCatalogFailures: (names) => `有 ${names} 个来源读不到模型清单，已跳过。`,
  // ── 保存与装载反馈
  // 保存按钮的四种脸：保存 / 保存中 / 勾 / 保存失败。成功与失败各自只停留
  // `SAVE_FEEDBACK_MS`，随后回到「保存」。
  saveAction: '保存',
  saving: '保存中…',
  saved: '已保存',
  saveFailed: '保存失败',
  loadFailed: '读取设置失败，检查宿主是否加载了本插件',
  loading: '读取中…',
  // 总开关的范围句与「每次压缩前现读」这两句有守卫盯着，面板上暂时没有渲染点（总开关
  // 已换成两段控件、覆盖表已换成只读行），按 2026.09.19 F11 的先例留着不删。
  enabledHint: '开：本插件压，摘要是五段式交接稿，模型的工作笔记并入摘要。关：交回内置后端压，用它的摘要写法，笔记不参与。这个开关只管自动压缩那一步；/zip-compact 命令不受它管，关着也能敲。',
  agentsHint: '键填会话号或 agent 预设名，值覆盖上面的总开关。会话号那一档是用来让同时开着的两个会话压得不一样的：每次压缩前现读，改了立刻对下一个压缩步骤生效，不用重启。',
  // F11 裁决：实时计数的渲染位已撤，轮询与这两条字符串暂留不删。
  effectiveLive: (on, off) => `本进程此刻有 ${on} 个会话由本插件压、${off} 个由内置后端压；这是按当前设置现算的，改上面的开关会立刻改变这里的数，也会改变已有会话的下一次压缩。`,
  effectiveStale: (count, at) => `上面这行数字已经连着 ${count} 次没刷新上（最后一次读到的是 ${at}），它可能不是此刻的真实值。把面板关掉再打开会立刻重试一次。`,
  // ── 输入框旁的模式芯片
  modeOn:
    '上下文压缩方式：本插件。五段交接摘要，压缩掉的原文还能按事件号读回。拨到左边改用内置后端，当前会话的下一次压缩就生效，不用重启。',
  modeOff:
    '上下文压缩方式：内置后端。拨到右边改用本插件，当前会话的下一次压缩就生效，不用重启。',
  modeLoading: '正在读取上下文压缩方式…',
  modePending: '这个会话还没开始，等它建立后会自动读取压缩方式。',
  modeFailed:
    '读不到上下文压缩方式，检查宿主是否装载了本插件。稍后会自动重试；点这个开关可以立刻重试。',
};

const EN = {
  nav: 'ContextZip',
  title: 'ContextZip',
  groupMethod: 'Compaction method',
  groupFallback: 'Summary fallback',
  groupRewrite: 'Summary re-layout',
  groupExperiment: 'Experiments and diagnostics',
  groupExperimentTag: 'unverified',
  groupSegments: 'Compaction segments',
  methodLabel: 'Compaction method for new sessions',
  methodPlugin: 'ContextZip',
  methodDefault: 'Shipped backend',
  // Compaction backend: who took over the compaction row. One title with its
  // question mark, a main line and a sub line in the middle, and a button on the
  // right only while there is still something to do.
  rowTitle: 'Compaction',
  help: 'Takeover is required for this plugin to work. Restart once after takeover.',
  inactiveMain: 'Inactive',
  inactiveSub: 'Built-in compaction is active',
  takeover: 'Take over',
  takingMain: 'Taking over',
  takingSub: 'One moment',
  activeMain: 'Active',
  activeSubPrefix: 'Based on built-in',
  // Fallback for a stamp that carries no version: the sub line must print one,
  // and an empty slot is not a version.
  versionUnknown: 'version unknown',
  updateMain: 'Update available',
  // Same guard as the Chinese table: a part that is not there is dropped with its
  // separator, so the line can never read `Built-in , snapshot …`.
  updateTpl: (current, snapshot) => {
    const parts = [current.length > 0 ? `Built-in ${current}` : '', snapshot.length > 0 ? `snapshot ${snapshot}` : '', 'reconnect to follow'];
    return parts.filter((part) => part.length > 0).join(', ');
  },
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
  agentsSection: 'Sessions in effect',
  showMore: 'Show more',
  emptyList: 'None',
  copySessionId: 'Copy session id',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  fallbackRowLabel: 'Mechanical summary fallback',
  fallbackAfterLabel: 'Failures allowed',
  fallbackHintLabel: 'Show the mechanical summary fallback explanation',
  fallbackHint: FALLBACK_ENABLED_COPY.en,
  rewriteRowLabel: 'Re-lay-out the summary',
  rewriteModelRowLabel: 'Model for the re-layout',
  rewriteHintLabel: 'Show the summary re-layout explanation',
  rewriteHint: REWRITE_ENABLED_COPY.en,
  retrievalLabel: 'History tool presentation',
  retrievalGranular: 'One by one',
  retrievalBatched: 'With find',
  retrievalBatchedOnly: 'Find only',
  retrievalSection: 'Retrieval overrides',
  throttleLabel: 'Retrieval throttle',
  traceLabel: 'Retrieval trace file',
  tracePlaceholder: '/path/to/retrieval.jsonl',
  segmentsSessionLabel: 'Session id',
  segmentsPlaceholder: 'session-…',
  segmentsQuery: 'List segments',
  segmentsCollapse: 'Hide segments',
  segmentsEmpty: 'This session has no segments yet.',
  segmentsNoCurrent: 'No session is selected on the page yet; open one first.',
  segmentsFailed: 'Read failed',
  rewriteProvider: 'Provider',
  rewriteModel: 'Model',
  rewriteUnset: '(none)',
  rewriteGone: '(not in the registry)',
  rewriteCatalogLoading: 'Reading the model catalog…',
  rewriteCatalogEmpty: 'No registered model was returned.',
  rewriteCatalogFailed: 'Could not read the model catalog',
  rewriteCatalogFailures: (names) => `${names} provider(s) did not answer with a model list and were skipped.`,
  saveAction: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Save failed',
  loadFailed: 'Could not read settings; check that the host loaded this plugin',
  loading: 'Loading…',
  enabledHint:
    'On: this plugin compacts, the summary is the five-section handoff template, and the model\u2019s working notes are merged into it. Off: the session is handed back to the shipped backend, which writes the summary its own way, and notes take no part. The switch covers the automatic step; the /zip-compact command is not gated by it and still runs while the switch is off.',
  agentsHint:
    'Key is a session id or an agent preset name; its value overrides the global switch. The session-id key is what lets two open sessions compact differently. It is read fresh before each compaction, so a change takes effect at the next one without a restart.',
  effectiveLive: (on, off) =>
    `${on} live session(s) compact through this plugin right now and ${off} through the shipped backend; this is computed from the settings in force, so changing the switch above changes this count and the next compaction of sessions that already exist.`,
  effectiveStale: (count, at) =>
    `These counts have failed to refresh ${count} time(s) (the last successful read was ${at}), so they may not be the current values. Closing and reopening the panel retries right away.`,
  modeOn:
    'Compaction: this plugin. Five-section handoff summary, and the replaced original text stays readable by event number. Flip left for the shipped backend; it takes effect at this session\'s next compaction, no restart.',
  modeOff:
    'Compaction: the shipped backend. Flip right to use this plugin; it takes effect at this session\'s next compaction, no restart.',
  modeLoading: 'Reading the compaction mode…',
  modePending: 'This session has not started yet; the compaction mode is read as soon as it exists.',
  modeFailed:
    'Could not read the compaction mode; check that the host loaded this plugin. It retries on its own, and clicking this switch retries now.',
};

/**
 * One effective-mode view, as the host reports it for a new session.
 *
 * `overrides` and `live` are optional: the read route sends both, but a host that
 * has not counted anything yet may leave them out, and the panel already defaults
 * them at the read site.
 */
type EffectiveMode = {
  compaction: string;
  source: string;
  overrides?: number;
  live?: { on?: number; off?: number };
};

/**
 * One read of the settings section.
 *
 * Written out rather than left to the initial literal: the literal only ever
 * carried the loading shape, so `setState` was pinned to that narrow shape and
 * every later branch that adds `effective` was rejected. Every branch that
 * writes a non-null `value` writes `effective` with it.
 *
 * The panel no longer keeps a per-group message here: the only save feedback is
 * the one button in the title row, which carries its own phase state below.
 */
type SettingsState = {
  status: 'loading' | 'ready' | 'saving' | 'error';
  value: Record<string, unknown> | null;
  effective: EffectiveMode | null;
  /**
   * 会话号 → 宿主标题，来自 `/settings` 载荷里的 `titles`。
   *
   * 由宿主自己的标题投影而来，和侧边栏读的是同一份，所以面板与侧边栏不会对「这个
   * 会话叫什么」各说各话。没有标题的会话号根本不在表里，面板就打印会话号本身。
   */
  titles: Record<string, string>;
};

/**
 * 标题行那颗唯一的保存按钮的四种脸。
 *
 * `idle` 是常态；`saving` 是写入在飞；`saved` 与 `failed` 是各停留
 * {@link SAVE_FEEDBACK_MS} 的短暂反馈，之后自己回到 `idle`。
 */
type SavePhase = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * The model catalog the rewrite route is picked from.
 *
 * `message` is optional because only the failure branch carries one; the success
 * branch drops it and the panel reads it behind `status === 'error'`.
 */
type ModelCatalog = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  providers: { id: string; name?: string; models?: { id: string; name?: string }[] }[];
  failures: { id: string }[];
  message?: string;
};

/**
 * 一个表字段当表来用；不是对象（字段缺失，或被手改成别的类型）就当空表。
 *
 * @param value - 设置里的一个表字段。
 * @returns 可以直接取键的表。
 */
function asTable(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false ? value : {};
}

/**
 * 只显示会话号形态的键。
 *
 * 判据与宿主侧同一处原文（`src/session-key.ts`）：服务端取名之前先用它把预设名剔掉，
 * 面板渲染之前用同一个函数再筛一遍。宿主侧过滤省掉的是白跑的日志折叠，这一层过滤是面板
 * 不再依赖宿主的答案——两层都留着，抽掉任何一层都还能站住。
 *
 * 预设名形态的键只能手改 `settings.yaml`，本区只做显示与复制（用户 2026.09.19 定）：
 * 每会话覆盖的唯一写入口是输入框旁的压缩方式芯片。
 */

/** 只读列表首屏条数，也是「显示更多」每次增加的条数。 */
const LIST_PAGE = 10;

/** 复制与问号气泡的反馈时长。 */
const FEEDBACK_MS = 1500;

/** 问号气泡的目标宽度；视口更窄时按视口收窄。 */
const BUBBLE_WIDTH = 320;

/** 复制按钮的双框图标，前框内嵌 `id` 二字（照预览页的写法）。 */
const ICON_COPY =
  '<svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">' +
  '<rect x="6.4" y="1.6" width="8.8" height="10.6" rx="2.2" stroke="currentColor" stroke-width="1.5"/>' +
  '<rect x="2.6" y="5" width="8.8" height="10.6" rx="2.2" fill="var(--dsw-alias-bg-layer-2)" stroke="currentColor" stroke-width="1.5"/>' +
  '<text x="7" y="12.9" font-size="6" font-weight="600" fill="currentColor" text-anchor="middle" font-family="inherit">id</text></svg>';

/** 复制成功后 1.5 秒内替换上去的对勾。 */
const ICON_CHECK =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';

/** 虚化问号：16×16 圆形描边，内嵌一个问号字。 */
const ICON_HELP =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.5"/>' +
  '<text x="8" y="11.3" font-size="8.4" font-weight="500" fill="currentColor" text-anchor="middle" font-family="inherit">?</text></svg>';

/** 折叠区的右向小箭头，展开时由样式转 90°。 */
const ICON_CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>';

/** The settings section component. */
function ContextZipSection(props) {
  const { close, ctx } = props ?? {};
  const strings = useStrings();
  // 只给「压缩后端」那一行用：已生效副行里版本与时间之间的那个逗号，中文全角、英文半角。
  const locale = React.useContext(LocaleContext);
  const [state, setState] = React.useState<SettingsState>({
    status: 'loading',
    value: null,
    effective: null,
    titles: {},
  });
  /**
   * 本地草稿：面板上所有控件都只改它，点标题行的保存按钮才整份 POST 一次。
   *
   * `null` 表示还没读到服务端值。读成功后它先是服务端那一份的同一个对象，控件改
   * 的时候才换成新对象——所以「草稿与服务端相同」可以直接比对内容，见
   * {@link sameSettings}。
   */
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null);
  /** 保存按钮当下的脸；`saved` / `failed` 由定时器收回 `idle`。 */
  const [savePhase, setSavePhase] = React.useState<SavePhase>('idle');
  /**
   * 分段查看那一格的目标会话号。
   *
   * **初值取页面上当前选中的会话**（2026.09.19 用户报「为什么还要我手动输入会话号」）。
   * 设置面板是 root scope 的座位、宿主不传会话号，但 `sessions` 服务是全局可读的。
   * 既然拿得到，就没有理由让用户手打自己正在其中的那个会话号。取不到时留空，行为与从前一致。
   */
  const [sessionId, setSessionId] = React.useState(() => currentSessionId(ctx));
  const [segments, setSegments] = React.useState(null);
  // 模型清单。`idle` 表示还没读过——只有开关打开时才去读，关着的时候一次请求都不发。
  const [catalog, setCatalog] = React.useState<ModelCatalog>({ status: 'idle', providers: [], failures: [] });
  /**
   * 轮询的健康度：连续失败次数，以及最后一次读成功是几点。
   *
   * 单独一个 state，不塞进 `state`：失败时一个字段都不该动到用户正在编辑的东西，
   * 也不该盖掉「已保存」这类主动反馈。`lastOk` 初值取挂载时刻，因为面板能渲染出
   * 这一行，说明挂载那次整份读已经成功了。
   *
   * 2026.09.19 F11 裁决：实时计数的渲染位已撤，这份健康度暂时没有渲染点，轮询本身
   * 按裁决保留，暂不删除。
   */
  const [liveHealth, setLiveHealth] = React.useState(() => initialLiveHealth(Date.now()));
  /**
   * 压缩后端那一行的原始读数：压缩那一行有没有真的由本插件接管。
   *
   * 与设置值分开一个 state，因为它不是设置：它描述的是 profile 里那份重定向包在不在，
   * 而那份包由服务器写文件决定，不由 `settings.yaml` 决定。**存的是载荷本身**，不是
   * 算好的脸：九态的判定要同时看这份载荷与下面那个动作位，两者任一变化都要重算，所以
   * 判定放在渲染处由 `wireStatusFrom` 现算（`client/live.ts`）。「等待重启」也不再问
   * `/live` 的 `effective`：它比的是这份载荷里的 `copiedAt` 与 `processStartedAt`，
   * 所以这一行不需要为它多发一个请求。
   *
   * `null` 表示这一次面板打开还没读到答案，界面上是「读取中」那一态。
   */
  const [wire, setWire] = React.useState(null);
  /**
   * 接管动作自己的状态，与读数分开。
   *
   * `'taking'` 是接管请求已经发出、还没回来；`'failed'` 是那次请求被服务端拒了或网络层
   * 失败，原因原样存在载荷的 `error` 里。两者都不是读数能表达的事实，所以由面板自己记；
   * 读数成功回来后清成 `null`。
   *
   * 发请求前会把载荷里的 `wired` 乐观置真：判定顺序里「未生效」排在「接管中」前面
   * （见 `wireStatusFrom` 的说明），不乐观置真就永远读不到「正在接管」这一态。
   */
  const [wireAction, setWireAction] = React.useState(null);
  /**
   * 两组只读列表各自的显示条数：默认 10，每点一次「显示更多」加 10，可重复。
   *
   * 总条数不超过 10 时按钮不渲染；状态只活在本次面板打开期内——关掉再进是重挂载，
   * 初值又回到 10（用户 2026.09.19 定，明确不落盘）。
   */
  const [agentsLimit, setAgentsLimit] = React.useState(LIST_PAGE);
  const [retrievalLimit, setRetrievalLimit] = React.useState(LIST_PAGE);
  /** 「实验与排障」折叠区默认收起。 */
  const [experimentOpen, setExperimentOpen] = React.useState(false);
  /** 问号气泡：同时只开一个，值是 `'wire'` / `'fallback'` / `'rewrite'` / `null`。 */
  const [help, setHelp] = React.useState(null);
  /** 刚复制成功的那一行 id；1.5 秒后清掉，图标从对勾回到复制形。 */
  const [copiedId, setCopiedId] = React.useState(null);
  /** 行内「已复制 / 复制失败」气泡：文字加锚点坐标，宽度在 effect 里量到之后再定位。 */
  const [tip, setTip] = React.useState(null);
  const bubbleRef = React.useRef(null);
  const tipRef = React.useRef(null);
  const helpWireRef = React.useRef(null);
  const helpFallbackRef = React.useRef(null);
  const helpRewriteRef = React.useRef(null);
  const tipTimer = React.useRef(null);
  const checkTimer = React.useRef(null);
  const saveTimer = React.useRef(null);

  /**
   * 面板开着时自动跟随活会话数。
   *
   * **只取 `effective`，不整份重取设置**：整份重取会把用户正在编辑的东西覆盖掉。
   *
   * **网络层也只取 `effective`**：走 `/live` 那条轻路由，它不回设置值。
   *
   * **失败不再完全静默**：连续失败时记一笔健康度，读到一次成功就撤掉。失败不改
   * `value`、不碰草稿，也不动保存按钮的脸，所以用户正在看的东西与主动反馈都不受
   * 影响。
   *
   * **切回前台补一次**：标签页切到后台之后，Chrome 会把 5 秒的定时器压到几十秒
   * 甚至一分钟一次，这段时间里数字在悄悄过期而界面一切正常。后台节流是浏览器的
   * 省电行为、不是故障，所以这里不试图在后台跑满周期，只在页面重新可见的那一刻
   * 多读一次。判定、挂载与去重放在 `startLivePoll` 里。
   *
   * 定时器在卸载时清掉，所以面板一关就不再有请求。
   */
  React.useEffect(() => {
    let cancelled = false;
    const read = async () => {
      let healthy = false;
      try {
        const response = await fetch(LIVE_ROUTE);
        const data = await response.json();
        if (cancelled) return;
        healthy = data?.ok === true;
        if (!healthy) return;
        // 只并 effective 与 titles，其余字段原样保留。titles 是后到的那份：首次
        // `/settings` 只答备忘录里已经有的名字，折叠在响应之后才跑，而这一跳是面板
        // 开着时唯一还在问的请求，晚到的名字从这里进界面。
        setState((previous) => mergeLivePayload(previous, data));
      } catch {
        // 网络层失败和 `ok: false` 一样，都只记一次失败：下一次还有机会，报错不该
        // 盖掉用户正在看的界面。
      } finally {
        if (!cancelled) setLiveHealth((previous) => liveHealthAfter(previous, healthy, Date.now()));
      }
    };
    const stop = startLivePoll({
      read,
      intervalMs: LIVE_POLL_MS,
      doc: document,
      setTimer: setInterval,
      clearTimer: clearInterval,
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(SETTINGS_ROUTE);
        const data = await response.json();
        if (cancelled) return;
        if (data?.ok !== true) throw new Error(data?.error ?? 'unavailable');
        const stored = data.value ?? {};
        setState({
          status: 'ready',
          value: stored,
          effective: data.effective ?? null,
          titles: titlesFrom(data.titles),
        });
        // 草稿从服务端这一份起步；控件之后只换新对象，不原地改。
        setDraft(stored);
      } catch {
        if (!cancelled) {
          setState({ status: 'error', value: null, effective: null, titles: {} });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 读一次压缩后端的接管状态。
   *
   * 只读一次，不进轮询：接管状态在一次面板打开期内不会自己变化——写它的只有那颗按钮，
   * 而按钮自己会把答案放进同一个 state。这条读也被「状态未知」那一态的「重试」用：
   * 那说明上一次没读到，再读一次就是它唯一能做的事。
   *
   * 失败（网络层抛错或 `ok: false`）都落成一份 `ok: false` 的载荷，九态判定把它读成
   * 「状态未知」，不假装「未生效」——那会让用户点一颗注定失败的按钮。失败的具体原因不在
   * 这一行显示（未知态的副行是「刚才没有读到」），下一次读有机会拿到真答案。
   */
  const readWire = React.useCallback(async () => {
    try {
      const data = await fetch(WIRE_ROUTE).then((response) => response.json());
      setWire(data);
    } catch (error) {
      setWire({ ok: false, error: String(error?.message ?? error) });
    }
  }, []);

  React.useEffect(() => {
    void readWire();
  }, [readWire]);

  /**
   * 按下「接管」：POST 一次，把压缩那一行接到本插件。
   *
   * 面板只负责发这一次请求与显示答案：写什么文件、写进哪个 profile、目标被别人占着怎么办，
   * 全在宿主侧的 `/dsh-context-zip/wire`。成功后**不重启**任何东西——重启必须由用户手动做，
   * 所以「下次启动时生效」是文字，不是插件从进程内重启。
   *
   * 发请求前把载荷乐观置成已接管、并挂上 `'taking'`：九态的判定顺序里「未生效」在
   * 「接管中」前面（见 `wireStatusFrom`），不乐观置真，按钮按下去界面会停在未生效。
   * 请求回来无论成功载荷还是拒绝原因都盖掉这份乐观值；拒绝原因原样存在载荷的 `error` 里，
   * 「接管失败」的副行只印它。
   */
  const wireRow = React.useCallback(async () => {
    setWireAction('taking');
    setWire((current) => ({ ...(current ?? {}), ok: true, wired: true, foreign: false, partial: false }));
    try {
      const response = await fetch(WIRE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (data?.ok === true && data.wired === true) {
        setWire(data);
        setWireAction(null);
        return;
      }
      setWire((current) => ({ ...(current ?? {}), ok: true, wired: true, error: String(data?.error ?? 'unavailable') }));
      setWireAction('failed');
    } catch (error) {
      setWire((current) => ({ ...(current ?? {}), ok: true, wired: true, error: String(error?.message ?? error) }));
      setWireAction('failed');
    }
  }, []);

  /**
   * 读一次注册表里的模型清单。
   *
   * 每次打开面板、以及每次把格式改写开关拨到打开时读一次，读的是宿主侧的
   * `/dsh-context-zip/models`，那条路由直接问活的 `ctx.llm`。这样面板里的清单与
   * 实际能用的路由不会各说各话，也不需要在插件里维护第二份清单。
   */
  const loadCatalog = React.useCallback(async () => {
    setCatalog((current) => ({ ...current, status: 'loading' }));
    try {
      const data = await fetch(MODELS_ROUTE).then((response) => response.json());
      if (data?.ok !== true) throw new Error(data?.error ?? 'unavailable');
      setCatalog({ status: 'ready', providers: data.providers ?? [], failures: data.failures ?? [] });
    } catch (error) {
      setCatalog({ status: 'error', providers: [], failures: [], message: String(error?.message ?? error) });
    }
  }, []);

  /**
   * 问号气泡的定位。
   *
   * `position: fixed`、坐标按问号当下的 `getBoundingClientRect()` 现算：宿主的内容区
   * 是 `overflow-y: auto` 的滚动容器，`absolute` 会被它裁掉。翻转与钳制的算式在
   * `helpBubblePlacement`（`live.ts`），那里能单测。滚动监听走捕获阶段，因为元素的
   * `scroll` 事件不冒泡，而面板不知道自己被塞进哪个滚动容器。
   */
  React.useEffect(() => {
    if (help === null) return void 0;
    const anchor =
      help === 'fallback'
        ? helpFallbackRef.current
        : help === 'rewrite'
          ? helpRewriteRef.current
          : helpWireRef.current;
    const bubble = bubbleRef.current;
    if (anchor === null || bubble === null) return void 0;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const at = helpBubblePlacement(
        { top: rect.top, right: rect.right, bottom: rect.bottom },
        { width: window.innerWidth, height: window.innerHeight },
        { width: BUBBLE_WIDTH, height: bubble.offsetHeight },
      );
      bubble.style.left = `${at.left}px`;
      bubble.style.top = `${at.top}px`;
      bubble.style.width = `${at.width}px`;
    };
    anchor.scrollIntoView?.({ block: 'nearest' });
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [help]);

  /**
   * 点气泡外或按 Esc 关掉气泡。
   *
   * 点在问号上不算「外部」：那个问号自己的 click 负责开关或换一个，这里不抢。
   */
  React.useEffect(() => {
    if (help === null) return void 0;
    const onPointer = (event) => {
      const bubble = bubbleRef.current;
      if (bubble !== null && bubble.contains(event.target)) return;
      let node = event.target;
      while (node !== null && node !== void 0 && node !== document.body) {
        if (node.classList?.contains?.('dsh-context-zip__help')) return;
        node = node.parentNode;
      }
      setHelp(null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setHelp(null);
    };
    document.addEventListener('click', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [help]);

  /** 行内气泡的定位：量到宽度之后再钳进视口，靠下沿时翻到按钮上方。 */
  React.useEffect(() => {
    if (tip === null) return void 0;
    const node = tipRef.current;
    if (node === null) return void 0;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const left = Math.min(Math.max(12, tip.anchorLeft - width / 2), window.innerWidth - width - 12);
    let top = tip.anchorBottom + 6;
    if (top + height > window.innerHeight - 12) top = tip.anchorTop - height - 6;
    node.style.left = `${left}px`;
    node.style.top = `${Math.max(12, top)}px`;
  }, [tip]);

  /** 卸载时把三颗反馈定时器清掉，别让它们在面板关掉之后再改状态。 */
  React.useEffect(
    () => () => {
      if (tipTimer.current !== null) clearTimeout(tipTimer.current);
      if (checkTimer.current !== null) clearTimeout(checkTimer.current);
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );

  /**
   * 把按钮切到一张脸。
   *
   * `saved` / `failed` 是短暂反馈，各停 {@link SAVE_FEEDBACK_MS} 后收回 `idle`；
   * `saving` 不设闹钟，它由写入落地时那一次 `flashSave('saved' | 'failed')` 结束。
   * 若给 `saving` 也设 1.5 秒闹钟，一次慢于 1.5 秒的写入会在它还在飞的时候把按钮
   * 变回可点，用户再点一下就发出第二个 POST。
   */
  const flashSave = React.useCallback((next: SavePhase) => {
    setSavePhase(next);
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = next === 'saving' ? null : setTimeout(() => setSavePhase('idle'), SAVE_FEEDBACK_MS);
  }, []);

  /**
   * 保存这份草稿：整份设置 POST 一次，成功后把草稿对齐到服务端答案。
   *
   * 「改写用的模型」那一次探活在宿主侧：写路由拿到整份设置后自己比对
   * `rewriteEnabled / rewriteProvider / rewriteModel` 有没有真的改，
   * 改了才发一次最小请求，探不通就拒绝整次保存。面板这边只负责把整份草稿发过去，
   * 不在浏览器里重做第二份判定。
   */
  const saveDraft = React.useCallback(async () => {
    if (draft === null) return;
    setState((current) => ({ ...current, status: 'saving' }));
    flashSave('saving');
    try {
      const response = await fetch(UPDATE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (data?.ok !== true) throw new Error(data?.error ?? 'rejected');
      // The write route answers with the new value but not the effective view,
      // so the line is refreshed from the read route right after a save.
      const refreshed = await fetch(SETTINGS_ROUTE)
        .then((answer) => answer.json())
        .catch(() => null);
      const stored = data.value ?? {};
      // Written through the updater so the fallback sees the CURRENT state: the
      // settings read is not re-issued here, so a closed-over `state` would be a
      // frame behind and its missing `effective` would blank the line.
      setState((current) => ({
        status: 'ready',
        value: stored,
        effective: refreshed?.ok === true ? (refreshed.effective ?? null) : current.effective,
        titles: refreshed?.ok === true ? titlesFrom(refreshed.titles) : current.titles,
      }));
      // 草稿对齐到服务端刚存下的那一份，于是它与服务端相等、保存按钮回到置灰。
      setDraft(stored);
      flashSave('saved');
    } catch {
      setState((current) => ({ ...current, status: 'ready' }));
      flashSave('failed');
    }
  }, [draft, flashSave]);

  /** 控件改草稿：整份换成一个新对象，不原地改，脏净比对才靠得住。 */
  const editDraft = React.useCallback((change) => {
    setDraft((current) => ({ ...(current ?? {}), ...change }));
  }, []);

  const loaded = state.value !== null;
  /** 面板上所有控件读的是这份草稿，不是服务端值。 */
  const value = draft ?? {};
  const busy = state.status === 'saving';
  /** 草稿与服务端最后一次读到的值不同，才算「有东西要存」。 */
  const dirty = loaded && draft !== null && sameSettings(state.value, draft) === false;
  const saveFace = saveButtonFace(savePhase);
  const canSave = saveButtonEnabled(dirty, savePhase, loaded);
  /** 总开关：`enabled` 为真就是本插件压。分段控件只是把这个布尔换了个形态。 */
  const pluginOn = value.enabled === true;

  /**
   * 开关一打开就把清单读回来。
   *
   * `status === 'idle'` 是防重入的闸：读到之后不再重复读，但把开关关掉再打开也不会
   * 重读——要刷新清单，重开面板即可。这条写进了功能文档。
   */
  React.useEffect(() => {
    if (value.rewriteEnabled !== true) return;
    if (catalog.status !== 'idle') return;
    void loadCatalog();
  }, [catalog.status, loadCatalog, value.rewriteEnabled]);

  const toggleFallback = (event) => {
    editDraft({ fallbackEnabled: event.target.checked });
  };

  const toggleRewrite = (event) => {
    editDraft({ rewriteEnabled: event.target.checked });
  };

  const toggleThrottle = (event) => {
    editDraft({ throttle: event.target.checked });
  };

  /**
   * 换来源要把模型清掉。
   *
   * provider 与 model 是一条路由的两半，旧 provider 下选的模型名对新 provider 没有
   * 意义。清掉之后草稿里这条路由不完整，这次保存也就不会触发探活；等模型也选好，
   * 那次保存才探。
   */
  const chooseRewriteProvider = (event) => {
    editDraft({ rewriteProvider: event.target.value, rewriteModel: '' });
  };

  const chooseRewriteModel = (event) => {
    editDraft({ rewriteModel: event.target.value });
  };

  /**
   * 只接受阿拉伯数字字符：先剥掉非数字，再夹到 0–10。
   *
   * **空串要当成「用默认值」而不是 0**，否则用户清空输入框的一瞬间就会被存成 0，
   * 而 0 的含义是「第一次失败立刻兜底」，与「我没填」相差很远。
   */
  const setFallbackAfter = (event) => {
    const digits = String(event.target.value).replace(/[^0-9]/g, '');
    if (digits === '') return;
    const clamped = Math.min(10, Math.max(0, Number(digits)));
    editDraft({ fallbackAfterFailures: clamped });
  };

  /**
   * 列出某个会话的分段。不传目标时读输入框，空串直接返回、一次请求都不发。
   *
   * @param target - 调用方给定的会话号；省略时用输入框里的值。
   */
  const querySegments = async (target?: string) => {
    const id = (typeof target === 'string' ? target : sessionId).trim();
    if (id.length === 0) return;
    try {
      const response = await fetch(`${SEGMENTS_ROUTE}?sessionId=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (data?.ok !== true) throw new Error(data?.error ?? 'unavailable');
      setSegments({ ok: true, lines: data.lines ?? [] });
    } catch (error) {
      setSegments({ ok: false, lines: [String(error?.message ?? error)] });
    }
  };

  /**
   * 「列出分段」/「收起信息」：同一颗按钮随展开态换字，`aria-expanded` 同步。
   *
   * 展开态就是「这一格有内容要显示」，也就是 `segments !== null`。
   */
  const toggleSegments = () => {
    if (segments !== null) {
      setSegments(null);
      return;
    }
    void querySegments();
  };

  /**
   * 复制一行的会话 id，并给出两种反馈。
   *
   * 成功时图标变对勾、旁边出「已复制」，两样都 1.5 秒后收回；剪贴板不可用时只出
   * 「复制失败」（用户定：两种反馈都要）。`navigator.clipboard` 在没有安全上下文或
   * 没有权限时会整条不存在，所以留一条离屏 `textarea` 的 `document.execCommand('copy')`
   * 兜底通道，顺序与预览页相同。
   */
  const copyId = (id, button) => {
    const showTip = (text) => {
      const rect = button.getBoundingClientRect();
      setTip({ text, anchorLeft: rect.left + rect.width / 2, anchorTop: rect.top, anchorBottom: rect.bottom });
      if (tipTimer.current !== null) clearTimeout(tipTimer.current);
      tipTimer.current = setTimeout(() => setTip(null), FEEDBACK_MS);
    };
    const settle = (ok) => {
      if (ok) {
        setCopiedId(id);
        if (checkTimer.current !== null) clearTimeout(checkTimer.current);
        checkTimer.current = setTimeout(() => setCopiedId(null), FEEDBACK_MS);
      }
      showTip(ok ? strings.copied : strings.copyFailed);
    };
    if (navigator.clipboard !== void 0 && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(id).then(
        () => settle(true),
        () => settle(false),
      );
      return;
    }
    try {
      const scratch = document.createElement('textarea');
      scratch.value = id;
      scratch.setAttribute('readonly', '');
      scratch.className = 'dsh-context-zip__offscreen';
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(scratch);
      settle(ok === true);
    } catch {
      settle(false);
    }
  };

  /** 一档取值标签的文案，取值来自 schema 的 `retrieval` 联合。 */
  const retrievalText = (presentation) =>
    presentation === 'batched'
      ? strings.retrievalBatched
      : presentation === 'batched-only'
        ? strings.retrievalBatchedOnly
        : strings.retrievalGranular;

  /** 一条只读行：会话名（取不到显示完整会话号）+ 可选取值标签 + 复制按钮。 */
  const renderSessionRow = (id, presentation) => {
    const title = typeof state.titles[id] === 'string' ? state.titles[id] : '';
    const named = title.length > 0;
    const children: any[] = [
      React.createElement(
        'span',
        {
          key: 'name',
          className: `dsh-context-zip__srow-name${named ? '' : ' dsh-context-zip__srow-name--id'}`,
          title: named ? id : void 0,
        },
        named ? title : id,
      ),
    ];
    if (typeof presentation === 'string' && presentation.length > 0) {
      children.push(
        React.createElement('span', { key: 'tag', className: 'dsh-context-zip__srow-tag' }, retrievalText(presentation)),
      );
    }
    children.push(
      React.createElement('button', {
        key: 'copy',
        type: 'button',
        className: 'dsh-context-zip__copy',
        'aria-label': strings.copySessionId,
        onClick: (event) => copyId(id, event.currentTarget),
        dangerouslySetInnerHTML: { __html: copiedId === id ? ICON_CHECK : ICON_COPY },
      }),
    );
    return React.createElement('div', { className: 'dsh-context-zip__srow', key: `srow-${id}` }, ...children);
  };

  /** 只读列表的内容：空态一行「无」，否则前 limit 条。「显示更多」由调用方另画。 */
  const renderList = (entries, limit) => {
    if (entries.length === 0) {
      return [React.createElement('div', { className: 'dsh-context-zip__empty', key: 'empty' }, strings.emptyList)];
    }
    return entries.slice(0, Math.min(limit, entries.length)).map((entry) => renderSessionRow(entry.id, entry.presentation));
  };

  /** 「显示更多」：总条数不超过当前上限时不渲染。 */
  const renderMore = (entries, limit, onMore) =>
    React.createElement(
      'div',
      { className: 'dsh-context-zip__more' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-context-zip__btn dsh-context-zip__btn--flush',
          hidden: entries.length <= limit,
          onClick: onMore,
        },
        strings.showMore,
      ),
    );

  /** 一行分段控件。`aria-labelledby` 指向这一行自己的标签。 */
  const renderSegRow = (labelId, label, options, current, onPick) =>
    React.createElement(
      'div',
      { className: 'dsh-context-zip__row' },
      React.createElement('span', { className: 'dsh-context-zip__row-label', id: labelId }, label),
      React.createElement(
        'div',
        { className: 'dsh-context-zip__row-ctl' },
        React.createElement(
          'div',
          { className: 'dsh-context-zip__seg', role: 'group', 'aria-labelledby': labelId },
          ...options.map((option) =>
            React.createElement(
              'button',
              {
                key: option.value,
                type: 'button',
                className: 'dsh-context-zip__seg-btn',
                'aria-pressed': current === option.value ? 'true' : 'false',
                disabled: busy,
                onClick: () => onPick(option.value),
              },
              option.label,
            ),
          ),
        ),
      ),
    );

  /** 一行开关，可带一颗虚化问号。 */
  const renderSwitchRow = (rowId, label, checked, onChange, helpKey, helpLabel) =>
    React.createElement(
      'div',
      { className: 'dsh-context-zip__row' },
      React.createElement('span', { className: 'dsh-context-zip__row-label', id: `${rowId}-label` }, label),
      React.createElement(
        'div',
        { className: 'dsh-context-zip__row-ctl' },
        React.createElement(
          'label',
          { className: 'dsh-context-zip__sw' },
          React.createElement('input', {
            type: 'checkbox',
            checked,
            disabled: busy,
            'aria-labelledby': `${rowId}-label`,
            onChange,
          }),
          React.createElement('span', { className: 'dsh-context-zip__sw-track' }),
          React.createElement('span', { className: 'dsh-context-zip__sw-knob' }),
        ),
        helpKey === void 0
          ? null
          : React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-context-zip__help',
                ref: helpKey === 'fallback' ? helpFallbackRef : helpRewriteRef,
                'aria-label': helpLabel,
                'aria-expanded': help === helpKey ? 'true' : 'false',
                'aria-describedby': `dsh-context-zip-help-${helpKey}`,
                onClick: (event) => {
                  event.stopPropagation();
                  setHelp((open) => (open === helpKey ? null : helpKey));
                },
              },
              React.createElement('span', { dangerouslySetInnerHTML: { __html: ICON_HELP } }),
            ),
      ),
    );

  /**
   * 「压缩后端」这一行：左标题（含问号气泡）、中主副行、右按钮，是「压缩方式」组的第一行。
   *
   * 结构固定三样：标题在最左，主行加副行占中间（状态点带在主行行首），按钮贴最右。按钮的
   * 右缘与同一组里分段控件的右缘对齐——两者都是所在行最后一个伸缩项，行宽相同，所以对齐由
   * 布局本身保证，不靠额外定位。
   *
   * 状态由 `wireStatusFrom` 现算：它要同时看这份载荷与动作位，两者任一变化都要重算；
   * 「等待重启」的正向证据是载荷里的 `copiedAt` 与 `processStartedAt`，不再读 `/live` 的
   * `effective`。文字、按钮标签与按钮的有无由 `wireText` 拼，点的脸由 `wireFace`
   * 决定（都在 `client/live.ts`，无 react 依赖、可单测），样式表只按 `data-face` 上色换形状。
   *
   * 按钮的缺席是规格的一部分：已生效、等待重启、被占用三态没有可做的事，`action` 为空串，
   * 按钮整个不渲染；行本身常驻，主副行照旧，所以行高与有按钮时一致。接管在飞时按钮禁用，
   * 防同一次接管发两次 POST。
   */
  const renderWireRow = () => {
    const status = wire === null ? 'loading' : wireStatusFrom(wire, wireAction);
    const face = wireFace(status);
    const copy = wireText(status, wire, strings, locale);
    const busyNow = status === 'taking';
    // 未知态的按钮是重读，其余有按钮的态都是重写；两条落点见 `readWire` 与 `wireRow`。
    const click = status === 'unknown' ? () => void readWire() : () => void wireRow();
    return React.createElement(
      'div',
      { className: 'dsh-context-zip__wire', 'data-status': status, 'data-face': face, 'aria-busy': busyNow ? 'true' : 'false' },
      React.createElement(
        'span',
        { className: 'dsh-context-zip__wire-title' },
        React.createElement('span', { className: 'dsh-context-zip__row-label' }, strings.rowTitle),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-context-zip__help',
            ref: helpWireRef,
            'aria-label': strings.help,
            'aria-expanded': help === 'wire' ? 'true' : 'false',
            'aria-describedby': 'dsh-context-zip-help-wire',
            onClick: (event) => {
              event.stopPropagation();
              setHelp((open) => (open === 'wire' ? null : 'wire'));
            },
          },
          React.createElement('span', { dangerouslySetInnerHTML: { __html: ICON_HELP } }),
        ),
      ),
      React.createElement(
        'span',
        { className: 'dsh-context-zip__wire-body', role: 'status', 'aria-live': 'polite' },
        React.createElement(
          'span',
          { className: 'dsh-context-zip__wire-main' },
          React.createElement('span', { className: 'dsh-context-zip__wire-dot', 'data-face': face, 'aria-hidden': 'true' }),
          React.createElement('span', { className: 'dsh-context-zip__wire-main-text' }, copy.main),
        ),
        React.createElement('span', { className: 'dsh-context-zip__wire-sub' }, copy.sub),
      ),
      copy.action === ''
        ? null
        : React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-context-zip__btn dsh-context-zip__btn--outline dsh-context-zip__wire-btn',
              disabled: busyNow,
              onClick: click,
            },
            copy.action,
          ),
    );
  };

  /**
   * 标题行那颗唯一的保存按钮。
   *
   * 四个脸：`save`（草稿脏了、可点）/ `saving`（写入在飞，禁用）/ `check`（存成功，
   * 复用复制按钮的对勾）/ `failed`（存失败，红底）——后两个各停留
   * {@link SAVE_FEEDBACK_MS}，然后自己回到「保存」。草稿与服务端相同时禁用且置灰，
   * 因为没有任何东西可存。可点性只由 `saveButtonEnabled` 判定；配色与置灰放在样式
   * 表的 `data-face` 与 `:disabled` 上。
   */
  const saveButton = () => {
    const label = saveFace === 'saving' ? strings.saving : saveFace === 'failed' ? strings.saveFailed : strings.saveAction;
    const props = {
      type: 'button',
      className: 'dsh-context-zip__save',
      'data-face': saveFace,
      disabled: canSave === false,
      'aria-label': saveFace === 'check' ? strings.saved : label,
      onClick: () => void saveDraft(),
    };
    // 勾用内联 SVG，和复制按钮同一枚图标；成功那 1.5 秒里按钮没有文字。
    if (saveFace === 'check') {
      return React.createElement('button', { ...props, dangerouslySetInnerHTML: { __html: ICON_CHECK } });
    }
    return React.createElement('button', props, label);
  };

  /**
   * 重排用的两档下拉框：来源与模型。
   *
   * 已保存但**不在当前清单里**的值会被补成一个带「（不在注册表里）」字样的选项。
   * 不这么做的话，一个被卸载的 adapter 会让下拉框显示「未选择」，而设置里其实还
   * 存着那条路由：界面与存储不一致，用户会以为没配过。
   */
  const rewritePickers = () => {
    const provider = String(value.rewriteProvider ?? '');
    const model = String(value.rewriteModel ?? '');
    const providers = [...(catalog.providers ?? [])];
    if (provider.length > 0 && !providers.some((entry) => entry.id === provider)) {
      providers.unshift({ id: provider, name: `${provider} ${strings.rewriteGone}`, models: [] });
    }
    const modelOptions = [...(providers.find((entry) => entry.id === provider)?.models ?? [])];
    if (model.length > 0 && !modelOptions.some((entry) => entry.id === model)) {
      modelOptions.unshift({ id: model, name: `${model} ${strings.rewriteGone}` });
    }
    const picker = (label, current, options, onChange) =>
      React.createElement(
        'select',
        { className: 'dsh-context-zip__select', value: current, disabled: busy, 'aria-label': label, onChange },
        React.createElement('option', { value: '' }, strings.rewriteUnset),
        ...options.map((option) =>
          React.createElement('option', { key: option.id, value: option.id }, option.name || option.id),
        ),
      );
    return [
      picker(strings.rewriteProvider, provider, providers, chooseRewriteProvider),
      picker(strings.rewriteModel, model, modelOptions, chooseRewriteModel),
    ];
  };

  /**
   * 模型清单读不到时的那几行状态。
   *
   * 面板不写说明段落，但「读不到清单」与「清单是空的」必须说出来：不说的话，下拉框
   * 看起来只是没得选。
   */
  const rewriteStatus = () => {
    const lines = [];
    if (catalog.status === 'idle' || catalog.status === 'loading') {
      lines.push(React.createElement('p', { className: 'dsh-context-zip__hint', key: 'loading' }, strings.rewriteCatalogLoading));
    }
    if (catalog.status === 'error') {
      lines.push(
        React.createElement(
          'p',
          { className: 'dsh-context-zip__hint', key: 'error' },
          `${strings.rewriteCatalogFailed}: ${catalog.message ?? ''}`,
        ),
      );
    }
    if (catalog.status === 'ready' && (catalog.providers ?? []).length === 0) {
      lines.push(React.createElement('p', { className: 'dsh-context-zip__hint', key: 'empty' }, strings.rewriteCatalogEmpty));
    }
    if ((catalog.failures ?? []).length > 0) {
      lines.push(
        React.createElement(
          'p',
          { className: 'dsh-context-zip__hint', key: 'failures' },
          strings.rewriteCatalogFailures((catalog.failures ?? []).map((entry) => entry.id).join(', ')),
        ),
      );
    }
    return lines;
  };

  /** 「已生效会话」的行：`agents` 表里键形如会话号的那些，预设名形态的不显示。 */
  const agentEntries = toRows(asTable(value.agents))
    .map((row) => row.key)
    .filter((key) => isSessionKey(key))
    .map((key) => ({ id: key }));

  /** 「检索覆盖」的行：`retrievalAgents` 里同一套键形的那些，行上多一档取值标签。 */
  const retrievalEntries = Object.entries(asTable(value.retrievalAgents))
    .filter(([key]) => isSessionKey(key))
    .map(([key, presentation]) => ({ id: key, presentation: String(presentation ?? '') }));

  /** 面板根的子节点，按预览页的分组顺序拼起来。 */
  const children: any[] = [
    // 大标题与唯一的保存按钮同一行，按钮靠最右（`.dsh-context-zip__title` 的类名与
    // 文本有判据盯着，不能动；这里只把两者放进同一个容器）。
    React.createElement(
      'div',
      { className: 'dsh-context-zip__title-row', key: 'title' },
      React.createElement('span', { className: 'dsh-context-zip__title' }, strings.title),
      saveButton(),
    ),
  ];
  if (state.status === 'loading') {
    children.push(React.createElement('p', { key: 'loading' }, strings.loading));
  }
  if (state.status === 'error' && state.value === null) {
    children.push(React.createElement('p', { className: 'dsh-context-zip__error', key: 'error' }, strings.loadFailed));
  }

  if (state.value !== null) {
    // ── 压缩方式 + 已生效会话 ─────────────────────────────────────────────────
    children.push(
      React.createElement(
        'section',
        { className: 'dsh-context-zip__group', key: 'method' },
        React.createElement('h2', { className: 'dsh-context-zip__hd' }, strings.groupMethod),
        React.createElement(
          'div',
          { className: 'dsh-context-zip__rows' },
          // 压缩后端那一行是这一组的第一行，排在「新建会话默认压缩方式」上面：先回答
          // 「压缩那一行被本插件接管了没有」，再回答「选谁压」。`dsh plugin add` 装出来的
          // profile 正好是「选得了、没接管」，把它放下面会让只扫第一行的人以为已经生效。
          renderWireRow(),
          renderSegRow(
            'dsh-context-zip-method',
            strings.methodLabel,
            [
              { value: 'plugin', label: strings.methodPlugin },
              { value: 'default', label: strings.methodDefault },
            ],
            pluginOn ? 'plugin' : 'default',
            (which) => {
              setHelp(null);
              editDraft({ enabled: which === 'plugin' });
            },
          ),
        ),
        React.createElement(
          'h3',
          { className: 'dsh-context-zip__sub', id: 'dsh-context-zip-agents' },
          strings.agentsSection,
        ),
        React.createElement(
          'div',
          { className: 'dsh-context-zip__list', 'aria-live': 'polite', 'aria-labelledby': 'dsh-context-zip-agents' },
          ...renderList(agentEntries, agentsLimit),
        ),
        renderMore(agentEntries, agentsLimit, () => setAgentsLimit((current) => current + LIST_PAGE)),
      ),
    );

    // ── 摘要兜底与摘要重排：选「内置后端」时整组不出现 ──────────────────────
    if (pluginOn) {
      children.push(
        React.createElement(
          'section',
          { className: 'dsh-context-zip__group', key: 'fallback' },
          React.createElement('h2', { className: 'dsh-context-zip__hd' }, strings.groupFallback),
          React.createElement(
            'div',
            { className: 'dsh-context-zip__rows' },
            renderSwitchRow(
              'dsh-context-zip-fallback',
              strings.fallbackRowLabel,
              value.fallbackEnabled === true,
              toggleFallback,
              'fallback',
              strings.fallbackHintLabel,
            ),
            value.fallbackEnabled === true
              ? React.createElement(
                  'div',
                  { className: 'dsh-context-zip__row' },
                  React.createElement('span', { className: 'dsh-context-zip__row-label' }, strings.fallbackAfterLabel),
                  React.createElement(
                    'div',
                    { className: 'dsh-context-zip__row-ctl' },
                    React.createElement('input', {
                      className: 'dsh-context-zip__input dsh-context-zip__input--num',
                      type: 'text',
                      inputMode: 'numeric',
                      value: String(value.fallbackAfterFailures ?? 5),
                      disabled: busy,
                      'aria-label': strings.fallbackAfterLabel,
                      onChange: setFallbackAfter,
                    }),
                  ),
                )
              : null,
          ),
        ),
      );

      children.push(
        React.createElement(
          'section',
          { className: 'dsh-context-zip__group', key: 'rewrite' },
          React.createElement('h2', { className: 'dsh-context-zip__hd' }, strings.groupRewrite),
          React.createElement(
            'div',
            { className: 'dsh-context-zip__rows' },
            renderSwitchRow(
              'dsh-context-zip-rewrite',
              strings.rewriteRowLabel,
              value.rewriteEnabled === true,
              toggleRewrite,
              'rewrite',
              strings.rewriteHintLabel,
            ),
            value.rewriteEnabled === true
              ? React.createElement(
                  'div',
                  { className: 'dsh-context-zip__row' },
                  React.createElement('span', { className: 'dsh-context-zip__row-label' }, strings.rewriteModelRowLabel),
                  React.createElement('div', { className: 'dsh-context-zip__row-ctl' }, ...rewritePickers()),
                )
              : null,
          ),
          ...rewriteStatus(),
        ),
      );
    }

    // ── 实验与排障：默认收起，标题带「未验证」标签 ──────────────────────────
    children.push(
      React.createElement(
        'section',
        { className: 'dsh-context-zip__group', key: 'experiment', 'data-open': experimentOpen ? 'true' : 'false' },
        React.createElement(
          'h2',
          { className: 'dsh-context-zip__hd' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-context-zip__hd-btn',
              id: 'dsh-context-zip-exp-toggle',
              'aria-expanded': experimentOpen ? 'true' : 'false',
              'aria-controls': 'dsh-context-zip-exp-body',
              onClick: () => {
                setHelp(null);
                setExperimentOpen((open) => !open);
              },
            },
            strings.groupExperiment,
            React.createElement('span', { className: 'dsh-context-zip__tag' }, strings.groupExperimentTag),
            React.createElement('span', {
              className: 'dsh-context-zip__chev',
              dangerouslySetInnerHTML: { __html: ICON_CHEVRON },
            }),
          ),
        ),
        React.createElement(
          'div',
          { className: 'dsh-context-zip__body', id: 'dsh-context-zip-exp-body' },
          React.createElement(
            'div',
            { className: 'dsh-context-zip__rows' },
            renderSegRow(
              'dsh-context-zip-retrieval',
              strings.retrievalLabel,
              [
                { value: 'granular', label: strings.retrievalGranular },
                { value: 'batched', label: strings.retrievalBatched },
                { value: 'batched-only', label: strings.retrievalBatchedOnly },
              ],
              typeof value.retrieval === 'string' ? value.retrieval : 'granular',
              (which) => editDraft({ retrieval: which }),
            ),
          ),
          React.createElement(
            'h3',
            { className: 'dsh-context-zip__sub', id: 'dsh-context-zip-ret-hd' },
            strings.retrievalSection,
          ),
          React.createElement(
            'div',
            { className: 'dsh-context-zip__list', 'aria-live': 'polite', 'aria-labelledby': 'dsh-context-zip-ret-hd' },
            ...renderList(retrievalEntries, retrievalLimit),
          ),
          renderMore(retrievalEntries, retrievalLimit, () => setRetrievalLimit((current) => current + LIST_PAGE)),
          React.createElement(
            'div',
            { className: 'dsh-context-zip__rows dsh-context-zip__rows--gap' },
            renderSwitchRow(
              'dsh-context-zip-throttle',
              strings.throttleLabel,
              value.throttle === true,
              toggleThrottle,
              void 0,
              void 0,
            ),
            React.createElement(
              'div',
              { className: 'dsh-context-zip__row dsh-context-zip__row--stack' },
              React.createElement(
                'div',
                { className: 'dsh-context-zip__field' },
                React.createElement('span', { className: 'dsh-context-zip__field-label' }, strings.traceLabel),
                React.createElement('input', {
                  className: 'dsh-context-zip__input dsh-context-zip__input--mono dsh-context-zip__input--grow',
                  type: 'text',
                  // 受控于草稿：每敲一个字只改本地草稿，一次写请求都不发；整份设置由
                  // 标题行的保存按钮统一提交。这个输入框保存时也不禁用，禁用一个有焦点
                  // 的元素会把焦点丢到 body，路径一路打字就会断。
                  value: String(value.tracePath ?? ''),
                  placeholder: strings.tracePlaceholder,
                  'aria-label': strings.traceLabel,
                  onChange: (event) => editDraft({ tracePath: event.target.value }),
                }),
              ),
            ),
          ),
        ),
      ),
    );

    // ── 压缩分段：排障工具，置底 ────────────────────────────────────────────
    children.push(
      React.createElement(
        'section',
        { className: 'dsh-context-zip__group', key: 'segments' },
        React.createElement('h2', { className: 'dsh-context-zip__hd' }, strings.groupSegments),
        React.createElement(
          'div',
          { className: 'dsh-context-zip__rows' },
          React.createElement(
            'div',
            { className: 'dsh-context-zip__row dsh-context-zip__row--grow' },
            React.createElement(
              'div',
              { className: 'dsh-context-zip__row-ctl' },
              React.createElement('input', {
                className: 'dsh-context-zip__input dsh-context-zip__input--mono dsh-context-zip__input--grow',
                type: 'text',
                value: sessionId,
                placeholder: strings.segmentsPlaceholder,
                'aria-label': strings.segmentsSessionLabel,
                onChange: (event) => setSessionId(event.target.value),
              }),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-context-zip__btn dsh-context-zip__btn--outline',
                  'aria-expanded': segments === null ? 'false' : 'true',
                  'aria-controls': 'dsh-context-zip-segments',
                  onClick: toggleSegments,
                },
                segments === null ? strings.segmentsQuery : strings.segmentsCollapse,
              ),
            ),
          ),
        ),
        segments === null
          ? null
          : React.createElement(
              'pre',
              { className: 'dsh-context-zip__segments', id: 'dsh-context-zip-segments' },
              segments.lines.length === 0
                ? strings.segmentsEmpty
                : segments.ok
                  ? segments.lines.join('\n')
                  : `${strings.segmentsFailed}: ${segments.lines.join('\n')}`,
            ),
      ),
    );
  }

  // 问号气泡、行内复制气泡，以及两条正式说明的隐藏原文（`aria-describedby` 要指向它们）。
  children.push(
    React.createElement(
      'div',
      {
        className: 'dsh-context-zip__bubble',
        role: 'dialog',
        ref: bubbleRef,
        key: 'bubble',
        'data-show': help === null ? 'false' : 'true',
      },
      help === null ? '' : help === 'fallback' ? strings.fallbackHint : help === 'rewrite' ? strings.rewriteHint : strings.help,
    ),
    React.createElement(
      'div',
      {
        className: 'dsh-context-zip__tip',
        role: 'status',
        ref: tipRef,
        key: 'tip',
        'data-show': tip === null ? 'false' : 'true',
      },
      tip === null ? '' : tip.text,
    ),
    React.createElement('div', { id: 'dsh-context-zip-help-wire', key: 'help-wire', hidden: true }, strings.help),
    React.createElement('div', { id: 'dsh-context-zip-help-fallback', key: 'help-fallback', hidden: true }, strings.fallbackHint),
    React.createElement('div', { id: 'dsh-context-zip-help-rewrite', key: 'help-rewrite', hidden: true }, strings.rewriteHint),
  );

  return React.createElement('div', { className: 'dsh-context-zip' }, ...children);
}

/** Read the active locale's strings. */
/** Knob glyph for the shipped backend: two arrows pressed together. */
const ICON_COMPRESS =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.6v3.6M8 14.4v-3.6"/>' +
  '<path d="M5.7 3.9 8 6.2l2.3-2.3"/><path d="M5.7 12.1 8 9.8l2.3 2.3"/></svg>';

/** Knob glyph for this plugin: the originals are kept and can be read back. */
const ICON_BOOKMARK =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linejoin="round"><path d="M4.2 2.4h7.6a.9.9 0 0 1 .9.9v10.9L8 11.1l-4.7 3.1V3.3a.9.9 0 0 1 .9-.9z"/></svg>';

/**
 * 页面上当前选中的会话号，取不到就返回空串。
 *
 * `sessions.list` 是会话控制器给前端的「列表 + 当前选择」快照，`current` 就是
 * 侧栏里选中的那个。**面板本身不带会话号**（`settings.section` 是 root scope 的
 * 座位，宿主不传会话），所以这是它能知道「用户正看着哪个会话」的唯一途径；
 * 这一条读不到时返回空串，由宿主的单会话兜底或明确拒绝来收尾，不在这里猜。
 */
function currentSessionId(ctx) {
  try {
    const id = ctx?.get?.('sessions')?.list?.getSnapshot?.()?.current;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/** One inline glyph, built once and reused by every render. */
function glyph(html, extra) {
  return React.createElement('span', {
    className: `dsh-context-zip-mode__ic dsh-context-zip-mode__ic--${extra}`,
    dangerouslySetInnerHTML: { __html: html },
  });
}

/**
 * The composer-row chip that says which compaction backend this session uses.
 *
 * Reading goes through the host route rather than re-deriving the answer here:
 * the mode depends on the session key, the preset key, and the global switch,
 * with a precedence rule between them, and a second implementation in the
 * browser would eventually disagree with the one the engine actually calls.
 *
 * Flipping it writes a session-id row, which is the only key that can single out
 * one session from its siblings. That is the whole point of the control.
 *
 * @param props - slot props carrying the session id.
 */
function ModeSwitch(props) {
  const { sessionId } = props ?? {};
  const strings = useStrings();
  /**
   * The mode, seeded from what this browser remembered for this session so a
   * switch back to a session it has already read draws the truth on the first
   * frame, and so does a reload.
   *
   * `undefined` means "nothing known yet", which is the honest answer for the
   * first visit to a session: the chip reads as "reading…" and then animates to
   * whatever the host says, exactly as any unknown switch would. A remembered
   * value is a starting point, not a verdict — the effect below reads the host
   * again on every mount, and if the answer moved, that change animates like any
   * other.
   */
  const [mode, setMode] = React.useState(() => rememberedMode(sessionId));
  const [busy, setBusy] = React.useState(false);
  /**
   * Consecutive failed reads, reported as `data-failures` on the chip so the
   * stylesheet and diagnostics can see it. The schedule itself belongs to
   * `startModeReadRetry`.
   */
  const [failures, setFailures] = React.useState(0);
  /**
   * Whether the host has handed this seat a session id yet.
   *
   * Assumed true so the first frame reads "reading…" rather than claiming
   * something about a session it has not been told about. A missing id is not a
   * read failure: the effect re-runs when the id arrives, and the chip says what
   * it is waiting for instead of spinning on "reading…" forever.
   */
  const [named, setNamed] = React.useState(true);

  /**
   * One read of the host route.
   *
   * Returns whether it landed, which is what the retry loop schedules on.
   */
  const read = React.useCallback(async () => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      setNamed(false);
      return false;
    }
    setNamed(true);
    try {
      const answer = await fetch(`${MODE_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await answer.json();
      // `ok`, a mode, and a compaction inside it: a 404 for a session the host
      // has not registered yet is the ordinary transient case, not an answer.
      if (data?.ok !== true || data.mode === void 0 || data.mode === null) {
        setMode(null);
        return false;
      }
      // Remembered under the id this read was issued for, not under whatever the
      // chip is showing by the time the answer lands.
      writeModeMemory(sessionId, data.mode);
      setMode(data.mode);
      return true;
    } catch {
      setMode(null);
      return false;
    }
  }, [sessionId]);

  // The first read plus every retry after it. This replaced a bare `void read()`:
  // one failed read used to latch the chip into `failed`, and `failed` disables
  // the checkbox, so the control never came back without a page reload. Measured
  // in Chrome 153 before this change: a single failed read left the chip
  // disabled and it sent no further request in the next ten seconds.
  React.useEffect(
    () =>
      startModeReadRetry({
        read,
        doc: document,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (id) => clearTimeout(id),
        onAttempt: setFailures,
      }),
    [read],
  );

  const on = mode?.compaction === 'plugin';
  /**
   * A first failed read still renders as "reading", not as "read failed".
   *
   * Switching to a session the process has not taken hold of yet answers
   * `session-not-found` once and then succeeds on the 400ms retry — measured, and
   * the user sees it as a flash of the warm failure colour while switching
   * quickly (2026.09.19 report). One failed read is not enough evidence to tell a
   * person the plugin cannot be read; two in a row is, and that costs 1.4s.
   */
  const failed = mode === null && failures >= 2;
  const loading = mode === void 0 || (mode === null && failures < 2);
  const stuck = failed || loading;

  /**
   * The look the previous chip was painted with, frozen at mount.
   *
   * `undefined` means this page has not painted a chip yet (a reload, or the
   * first composer it ever showed), where there is nothing to continue from and
   * the chip simply draws its own answer. See `lastLookOn` for why the host
   * remounts the chip and why the continuation has to be drawn rather than
   * animated.
   */
  const entryLook = React.useRef(lastLookOn).current;
  /**
   * Whether this chip has reached the screen at least once.
   *
   * The continuation above is a change of computed style on one element, so it
   * animates only if the starting look was actually painted first. Two frames,
   * not one: a `requestAnimationFrame` scheduled while the mount is still being
   * committed can run before that frame paints, and dropping the continuation
   * there would paint the final answer alone, which is the hard cut this exists
   * to remove. Holding it one frame longer costs 16ms and cannot be seen.
   */
  const [painted, setPainted] = React.useState(false);
  React.useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPainted(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  /**
   * Draw the previous look until this chip has an answer of its own, and never
   * after that.
   *
   * "Has no answer yet" has three shapes, and all three are transients of a
   * switch: the first frames before the continuation is painted, a read that is
   * still in flight (`loading`, which already carries a single 404 as "still
   * reading"), and a session id the host has not handed this seat yet. The last
   * one used to end the hold early: an empty id made `named` false, the
   * condition required it true, so the chip painted the unchecked frame, got
   * "on" on the retry and animated back: the off-then-on flash a quick switch
   * showed. The id arriving late is the same kind of not-knowing as the read
   * being in flight, so it holds the same way, and the chip keeps showing what
   * it showed a moment ago instead of the unchecked frame that "reading…"
   * happens to look like.
   *
   * A settled answer ends the hold even when it is a failure: `named` true with
   * a mode, or with two failed reads in a row (`failed`), is a verdict, and
   * holding a stale look over a known answer is the "wrong state first, jump
   * later" this is meant to avoid.
   *
   * The trade-off, stated plainly: while the id is missing the chip holds the
   * previous look for as long as the id stays missing, and in that state the
   * chip is disabled and its label already says it is waiting for the session
   * id. A disabled chip still showing the last real answer is closer to the
   * truth than one painting "off"; if the id never arrives, the old look stays
   * on screen indefinitely rather than resolving to anything.
   */
  const held = entryLook !== void 0 && (painted === false || !named || loading);
  const look = held ? entryLook === true : on;
  // What the eye last saw, for the next chip to start from. Written on every
  // commit, so the value carried across a switch is always the one on screen.
  React.useEffect(() => {
    lastLookOn = look;
  });

  const flip = React.useCallback(async () => {
    if (loading || failed || busy) return;
    const want = !on;
    setBusy(true);
    // Optimistic. The input is controlled, so without this the knob would sit on
    // the old value for the whole round trip, which on a cold settings service
    // is about half a second: the tester measured 481ms between the keypress and
    // the knob moving, with `checked` still reading the old value in between.
    // `read()` below replaces this with what the host actually answered.
    const optimistic = { compaction: want ? 'plugin' : 'default', source: 'settings', revision: null };
    // Written to the memory as well as to the screen, so a session the user flips
    // and immediately leaves opens on the flipped value instead of the old one.
    // The read below corrects both if the host disagreed.
    writeModeMemory(sessionId, optimistic);
    setMode(optimistic);
    try {
      // The write route replaces the whole table, so the current one is read
      // first and only this session's row is changed.
      const current = await fetch(SETTINGS_ROUTE).then((answer) => answer.json());
      const agents = { ...(current?.value?.agents ?? {}) };
      agents[sessionId] = want;
      const answer = await fetch(UPDATE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agents }),
      }).then((response) => response.json());
      if (answer?.ok !== true) throw new Error(answer?.error ?? 'rejected');
      await read();
    } catch {
      setMode(null);
    } finally {
      setBusy(false);
    }
  }, [busy, failed, loading, on, read, sessionId]);

  /**
   * A click on a chip that cannot be read means "try again".
   *
   * It has to live on the label, not on the checkbox: the checkbox is disabled
   * in exactly that state, and a disabled checkbox swallows its own activation.
   * Measured in Chrome 153 on the failed chip: pointerdown, mousedown, mouseup
   * and click all arrived on the track span inside the label, none of them
   * cancelled, and the checkbox never toggled and no request went out — which is
   * what "the switch does nothing" looked like from the outside.
   */
  const onLabelClick = React.useCallback(
    (event) => {
      if (modeClickIntent(!stuck) !== 'retry') return;
      event.preventDefault();
      // Back to "reading…" so the click is visibly answered even before the
      // request settles.
      setMode(void 0);
      void read();
    },
    [read, stuck],
  );

  // No `title` on the chip on purpose (user decision, 2026.09.19): the hover
  // tooltip repeated a whole paragraph over a 4.6em chip and the user called it
  // inelegant. `aria-label` carries the same sentence for assistive technology,
  // where it is announced rather than hovered, and the chip's own state
  // (checked, `data-failed`, `data-stuck`, `data-failures`) is unchanged.
  const label = !named
    ? strings.modePending
    : failed
      ? strings.modeFailed
      : loading
        ? strings.modeLoading
        : on
          ? strings.modeOn
          : strings.modeOff;

  return React.createElement(
    'label',
    {
      className: 'dsh-context-zip-mode',
      'aria-label': label,
      'data-failed': failed ? 'true' : void 0,
      // `stuck` covers "loading" too, so the stylesheet can say "this is
      // clickable, it retries" without repeating the two conditions.
      'data-stuck': stuck ? 'true' : void 0,
      'data-failures': failures > 0 ? String(failures) : void 0,
      // The one thing that paints the look, checked or not: `checked` stays the
      // honest state of the control, while this carries what is on screen, which
      // is the previous chip's look until this one has an answer (see `held`).
      // Kept off `className`/`aria-label`'s lines on purpose: the runtime checks
      // pin that pair's order.
      'data-look': look ? 'on' : 'off',
      onClick: onLabelClick,
    },
    React.createElement('input', {
      type: 'checkbox',
      checked: on,
      // `busy` is deliberately NOT part of this. Disabling a focused element
      // moves focus to <body> and never gives it back: the tester's trace shows
      // the second Space press landing on <body> instead of the chip, and a
      // mouse click on the chip while the composer had focus left the composer
      // unfocused with the next keystroke going nowhere. The re-entry guard at
      // the top of `flip` is what stops a double submit, not this attribute.
      disabled: stuck,
      onChange: flip,
    }),
    React.createElement(
      'span',
      { className: 'dsh-context-zip-mode__track' },
      React.createElement(
        'span',
        { className: 'dsh-context-zip-mode__knob' },
        glyph(ICON_COMPRESS, 'a'),
        glyph(ICON_BOOKMARK, 'b'),
      ),
    ),
  );
}

function useStrings() {
  const locale = React.useContext(LocaleContext);
  return locale === 'en' ? EN : ZH;
}

/** Locale value shared with the section through React context. */
const LocaleContext = React.createContext('zh');

/** Stylesheet for the section. */
const STYLE = `
/* ============================================================================
   尺度令牌：宿主设计令牌一律用真名 --dsw-alias-*，取值由宿主定义；面板自己
   的尺寸、时长、圆角与阴影收在这张表里，规则里不写散值。
   ============================================================================ */
/* 时长与缓动是面板和输入框芯片共用的一对，所以单独成块，选择器同时挂两个根：
   芯片长在输入框那一侧，不在面板那棵树里，继承不到面板那份。 */
.dsh-context-zip,.dsh-context-zip-mode{--cz-dur:200ms;--cz-ease:cubic-bezier(.4,0,.2,1)}
.dsh-context-zip{
  --cz-font-sm:12px;--cz-font-md:14px;--cz-font-lg:16px;
  --cz-line-sm:18px;--cz-line-md:22px;--cz-line-lg:24px;
  --cz-radius-control:8px;--cz-radius-surface:10px;--cz-radius-group:12px;
  --cz-row-h:40px;--cz-hit:28px;--cz-save-w:104px;--cz-pulse:1200ms;
  --cz-gap-xs:4px;--cz-gap-sm:8px;--cz-gap-md:12px;--cz-gap-lg:20px;
  --cz-z-bubble:30;--cz-z-tip:40;
  --cz-font-code:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
  --cz-shadow-tip:0 6px 20px rgba(0,0,0,.18);
  --cz-shadow-surface:0 10px 30px rgba(0,0,0,.22);
  --cz-shadow-knob:0 1px 3px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.6);
  box-sizing:border-box;padding:0;
  display:flex;flex-direction:column;
  font-size:var(--cz-font-md);line-height:var(--cz-line-md);
  color:var(--dsw-alias-label-primary);
}
.dsh-context-zip *,.dsh-context-zip *::before,.dsh-context-zip *::after{box-sizing:border-box}
.dsh-context-zip :focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:2px;border-radius:var(--cz-radius-control)}
.dsh-context-zip button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.dsh-context-zip input,.dsh-context-zip select{font:inherit;color:inherit}

/* 面板标题行（插件显示名在左，唯一的保存按钮在最右；原状态行与实时计数已撤） */
.dsh-context-zip__title-row{display:flex;align-items:center;gap:var(--cz-gap-md)}
.dsh-context-zip__title{font-weight:600;font-size:var(--cz-font-lg);line-height:var(--cz-line-lg);padding:6px 0 2px}

/* 唯一的保存按钮：脏了才可点；成功变勾、失败红底，两种脸各停留 1.5 秒 */
.dsh-context-zip__save{margin-left:auto;min-width:var(--cz-save-w);min-height:32px;padding:0 12px;border-radius:var(--cz-radius-control);font-size:var(--cz-font-md);line-height:20px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease),opacity var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-context-zip__save:disabled{opacity:.4;cursor:default}
.dsh-context-zip__save[data-face="saving"]{opacity:.7}
.dsh-context-zip__save[data-face="check"]{opacity:1;cursor:default}
.dsh-context-zip__save[data-face="failed"],.dsh-context-zip__save[data-face="failed"]:hover:not(:disabled),.dsh-context-zip__save[data-face="failed"]:active{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);opacity:1}

/* 分组：横线只画在功能块之间，块内不画 */
.dsh-context-zip__group{border-top:1px solid var(--dsw-alias-border-l1);margin-top:var(--cz-gap-lg);padding-top:var(--cz-gap-lg);display:flex;flex-direction:column}
.dsh-context-zip__hd{margin:0;font-size:var(--cz-font-md);font-weight:600;line-height:var(--cz-line-md)}
.dsh-context-zip__hd-btn{width:100%;text-align:left;padding:var(--cz-gap-xs) 0;font-weight:600;display:flex;align-items:center;gap:var(--cz-gap-sm);transition:color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__tag{font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);font-weight:400;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:2px 8px}
.dsh-context-zip__chev{margin-left:auto;display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__group[data-open="true"] .dsh-context-zip__chev{transform:rotate(90deg)}
.dsh-context-zip__group[data-open="false"] .dsh-context-zip__body{display:none}

/* 设置行（与只读行同高，行与行之间不画线） */
.dsh-context-zip__rows{display:flex;flex-direction:column}
.dsh-context-zip__rows--gap{margin-top:var(--cz-gap-md)}
.dsh-context-zip__row{display:flex;align-items:center;gap:16px;min-height:var(--cz-row-h)}
.dsh-context-zip__row-label{flex:none}
.dsh-context-zip__row-ctl{margin-left:auto;display:flex;align-items:center;gap:var(--cz-gap-sm)}
.dsh-context-zip__row--stack{display:block}
.dsh-context-zip__row--grow .dsh-context-zip__row-ctl{margin-left:0;flex:1}

/* 小节标题（只读子表的名字） */
.dsh-context-zip__sub{margin:0;padding:var(--cz-gap-md) 0 var(--cz-gap-xs);font-size:var(--cz-font-md);font-weight:500;line-height:var(--cz-line-md);color:var(--dsw-alias-label-secondary)}

/* 分段控件 */
.dsh-context-zip__seg{display:inline-flex;padding:2px;gap:2px;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--cz-radius-surface)}
.dsh-context-zip__seg-btn{min-height:32px;padding:0 14px;border-radius:var(--cz-radius-control);font-size:var(--cz-font-md);line-height:20px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-context-zip__seg-btn[aria-pressed="true"]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dsh-context-zip__seg-btn[aria-pressed="true"]:hover{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-context-zip__seg-btn:disabled{opacity:.55;cursor:default}

/* 开关 */
.dsh-context-zip__sw{position:relative;width:44px;height:26px;flex:none;display:inline-flex;align-items:center;cursor:pointer}
.dsh-context-zip__sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.dsh-context-zip__sw-track{width:40px;height:24px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active);border:1px solid var(--dsw-alias-border-l2);transition:background-color var(--cz-dur) var(--cz-ease),border-color var(--cz-dur) var(--cz-ease);pointer-events:none}
.dsh-context-zip__sw-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:var(--cz-shadow-knob);transition:transform var(--cz-dur) var(--cz-ease);pointer-events:none}
.dsh-context-zip__sw input:checked~.dsh-context-zip__sw-track{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.dsh-context-zip__sw input:checked~.dsh-context-zip__sw-knob{transform:translateX(16px)}
.dsh-context-zip__sw input:focus-visible~.dsh-context-zip__sw-track{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:2px}

/* 输入与下拉 */
.dsh-context-zip__input,.dsh-context-zip__select{height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--cz-radius-control);background:transparent;font-size:var(--cz-font-md);line-height:20px;transition:border-color var(--cz-dur) var(--cz-ease),background-color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__input:hover,.dsh-context-zip__select:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-context-zip__input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}
.dsh-context-zip__input:focus,.dsh-context-zip__select:focus{border-color:var(--dsw-alias-button-primary-fill);outline:none}
.dsh-context-zip__input:disabled,.dsh-context-zip__select:disabled{opacity:.55}
.dsh-context-zip__input--mono{font-family:var(--cz-font-code);font-size:var(--cz-font-sm)}
.dsh-context-zip__input--num{width:64px;text-align:center;font-variant-numeric:tabular-nums}
.dsh-context-zip__input--grow{flex:1;min-width:0}
.dsh-context-zip__select{appearance:none;padding-right:26px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary) 50%),linear-gradient(135deg,var(--dsw-alias-label-tertiary) 50%,transparent 50%);background-position:calc(100% - 14px) 14px,calc(100% - 9px) 14px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.dsh-context-zip__field{display:flex;flex-direction:column;gap:var(--cz-gap-xs);min-width:0;flex:1}
.dsh-context-zip__field-label{font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);color:var(--dsw-alias-label-secondary)}

/* 按钮 */
.dsh-context-zip__btn{min-height:32px;padding:0 12px;border-radius:var(--cz-radius-control);font-size:var(--cz-font-md);line-height:20px;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:6px;transition:background-color var(--cz-dur) var(--cz-ease),transform var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-context-zip__btn:active{background:var(--dsw-alias-interactive-bg-active);transform:translateY(1px)}
.dsh-context-zip__btn--outline{border:1px solid var(--dsw-alias-border-l2)}
.dsh-context-zip__btn--flush{margin-left:-12px}
.dsh-context-zip__btn[hidden]{display:none}
.dsh-context-zip__more{padding-top:var(--cz-gap-sm)}

/* 「压缩后端」行：左标题（含问号）、中主副行、右按钮，是「压缩方式」组的第一行。两条技能包
   规则落在这一块：状态点只画真实的语义状态（本插件有没有接管压缩那一行），不做装饰，全面板
   只此一颗（taste-skill 的 SKILL.md:683）；动画只为「有动作在进行」而存在（同文件 :360）。
   形状与颜色分工，色盲用户也能读：空心=未生效与加载、实心=已生效、失败=实心加错误色、
   接管中=空心加一圈呼吸环。点对读屏器无意义（状态在句子里），加 aria-hidden。
   三样横排：标题不伸缩，主副行占满中间，按钮贴最右；行高取 --cz-row-h，主行 22px 加副行
   18px 正好填满，所以有按钮与没按钮的态一样高。按钮与该组分段控件都是所在行的最后一个
   伸缩项、行宽相同，右缘因此对齐，不额外定位。 */
.dsh-context-zip__wire{display:flex;align-items:center;gap:16px;min-height:var(--cz-row-h)}
.dsh-context-zip__wire-title{flex:none;display:flex;align-items:center;gap:var(--cz-gap-sm)}
.dsh-context-zip__wire-body{flex:1;min-width:0;display:flex;flex-direction:column}
.dsh-context-zip__wire-main{display:flex;align-items:center;gap:var(--cz-gap-sm);font-size:var(--cz-font-md);line-height:var(--cz-line-md);color:var(--dsw-alias-label-primary)}
.dsh-context-zip__wire-main-text{min-width:0}
.dsh-context-zip__wire-sub{padding-left:16px;font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);color:var(--dsw-alias-label-secondary);text-wrap:pretty}
.dsh-context-zip__wire-dot{position:relative;flex:none;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--dsw-alias-label-tertiary);background:transparent;transition:background-color var(--cz-dur) var(--cz-ease),border-color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__wire-dot[data-face="on"]{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.dsh-context-zip__wire-dot[data-face="busy"]{border-color:var(--dsw-alias-button-primary-fill)}
.dsh-context-zip__wire-dot[data-face="error"]{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-context-zip__wire-dot[data-face="busy"]::after{content:"";position:absolute;inset:-1.5px;border-radius:50%;border:1.5px solid var(--dsw-alias-button-primary-fill);transform:scale(1);opacity:.5;animation:cz-wire-pulse var(--cz-pulse) var(--cz-ease) infinite}
@keyframes cz-wire-pulse{0%{transform:scale(1);opacity:.5}70%,100%{transform:scale(1.9);opacity:0}}
.dsh-context-zip__wire-btn{flex:none}
/* 接管在飞时那颗按钮禁用置灰：:hover 对禁用按钮照样命中，所以连同悬停背景一起按掉。 */
.dsh-context-zip__wire-btn:disabled,.dsh-context-zip__wire-btn:disabled:hover{opacity:.55;cursor:default;background:none}

/* 只读会话行（已生效会话与检索覆盖共用同一套；行间不画线） */
.dsh-context-zip__list{display:flex;flex-direction:column}
.dsh-context-zip__srow{display:flex;align-items:center;gap:var(--cz-gap-md);min-height:var(--cz-row-h)}
.dsh-context-zip__srow-name{flex:1;min-width:0;font-size:var(--cz-font-md);line-height:var(--cz-line-md);color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-context-zip__srow-name--id{font-family:var(--cz-font-code);font-size:var(--cz-font-sm);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__srow-tag{flex:none;font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:2px 8px}
.dsh-context-zip__empty{font-size:var(--cz-font-md);line-height:var(--cz-line-md);color:var(--dsw-alias-label-caption)}

/* 复制按钮与行内反馈气泡 */
.dsh-context-zip__copy{width:var(--cz-hit);height:var(--cz-hit);border-radius:var(--cz-radius-control);flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-context-zip__copy:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-context-zip__tip{position:fixed;z-index:var(--cz-z-tip);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--cz-radius-surface);padding:4px 10px;font-size:var(--cz-font-sm);line-height:20px;color:var(--dsw-alias-label-primary);box-shadow:var(--cz-shadow-tip);opacity:0;transform:translateY(2px);transition:opacity var(--cz-dur) var(--cz-ease),transform var(--cz-dur) var(--cz-ease);pointer-events:none}
.dsh-context-zip__tip[data-show="true"]{opacity:1;transform:translateY(0)}
.dsh-context-zip__offscreen{position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none}

/* 虚化问号与浮层气泡（无指向箭头，圆角 10px，宽 320px） */
.dsh-context-zip__help{width:var(--cz-hit);height:var(--cz-hit);border-radius:var(--cz-radius-control);flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-dimmed);transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__help:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__help[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__help:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-context-zip__bubble{position:fixed;z-index:var(--cz-z-bubble);width:320px;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--cz-radius-surface);padding:10px 12px;font-size:var(--cz-font-sm);line-height:1.6;color:var(--dsw-alias-label-primary);box-shadow:var(--cz-shadow-surface);text-wrap:pretty;display:none}
.dsh-context-zip__bubble[data-show="true"]{display:block}

/* 分段结果 */
.dsh-context-zip__segments{margin:var(--cz-gap-sm) 0 0;padding:10px 12px;border-radius:var(--cz-radius-control);background:var(--dsw-alias-interactive-bg-hover);font-family:var(--cz-font-code);font-size:var(--cz-font-sm);line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto}

/* 状态行与保存反馈 */
.dsh-context-zip__hint{margin:var(--cz-gap-xs) 0 0;font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__error{color:var(--dsw-alias-state-error-primary)}

@media (prefers-reduced-motion:reduce){.dsh-context-zip *,.dsh-context-zip-mode *{transition:none!important;animation:none!important}}

/* ============================================================================
   输入框旁的模式芯片。
   data-look 是唯一决定外观的东西（checked 只记账）：切会话会整颗重挂载，
   新元素没有「上一帧」可插值，所以新芯片先按 data-look 画上一颗的样子，等它
   自己有了答案再改这个属性，改的那一刻才播过渡——与同一颗芯片内拨动开关时走的
   是同一条过渡。时长与缓动用面板的令牌，见文件顶部那张表。
   ============================================================================ */
.dsh-context-zip-mode{font-size:14px;position:relative;display:inline-block;width:4.6em;height:2em;vertical-align:middle;flex:none}
.dsh-context-zip-mode input{opacity:0;width:0;height:0;position:absolute}
.dsh-context-zip-mode__track{position:absolute;inset:0;background:#ccd0d5;border-radius:999px;cursor:pointer;transition:background-color var(--cz-dur) var(--cz-ease);box-shadow:inset 0 1px 3px rgba(0,0,0,.22)}
.dsh-context-zip-mode[data-look="on"] .dsh-context-zip-mode__track{background:#2563eb}
.dsh-context-zip-mode input:disabled+.dsh-context-zip-mode__track{cursor:default}
 .dsh-context-zip-mode input:focus-visible+.dsh-context-zip-mode__track{box-shadow:inset 0 1px 3px rgba(0,0,0,.22),0 0 0 2px rgba(255,255,255,.9),0 0 0 4px #2563eb}
 .dsh-context-zip-mode[data-failed="true"] input:focus-visible+.dsh-context-zip-mode__track{box-shadow:inset 0 1px 3px rgba(0,0,0,.22),0 0 0 2px rgba(255,255,255,.9),0 0 0 4px #a45c5c}
.dsh-context-zip-mode[data-failed="true"] .dsh-context-zip-mode__track{background:#d9b3b3}
.dsh-context-zip-mode[data-failed="true"] .dsh-context-zip-mode__knob{color:#a45c5c}
 .dsh-context-zip-mode[data-stuck="true"] input:disabled+.dsh-context-zip-mode__track{cursor:pointer}
 .dsh-context-zip-mode[data-stuck="true"] input:focus-visible+.dsh-context-zip-mode__track{box-shadow:inset 0 1px 3px rgba(0,0,0,.22),0 0 0 2px rgba(255,255,255,.9),0 0 0 4px #a45c5c}
.dsh-context-zip-mode__knob{position:absolute;height:1.6em;width:1.6em;left:.2em;top:.2em;border-radius:50%;background:linear-gradient(180deg,#fff 0%,#eef1f5 100%);box-shadow:0 1.5px 3px rgba(0,0,0,.28),0 .5px 1px rgba(0,0,0,.16),inset 0 1px 0 #fff;transition:transform var(--cz-dur) var(--cz-ease);display:flex;align-items:center;justify-content:center;color:#6b7280}
.dsh-context-zip-mode[data-look="on"] .dsh-context-zip-mode__knob{transform:translateX(2.6em);color:#2563eb}
.dsh-context-zip-mode__ic{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:opacity var(--cz-dur) var(--cz-ease)}
.dsh-context-zip-mode__ic svg{display:block}
.dsh-context-zip-mode__ic--b{opacity:0}
.dsh-context-zip-mode[data-look="on"] .dsh-context-zip-mode__ic--a{opacity:0}
.dsh-context-zip-mode[data-look="on"] .dsh-context-zip-mode__ic--b{opacity:1}
`;

/**
 * Mount the browser half.
 *
 * @param ctx - client context carrying the slot registry and locale service.
 */
export function apply(ctx) {
  const style = document.createElement('style');
  style.id = 'dsh-context-zip-style';
  style.textContent = STYLE;
  document.head.append(style);

  if (ctx.locale !== undefined) {
    ctx.locale.register(NS, { zh: ZH, en: EN });
  }

  const LocaleBoundSection = (props) =>
    React.createElement(
      LocaleContext.Provider,
      { value: ctx.locale?.getLocale?.().active === 'en' ? 'en' : 'zh' },
      // `ctx` travels as a prop because the segments field has to read the page's
      // current session selection, which is a service and not a slot prop: the
      // settings seat is root-scoped and the host passes it no session id.
      React.createElement(ContextZipSection, { ...props, ctx }),
    );

  // The composer tool row. `conversation.input.left` is a list slot, so this sits
  // beside whatever else a profile puts there instead of shadowing it.
  const LocaleBoundModeSwitch = (props) =>
    React.createElement(
      LocaleContext.Provider,
      { value: ctx.locale?.getLocale?.().active === 'en' ? 'en' : 'zh' },
      React.createElement(ModeSwitch, props),
    );

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'context-zip-mode',
        order: 40,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      },
      LocaleBoundModeSwitch,
    ),
  );

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'context-zip',
        order: 65,
        label: () => labelFor(ctx),
        locale: NS,
      },
      LocaleBoundSection,
    ),
  );
}

/** Section navigation label in the active locale. */
function labelFor(ctx) {
  return ctx.locale?.getLocale?.().active === 'en' ? EN.nav : ZH.nav;
}

export default { name, inject, apply, NS };
