window.__ModuleLoader__.load({
  id: "dsh-context-zip",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.ts
var index_exports = {};
__export(index_exports, {
  NS: () => NS,
  apply: () => apply,
  default: () => index_default,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React = __toESM(require("react"), 1);

// client/live.ts
var LIVE_POLL_MS = 5e3;
var LIVE_DEDUPE_MS = 1e3;
var MODE_RETRY_SCHEDULE_MS = [400, 1e3, 2500, 5e3, 1e4, 3e4];
var MODE_DEDUPE_MS = 1e3;
function modeRetryDelay(failures, scheduleMs = MODE_RETRY_SCHEDULE_MS) {
  const steps = Array.isArray(scheduleMs) && scheduleMs.length > 0 ? scheduleMs : MODE_RETRY_SCHEDULE_MS;
  const nth = Number.isFinite(failures) && failures >= 1 ? Math.floor(failures) : 1;
  return steps[Math.min(nth - 1, steps.length - 1)];
}
function modeClickIntent(readable) {
  return readable ? "flip" : "retry";
}
function startModeReadRetry(options) {
  const {
    read,
    scheduleMs = MODE_RETRY_SCHEDULE_MS,
    dedupeMs = MODE_DEDUPE_MS,
    now = Date.now,
    doc,
    setTimer,
    clearTimer,
    onAttempt
  } = options ?? {};
  let stopped = false;
  let failures = 0;
  let timer = null;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  const run = async () => {
    if (stopped) return;
    lastReadAt = now();
    let landed = false;
    try {
      landed = await read() === true;
    } catch {
      landed = false;
    }
    if (stopped) return;
    if (landed) {
      failures = 0;
      onAttempt?.(0);
      return;
    }
    failures += 1;
    onAttempt?.(failures);
    timer = setTimer(() => {
      timer = null;
      void run();
    }, modeRetryDelay(failures, scheduleMs));
  };
  const onVisibilityChange = () => {
    if (doc?.visibilityState !== "visible") return;
    if (!liveReadDue(lastReadAt, now(), dedupeMs)) return;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    failures = 0;
    onAttempt?.(0);
    void run();
  };
  void run();
  doc?.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
function initialLiveHealth(at) {
  return { failures: 0, lastOk: at };
}
function liveHealthAfter(previous, healthy, at) {
  if (healthy) return previous.failures === 0 ? previous : initialLiveHealth(at);
  return { failures: previous.failures + 1, lastOk: previous.lastOk };
}
function helpBubblePlacement(anchor, viewport, size, gap = 8, margin = 12) {
  const width = Math.max(0, Math.min(size.width, viewport.width - margin * 2));
  const left = Math.max(margin, Math.min(anchor.right - width, viewport.width - width - margin));
  let top = anchor.bottom + gap;
  if (top + size.height > viewport.height - margin && anchor.top - gap - size.height > margin) {
    top = anchor.top - gap - size.height;
  }
  return { left, top: Math.max(margin, top), width };
}
function toRows(agents) {
  return Object.entries(agents ?? {}).map(([key, value]) => ({ key, value: value === true }));
}
function titlesFrom(source) {
  const clean = {};
  if (source === null || typeof source !== "object" || Array.isArray(source)) return clean;
  for (const [id, title] of Object.entries(source)) {
    if (typeof title === "string" && title.trim().length > 0) clean[id] = title.trim();
  }
  return clean;
}
function mergeLivePayload(previous, payload) {
  if (previous === null || previous === void 0) return previous;
  const titles = payload !== null && typeof payload === "object" && "titles" in payload ? titlesFrom(payload.titles) : previous.titles;
  const effective = payload?.effective ?? previous.effective;
  const sameTitles = sameTitleMap(previous.titles, titles);
  const sameEffective = JSON.stringify(previous.effective) === JSON.stringify(effective);
  if (sameTitles && sameEffective) return previous;
  return { ...previous, titles, effective };
}
function sameTitleMap(left, right) {
  const a = left ?? {};
  const b = right ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}
var SAVE_FEEDBACK_MS = 1500;
function wireStatusFrom(payload, action) {
  if (payload === null || payload === void 0 || payload.ok !== true) return "unknown";
  if (payload.foreign === true) return "taken";
  if (payload.wired !== true) return payload.partial === true ? "incomplete" : "inactive";
  if (action === "taking") return "taking";
  if (action === "failed") return "failed";
  if (payload.stale === true) return "update";
  if (redirectIsNewerThanProcess(payload)) return "restart";
  return "active";
}
function redirectIsNewerThanProcess(payload) {
  const copiedAt = payload?.copiedAt;
  const processStartedAt = payload?.processStartedAt;
  if (typeof copiedAt !== "string" || copiedAt.length === 0) return false;
  if (typeof processStartedAt !== "string" || processStartedAt.length === 0) return false;
  const copied = Date.parse(copiedAt);
  const started = Date.parse(processStartedAt);
  if (Number.isFinite(copied) === false || Number.isFinite(started) === false) return false;
  return copied > started;
}
function wireText(status, payload, strings, locale = "zh") {
  const stampVersion = typeof payload?.version === "string" && payload.version.length > 0 ? payload.version : "";
  const version = stampVersion.length > 0 ? stampVersion : strings.versionUnknown;
  const current = typeof payload?.current === "string" ? payload.current : "";
  const at = stampText(payload?.copiedAt);
  const sep = locale === "en" ? ", " : "\uFF0C";
  if (status === "loading") return { main: strings.loading, sub: "", action: "" };
  if (status === "taking") return { main: strings.takingMain, sub: strings.takingSub, action: strings.takeover };
  if (status === "active") {
    const sub = at.length > 0 ? `${strings.activeSubPrefix} ${version}${sep}${at}` : `${strings.activeSubPrefix} ${version}`;
    return { main: strings.activeMain, sub, action: "" };
  }
  if (status === "update") {
    return { main: strings.updateMain, sub: strings.updateTpl(current, version), action: strings.reconnect };
  }
  if (status === "restart") return { main: strings.restartMain, sub: strings.restartSub, action: "" };
  if (status === "taken") return { main: strings.inactiveMain, sub: strings.takenSub, action: "" };
  if (status === "incomplete") {
    return { main: strings.incompleteMain, sub: strings.incompleteSub, action: strings.retry };
  }
  if (status === "unknown") return { main: strings.unknownMain, sub: strings.unknownSub, action: strings.retry };
  if (status === "failed") return { main: strings.failMain, sub: String(payload?.error ?? ""), action: strings.retry };
  return { main: strings.inactiveMain, sub: strings.inactiveSub, action: strings.takeover };
}
function wireFace(status) {
  if (status === "taking") return "busy";
  if (status === "active") return "on";
  if (status === "failed") return "error";
  return "off";
}
var ATTENTION_STATE_KEYS = {
  inactive: "inactiveMain",
  update: "updateMain",
  migrate: "migrateMain",
  restart: "restartMain",
  incomplete: "incompleteMain",
  failed: "failMain",
  unknown: "unknownMain"
};
function attentionOf(attention) {
  if (attention === null || typeof attention !== "object" || Array.isArray(attention)) return null;
  const kind = typeof attention.kind === "string" ? attention.kind : "";
  if (kind.length === 0) return null;
  return {
    kind,
    home: typeof attention.home === "string" ? attention.home : "",
    profile: typeof attention.profile === "string" ? attention.profile : ""
  };
}
function fillTemplate(text, values) {
  let filled = text;
  for (const [name2, value] of Object.entries(values)) filled = filled.split(`{${name2}}`).join(value);
  return filled;
}
function attentionPrompt(attention, strings, port = "") {
  const clean = attentionOf(attention);
  if (clean === null) return null;
  const stateKey = ATTENTION_STATE_KEYS[clean.kind];
  if (stateKey === void 0) return null;
  const state = typeof strings?.[stateKey] === "string" ? strings[stateKey] : "";
  const values = { home: clean.home, profile: clean.profile, port: String(port ?? ""), state };
  const templates = {
    inactive: strings?.promptInactive,
    update: strings?.promptUpdate,
    migrate: strings?.promptMigrate,
    incomplete: strings?.promptRepair,
    failed: strings?.promptRepair,
    unknown: strings?.promptRepair
  };
  const template = templates[clean.kind];
  const body = typeof template === "string" && template.length > 0 ? fillTemplate(template, values) : "";
  const note = clean.kind === "restart" && typeof strings?.helpTopRestart === "string" ? strings.helpTopRestart : "";
  return { kind: clean.kind, state, body, note, copyText: body.length > 0 ? body : null };
}
function stampText(iso) {
  if (typeof iso !== "string" || iso.length === 0) return "";
  const ms = Date.parse(iso);
  if (Number.isFinite(ms) === false) return "";
  const at = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
function settingsShape(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(settingsShape).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${settingsShape(value[key])}`).join(",")}}`;
}
function sameSettings(a, b) {
  return settingsShape(a) === settingsShape(b);
}
function saveButtonEnabled(dirty, phase, loaded) {
  return loaded === true && phase !== "saving" && dirty === true;
}
function saveButtonFace(phase) {
  return phase === "saving" ? "saving" : phase === "saved" ? "check" : phase === "failed" ? "failed" : "save";
}
function liveReadDue(lastReadAt, at, windowMs = LIVE_DEDUPE_MS) {
  return at - lastReadAt >= windowMs;
}
function startLivePoll(options) {
  const {
    read,
    intervalMs = LIVE_POLL_MS,
    dedupeMs = LIVE_DEDUPE_MS,
    now = Date.now,
    doc,
    setTimer,
    clearTimer
  } = options ?? {};
  let lastReadAt = Number.NEGATIVE_INFINITY;
  const dispatch = () => {
    const at = now();
    if (!liveReadDue(lastReadAt, at, dedupeMs)) return;
    lastReadAt = at;
    void read();
  };
  const timer = setTimer(() => dispatch(), intervalMs);
  const onVisibilityChange = () => {
    if (doc?.visibilityState !== "visible") return;
    dispatch();
  };
  doc?.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearTimer(timer);
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
  };
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

// src/session-key.ts
var SESSION_KEY = /^session-[A-Za-z0-9-]{1,120}$/;
function isSessionKey(key) {
  return typeof key === "string" && SESSION_KEY.test(key);
}

// client/index.ts
var name = "dsh-context-zip/client";
var inject = ["slots", "locale"];
var NS = "context-zip";
var SETTINGS_ROUTE = "/dsh-context-zip/settings";
var LIVE_ROUTE = "/dsh-context-zip/live";
var UPDATE_ROUTE = "/dsh-context-zip/settings/update";
var SEGMENTS_ROUTE = "/dsh-context-zip/segments";
var MODE_ROUTE = "/dsh-context-zip/mode";
var MODELS_ROUTE = "/dsh-context-zip/models";
var WIRE_ROUTE = "/dsh-context-zip/wire";
var MODE_MEMORY_KEY = "dsh-context-zip:modes";
function readModeMemory() {
  try {
    const raw = window.localStorage.getItem(MODE_MEMORY_KEY);
    if (raw === null) return {};
    const table = JSON.parse(raw);
    return table !== null && typeof table === "object" ? table : {};
  } catch {
    return {};
  }
}
function rememberedMode(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
  const table = readModeMemory();
  return Object.hasOwn(table, sessionId) ? table[sessionId] : void 0;
}
function writeModeMemory(sessionId, mode) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  try {
    const table = readModeMemory();
    table[sessionId] = mode;
    window.localStorage.setItem(MODE_MEMORY_KEY, JSON.stringify(table));
  } catch {
  }
}
var lastLookOn;
var ZH = {
  nav: "ContextZip",
  title: "ContextZip",
  // ── 分组标题：面板不写说明段落，可见文字只有分组名、控件与两条问号说明（E 轮定）
  groupMethod: "\u538B\u7F29\u65B9\u5F0F",
  groupFallback: "\u6458\u8981\u515C\u5E95",
  groupRewrite: "\u6458\u8981\u91CD\u6392",
  groupExperiment: "\u5B9E\u9A8C\u4E0E\u6392\u969C",
  groupExperimentTag: "\u672A\u9A8C\u8BC1",
  groupSegments: "\u538B\u7F29\u5206\u6BB5",
  // ── 压缩方式：一行分段控件，值仍是 `enabled` 布尔
  methodLabel: "\u65B0\u5EFA\u4F1A\u8BDD\u9ED8\u8BA4\u538B\u7F29\u65B9\u5F0F",
  methodPlugin: "ContextZip",
  methodDefault: "\u5185\u7F6E\u540E\u7AEF",
  // ── 压缩后端：压缩那一行由谁接管（`dsh plugin add` 装的人默认没有接管）。
  // 一行标题加一颗问号，中间是主行加副行，右端按钮只在还能做事时出现。九态各有一套
  // 主副行，判定顺序在 `client/live.ts` 的 `wireStatusFrom`；这里只有文字。
  rowTitle: "\u538B\u7F29\u540E\u7AEF",
  help: "\u63D2\u4EF6\u63A5\u7BA1\u538B\u7F29\u540E\u624D\u751F\u6548\uFF0C\u63A5\u7BA1\u540E\u9700\u91CD\u542F\u4E00\u6B21 harness\u3002",
  inactiveMain: "\u672A\u751F\u6548",
  inactiveSub: "\u5185\u7F6E\u538B\u7F29\u6B63\u5728\u5DE5\u4F5C",
  takeover: "\u63A5\u7BA1",
  takingMain: "\u6B63\u5728\u63A5\u7BA1",
  takingSub: "\u8BF7\u7A0D\u5019",
  activeMain: "\u5DF2\u751F\u6548",
  activeSubPrefix: "\u57FA\u4E8E\u5185\u7F6E",
  // 戳里没有版本时的兜底句：副行要印版本，缺字段就用这一句，不留空位。
  versionUnknown: "\u7248\u672C\u672A\u77E5",
  updateMain: "\u5F85\u66F4\u65B0",
  // 两个版本都可能缺席：快照由 `wireText` 兜成「版本未知」，当前版本没有兜底句，所以这里
  // 把空的那一段连同它的分隔符一起去掉，而不是印出 `内置 ，快照 …` 或尾随的逗号。
  updateTpl: (current, snapshot) => {
    const parts = [current.length > 0 ? `\u5185\u7F6E ${current}` : "", snapshot.length > 0 ? `\u5FEB\u7167 ${snapshot}` : "", "\u91CD\u63A5\u4E00\u6B21\u5373\u53EF"];
    return parts.filter((part) => part.length > 0).join("\uFF0C");
  },
  reconnect: "\u91CD\u65B0\u63A5\u7BA1",
  restartMain: "\u7B49\u5F85\u91CD\u542F",
  restartSub: "\u4E0B\u6B21\u542F\u52A8\u65F6\u751F\u6548",
  takenSub: "\u8BE5\u4F4D\u7F6E\u5DF2\u6709\u5176\u4ED6\u5B9E\u73B0\uFF0C\u4FDD\u6301\u4E0D\u52A8",
  incompleteMain: "\u63A5\u7BA1\u4E0D\u5B8C\u6574",
  incompleteSub: "\u91CD\u8BD5\u4E00\u6B21\u5373\u53EF\u6062\u590D",
  unknownMain: "\u72B6\u6001\u672A\u77E5",
  unknownSub: "\u521A\u624D\u6CA1\u6709\u8BFB\u5230",
  failMain: "\u63A5\u7BA1\u5931\u8D25",
  retry: "\u91CD\u8BD5",
  // ── 第 4 颗问号：接管异常时的修复提示词（2026.09.23）
  // 服务端 `/wire` 的 `attention` 非 null 才渲染；`null`（已生效、正在接管）与
  // `foreign`（没有可修的东西）都不显示。气泡是「一句现状 + 提示词正文 + 复制按钮」，
  // 复制按钮复制的只有正文。正文里的 {home} / {profile} / {port} 在渲染与复制时都换
  // 成真值，来源是 `attention` 与 `location.port`。`restart` 没有提示词：重启只能由
  // 用户做，agent 不许碰。
  helpTopLabel: "\u67E5\u770B\u5F53\u524D\u63A5\u7BA1\u5F02\u5E38\u7684\u4FEE\u590D\u63D0\u793A\u8BCD",
  helpTopCopy: "\u590D\u5236\u63D0\u793A\u8BCD",
  helpTopWhere: (state) => `\u5F53\u524D\u72B6\u6001\uFF1A${state}\u3002\u4E0B\u9762\u8FD9\u6BB5\u63D0\u793A\u8BCD\u53EF\u4EE5\u6574\u6BB5\u590D\u5236\u7ED9\u4E00\u4E2A agent\uFF0C\u5168\u7A0B\u4E0D\u9700\u8981\u754C\u9762\u64CD\u4F5C\u3002`,
  helpTopRestart: "\u91CD\u542F\u5BBF\u4E3B\u540E\u751F\u6548\u3002\u91CD\u542F\u8FD9\u4E00\u6B65\u53EA\u80FD\u7531\u4F60\u81EA\u5DF1\u505A\uFF0C\u63D0\u793A\u8BCD\u91CC\u4E0D\u4F1A\u3001\u4E5F\u4E0D\u5E94\u8BE5\u8BA9 agent \u53BB\u91CD\u542F\u3002",
  migrateMain: "\u8BBE\u7F6E\u672A\u8FC1\u79FB",
  promptInactive: `\u80CC\u666F\uFF1A\u6211\u7684 DSH \u88C5\u4E86 dsh-context-zip\uFF0C\u4F46\u538B\u7F29\u63A5\u7BA1\u6CA1\u751F\u6548\uFF0C\u538B\u7F29\u8FD8\u5728\u8D70\u5BBF\u4E3B\u5185\u7F6E\u540E\u7AEF\u3002\u8BF7\u6309\u4E0B\u9762\u505A\uFF0C\u8FD9\u4E9B\u6B65\u9AA4\u90FD\u4E0D\u9700\u8981\u754C\u9762\u64CD\u4F5C\u3002

1. \u5199\u5165\u63A5\u7BA1\uFF08\u4E0D\u7528\u70B9\u754C\u9762\uFF09\uFF1A\u8C03\u63D2\u4EF6\u81EA\u5DF1\u7684\u63A5\u7BA1\u8DEF\u7531\uFF0C\u628A\u5185\u7F6E\u540E\u7AEF\u7684\u4E00\u4EFD\u65B0\u62F7\u8D1D\u5199\u8FDB profile \u7684\u91CD\u5B9A\u5411\u69FD\u4F4D\u5E76\u66F4\u65B0\u6233\uFF1A
   curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:{port}/dsh-context-zip/wire
   \u5B83\u53EA\u91CD\u5199 profile \u91CC\u90A3\u4E00\u4EFD\u91CD\u5B9A\u5411\uFF08package.json\u3001index.js\u3001base.js \u4E0E\u6233\uFF09\uFF0C\u4E0D\u78B0\u63D2\u4EF6\u672C\u4F53\uFF0C\u5347\u7EA7\u4ECD\u8D70 dsh plugin add\u3002
2. \u515C\u5E95\uFF08\u53EA\u6709\u7B2C 1 \u6B65\u62A5\u300C\u672C\u63D2\u4EF6\u7684 redirect \u6587\u4EF6\u7F3A\u5931\u300D\u624D\u505A\uFF09\uFF1A\u8BFB {home}/profiles/{profile}/package.json\uFF0C\u770B dependencies \u91CC\u6709\u6CA1\u6709 dsh-context-zip\u3001dsh.profile.bundles \u91CC\u6709\u6CA1\u6709\u5B83\uFF1B\u786E\u5B9E\u7F3A\u4E86\u624D\u88C5\uFF1Adsh plugin --profile {profile} add dsh-context-zip\uFF0C\u88C5\u5B8C\u518D\u8DD1\u4E00\u6B21\u7B2C 1 \u6B65\u3002
3. \u786E\u8BA4\uFF1Acurl -s http://127.0.0.1:{port}/dsh-context-zip/wire \u5E94\u770B\u5230 wired:true\u3001copiedAt \u665A\u4E8E processStartedAt\uFF08\u672C\u6B21\u8FDB\u7A0B\u91CC\u72B6\u6001\u4F1A\u53D8\u6210\u300C\u7B49\u5F85\u91CD\u542F\u300D\uFF09\uFF1Bstale \u5E94\u4E3A false\uFF08\u6BCF\u6B21\u8BFB\u53D6\u73B0\u7B97\uFF0C\u63A5\u7BA1\u5199\u5B8C\u6233\u5C31\u4F1A\u7FFB\uFF09\uFF1B\u82E5\u4ECD\u4E3A true\uFF0C\u8BF4\u660E\u8FD9\u6B21\u63A5\u7BA1\u6CA1\u843D\u5230\u4F4D\uFF0C\u8BF7\u62A5\u7ED9\u6211\u3002
4. \u56DE\u62A5\uFF1A\u7B2C 1 \u6B65\u4E0E\u7B2C 3 \u6B65\u7684\u5B8C\u6574\u8FD4\u56DE\u3002
5. \u4E0D\u8981\u81EA\u884C\u91CD\u542F DSH\u3002`,
  promptUpdate: `\u80CC\u666F\uFF1A\u6211\u7684 dsh-context-zip \u63D0\u793A\u91CD\u5B9A\u5411\u9700\u8981\u66F4\u65B0\uFF08\u5B83\u5305\u4F4F\u7684\u5185\u7F6E\u538B\u7F29\u540E\u7AEF\u7248\u672C\u6BD4\u5BBF\u4E3B\u65E7\uFF09\u3002\u8BF7\u6309\u4E0B\u9762\u505A\uFF0C\u5168\u7A0B\u4E0D\u9700\u8981\u754C\u9762\u64CD\u4F5C\u3002

1. \u8BB0\u73B0\u72B6\uFF1Acurl -s http://127.0.0.1:{port}/dsh-context-zip/wire \uFF0C\u628A version \u4E0E current \u62A5\u7ED9\u6211\u3002
2. \u5237\u65B0\u91CD\u5B9A\u5411\uFF1A\u8C03\u63D2\u4EF6\u81EA\u5DF1\u7684\u63A5\u7BA1\u8DEF\u7531\uFF0C\u628A\u5185\u7F6E\u540E\u7AEF\u7684\u4E00\u4EFD\u65B0\u62F7\u8D1D\u5199\u8FDB profile \u7684\u69FD\u4F4D\u5E76\u66F4\u65B0\u6233\uFF1A
   curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:{port}/dsh-context-zip/wire
3. \u518D curl \u4E00\u6B21\u7B2C 1 \u6B65\u7684\u5730\u5740\uFF0C\u786E\u8BA4 wired:true\u3001copiedAt \u665A\u4E8E processStartedAt\uFF08\u672C\u6B21\u8FDB\u7A0B\u91CC\u72B6\u6001\u4F1A\u53D8\u6210\u300C\u7B49\u5F85\u91CD\u542F\u300D\uFF09\uFF1Bstale \u5E94\u4E3A false\uFF08\u6BCF\u6B21\u8BFB\u53D6\u73B0\u7B97\uFF0C\u63A5\u7BA1\u5199\u5B8C\u6233\u5C31\u4F1A\u7FFB\uFF09\uFF1B\u82E5\u4ECD\u4E3A true\uFF0C\u8BF4\u660E\u8FD9\u6B21\u63A5\u7BA1\u6CA1\u843D\u5230\u4F4D\uFF0C\u8BF7\u62A5\u7ED9\u6211\u3002
4. \u56DE\u62A5\u4E24\u6B21\u8FD4\u56DE\u3002\u4E0D\u8981\u81EA\u884C\u91CD\u542F DSH\u3002`,
  promptMigrate: `\u80CC\u666F\uFF1A\u6211\u7684 DSH \u4ECE 0.1.5/0.1.6 \u5347\u5230 0.1.7 \u4E4B\u540E\uFF0Cdsh-context-zip \u7684\u8BBE\u7F6E\u6CA1\u8DDF\u8FC7\u6765\uFF08\u6458\u8981\u515C\u5E95\u3001\u6458\u8981\u91CD\u6392\u53D8\u5173\uFF0C\u5DF2\u751F\u6548\u4F1A\u8BDD\u53D8\u300C\u65E0\u300D\uFF09\u3002\u539F\u56E0\u662F 0.1.7 \u628A settings.yaml \u6539\u540D\u6210 settings.yaml.imported\uFF0C\u53EA\u8FC1\u79FB\u767D\u540D\u5355\u91CC\u7684\u6BB5\uFF0C\u63D2\u4EF6\u6BB5\u88AB\u843D\u4E0B\u3002\u8BF7\u6309\u4E0B\u9762\u505A\uFF0C\u5168\u7A0B\u4E0D\u9700\u8981\u754C\u9762\u64CD\u4F5C\u3002

1. \u8BFB {home}/settings.yaml.imported\uFF08\u82E5 settings.yaml \u8FD8\u5728\u5C31\u8BFB\u5B83\uFF09\uFF0C\u628A context-zip: \u90A3\u4E00\u6BB5\u5B8C\u6574\u6284\u7ED9\u6211\u3002
2. \u5199\u8FDB {home}/profiles/{profile}/cordis.patch.yml\uFF0C\u4F5C\u4E3A id \u4E3A dsh-context-zip \u7684\u90A3\u4E00\u884C\u7684 config\u3002\u6CE8\u610F id \u5FC5\u987B\u662F dsh-context-zip\uFF0C\u4E0D\u662F context-zip\uFF1A
   - id: dsh-context-zip
     config:
       <\u628A\u90A3\u6BB5\u5B57\u6BB5\u9010\u6761\u642C\u8FC7\u6765\uFF0C\u4E00\u4E2A\u90FD\u522B\u4E22\uFF0C\u542B agents \u91CC\u6240\u6709\u4F1A\u8BDD id \u4E0E true/false>
3. \u6539\u524D\u5907\u4EFD\u8BE5\u6587\u4EF6\uFF1B\u6539\u540E\u7528 YAML \u89E3\u6790\u5668\u9A8C\u4E00\u904D\u80FD\u4E0D\u80FD\u89E3\u6790\u3002
4. \u81EA\u67E5\uFF1Acurl http://127.0.0.1:{port}/dsh-context-zip/settings \u5E94\u8FD4\u56DE\u4F60\u5199\u8FDB\u53BB\u7684\u503C\u3002
5. \u56DE\u62A5\uFF1A\u6539\u52A8\u524D\u540E\u7684\u7247\u6BB5 + \u63A5\u53E3\u8FD4\u56DE\u3002\u4E0D\u8981\u81EA\u884C\u91CD\u542F DSH\u3002`,
  promptRepair: `\u80CC\u666F\uFF1A\u6211\u7684 DSH \u4E0A dsh-context-zip \u7684\u538B\u7F29\u63A5\u7BA1\u72B6\u6001\u5F02\u5E38\uFF08\u9762\u677F\u663E\u793A\uFF1A{state}\uFF09\u3002\u8BF7\u4F60\u67E5\u6E05\u5E76\u4FEE\u597D\uFF0C\u5168\u7A0B\u4E0D\u9700\u8981\u754C\u9762\u64CD\u4F5C\u3002

1. \u6536\u96C6\u73B0\u573A\uFF1Acurl -s http://127.0.0.1:{port}/dsh-context-zip/wire \uFF0C\u628A\u5B8C\u6574\u8FD4\u56DE\u62A5\u7ED9\u6211\uFF1B\u518D\u627E\u51FA harness \u542F\u52A8\u65E5\u5FD7\u91CC\u542B dsh-context-zip \u7684\u884C\u5E76\u6458\u51FA\u6765\u3002
2. \u6309\u987A\u5E8F\u8BD5\u8FD9\u4E2A\u4FEE\u6CD5\uFF08\u505A\u5B8C\u4E00\u6B65\u5C31\u56DE\u62A5\uFF09\uFF1A\u8C03\u63D2\u4EF6\u81EA\u5DF1\u7684\u63A5\u7BA1\u8DEF\u7531\uFF0C\u628A\u5185\u7F6E\u540E\u7AEF\u7684\u4E00\u4EFD\u65B0\u62F7\u8D1D\u5199\u8FDB profile \u7684\u69FD\u4F4D\u5E76\u66F4\u65B0\u6233\uFF1A
   curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:{port}/dsh-context-zip/wire
3. \u786E\u8BA4\uFF1Acurl -s http://127.0.0.1:{port}/dsh-context-zip/wire \u5E94\u770B\u5230 wired:true\u3001copiedAt \u665A\u4E8E processStartedAt\uFF08\u672C\u6B21\u8FDB\u7A0B\u91CC\u72B6\u6001\u4F1A\u53D8\u6210\u300C\u7B49\u5F85\u91CD\u542F\u300D\uFF09\uFF1Bstale \u5E94\u4E3A false\uFF08\u6BCF\u6B21\u8BFB\u53D6\u73B0\u7B97\uFF0C\u63A5\u7BA1\u5199\u5B8C\u6233\u5C31\u4F1A\u7FFB\uFF09\uFF1B\u82E5\u4ECD\u4E3A true\uFF0C\u8BF4\u660E\u8FD9\u6B21\u63A5\u7BA1\u6CA1\u843D\u5230\u4F4D\uFF0C\u8BF7\u62A5\u7ED9\u6211\u3002
4. \u56DE\u62A5\u6BCF\u6B65\u8F93\u51FA\u3002\u4E0D\u8981\u81EA\u884C\u91CD\u542F DSH\u3002`,
  // ── 已生效会话（只读）
  agentsSection: "\u5DF2\u751F\u6548\u4F1A\u8BDD",
  showMore: "\u663E\u793A\u66F4\u591A",
  emptyList: "\u65E0",
  copySessionId: "\u590D\u5236\u4F1A\u8BDD id",
  copied: "\u5DF2\u590D\u5236",
  copyFailed: "\u590D\u5236\u5931\u8D25",
  // ── 摘要兜底
  fallbackRowLabel: "\u673A\u68B0\u6458\u8981\u515C\u5E95",
  fallbackAfterLabel: "\u5931\u8D25\u51E0\u6B21\u540E\u515C\u5E95",
  fallbackHintLabel: "\u67E5\u770B\u673A\u68B0\u6458\u8981\u515C\u5E95\u8BF4\u660E",
  fallbackHint: FALLBACK_ENABLED_COPY.zh,
  // ── 摘要重排
  rewriteRowLabel: "\u6458\u8981\u6392\u7248\u91CD\u6392",
  rewriteModelRowLabel: "\u91CD\u6392\u7528\u7684\u6A21\u578B",
  rewriteHintLabel: "\u67E5\u770B\u6458\u8981\u6392\u7248\u91CD\u6392\u8BF4\u660E",
  rewriteHint: REWRITE_ENABLED_COPY.zh,
  // ── 实验与排障：此前只在 schema 里、面板没有控件的四个键收在这里
  retrievalLabel: "\u5386\u53F2\u5DE5\u5177\u5448\u73B0",
  retrievalGranular: "\u9010\u6761",
  retrievalBatched: "\u52A0\u67E5\u627E",
  retrievalBatchedOnly: "\u4EC5\u67E5\u627E",
  retrievalSection: "\u68C0\u7D22\u8986\u76D6",
  throttleLabel: "\u68C0\u7D22\u8282\u6D41",
  traceLabel: "\u68C0\u7D22\u6253\u70B9\u6587\u4EF6",
  tracePlaceholder: "/path/to/retrieval.jsonl",
  // ── 压缩分段
  segmentsSessionLabel: "\u4F1A\u8BDD\u53F7",
  segmentsPlaceholder: "session-\u2026",
  segmentsQuery: "\u5217\u51FA\u5206\u6BB5",
  segmentsCollapse: "\u6536\u8D77\u4FE1\u606F",
  segmentsEmpty: "\u8FD9\u4E2A\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u5206\u6BB5\u3002",
  segmentsNoCurrent: "\u9875\u9762\u4E0A\u8FD8\u6CA1\u6709\u9009\u4E2D\u7684\u4F1A\u8BDD\uFF0C\u5148\u5F00\u4E00\u4E2A\u4F1A\u8BDD\u518D\u6765\u3002",
  segmentsFailed: "\u8BFB\u53D6\u5931\u8D25",
  // ── 重排用的模型清单
  rewriteProvider: "\u6765\u6E90",
  rewriteModel: "\u6A21\u578B",
  rewriteUnset: "\uFF08\u672A\u9009\u62E9\uFF09",
  rewriteGone: "\uFF08\u4E0D\u5728\u6CE8\u518C\u8868\u91CC\uFF09",
  rewriteCatalogLoading: "\u8BFB\u53D6\u6A21\u578B\u6E05\u5355\u2026",
  rewriteCatalogEmpty: "\u6CA1\u6709\u8BFB\u5230\u4EFB\u4F55\u5DF2\u6CE8\u518C\u7684\u6A21\u578B\u3002",
  rewriteCatalogFailed: "\u8BFB\u53D6\u6A21\u578B\u6E05\u5355\u5931\u8D25",
  rewriteCatalogFailures: (names) => `\u6709 ${names} \u4E2A\u6765\u6E90\u8BFB\u4E0D\u5230\u6A21\u578B\u6E05\u5355\uFF0C\u5DF2\u8DF3\u8FC7\u3002`,
  // ── 保存与装载反馈
  // 保存按钮的四种脸：保存 / 保存中 / 勾 / 保存失败。成功与失败各自只停留
  // `SAVE_FEEDBACK_MS`，随后回到「保存」。
  saveAction: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  saved: "\u5DF2\u4FDD\u5B58",
  saveFailed: "\u4FDD\u5B58\u5931\u8D25",
  loadFailed: "\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25\uFF0C\u68C0\u67E5\u5BBF\u4E3B\u662F\u5426\u52A0\u8F7D\u4E86\u672C\u63D2\u4EF6",
  loading: "\u8BFB\u53D6\u4E2D\u2026",
  // 总开关的范围句与「每次压缩前现读」这两句有守卫盯着，面板上暂时没有渲染点（总开关
  // 已换成两段控件、覆盖表已换成只读行），按 2026.09.19 F11 的先例留着不删。
  enabledHint: "\u5F00\uFF1A\u672C\u63D2\u4EF6\u538B\uFF0C\u6458\u8981\u662F\u4E94\u6BB5\u5F0F\u4EA4\u63A5\u7A3F\uFF0C\u6A21\u578B\u7684\u5DE5\u4F5C\u7B14\u8BB0\u5E76\u5165\u6458\u8981\u3002\u5173\uFF1A\u4EA4\u56DE\u5185\u7F6E\u540E\u7AEF\u538B\uFF0C\u7528\u5B83\u7684\u6458\u8981\u5199\u6CD5\uFF0C\u7B14\u8BB0\u4E0D\u53C2\u4E0E\u3002\u8FD9\u4E2A\u5F00\u5173\u53EA\u7BA1\u81EA\u52A8\u538B\u7F29\u90A3\u4E00\u6B65\uFF1B/zip-compact \u547D\u4EE4\u4E0D\u53D7\u5B83\u7BA1\uFF0C\u5173\u7740\u4E5F\u80FD\u6572\u3002",
  agentsHint: "\u952E\u586B\u4F1A\u8BDD\u53F7\u6216 agent \u9884\u8BBE\u540D\uFF0C\u503C\u8986\u76D6\u4E0A\u9762\u7684\u603B\u5F00\u5173\u3002\u4F1A\u8BDD\u53F7\u90A3\u4E00\u6863\u662F\u7528\u6765\u8BA9\u540C\u65F6\u5F00\u7740\u7684\u4E24\u4E2A\u4F1A\u8BDD\u538B\u5F97\u4E0D\u4E00\u6837\u7684\uFF1A\u6BCF\u6B21\u538B\u7F29\u524D\u73B0\u8BFB\uFF0C\u6539\u4E86\u7ACB\u523B\u5BF9\u4E0B\u4E00\u4E2A\u538B\u7F29\u6B65\u9AA4\u751F\u6548\uFF0C\u4E0D\u7528\u91CD\u542F\u3002",
  // F11 裁决：实时计数的渲染位已撤，轮询与这两条字符串暂留不删。
  effectiveLive: (on, off) => `\u672C\u8FDB\u7A0B\u6B64\u523B\u6709 ${on} \u4E2A\u4F1A\u8BDD\u7531\u672C\u63D2\u4EF6\u538B\u3001${off} \u4E2A\u7531\u5185\u7F6E\u540E\u7AEF\u538B\uFF1B\u8FD9\u662F\u6309\u5F53\u524D\u8BBE\u7F6E\u73B0\u7B97\u7684\uFF0C\u6539\u4E0A\u9762\u7684\u5F00\u5173\u4F1A\u7ACB\u523B\u6539\u53D8\u8FD9\u91CC\u7684\u6570\uFF0C\u4E5F\u4F1A\u6539\u53D8\u5DF2\u6709\u4F1A\u8BDD\u7684\u4E0B\u4E00\u6B21\u538B\u7F29\u3002`,
  effectiveStale: (count, at) => `\u4E0A\u9762\u8FD9\u884C\u6570\u5B57\u5DF2\u7ECF\u8FDE\u7740 ${count} \u6B21\u6CA1\u5237\u65B0\u4E0A\uFF08\u6700\u540E\u4E00\u6B21\u8BFB\u5230\u7684\u662F ${at}\uFF09\uFF0C\u5B83\u53EF\u80FD\u4E0D\u662F\u6B64\u523B\u7684\u771F\u5B9E\u503C\u3002\u628A\u9762\u677F\u5173\u6389\u518D\u6253\u5F00\u4F1A\u7ACB\u523B\u91CD\u8BD5\u4E00\u6B21\u3002`,
  // ── 输入框旁的模式芯片
  modeOn: "\u4E0A\u4E0B\u6587\u538B\u7F29\u65B9\u5F0F\uFF1A\u672C\u63D2\u4EF6\u3002\u4E94\u6BB5\u4EA4\u63A5\u6458\u8981\uFF0C\u538B\u7F29\u6389\u7684\u539F\u6587\u8FD8\u80FD\u6309\u4E8B\u4EF6\u53F7\u8BFB\u56DE\u3002\u62E8\u5230\u5DE6\u8FB9\u6539\u7528\u5185\u7F6E\u540E\u7AEF\uFF0C\u5F53\u524D\u4F1A\u8BDD\u7684\u4E0B\u4E00\u6B21\u538B\u7F29\u5C31\u751F\u6548\uFF0C\u4E0D\u7528\u91CD\u542F\u3002",
  modeOff: "\u4E0A\u4E0B\u6587\u538B\u7F29\u65B9\u5F0F\uFF1A\u5185\u7F6E\u540E\u7AEF\u3002\u62E8\u5230\u53F3\u8FB9\u6539\u7528\u672C\u63D2\u4EF6\uFF0C\u5F53\u524D\u4F1A\u8BDD\u7684\u4E0B\u4E00\u6B21\u538B\u7F29\u5C31\u751F\u6548\uFF0C\u4E0D\u7528\u91CD\u542F\u3002",
  modeLoading: "\u6B63\u5728\u8BFB\u53D6\u4E0A\u4E0B\u6587\u538B\u7F29\u65B9\u5F0F\u2026",
  modePending: "\u8FD9\u4E2A\u4F1A\u8BDD\u8FD8\u6CA1\u5F00\u59CB\uFF0C\u7B49\u5B83\u5EFA\u7ACB\u540E\u4F1A\u81EA\u52A8\u8BFB\u53D6\u538B\u7F29\u65B9\u5F0F\u3002",
  modeFailed: "\u8BFB\u4E0D\u5230\u4E0A\u4E0B\u6587\u538B\u7F29\u65B9\u5F0F\uFF0C\u68C0\u67E5\u5BBF\u4E3B\u662F\u5426\u88C5\u8F7D\u4E86\u672C\u63D2\u4EF6\u3002\u7A0D\u540E\u4F1A\u81EA\u52A8\u91CD\u8BD5\uFF1B\u70B9\u8FD9\u4E2A\u5F00\u5173\u53EF\u4EE5\u7ACB\u523B\u91CD\u8BD5\u3002"
};
var EN = {
  nav: "ContextZip",
  title: "ContextZip",
  groupMethod: "Compaction method",
  groupFallback: "Summary fallback",
  groupRewrite: "Summary re-layout",
  groupExperiment: "Experiments and diagnostics",
  groupExperimentTag: "unverified",
  groupSegments: "Compaction segments",
  methodLabel: "Compaction method for new sessions",
  methodPlugin: "ContextZip",
  methodDefault: "Shipped backend",
  // Compaction backend: who took over the compaction row. One title with its
  // question mark, a main line and a sub line in the middle, and a button on the
  // right only while there is still something to do.
  rowTitle: "Compaction",
  help: "Takeover is required for this plugin to work. Restart once after takeover.",
  inactiveMain: "Inactive",
  inactiveSub: "Built-in compaction is active",
  takeover: "Take over",
  takingMain: "Taking over",
  takingSub: "One moment",
  activeMain: "Active",
  activeSubPrefix: "Based on built-in",
  // Fallback for a stamp that carries no version: the sub line must print one,
  // and an empty slot is not a version.
  versionUnknown: "version unknown",
  updateMain: "Update available",
  // Same guard as the Chinese table: a part that is not there is dropped with its
  // separator, so the line can never read `Built-in , snapshot …`.
  updateTpl: (current, snapshot) => {
    const parts = [current.length > 0 ? `Built-in ${current}` : "", snapshot.length > 0 ? `snapshot ${snapshot}` : "", "reconnect to follow"];
    return parts.filter((part) => part.length > 0).join(", ");
  },
  reconnect: "Reconnect",
  restartMain: "Restart required",
  restartSub: "Takes effect on next launch",
  takenSub: "That slot is already taken, left untouched",
  incompleteMain: "Incomplete",
  incompleteSub: "One retry restores it",
  unknownMain: "Unknown",
  unknownSub: "Could not read the status",
  failMain: "Could not take over",
  retry: "Retry",
  // ── The fourth question mark: repair prompts for a takeover problem (2026.09.23)
  // Rendered only when the server's `attention` is non-null; `null` (active, or a
  // write in flight) and `foreign` (nothing here this plugin may repair) draw no
  // mark. The bubble is "one line of state + the prompt body + a copy button", and
  // the button copies the BODY alone. `{home}`, `{profile}` and `{port}` are
  // replaced with real values from `attention` and `location.port`, in the bubble
  // and in what is copied. `restart` has no prompt: only the user may restart.
  helpTopLabel: "Show the repair prompt for the current takeover problem",
  helpTopCopy: "Copy the prompt",
  helpTopWhere: (state) => `Current state: ${state}. The prompt below can be copied whole to an agent; none of it needs the UI.`,
  helpTopRestart: "It takes effect after the host restarts. Only you can do that; the prompt will not, and should not, ask an agent to restart DSH.",
  migrateMain: "Settings not migrated",
  promptInactive: `Background: my DSH has dsh-context-zip installed, but the compaction takeover is not in effect and compaction still goes through the host's built-in backend. Please do the following; none of these steps needs the UI.

1. Write the takeover (no clicking in the UI): call the plugin's own takeover route, which writes a fresh copy of the built-in backend into the profile's slot and updates the stamp:
   curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:{port}/dsh-context-zip/wire
   It rewrites only that redirect copy in the profile (package.json, index.js, base.js and the stamp); the plugin itself is left alone, so upgrades still go through dsh plugin add.
2. Fallback (only if step 1 reports this plugin's redirect files are missing): read {home}/profiles/{profile}/package.json and check that dsh-context-zip is in dependencies and in dsh.profile.bundles; only if it is really missing, install it: dsh plugin --profile {profile} add dsh-context-zip, then run step 1 again.
3. Check it yourself: curl -s http://127.0.0.1:{port}/dsh-context-zip/wire should show wired:true with copiedAt later than processStartedAt (the row reads "restart required" in this process); stale should be false (it is recomputed on every read, so it turns over as soon as the takeover writes the stamp). If it is still true, the takeover did not land; report that back to me.
4. Report back: the whole answer of steps 1 and 3.
5. Do not restart DSH yourself.`,
  promptUpdate: `Background: my dsh-context-zip says the redirect needs an update (the built-in compaction backend it wraps is older than the one the host ships). Please do the following; no UI steps at any point.

1. Record the current state: curl -s http://127.0.0.1:{port}/dsh-context-zip/wire and report version and current to me.
2. Refresh the redirect: call the plugin's own takeover route, which writes a fresh copy of the built-in backend into the profile's slot and updates the stamp:
   curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:{port}/dsh-context-zip/wire
3. curl the address from step 1 again and confirm wired:true with copiedAt later than processStartedAt (the row reads "restart required" in this process); stale should be false (it is recomputed on every read, so it turns over as soon as the takeover writes the stamp). If it is still true, the takeover did not land; report that back to me.
4. Report both answers. Do not restart DSH yourself.`,
  promptMigrate: `Background: after my DSH was upgraded from 0.1.5/0.1.6 to 0.1.7, the dsh-context-zip settings did not come along (the mechanical summary fallback and the summary re-layout turned off, and the sessions in effect became "none"). The cause is that 0.1.7 renamed settings.yaml to settings.yaml.imported and migrates only a whitelist of sections, so the plugin section was left behind. Please do the following; no UI steps at any point.

1. Read {home}/settings.yaml.imported (or settings.yaml if it is still there) and copy the whole context-zip: section back to me.
2. Write it into {home}/profiles/{profile}/cordis.patch.yml as the config of the row whose id is dsh-context-zip. Note that the id must be dsh-context-zip, not context-zip:
   - id: dsh-context-zip
     config:
       <move every field over one by one and lose none of them, including every session id under agents with its true/false>
3. Back the file up before changing it; after the change, parse it once with a YAML parser to confirm it parses.
4. Check it yourself: curl http://127.0.0.1:{port}/dsh-context-zip/settings should return the values you wrote.
5. Report back: the fragments before and after the change, plus the route's answer. Do not restart DSH yourself.`,
  promptRepair: `Background: the compaction takeover of dsh-context-zip on my DSH is in a bad state (the panel shows: {state}). Please find out why and fix it; no UI steps at any point.

1. Collect the scene: curl -s http://127.0.0.1:{port}/dsh-context-zip/wire and report the whole answer to me; then find the lines of the harness startup log that mention dsh-context-zip and quote them.
2. Try this repair in order (report after each step): call the plugin's own takeover route, which writes a fresh copy of the built-in backend into the profile's slot and updates the stamp:
   curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:{port}/dsh-context-zip/wire
3. Check it yourself: curl -s http://127.0.0.1:{port}/dsh-context-zip/wire should show wired:true with copiedAt later than processStartedAt (the row reads "restart required" in this process); stale should be false (it is recomputed on every read, so it turns over as soon as the takeover writes the stamp). If it is still true, the takeover did not land; report that back to me.
4. Report the output of every step. Do not restart DSH yourself.`,
  agentsSection: "Sessions in effect",
  showMore: "Show more",
  emptyList: "None",
  copySessionId: "Copy session id",
  copied: "Copied",
  copyFailed: "Copy failed",
  fallbackRowLabel: "Mechanical summary fallback",
  fallbackAfterLabel: "Failures allowed",
  fallbackHintLabel: "Show the mechanical summary fallback explanation",
  fallbackHint: FALLBACK_ENABLED_COPY.en,
  rewriteRowLabel: "Re-lay-out the summary",
  rewriteModelRowLabel: "Model for the re-layout",
  rewriteHintLabel: "Show the summary re-layout explanation",
  rewriteHint: REWRITE_ENABLED_COPY.en,
  retrievalLabel: "History tool presentation",
  retrievalGranular: "One by one",
  retrievalBatched: "With find",
  retrievalBatchedOnly: "Find only",
  retrievalSection: "Retrieval overrides",
  throttleLabel: "Retrieval throttle",
  traceLabel: "Retrieval trace file",
  tracePlaceholder: "/path/to/retrieval.jsonl",
  segmentsSessionLabel: "Session id",
  segmentsPlaceholder: "session-\u2026",
  segmentsQuery: "List segments",
  segmentsCollapse: "Hide segments",
  segmentsEmpty: "This session has no segments yet.",
  segmentsNoCurrent: "No session is selected on the page yet; open one first.",
  segmentsFailed: "Read failed",
  rewriteProvider: "Provider",
  rewriteModel: "Model",
  rewriteUnset: "(none)",
  rewriteGone: "(not in the registry)",
  rewriteCatalogLoading: "Reading the model catalog\u2026",
  rewriteCatalogEmpty: "No registered model was returned.",
  rewriteCatalogFailed: "Could not read the model catalog",
  rewriteCatalogFailures: (names) => `${names} provider(s) did not answer with a model list and were skipped.`,
  saveAction: "Save",
  saving: "Saving\u2026",
  saved: "Saved",
  saveFailed: "Save failed",
  loadFailed: "Could not read settings; check that the host loaded this plugin",
  loading: "Loading\u2026",
  enabledHint: "On: this plugin compacts, the summary is the five-section handoff template, and the model\u2019s working notes are merged into it. Off: the session is handed back to the shipped backend, which writes the summary its own way, and notes take no part. The switch covers the automatic step; the /zip-compact command is not gated by it and still runs while the switch is off.",
  agentsHint: "Key is a session id or an agent preset name; its value overrides the global switch. The session-id key is what lets two open sessions compact differently. It is read fresh before each compaction, so a change takes effect at the next one without a restart.",
  effectiveLive: (on, off) => `${on} live session(s) compact through this plugin right now and ${off} through the shipped backend; this is computed from the settings in force, so changing the switch above changes this count and the next compaction of sessions that already exist.`,
  effectiveStale: (count, at) => `These counts have failed to refresh ${count} time(s) (the last successful read was ${at}), so they may not be the current values. Closing and reopening the panel retries right away.`,
  modeOn: "Compaction: this plugin. Five-section handoff summary, and the replaced original text stays readable by event number. Flip left for the shipped backend; it takes effect at this session's next compaction, no restart.",
  modeOff: "Compaction: the shipped backend. Flip right to use this plugin; it takes effect at this session's next compaction, no restart.",
  modeLoading: "Reading the compaction mode\u2026",
  modePending: "This session has not started yet; the compaction mode is read as soon as it exists.",
  modeFailed: "Could not read the compaction mode; check that the host loaded this plugin. It retries on its own, and clicking this switch retries now."
};
function asTable(value) {
  return value !== null && typeof value === "object" && Array.isArray(value) === false ? value : {};
}
var LIST_PAGE = 10;
var FEEDBACK_MS = 1500;
var BUBBLE_WIDTH = 320;
var ICON_COPY = '<svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="6.4" y="1.6" width="8.8" height="10.6" rx="2.2" stroke="currentColor" stroke-width="1.5"/><rect x="2.6" y="5" width="8.8" height="10.6" rx="2.2" fill="var(--dsw-alias-bg-layer-2)" stroke="currentColor" stroke-width="1.5"/><text x="7" y="12.9" font-size="6" font-weight="600" fill="currentColor" text-anchor="middle" font-family="inherit">id</text></svg>';
var ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';
var ICON_HELP = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.5"/><text x="8" y="11.3" font-size="8.4" font-weight="500" fill="currentColor" text-anchor="middle" font-family="inherit">?</text></svg>';
var ICON_CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>';
function ContextZipSection(props) {
  const { close, ctx } = props ?? {};
  const strings = useStrings();
  const locale = React.useContext(LocaleContext);
  const [state, setState] = React.useState({
    status: "loading",
    value: null,
    effective: null,
    titles: {}
  });
  const [draft, setDraft] = React.useState(null);
  const [savePhase, setSavePhase] = React.useState("idle");
  const [sessionId, setSessionId] = React.useState(() => currentSessionId(ctx));
  const [segments, setSegments] = React.useState(null);
  const [catalog, setCatalog] = React.useState({ status: "idle", providers: [], failures: [] });
  const [liveHealth, setLiveHealth] = React.useState(() => initialLiveHealth(Date.now()));
  const [wire, setWire] = React.useState(null);
  const [wireAction, setWireAction] = React.useState(null);
  const [agentsLimit, setAgentsLimit] = React.useState(LIST_PAGE);
  const [retrievalLimit, setRetrievalLimit] = React.useState(LIST_PAGE);
  const [experimentOpen, setExperimentOpen] = React.useState(false);
  const [help, setHelp] = React.useState(null);
  const [copiedId, setCopiedId] = React.useState(null);
  const [tip, setTip] = React.useState(null);
  const bubbleRef = React.useRef(null);
  const tipRef = React.useRef(null);
  const helpWireRef = React.useRef(null);
  const helpTopRef = React.useRef(null);
  const helpFallbackRef = React.useRef(null);
  const helpRewriteRef = React.useRef(null);
  const tipTimer = React.useRef(null);
  const checkTimer = React.useRef(null);
  const saveTimer = React.useRef(null);
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
        setState((previous) => mergeLivePayload(previous, data));
      } catch {
      } finally {
        if (!cancelled) setLiveHealth((previous) => liveHealthAfter(previous, healthy, Date.now()));
      }
    };
    const stop = startLivePoll({
      read,
      intervalMs: LIVE_POLL_MS,
      doc: document,
      setTimer: setInterval,
      clearTimer: clearInterval
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
        if (data?.ok !== true) throw new Error(data?.error ?? "unavailable");
        const stored = data.value ?? {};
        setState({
          status: "ready",
          value: stored,
          effective: data.effective ?? null,
          titles: titlesFrom(data.titles)
        });
        setDraft(stored);
      } catch {
        if (!cancelled) {
          setState({ status: "error", value: null, effective: null, titles: {} });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
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
  const wireRow = React.useCallback(async () => {
    setWireAction("taking");
    setWire((current) => ({ ...current ?? {}, ok: true, wired: true, foreign: false, partial: false }));
    try {
      const response = await fetch(WIRE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json();
      if (data?.ok === true && data.wired === true) {
        setWire(data);
        setWireAction(null);
        return;
      }
      setWire((current) => ({
        ...current ?? {},
        ok: true,
        wired: true,
        error: String(data?.error ?? "unavailable"),
        attention: data?.attention ?? current?.attention ?? null
      }));
      setWireAction("failed");
    } catch (error) {
      setWire((current) => ({ ...current ?? {}, ok: true, wired: true, error: String(error?.message ?? error) }));
      setWireAction("failed");
    }
  }, []);
  const loadCatalog = React.useCallback(async () => {
    setCatalog((current) => ({ ...current, status: "loading" }));
    try {
      const data = await fetch(MODELS_ROUTE).then((response) => response.json());
      if (data?.ok !== true) throw new Error(data?.error ?? "unavailable");
      setCatalog({ status: "ready", providers: data.providers ?? [], failures: data.failures ?? [] });
    } catch (error) {
      setCatalog({ status: "error", providers: [], failures: [], message: String(error?.message ?? error) });
    }
  }, []);
  React.useEffect(() => {
    if (help === null) return void 0;
    const anchor = help === "fallback" ? helpFallbackRef.current : help === "rewrite" ? helpRewriteRef.current : help === "top" ? helpTopRef.current : helpWireRef.current;
    const bubble = bubbleRef.current;
    if (anchor === null || bubble === null) return void 0;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const at = helpBubblePlacement(
        { top: rect.top, right: rect.right, bottom: rect.bottom },
        { width: window.innerWidth, height: window.innerHeight },
        { width: BUBBLE_WIDTH, height: bubble.offsetHeight }
      );
      bubble.style.left = `${at.left}px`;
      bubble.style.top = `${at.top}px`;
      bubble.style.width = `${at.width}px`;
    };
    anchor.scrollIntoView?.({ block: "nearest" });
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [help]);
  React.useEffect(() => {
    if (help === null) return void 0;
    const onPointer = (event) => {
      const bubble = bubbleRef.current;
      if (bubble !== null && bubble.contains(event.target)) return;
      let node = event.target;
      while (node !== null && node !== void 0 && node !== document.body) {
        if (node.classList?.contains?.("dsh-context-zip__help")) return;
        node = node.parentNode;
      }
      setHelp(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setHelp(null);
    };
    document.addEventListener("click", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [help]);
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
  React.useEffect(
    () => () => {
      if (tipTimer.current !== null) clearTimeout(tipTimer.current);
      if (checkTimer.current !== null) clearTimeout(checkTimer.current);
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    []
  );
  const flashSave = React.useCallback((next) => {
    setSavePhase(next);
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = next === "saving" ? null : setTimeout(() => setSavePhase("idle"), SAVE_FEEDBACK_MS);
  }, []);
  const saveDraft = React.useCallback(async () => {
    if (draft === null) return;
    setState((current) => ({ ...current, status: "saving" }));
    flashSave("saving");
    try {
      const response = await fetch(UPDATE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft)
      });
      const data = await response.json();
      if (data?.ok !== true) throw new Error(data?.error ?? "rejected");
      const refreshed = await fetch(SETTINGS_ROUTE).then((answer) => answer.json()).catch(() => null);
      const stored = data.value ?? {};
      setState((current) => ({
        status: "ready",
        value: stored,
        effective: refreshed?.ok === true ? refreshed.effective ?? null : current.effective,
        titles: refreshed?.ok === true ? titlesFrom(refreshed.titles) : current.titles
      }));
      setDraft(stored);
      flashSave("saved");
    } catch {
      setState((current) => ({ ...current, status: "ready" }));
      flashSave("failed");
    }
  }, [draft, flashSave]);
  const editDraft = React.useCallback((change) => {
    setDraft((current) => ({ ...current ?? {}, ...change }));
  }, []);
  const loaded = state.value !== null;
  const value = draft ?? {};
  const busy = state.status === "saving";
  const dirty = loaded && draft !== null && sameSettings(state.value, draft) === false;
  const saveFace = saveButtonFace(savePhase);
  const canSave = saveButtonEnabled(dirty, savePhase, loaded);
  const pluginOn = value.enabled === true;
  React.useEffect(() => {
    if (value.rewriteEnabled !== true) return;
    if (catalog.status !== "idle") return;
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
  const chooseRewriteProvider = (event) => {
    editDraft({ rewriteProvider: event.target.value, rewriteModel: "" });
  };
  const chooseRewriteModel = (event) => {
    editDraft({ rewriteModel: event.target.value });
  };
  const setFallbackAfter = (event) => {
    const digits = String(event.target.value).replace(/[^0-9]/g, "");
    if (digits === "") return;
    const clamped = Math.min(10, Math.max(0, Number(digits)));
    editDraft({ fallbackAfterFailures: clamped });
  };
  const querySegments = async (target) => {
    const id = (typeof target === "string" ? target : sessionId).trim();
    if (id.length === 0) return;
    try {
      const response = await fetch(`${SEGMENTS_ROUTE}?sessionId=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (data?.ok !== true) throw new Error(data?.error ?? "unavailable");
      setSegments({ ok: true, lines: data.lines ?? [] });
    } catch (error) {
      setSegments({ ok: false, lines: [String(error?.message ?? error)] });
    }
  };
  const toggleSegments = () => {
    if (segments !== null) {
      setSegments(null);
      return;
    }
    void querySegments();
  };
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
    if (navigator.clipboard !== void 0 && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(id).then(
        () => settle(true),
        () => settle(false)
      );
      return;
    }
    try {
      const scratch = document.createElement("textarea");
      scratch.value = id;
      scratch.setAttribute("readonly", "");
      scratch.className = "dsh-context-zip__offscreen";
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(scratch);
      settle(ok === true);
    } catch {
      settle(false);
    }
  };
  const retrievalText = (presentation) => presentation === "batched" ? strings.retrievalBatched : presentation === "batched-only" ? strings.retrievalBatchedOnly : strings.retrievalGranular;
  const renderSessionRow = (id, presentation) => {
    const title = typeof state.titles[id] === "string" ? state.titles[id] : "";
    const named = title.length > 0;
    const children2 = [
      React.createElement(
        "span",
        {
          key: "name",
          className: `dsh-context-zip__srow-name${named ? "" : " dsh-context-zip__srow-name--id"}`,
          title: named ? id : void 0
        },
        named ? title : id
      )
    ];
    if (typeof presentation === "string" && presentation.length > 0) {
      children2.push(
        React.createElement("span", { key: "tag", className: "dsh-context-zip__srow-tag" }, retrievalText(presentation))
      );
    }
    children2.push(
      React.createElement("button", {
        key: "copy",
        type: "button",
        className: "dsh-context-zip__copy",
        "aria-label": strings.copySessionId,
        onClick: (event) => copyId(id, event.currentTarget),
        dangerouslySetInnerHTML: { __html: copiedId === id ? ICON_CHECK : ICON_COPY }
      })
    );
    return React.createElement("div", { className: "dsh-context-zip__srow", key: `srow-${id}` }, ...children2);
  };
  const renderList = (entries, limit) => {
    if (entries.length === 0) {
      return [React.createElement("div", { className: "dsh-context-zip__empty", key: "empty" }, strings.emptyList)];
    }
    return entries.slice(0, Math.min(limit, entries.length)).map((entry) => renderSessionRow(entry.id, entry.presentation));
  };
  const renderMore = (entries, limit, onMore) => React.createElement(
    "div",
    { className: "dsh-context-zip__more" },
    React.createElement(
      "button",
      {
        type: "button",
        className: "dsh-context-zip__btn dsh-context-zip__btn--flush",
        hidden: entries.length <= limit,
        onClick: onMore
      },
      strings.showMore
    )
  );
  const renderSegRow = (labelId, label, options, current, onPick) => React.createElement(
    "div",
    { className: "dsh-context-zip__row" },
    React.createElement("span", { className: "dsh-context-zip__row-label", id: labelId }, label),
    React.createElement(
      "div",
      { className: "dsh-context-zip__row-ctl" },
      React.createElement(
        "div",
        { className: "dsh-context-zip__seg", role: "group", "aria-labelledby": labelId },
        ...options.map(
          (option) => React.createElement(
            "button",
            {
              key: option.value,
              type: "button",
              className: "dsh-context-zip__seg-btn",
              "aria-pressed": current === option.value ? "true" : "false",
              disabled: busy,
              onClick: () => onPick(option.value)
            },
            option.label
          )
        )
      )
    )
  );
  const renderSwitchRow = (rowId, label, checked, onChange, helpKey, helpLabel) => React.createElement(
    "div",
    { className: "dsh-context-zip__row" },
    React.createElement("span", { className: "dsh-context-zip__row-label", id: `${rowId}-label` }, label),
    React.createElement(
      "div",
      { className: "dsh-context-zip__row-ctl" },
      React.createElement(
        "label",
        { className: "dsh-context-zip__sw" },
        React.createElement("input", {
          type: "checkbox",
          checked,
          disabled: busy,
          "aria-labelledby": `${rowId}-label`,
          onChange
        }),
        React.createElement("span", { className: "dsh-context-zip__sw-track" }),
        React.createElement("span", { className: "dsh-context-zip__sw-knob" })
      ),
      helpKey === void 0 ? null : React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-context-zip__help",
          ref: helpKey === "fallback" ? helpFallbackRef : helpRewriteRef,
          "aria-label": helpLabel,
          "aria-expanded": help === helpKey ? "true" : "false",
          "aria-describedby": `dsh-context-zip-help-${helpKey}`,
          onClick: (event) => {
            event.stopPropagation();
            setHelp((open) => open === helpKey ? null : helpKey);
          }
        },
        React.createElement("span", { dangerouslySetInnerHTML: { __html: ICON_HELP } })
      )
    )
  );
  const renderWireRow = () => {
    const status = wire === null ? "loading" : wireStatusFrom(wire, wireAction);
    const face = wireFace(status);
    const copy = wireText(status, wire, strings, locale);
    const busyNow = status === "taking";
    const click = status === "unknown" ? () => void readWire() : () => void wireRow();
    return React.createElement(
      "div",
      { className: "dsh-context-zip__wire", "data-status": status, "data-face": face, "aria-busy": busyNow ? "true" : "false" },
      React.createElement(
        "span",
        { className: "dsh-context-zip__wire-title" },
        React.createElement("span", { className: "dsh-context-zip__row-label" }, strings.rowTitle),
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-context-zip__help",
            ref: helpWireRef,
            "aria-label": strings.help,
            "aria-expanded": help === "wire" ? "true" : "false",
            "aria-describedby": "dsh-context-zip-help-wire",
            onClick: (event) => {
              event.stopPropagation();
              setHelp((open) => open === "wire" ? null : "wire");
            }
          },
          React.createElement("span", { dangerouslySetInnerHTML: { __html: ICON_HELP } })
        )
      ),
      React.createElement(
        "span",
        { className: "dsh-context-zip__wire-body", role: "status", "aria-live": "polite" },
        React.createElement(
          "span",
          { className: "dsh-context-zip__wire-main" },
          React.createElement("span", { className: "dsh-context-zip__wire-dot", "data-face": face, "aria-hidden": "true" }),
          React.createElement("span", { className: "dsh-context-zip__wire-main-text" }, copy.main)
        ),
        React.createElement("span", { className: "dsh-context-zip__wire-sub" }, copy.sub)
      ),
      copy.action === "" ? null : React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-context-zip__btn dsh-context-zip__btn--outline dsh-context-zip__wire-btn",
          disabled: busyNow,
          onClick: click
        },
        copy.action
      )
    );
  };
  const saveButton = () => {
    const label = saveFace === "saving" ? strings.saving : saveFace === "failed" ? strings.saveFailed : strings.saveAction;
    const props2 = {
      type: "button",
      className: "dsh-context-zip__save",
      "data-face": saveFace,
      disabled: canSave === false,
      "aria-label": saveFace === "check" ? strings.saved : label,
      onClick: () => void saveDraft()
    };
    if (saveFace === "check") {
      return React.createElement("button", { ...props2, dangerouslySetInnerHTML: { __html: ICON_CHECK } });
    }
    return React.createElement("button", props2, label);
  };
  const attentionHelp = () => {
    if (topPrompt === null) return [];
    return [
      React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-context-zip__help",
          ref: helpTopRef,
          "aria-label": strings.helpTopLabel,
          "aria-expanded": help === "top" ? "true" : "false",
          "aria-describedby": "dsh-context-zip-help-top",
          onClick: (event) => {
            event.stopPropagation();
            setHelp((open) => open === "top" ? null : "top");
          }
        },
        React.createElement("span", { dangerouslySetInnerHTML: { __html: ICON_HELP } })
      )
    ];
  };
  const rewritePickers = () => {
    const provider = String(value.rewriteProvider ?? "");
    const model = String(value.rewriteModel ?? "");
    const providers = [...catalog.providers ?? []];
    if (provider.length > 0 && !providers.some((entry) => entry.id === provider)) {
      providers.unshift({ id: provider, name: `${provider} ${strings.rewriteGone}`, models: [] });
    }
    const modelOptions = [...providers.find((entry) => entry.id === provider)?.models ?? []];
    if (model.length > 0 && !modelOptions.some((entry) => entry.id === model)) {
      modelOptions.unshift({ id: model, name: `${model} ${strings.rewriteGone}` });
    }
    const picker = (label, current, options, onChange) => React.createElement(
      "select",
      { className: "dsh-context-zip__select", value: current, disabled: busy, "aria-label": label, onChange },
      React.createElement("option", { value: "" }, strings.rewriteUnset),
      ...options.map(
        (option) => React.createElement("option", { key: option.id, value: option.id }, option.name || option.id)
      )
    );
    return [
      picker(strings.rewriteProvider, provider, providers, chooseRewriteProvider),
      picker(strings.rewriteModel, model, modelOptions, chooseRewriteModel)
    ];
  };
  const rewriteStatus = () => {
    const lines = [];
    if (catalog.status === "idle" || catalog.status === "loading") {
      lines.push(React.createElement("p", { className: "dsh-context-zip__hint", key: "loading" }, strings.rewriteCatalogLoading));
    }
    if (catalog.status === "error") {
      lines.push(
        React.createElement(
          "p",
          { className: "dsh-context-zip__hint", key: "error" },
          `${strings.rewriteCatalogFailed}: ${catalog.message ?? ""}`
        )
      );
    }
    if (catalog.status === "ready" && (catalog.providers ?? []).length === 0) {
      lines.push(React.createElement("p", { className: "dsh-context-zip__hint", key: "empty" }, strings.rewriteCatalogEmpty));
    }
    if ((catalog.failures ?? []).length > 0) {
      lines.push(
        React.createElement(
          "p",
          { className: "dsh-context-zip__hint", key: "failures" },
          strings.rewriteCatalogFailures((catalog.failures ?? []).map((entry) => entry.id).join(", "))
        )
      );
    }
    return lines;
  };
  const agentEntries = toRows(asTable(value.agents)).map((row) => row.key).filter((key) => isSessionKey(key)).map((key) => ({ id: key }));
  const retrievalEntries = Object.entries(asTable(value.retrievalAgents)).filter(([key]) => isSessionKey(key)).map(([key, presentation]) => ({ id: key, presentation: String(presentation ?? "") }));
  const attention = attentionOf(wire?.attention);
  const topPrompt = attention === null ? null : attentionPrompt(attention, strings, typeof location === "undefined" ? "" : location.port);
  const children = [
    // 大标题与唯一的保存按钮同一行，按钮靠最右（`.dsh-context-zip__title` 的类名与
    // 文本有判据盯着，不能动；这里只把两者放进同一个容器）。第 4 颗问号跟在保存按钮
    // 后面，只有 `attention` 非 null 时才在。
    React.createElement(
      "div",
      { className: "dsh-context-zip__title-row", key: "title" },
      React.createElement("span", { className: "dsh-context-zip__title" }, strings.title),
      saveButton(),
      ...attentionHelp()
    )
  ];
  if (state.status === "loading") {
    children.push(React.createElement("p", { key: "loading" }, strings.loading));
  }
  if (state.status === "error" && state.value === null) {
    children.push(React.createElement("p", { className: "dsh-context-zip__error", key: "error" }, strings.loadFailed));
  }
  if (state.value !== null) {
    children.push(
      React.createElement(
        "section",
        { className: "dsh-context-zip__group", key: "method" },
        React.createElement("h2", { className: "dsh-context-zip__hd" }, strings.groupMethod),
        React.createElement(
          "div",
          { className: "dsh-context-zip__rows" },
          // 压缩后端那一行是这一组的第一行，排在「新建会话默认压缩方式」上面：先回答
          // 「压缩那一行被本插件接管了没有」，再回答「选谁压」。`dsh plugin add` 装出来的
          // profile 正好是「选得了、没接管」，把它放下面会让只扫第一行的人以为已经生效。
          renderWireRow(),
          renderSegRow(
            "dsh-context-zip-method",
            strings.methodLabel,
            [
              { value: "plugin", label: strings.methodPlugin },
              { value: "default", label: strings.methodDefault }
            ],
            pluginOn ? "plugin" : "default",
            (which) => {
              setHelp(null);
              editDraft({ enabled: which === "plugin" });
            }
          )
        ),
        React.createElement(
          "h3",
          { className: "dsh-context-zip__sub", id: "dsh-context-zip-agents" },
          strings.agentsSection
        ),
        React.createElement(
          "div",
          { className: "dsh-context-zip__list", "aria-live": "polite", "aria-labelledby": "dsh-context-zip-agents" },
          ...renderList(agentEntries, agentsLimit)
        ),
        renderMore(agentEntries, agentsLimit, () => setAgentsLimit((current) => current + LIST_PAGE))
      )
    );
    if (pluginOn) {
      children.push(
        React.createElement(
          "section",
          { className: "dsh-context-zip__group", key: "fallback" },
          React.createElement("h2", { className: "dsh-context-zip__hd" }, strings.groupFallback),
          React.createElement(
            "div",
            { className: "dsh-context-zip__rows" },
            renderSwitchRow(
              "dsh-context-zip-fallback",
              strings.fallbackRowLabel,
              value.fallbackEnabled === true,
              toggleFallback,
              "fallback",
              strings.fallbackHintLabel
            ),
            value.fallbackEnabled === true ? React.createElement(
              "div",
              { className: "dsh-context-zip__row" },
              React.createElement("span", { className: "dsh-context-zip__row-label" }, strings.fallbackAfterLabel),
              React.createElement(
                "div",
                { className: "dsh-context-zip__row-ctl" },
                React.createElement("input", {
                  className: "dsh-context-zip__input dsh-context-zip__input--num",
                  type: "text",
                  inputMode: "numeric",
                  value: String(value.fallbackAfterFailures ?? 5),
                  disabled: busy,
                  "aria-label": strings.fallbackAfterLabel,
                  onChange: setFallbackAfter
                })
              )
            ) : null
          )
        )
      );
      children.push(
        React.createElement(
          "section",
          { className: "dsh-context-zip__group", key: "rewrite" },
          React.createElement("h2", { className: "dsh-context-zip__hd" }, strings.groupRewrite),
          React.createElement(
            "div",
            { className: "dsh-context-zip__rows" },
            renderSwitchRow(
              "dsh-context-zip-rewrite",
              strings.rewriteRowLabel,
              value.rewriteEnabled === true,
              toggleRewrite,
              "rewrite",
              strings.rewriteHintLabel
            ),
            value.rewriteEnabled === true ? React.createElement(
              "div",
              { className: "dsh-context-zip__row" },
              React.createElement("span", { className: "dsh-context-zip__row-label" }, strings.rewriteModelRowLabel),
              React.createElement("div", { className: "dsh-context-zip__row-ctl" }, ...rewritePickers())
            ) : null
          ),
          ...rewriteStatus()
        )
      );
    }
    children.push(
      React.createElement(
        "section",
        { className: "dsh-context-zip__group", key: "experiment", "data-open": experimentOpen ? "true" : "false" },
        React.createElement(
          "h2",
          { className: "dsh-context-zip__hd" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-context-zip__hd-btn",
              id: "dsh-context-zip-exp-toggle",
              "aria-expanded": experimentOpen ? "true" : "false",
              "aria-controls": "dsh-context-zip-exp-body",
              onClick: () => {
                setHelp(null);
                setExperimentOpen((open) => !open);
              }
            },
            strings.groupExperiment,
            React.createElement("span", { className: "dsh-context-zip__tag" }, strings.groupExperimentTag),
            React.createElement("span", {
              className: "dsh-context-zip__chev",
              dangerouslySetInnerHTML: { __html: ICON_CHEVRON }
            })
          )
        ),
        React.createElement(
          "div",
          { className: "dsh-context-zip__body", id: "dsh-context-zip-exp-body" },
          React.createElement(
            "div",
            { className: "dsh-context-zip__rows" },
            renderSegRow(
              "dsh-context-zip-retrieval",
              strings.retrievalLabel,
              [
                { value: "granular", label: strings.retrievalGranular },
                { value: "batched", label: strings.retrievalBatched },
                { value: "batched-only", label: strings.retrievalBatchedOnly }
              ],
              typeof value.retrieval === "string" ? value.retrieval : "granular",
              (which) => editDraft({ retrieval: which })
            )
          ),
          React.createElement(
            "h3",
            { className: "dsh-context-zip__sub", id: "dsh-context-zip-ret-hd" },
            strings.retrievalSection
          ),
          React.createElement(
            "div",
            { className: "dsh-context-zip__list", "aria-live": "polite", "aria-labelledby": "dsh-context-zip-ret-hd" },
            ...renderList(retrievalEntries, retrievalLimit)
          ),
          renderMore(retrievalEntries, retrievalLimit, () => setRetrievalLimit((current) => current + LIST_PAGE)),
          React.createElement(
            "div",
            { className: "dsh-context-zip__rows dsh-context-zip__rows--gap" },
            renderSwitchRow(
              "dsh-context-zip-throttle",
              strings.throttleLabel,
              value.throttle === true,
              toggleThrottle,
              void 0,
              void 0
            ),
            React.createElement(
              "div",
              { className: "dsh-context-zip__row dsh-context-zip__row--stack" },
              React.createElement(
                "div",
                { className: "dsh-context-zip__field" },
                React.createElement("span", { className: "dsh-context-zip__field-label" }, strings.traceLabel),
                React.createElement("input", {
                  className: "dsh-context-zip__input dsh-context-zip__input--mono dsh-context-zip__input--grow",
                  type: "text",
                  // 受控于草稿：每敲一个字只改本地草稿，一次写请求都不发；整份设置由
                  // 标题行的保存按钮统一提交。这个输入框保存时也不禁用，禁用一个有焦点
                  // 的元素会把焦点丢到 body，路径一路打字就会断。
                  value: String(value.tracePath ?? ""),
                  placeholder: strings.tracePlaceholder,
                  "aria-label": strings.traceLabel,
                  onChange: (event) => editDraft({ tracePath: event.target.value })
                })
              )
            )
          )
        )
      )
    );
    children.push(
      React.createElement(
        "section",
        { className: "dsh-context-zip__group", key: "segments" },
        React.createElement("h2", { className: "dsh-context-zip__hd" }, strings.groupSegments),
        React.createElement(
          "div",
          { className: "dsh-context-zip__rows" },
          React.createElement(
            "div",
            { className: "dsh-context-zip__row dsh-context-zip__row--grow" },
            React.createElement(
              "div",
              { className: "dsh-context-zip__row-ctl" },
              React.createElement("input", {
                className: "dsh-context-zip__input dsh-context-zip__input--mono dsh-context-zip__input--grow",
                type: "text",
                value: sessionId,
                placeholder: strings.segmentsPlaceholder,
                "aria-label": strings.segmentsSessionLabel,
                onChange: (event) => setSessionId(event.target.value)
              }),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-context-zip__btn dsh-context-zip__btn--outline",
                  "aria-expanded": segments === null ? "false" : "true",
                  "aria-controls": "dsh-context-zip-segments",
                  onClick: toggleSegments
                },
                segments === null ? strings.segmentsQuery : strings.segmentsCollapse
              )
            )
          )
        ),
        segments === null ? null : React.createElement(
          "pre",
          { className: "dsh-context-zip__segments", id: "dsh-context-zip-segments" },
          segments.lines.length === 0 ? strings.segmentsEmpty : segments.ok ? segments.lines.join("\n") : `${strings.segmentsFailed}: ${segments.lines.join("\n")}`
        )
      )
    );
  }
  const renderHelpBody = () => {
    if (help === null) return [];
    if (help === "fallback") return [strings.fallbackHint];
    if (help === "rewrite") return [strings.rewriteHint];
    if (help !== "top" || topPrompt === null) return [strings.help];
    const parts = [
      React.createElement("div", { className: "dsh-context-zip__prompt-state", key: "state" }, strings.helpTopWhere(topPrompt.state))
    ];
    if (topPrompt.body.length > 0) {
      parts.push(React.createElement("pre", { className: "dsh-context-zip__prompt", key: "prompt" }, topPrompt.body));
    }
    if (topPrompt.note.length > 0) {
      parts.push(React.createElement("div", { className: "dsh-context-zip__prompt-state", key: "note" }, topPrompt.note));
    }
    if (topPrompt.copyText !== null) {
      parts.push(
        React.createElement(
          "div",
          { className: "dsh-context-zip__prompt-actions", key: "actions" },
          // 复制的是提示词正文全文（`copyText` 就是替换过占位符的正文），不是气泡里
          // 那句现状，也不是带界面的东西。反馈走现成的 `__tip` 气泡。
          React.createElement("button", {
            type: "button",
            className: "dsh-context-zip__copy",
            "aria-label": strings.helpTopCopy,
            onClick: (event) => copyId(topPrompt.copyText, event.currentTarget),
            dangerouslySetInnerHTML: { __html: copiedId === "top" ? ICON_CHECK : ICON_COPY }
          })
        )
      );
    }
    return parts;
  };
  children.push(
    React.createElement(
      "div",
      {
        className: "dsh-context-zip__bubble",
        role: "dialog",
        ref: bubbleRef,
        key: "bubble",
        "data-show": help === null ? "false" : "true"
      },
      ...renderHelpBody()
    ),
    React.createElement(
      "div",
      {
        className: "dsh-context-zip__tip",
        role: "status",
        ref: tipRef,
        key: "tip",
        "data-show": tip === null ? "false" : "true"
      },
      tip === null ? "" : tip.text
    ),
    React.createElement("div", { id: "dsh-context-zip-help-wire", key: "help-wire", hidden: true }, strings.help),
    React.createElement("div", { id: "dsh-context-zip-help-fallback", key: "help-fallback", hidden: true }, strings.fallbackHint),
    React.createElement("div", { id: "dsh-context-zip-help-rewrite", key: "help-rewrite", hidden: true }, strings.rewriteHint),
    React.createElement(
      "div",
      { id: "dsh-context-zip-help-top", key: "help-top", hidden: true },
      topPrompt === null ? strings.helpTopLabel : `${strings.helpTopWhere(topPrompt.state)}
${topPrompt.body}${topPrompt.note}`
    )
  );
  return React.createElement("div", { className: "dsh-context-zip" }, ...children);
}
var ICON_COMPRESS = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.6v3.6M8 14.4v-3.6"/><path d="M5.7 3.9 8 6.2l2.3-2.3"/><path d="M5.7 12.1 8 9.8l2.3 2.3"/></svg>';
var ICON_BOOKMARK = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4.2 2.4h7.6a.9.9 0 0 1 .9.9v10.9L8 11.1l-4.7 3.1V3.3a.9.9 0 0 1 .9-.9z"/></svg>';
function currentSessionId(ctx) {
  try {
    const id = ctx?.get?.("sessions")?.list?.getSnapshot?.()?.current;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}
function glyph(html, extra) {
  return React.createElement("span", {
    className: `dsh-context-zip-mode__ic dsh-context-zip-mode__ic--${extra}`,
    dangerouslySetInnerHTML: { __html: html }
  });
}
function ModeSwitch(props) {
  const { sessionId } = props ?? {};
  const strings = useStrings();
  const [mode, setMode] = React.useState(() => rememberedMode(sessionId));
  const [busy, setBusy] = React.useState(false);
  const [failures, setFailures] = React.useState(0);
  const [named, setNamed] = React.useState(true);
  const read = React.useCallback(async () => {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      setNamed(false);
      return false;
    }
    setNamed(true);
    try {
      const answer = await fetch(`${MODE_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await answer.json();
      if (data?.ok !== true || data.mode === void 0 || data.mode === null) {
        setMode(null);
        return false;
      }
      writeModeMemory(sessionId, data.mode);
      setMode(data.mode);
      return true;
    } catch {
      setMode(null);
      return false;
    }
  }, [sessionId]);
  React.useEffect(
    () => startModeReadRetry({
      read,
      doc: document,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
      onAttempt: setFailures
    }),
    [read]
  );
  const on = mode?.compaction === "plugin";
  const failed = mode === null && failures >= 2;
  const loading = mode === void 0 || mode === null && failures < 2;
  const stuck = failed || loading;
  const entryLook = React.useRef(lastLookOn).current;
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
  const held = entryLook !== void 0 && (painted === false || !named || loading);
  const look = held ? entryLook === true : on;
  React.useEffect(() => {
    lastLookOn = look;
  });
  const flip = React.useCallback(async () => {
    if (loading || failed || busy) return;
    const want = !on;
    setBusy(true);
    const optimistic = { compaction: want ? "plugin" : "default", source: "settings", revision: null };
    writeModeMemory(sessionId, optimistic);
    setMode(optimistic);
    try {
      const current = await fetch(SETTINGS_ROUTE).then((answer2) => answer2.json());
      const agents = { ...current?.value?.agents ?? {} };
      agents[sessionId] = want;
      const answer = await fetch(UPDATE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents })
      }).then((response) => response.json());
      if (answer?.ok !== true) throw new Error(answer?.error ?? "rejected");
      await read();
    } catch {
      setMode(null);
    } finally {
      setBusy(false);
    }
  }, [busy, failed, loading, on, read, sessionId]);
  const onLabelClick = React.useCallback(
    (event) => {
      if (modeClickIntent(!stuck) !== "retry") return;
      event.preventDefault();
      setMode(void 0);
      void read();
    },
    [read, stuck]
  );
  const label = !named ? strings.modePending : failed ? strings.modeFailed : loading ? strings.modeLoading : on ? strings.modeOn : strings.modeOff;
  return React.createElement(
    "label",
    {
      className: "dsh-context-zip-mode",
      "aria-label": label,
      "data-failed": failed ? "true" : void 0,
      // `stuck` covers "loading" too, so the stylesheet can say "this is
      // clickable, it retries" without repeating the two conditions.
      "data-stuck": stuck ? "true" : void 0,
      "data-failures": failures > 0 ? String(failures) : void 0,
      // The one thing that paints the look, checked or not: `checked` stays the
      // honest state of the control, while this carries what is on screen, which
      // is the previous chip's look until this one has an answer (see `held`).
      // Kept off `className`/`aria-label`'s lines on purpose: the runtime checks
      // pin that pair's order.
      "data-look": look ? "on" : "off",
      onClick: onLabelClick
    },
    React.createElement("input", {
      type: "checkbox",
      checked: on,
      // `busy` is deliberately NOT part of this. Disabling a focused element
      // moves focus to <body> and never gives it back: the tester's trace shows
      // the second Space press landing on <body> instead of the chip, and a
      // mouse click on the chip while the composer had focus left the composer
      // unfocused with the next keystroke going nowhere. The re-entry guard at
      // the top of `flip` is what stops a double submit, not this attribute.
      disabled: stuck,
      onChange: flip
    }),
    React.createElement(
      "span",
      { className: "dsh-context-zip-mode__track" },
      React.createElement(
        "span",
        { className: "dsh-context-zip-mode__knob" },
        glyph(ICON_COMPRESS, "a"),
        glyph(ICON_BOOKMARK, "b")
      )
    )
  );
}
function useStrings() {
  const locale = React.useContext(LocaleContext);
  return locale === "en" ? EN : ZH;
}
var LocaleContext = React.createContext("zh");
var STYLE = `
/* ============================================================================
   \u5C3A\u5EA6\u4EE4\u724C\uFF1A\u5BBF\u4E3B\u8BBE\u8BA1\u4EE4\u724C\u4E00\u5F8B\u7528\u771F\u540D --dsw-alias-*\uFF0C\u53D6\u503C\u7531\u5BBF\u4E3B\u5B9A\u4E49\uFF1B\u9762\u677F\u81EA\u5DF1
   \u7684\u5C3A\u5BF8\u3001\u65F6\u957F\u3001\u5706\u89D2\u4E0E\u9634\u5F71\u6536\u5728\u8FD9\u5F20\u8868\u91CC\uFF0C\u89C4\u5219\u91CC\u4E0D\u5199\u6563\u503C\u3002
   ============================================================================ */
/* \u65F6\u957F\u4E0E\u7F13\u52A8\u662F\u9762\u677F\u548C\u8F93\u5165\u6846\u82AF\u7247\u5171\u7528\u7684\u4E00\u5BF9\uFF0C\u6240\u4EE5\u5355\u72EC\u6210\u5757\uFF0C\u9009\u62E9\u5668\u540C\u65F6\u6302\u4E24\u4E2A\u6839\uFF1A
   \u82AF\u7247\u957F\u5728\u8F93\u5165\u6846\u90A3\u4E00\u4FA7\uFF0C\u4E0D\u5728\u9762\u677F\u90A3\u68F5\u6811\u91CC\uFF0C\u7EE7\u627F\u4E0D\u5230\u9762\u677F\u90A3\u4EFD\u3002 */
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

/* \u9762\u677F\u6807\u9898\u884C\uFF08\u63D2\u4EF6\u663E\u793A\u540D\u5728\u5DE6\uFF0C\u552F\u4E00\u7684\u4FDD\u5B58\u6309\u94AE\u5728\u6700\u53F3\uFF1B\u539F\u72B6\u6001\u884C\u4E0E\u5B9E\u65F6\u8BA1\u6570\u5DF2\u64A4\uFF09 */
.dsh-context-zip__title-row{display:flex;align-items:center;gap:var(--cz-gap-md)}
.dsh-context-zip__title{font-weight:600;font-size:var(--cz-font-lg);line-height:var(--cz-line-lg);padding:6px 0 2px}

/* \u552F\u4E00\u7684\u4FDD\u5B58\u6309\u94AE\uFF1A\u810F\u4E86\u624D\u53EF\u70B9\uFF1B\u6210\u529F\u53D8\u52FE\u3001\u5931\u8D25\u7EA2\u5E95\uFF0C\u4E24\u79CD\u8138\u5404\u505C\u7559 1.5 \u79D2 */
.dsh-context-zip__save{margin-left:auto;min-width:var(--cz-save-w);min-height:32px;padding:0 12px;border-radius:var(--cz-radius-control);font-size:var(--cz-font-md);line-height:20px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease),opacity var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-context-zip__save:disabled{opacity:.4;cursor:default}
.dsh-context-zip__save[data-face="saving"]{opacity:.7}
.dsh-context-zip__save[data-face="check"]{opacity:1;cursor:default}
.dsh-context-zip__save[data-face="failed"],.dsh-context-zip__save[data-face="failed"]:hover:not(:disabled),.dsh-context-zip__save[data-face="failed"]:active{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);opacity:1}

/* \u5206\u7EC4\uFF1A\u6A2A\u7EBF\u53EA\u753B\u5728\u529F\u80FD\u5757\u4E4B\u95F4\uFF0C\u5757\u5185\u4E0D\u753B */
.dsh-context-zip__group{border-top:1px solid var(--dsw-alias-border-l1);margin-top:var(--cz-gap-lg);padding-top:var(--cz-gap-lg);display:flex;flex-direction:column}
.dsh-context-zip__hd{margin:0;font-size:var(--cz-font-md);font-weight:600;line-height:var(--cz-line-md)}
.dsh-context-zip__hd-btn{width:100%;text-align:left;padding:var(--cz-gap-xs) 0;font-weight:600;display:flex;align-items:center;gap:var(--cz-gap-sm);transition:color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__tag{font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);font-weight:400;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:2px 8px}
.dsh-context-zip__chev{margin-left:auto;display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__group[data-open="true"] .dsh-context-zip__chev{transform:rotate(90deg)}
.dsh-context-zip__group[data-open="false"] .dsh-context-zip__body{display:none}

/* \u8BBE\u7F6E\u884C\uFF08\u4E0E\u53EA\u8BFB\u884C\u540C\u9AD8\uFF0C\u884C\u4E0E\u884C\u4E4B\u95F4\u4E0D\u753B\u7EBF\uFF09 */
.dsh-context-zip__rows{display:flex;flex-direction:column}
.dsh-context-zip__rows--gap{margin-top:var(--cz-gap-md)}
.dsh-context-zip__row{display:flex;align-items:center;gap:16px;min-height:var(--cz-row-h)}
.dsh-context-zip__row-label{flex:none}
.dsh-context-zip__row-ctl{margin-left:auto;display:flex;align-items:center;gap:var(--cz-gap-sm)}
.dsh-context-zip__row--stack{display:block}
.dsh-context-zip__row--grow .dsh-context-zip__row-ctl{margin-left:0;flex:1}

/* \u5C0F\u8282\u6807\u9898\uFF08\u53EA\u8BFB\u5B50\u8868\u7684\u540D\u5B57\uFF09 */
.dsh-context-zip__sub{margin:0;padding:var(--cz-gap-md) 0 var(--cz-gap-xs);font-size:var(--cz-font-md);font-weight:500;line-height:var(--cz-line-md);color:var(--dsw-alias-label-secondary)}

/* \u5206\u6BB5\u63A7\u4EF6 */
.dsh-context-zip__seg{display:inline-flex;padding:2px;gap:2px;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--cz-radius-surface)}
.dsh-context-zip__seg-btn{min-height:32px;padding:0 14px;border-radius:var(--cz-radius-control);font-size:var(--cz-font-md);line-height:20px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-context-zip__seg-btn[aria-pressed="true"]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dsh-context-zip__seg-btn[aria-pressed="true"]:hover{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-context-zip__seg-btn:disabled{opacity:.55;cursor:default}

/* \u5F00\u5173 */
.dsh-context-zip__sw{position:relative;width:44px;height:26px;flex:none;display:inline-flex;align-items:center;cursor:pointer}
.dsh-context-zip__sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.dsh-context-zip__sw-track{width:40px;height:24px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active);border:1px solid var(--dsw-alias-border-l2);transition:background-color var(--cz-dur) var(--cz-ease),border-color var(--cz-dur) var(--cz-ease);pointer-events:none}
.dsh-context-zip__sw-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:var(--cz-shadow-knob);transition:transform var(--cz-dur) var(--cz-ease);pointer-events:none}
.dsh-context-zip__sw input:checked~.dsh-context-zip__sw-track{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.dsh-context-zip__sw input:checked~.dsh-context-zip__sw-knob{transform:translateX(16px)}
.dsh-context-zip__sw input:focus-visible~.dsh-context-zip__sw-track{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:2px}

/* \u8F93\u5165\u4E0E\u4E0B\u62C9 */
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

/* \u6309\u94AE */
.dsh-context-zip__btn{min-height:32px;padding:0 12px;border-radius:var(--cz-radius-control);font-size:var(--cz-font-md);line-height:20px;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:6px;transition:background-color var(--cz-dur) var(--cz-ease),transform var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-context-zip__btn:active{background:var(--dsw-alias-interactive-bg-active);transform:translateY(1px)}
.dsh-context-zip__btn--outline{border:1px solid var(--dsw-alias-border-l2)}
.dsh-context-zip__btn--flush{margin-left:-12px}
.dsh-context-zip__btn[hidden]{display:none}
.dsh-context-zip__more{padding-top:var(--cz-gap-sm)}

/* \u300C\u538B\u7F29\u540E\u7AEF\u300D\u884C\uFF1A\u5DE6\u6807\u9898\uFF08\u542B\u95EE\u53F7\uFF09\u3001\u4E2D\u4E3B\u526F\u884C\u3001\u53F3\u6309\u94AE\uFF0C\u662F\u300C\u538B\u7F29\u65B9\u5F0F\u300D\u7EC4\u7684\u7B2C\u4E00\u884C\u3002\u4E24\u6761\u6280\u80FD\u5305
   \u89C4\u5219\u843D\u5728\u8FD9\u4E00\u5757\uFF1A\u72B6\u6001\u70B9\u53EA\u753B\u771F\u5B9E\u7684\u8BED\u4E49\u72B6\u6001\uFF08\u672C\u63D2\u4EF6\u6709\u6CA1\u6709\u63A5\u7BA1\u538B\u7F29\u90A3\u4E00\u884C\uFF09\uFF0C\u4E0D\u505A\u88C5\u9970\uFF0C\u5168\u9762\u677F
   \u53EA\u6B64\u4E00\u9897\uFF08taste-skill \u7684 SKILL.md:683\uFF09\uFF1B\u52A8\u753B\u53EA\u4E3A\u300C\u6709\u52A8\u4F5C\u5728\u8FDB\u884C\u300D\u800C\u5B58\u5728\uFF08\u540C\u6587\u4EF6 :360\uFF09\u3002
   \u5F62\u72B6\u4E0E\u989C\u8272\u5206\u5DE5\uFF0C\u8272\u76F2\u7528\u6237\u4E5F\u80FD\u8BFB\uFF1A\u7A7A\u5FC3=\u672A\u751F\u6548\u4E0E\u52A0\u8F7D\u3001\u5B9E\u5FC3=\u5DF2\u751F\u6548\u3001\u5931\u8D25=\u5B9E\u5FC3\u52A0\u9519\u8BEF\u8272\u3001
   \u63A5\u7BA1\u4E2D=\u7A7A\u5FC3\u52A0\u4E00\u5708\u547C\u5438\u73AF\u3002\u70B9\u5BF9\u8BFB\u5C4F\u5668\u65E0\u610F\u4E49\uFF08\u72B6\u6001\u5728\u53E5\u5B50\u91CC\uFF09\uFF0C\u52A0 aria-hidden\u3002
   \u4E09\u6837\u6A2A\u6392\uFF1A\u6807\u9898\u4E0D\u4F38\u7F29\uFF0C\u4E3B\u526F\u884C\u5360\u6EE1\u4E2D\u95F4\uFF0C\u6309\u94AE\u8D34\u6700\u53F3\uFF1B\u884C\u9AD8\u53D6 --cz-row-h\uFF0C\u4E3B\u884C 22px \u52A0\u526F\u884C
   18px \u6B63\u597D\u586B\u6EE1\uFF0C\u6240\u4EE5\u6709\u6309\u94AE\u4E0E\u6CA1\u6309\u94AE\u7684\u6001\u4E00\u6837\u9AD8\u3002\u6309\u94AE\u4E0E\u8BE5\u7EC4\u5206\u6BB5\u63A7\u4EF6\u90FD\u662F\u6240\u5728\u884C\u7684\u6700\u540E\u4E00\u4E2A
   \u4F38\u7F29\u9879\u3001\u884C\u5BBD\u76F8\u540C\uFF0C\u53F3\u7F18\u56E0\u6B64\u5BF9\u9F50\uFF0C\u4E0D\u989D\u5916\u5B9A\u4F4D\u3002 */
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
/* \u63A5\u7BA1\u5728\u98DE\u65F6\u90A3\u9897\u6309\u94AE\u7981\u7528\u7F6E\u7070\uFF1A:hover \u5BF9\u7981\u7528\u6309\u94AE\u7167\u6837\u547D\u4E2D\uFF0C\u6240\u4EE5\u8FDE\u540C\u60AC\u505C\u80CC\u666F\u4E00\u8D77\u6309\u6389\u3002 */
.dsh-context-zip__wire-btn:disabled,.dsh-context-zip__wire-btn:disabled:hover{opacity:.55;cursor:default;background:none}

/* \u53EA\u8BFB\u4F1A\u8BDD\u884C\uFF08\u5DF2\u751F\u6548\u4F1A\u8BDD\u4E0E\u68C0\u7D22\u8986\u76D6\u5171\u7528\u540C\u4E00\u5957\uFF1B\u884C\u95F4\u4E0D\u753B\u7EBF\uFF09 */
.dsh-context-zip__list{display:flex;flex-direction:column}
.dsh-context-zip__srow{display:flex;align-items:center;gap:var(--cz-gap-md);min-height:var(--cz-row-h)}
.dsh-context-zip__srow-name{flex:1;min-width:0;font-size:var(--cz-font-md);line-height:var(--cz-line-md);color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-context-zip__srow-name--id{font-family:var(--cz-font-code);font-size:var(--cz-font-sm);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__srow-tag{flex:none;font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:2px 8px}
.dsh-context-zip__empty{font-size:var(--cz-font-md);line-height:var(--cz-line-md);color:var(--dsw-alias-label-caption)}

/* \u590D\u5236\u6309\u94AE\u4E0E\u884C\u5185\u53CD\u9988\u6C14\u6CE1 */
.dsh-context-zip__copy{width:var(--cz-hit);height:var(--cz-hit);border-radius:var(--cz-radius-control);flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-context-zip__copy:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-context-zip__tip{position:fixed;z-index:var(--cz-z-tip);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--cz-radius-surface);padding:4px 10px;font-size:var(--cz-font-sm);line-height:20px;color:var(--dsw-alias-label-primary);box-shadow:var(--cz-shadow-tip);opacity:0;transform:translateY(2px);transition:opacity var(--cz-dur) var(--cz-ease),transform var(--cz-dur) var(--cz-ease);pointer-events:none}
.dsh-context-zip__tip[data-show="true"]{opacity:1;transform:translateY(0)}
.dsh-context-zip__offscreen{position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none}

/* \u865A\u5316\u95EE\u53F7\u4E0E\u6D6E\u5C42\u6C14\u6CE1\uFF08\u65E0\u6307\u5411\u7BAD\u5934\uFF0C\u5706\u89D2 10px\uFF0C\u5BBD 320px\uFF09 */
.dsh-context-zip__help{width:var(--cz-hit);height:var(--cz-hit);border-radius:var(--cz-radius-control);flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-dimmed);transition:background-color var(--cz-dur) var(--cz-ease),color var(--cz-dur) var(--cz-ease)}
.dsh-context-zip__help:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__help[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__help:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-context-zip__bubble{position:fixed;z-index:var(--cz-z-bubble);width:320px;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--cz-radius-surface);padding:10px 12px;font-size:var(--cz-font-sm);line-height:1.6;color:var(--dsw-alias-label-primary);box-shadow:var(--cz-shadow-surface);text-wrap:pretty;display:none}
.dsh-context-zip__bubble[data-show="true"]{display:block}
.dsh-context-zip__prompt-state{margin:0 0 6px;color:var(--dsw-alias-label-primary)}
.dsh-context-zip__prompt{margin:0 0 6px;max-height:44vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__prompt-actions{display:flex;justify-content:flex-end;margin-top:2px}

/* \u5206\u6BB5\u7ED3\u679C */
.dsh-context-zip__segments{margin:var(--cz-gap-sm) 0 0;padding:10px 12px;border-radius:var(--cz-radius-control);background:var(--dsw-alias-interactive-bg-hover);font-family:var(--cz-font-code);font-size:var(--cz-font-sm);line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto}

/* \u72B6\u6001\u884C\u4E0E\u4FDD\u5B58\u53CD\u9988 */
.dsh-context-zip__hint{margin:var(--cz-gap-xs) 0 0;font-size:var(--cz-font-sm);line-height:var(--cz-line-sm);color:var(--dsw-alias-label-secondary)}
.dsh-context-zip__error{color:var(--dsw-alias-state-error-primary)}

@media (prefers-reduced-motion:reduce){.dsh-context-zip *,.dsh-context-zip-mode *{transition:none!important;animation:none!important}}

/* ============================================================================
   \u8F93\u5165\u6846\u65C1\u7684\u6A21\u5F0F\u82AF\u7247\u3002
   data-look \u662F\u552F\u4E00\u51B3\u5B9A\u5916\u89C2\u7684\u4E1C\u897F\uFF08checked \u53EA\u8BB0\u8D26\uFF09\uFF1A\u5207\u4F1A\u8BDD\u4F1A\u6574\u9897\u91CD\u6302\u8F7D\uFF0C
   \u65B0\u5143\u7D20\u6CA1\u6709\u300C\u4E0A\u4E00\u5E27\u300D\u53EF\u63D2\u503C\uFF0C\u6240\u4EE5\u65B0\u82AF\u7247\u5148\u6309 data-look \u753B\u4E0A\u4E00\u9897\u7684\u6837\u5B50\uFF0C\u7B49\u5B83
   \u81EA\u5DF1\u6709\u4E86\u7B54\u6848\u518D\u6539\u8FD9\u4E2A\u5C5E\u6027\uFF0C\u6539\u7684\u90A3\u4E00\u523B\u624D\u64AD\u8FC7\u6E21\u2014\u2014\u4E0E\u540C\u4E00\u9897\u82AF\u7247\u5185\u62E8\u52A8\u5F00\u5173\u65F6\u8D70\u7684
   \u662F\u540C\u4E00\u6761\u8FC7\u6E21\u3002\u65F6\u957F\u4E0E\u7F13\u52A8\u7528\u9762\u677F\u7684\u4EE4\u724C\uFF0C\u89C1\u6587\u4EF6\u9876\u90E8\u90A3\u5F20\u8868\u3002
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
function apply(ctx) {
  const style = document.createElement("style");
  style.id = "dsh-context-zip-style";
  style.textContent = STYLE;
  document.head.append(style);
  if (ctx.locale !== void 0) {
    ctx.locale.register(NS, { zh: ZH, en: EN });
  }
  const LocaleBoundSection = (props) => React.createElement(
    LocaleContext.Provider,
    { value: ctx.locale?.getLocale?.().active === "en" ? "en" : "zh" },
    // `ctx` travels as a prop because the segments field has to read the page's
    // current session selection, which is a service and not a slot prop: the
    // settings seat is root-scoped and the host passes it no session id.
    React.createElement(ContextZipSection, { ...props, ctx })
  );
  const LocaleBoundModeSwitch = (props) => React.createElement(
    LocaleContext.Provider,
    { value: ctx.locale?.getLocale?.().active === "en" ? "en" : "zh" },
    React.createElement(ModeSwitch, props)
  );
  ctx.slots.inject(
    "conversation.input.left",
    () => ctx.slots.register(
      {
        name: "conversation.input.left",
        id: "context-zip-mode",
        order: 40,
        locale: NS,
        inject: (sessionId) => ({ sessionId })
      },
      LocaleBoundModeSwitch
    )
  );
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "context-zip",
        order: 65,
        label: () => labelFor(ctx),
        locale: NS
      },
      LocaleBoundSection
    )
  );
}
function labelFor(ctx) {
  return ctx.locale?.getLocale?.().active === "en" ? EN.nav : ZH.nav;
}
var index_default = { name, inject, apply, NS };

    return module.exports;
  }
});
