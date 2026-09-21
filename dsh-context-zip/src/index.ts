/**
 * dsh-context-zip — a context-compaction plugin for the DeepSeek Harness.
 *
 * The plugin keeps one idea: compaction should not be a lossy rewrite of the
 * conversation. It replaces the shipped summarizer with a five-section handoff
 * summary, keeps a durable directory of every compaction segment, lets the model
 * (and a human) read the replaced text back, and optionally lets the model keep
 * short working notes that feed the next summary.
 *
 * It mounts as the `compaction-basic` row's replacement, so `ctx.compaction`
 * keeps exactly one implementation and every existing consumer of the seam —
 * automatic pressure compaction, overflow recovery, and `/compact` — keeps
 * working unchanged.
 *
 * @module dsh-context-zip
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

import {
  setSharedFallbackReader,
  setSharedModeReader,
  setSharedNotesReader,
  setSharedRewriteReader,
  runManualCompaction,
} from 'dsh-context-zip-engine';
import { PROBE_TIMEOUT_MS, probeModel, readModelCatalog } from './models.ts';
import { ContextZipService, registerExportCommand } from './export.ts';
import {
  ManualTargetError,
  planManualCompaction,
  readFailureCount,
  registerManualCompactCommand,
} from './manual.ts';
import { NoteStore } from './notes.ts';
import {
  COMPACTED_ANSWER_GUIDANCE,
  NOTES_GUIDANCE,
  NOTES_MAX_CHARS,
  NOTES_REMINDER_INSTRUCTION,
  REMINDER_THRESHOLD_PERCENT,
  SUMMARY_HARD_CAP_TOKENS,
  SUMMARY_SOFT_TARGET_TOKENS,
} from 'dsh-context-zip-engine/prompt';
import { latestContextWindow, loadSegments, readSessionEvents } from './segments.ts';
import { registerRoutes } from './routes.ts';
import { createTitleMemo, sessionTitlesFor } from './session-titles.ts';

// The panel's title read used to live in this module; it moved to
// `./session-titles.ts` so the memo and the fold share one home. Re-exported
// here because this module is the plugin's public entry.
export { sessionTitlesFor };
import { FALLBACK_ENABLED_COPY, REWRITE_ENABLED_COPY } from './panel-copy.ts';
import { registerTools, setThrottleEnabled, setThrottleListener, setTracePath } from './tools.ts';

/** Plugin name as it appears in the composed tree and the logs. */
export const name = 'dsh-context-zip';

/**
 * Services this plugin cannot work without, in the Cordis `inject` shape.
 *
 * Cordis normalizes `inject` to a `service name -> intercept config` map and
 * waits for every name in it, so the list must contain only services that are
 * genuinely required: an entry that never appears would park the row forever
 * and take the whole profile down with it.
 *
 * `compaction` is deliberately absent even though this plugin is the compaction
 * backend's other half: it supplies that service rather than consuming it, and a
 * required self-inject would leave the row parked on any tree where no other
 * component happened to ask for compaction. Because Cordis refuses to read a
 * service property that was not injected, every service outside this list is
 * reached through `ctx.get(...)` at the point of use, which returns undefined
 * instead of throwing. Each one degrades a single feature rather than the load:
 * without `settings` every session runs the default mode, without `sessionQuery`
 * the tools answer from the live log, without `commands` the export command is
 * not registered, without `systemPrompt` the resident notes guidance is not
 * added, without `webServer` the settings section has no route to talk to, and
 * without `agents` the pressure reminder and the archive hooks skip cleanly.
 */
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions'];

/**
 * Prompt-section placement for this plugin's two contributions.
 *
 * The harness owns a fixed `SECTION_ORDERS` table, so `getSectionOrder` only
 * resolves names the harness itself registered and returns `undefined` for
 * anything else, which `section()` then rejects as a non-finite order. A plugin
 * therefore cannot look its placement up and must name a number.
 *
 * These two sit in the unclaimed band between the last harness tool section
 * (`TOOL_REPORT`, 2900) and the SDK section (`TOOLS_SDK`, 5000): after every
 * built-in tool's guidance, before the sections that are not about tools at all.
 */
const NOTES_GUIDANCE_ORDER = 3000;
const COMPACTED_ANSWER_ORDER = 3100;

/** Settings namespace owned by this plugin. */
/** Throttle starts off: its effect was never established. See D26. */
const DEFAULT_THROTTLE = false;

/** Attempts allowed to fail before the mechanical fallback fires. See the schema entry. */
const DEFAULT_FALLBACK_AFTER_FAILURES = 5;

/** 格式改写默认关闭：它多花一次模型调用，用户拍板由用户显式打开。 */
const DEFAULT_REWRITE_ENABLED = false;

export const SETTINGS_NS = 'context-zip';

/** Default per-session compaction mode; a new session ships on the shipped backend. */
const DEFAULT_ENABLED = false;

/**
 * Settings shape: one global switch plus a per-session override table.
 *
 * The switch selects which summarizer a session compacts with, not merely
 * whether notes are recorded. `true` means this plugin's five-section handoff
 * template plus working notes; `false` delegates that session back to the
 * shipped backend, cap and wording included. Notes have no meaning on their own:
 * they only exist to be merged into this plugin's summary, so the two cannot be
 * separate switches without inventing a state where the model writes notes
 * nothing will ever read.
 */
export const ContextZipSettings = z.object({
  enabled: z
    .boolean()
    .default(DEFAULT_ENABLED)
    .description(
      'Compact new sessions with this plugin: the five-section handoff template plus working notes merged into the summary. Off delegates to the shipped backend.',
    ),
  agents: z
    .dict(z.boolean())
    .default({})
    .description(
      'Per-session override: the map key is an agent preset name or a session id, and it overrides the global switch for that session. Session ids let two sessions open at once compact differently.',
    ),
  retrieval: z
    .union(['granular', 'batched', 'batched-only'])
    .default('granular')
    .description(
      'How the history review tools are presented. "granular" (default) hides history_find and keeps one call per query, exactly as before this option existed. "batched" adds history_find alongside them. "batched-only" hides history_search, so several query terms and the stopping rule go in one call; measured runs on a fixed task put it at 9/10/12 answer-round round trips against 2 for "granular", so it is kept as an experimental arm rather than recommended.',
    ),
  retrievalAgents: z
    .dict(z.union(['granular', 'batched', 'batched-only']))
    .default({})
    .description(
      'Per-session override for "retrieval", keyed the same way as "agents": a session id or an agent preset name, session id first.',
    ),
  throttle: z
    .boolean()
    .default(DEFAULT_THROTTLE)
    .description(
      'Let the retrieval throttle change what the model sees: a receipt saying what this turn has already returned, withholding of events already returned in full, a pause on history_search and history_find after two consecutive zero-novelty sweeps, and a cap on how much one read may return. Off (the default) leaves every tool behaving as it did before the throttle existed. The ledger and the tracePath log still run while off, so an unthrottled baseline stays measurable. The effect was never established: over three runs of the same four cells the token ratio against baseline ranged from 0.10x to 8.46x, and published work on aggressive retrieval throttling reports accuracy losses.',
    ),
  fallbackEnabled: z
    .boolean()
    .default(false)
    .description(FALLBACK_ENABLED_COPY.en),
  fallbackAfterFailures: z
    .number()
    .default(DEFAULT_FALLBACK_AFTER_FAILURES)
    .description(
      'How many compaction attempts may fail before the fallback fires, counting attempts rather than model calls. 5 (the default) means attempts 1 through 5 use the model and attempt 6 is mechanical. 0 means the first failure falls back immediately. Range 0 to 10; values outside it are clamped. Only meaningful while "fallbackEnabled" is on: with it off, reaching this count reports the failure instead. Each attempt already retries once internally for the two kinds of failure a retry can fix, so this counts attempts, not calls.',
    ),
  rewriteEnabled: z
    .boolean()
    .default(DEFAULT_REWRITE_ENABLED)
    .description(REWRITE_ENABLED_COPY.en),
  rewriteProvider: z
    .string()
    .default('')
    .description(
      'Provider route the layout-only rewrite calls. Empty (the default) means nothing is selected, and the rewrite does not run. The provider must be registered in the live LLM registry; saving a selection probes it once with a minimal request and refuses to save when the probe fails.',
    ),
  rewriteModel: z
    .string()
    .default('')
    .description(
      'Model id the layout-only rewrite calls, within "rewriteProvider". Empty (the default) means nothing is selected. Together with the provider it forms the route; both fields must be set for the rewrite to run.',
    ),
  tracePath: z
    .string()
    .default('')
    .description(
      'Optional file to append one JSON line per history retrieval to. Empty (the default) writes nothing. Use it to see how the retrieval throttle behaves: each line carries the turn, the retrieval number, whether it was a sweep or a read, how many events were new, how many were withheld as already-held, the zero-novelty streak, and whether narrowing is in force. This harness ships no logger exporter, so plugin logs reach only an in-memory buffer; a file is the one place the numbers can actually be read from.',
    ),
});

/** One resolved settings value. */
type SettingsValue = {
  enabled?: boolean;
  agents?: Record<string, boolean>;
  retrieval?: RetrievalPresentation;
  retrievalAgents?: Record<string, RetrievalPresentation>;
  throttle?: boolean;
  fallbackEnabled?: boolean;
  fallbackAfterFailures?: number;
  rewriteEnabled?: boolean;
  rewriteProvider?: string;
  rewriteModel?: string;
  tracePath?: string;
};

/**
 * The last settings resolution this plugin observed.
 *
 * `userEnabled` and `userAgents` record which fields the STORED user section
 * actually names, because the schema supplies a default for every field: without
 * them, "the user turned it off" and "nobody ever configured it" are the same
 * resolved value, and the spec asks for those to stay distinguishable.
 */
const settingsState: {
  value: SettingsValue | null;
  revision: number | undefined;
  userEnabled: boolean;
  userAgents: Set<string>;
  /** Whether the stored user section names the retrieval presentation. */
  userRetrieval: boolean;
  /** Agent/preset keys the stored user section names for retrieval. */
  userRetrievalAgents: Set<string>;
} = {
  /** Resolved value, or null when no settings provider is composed. */
  value: null,
  /** Monotonic revision of the raw user section, when the provider reports one. */
  revision: undefined,
  /** Whether the stored user section names the global switch. */
  userEnabled: false,
  /** Whether the stored user section names the retrieval presentation. */
  userRetrieval: false,
  /** Agent/preset keys the stored user section names for retrieval. */
  userRetrievalAgents: new Set(),
  /** Agent/preset keys the stored user section names. */
  userAgents: new Set(),
};

/**
 * Work out the settings value a patch asks for, given the value in force.
 *
 * Split out from the write route so the rule can be tested without a settings
 * service: the caller's `agents` map REPLACES the stored one, so a key left out
 * is a key deleted.
 *
 * @param current - the value in force right now.
 * @param patch - the caller's request; only `enabled` and `agents` are read.
 * @returns the finished value, or null when the patch asked for nothing.
 */
export function applySettingsPatch(current: SettingsValue, patch: unknown): SettingsValue | null {
  const source = (
    patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  ) as Record<string, unknown>;
  // 每个本函数不"拥有"的字段都要**原样带过去**。
  //
  // 根因在这次改动之前就存在：写路由最后调的是 `scope.replace(next)`，它把整段设置
  // 换成 `next`。原先 `next` 只带 enabled/agents/retrieval/retrievalAgents 四个键，
  // 于是「保存一次覆盖表」会把 throttle/fallbackEnabled/fallbackAfterFailures/
  // tracePath 一起从存储段里抹掉，schema 再给它们补回默认值——用户打开过的机械兜底
  // 会被下一次别的保存悄悄关掉。原先没暴露，是因为面板一直把整份设置发回来，而这些
  // 字段当时恰好没有单独的可写入口；一旦加了格式改写这条同样走 replace 的路径，
  // 每保存一次改写设置就会重置一次兜底开关。
  //
  // 带过去的取值是"补丁里写了就用补丁的，没写就用当前生效的"。它们来自 `scope.get()`，
  // 已经是解析过默认值的值，所以写回去不改变生效结果。
  const next: SettingsValue = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : current.enabled,
    agents: { ...(current.agents ?? {}) },
    retrieval: RETRIEVAL_VALUES.includes(source.retrieval as RetrievalPresentation)
      ? (source.retrieval as RetrievalPresentation)
      : current.retrieval,
    retrievalAgents: { ...(current.retrievalAgents ?? {}) },
    throttle: typeof source.throttle === 'boolean' ? source.throttle : current.throttle,
    fallbackEnabled: typeof source.fallbackEnabled === 'boolean' ? source.fallbackEnabled : current.fallbackEnabled,
    fallbackAfterFailures:
      typeof source.fallbackAfterFailures === 'number' && Number.isFinite(source.fallbackAfterFailures)
        ? source.fallbackAfterFailures
        : current.fallbackAfterFailures,
    rewriteEnabled: typeof source.rewriteEnabled === 'boolean' ? source.rewriteEnabled : current.rewriteEnabled,
    rewriteProvider: typeof source.rewriteProvider === 'string' ? source.rewriteProvider : current.rewriteProvider,
    rewriteModel: typeof source.rewriteModel === 'string' ? source.rewriteModel : current.rewriteModel,
    tracePath: typeof source.tracePath === 'string' ? source.tracePath : current.tracePath,
  };
  let touched =
    typeof source.enabled === 'boolean' ||
    typeof source.throttle === 'boolean' ||
    typeof source.fallbackEnabled === 'boolean' ||
    typeof source.fallbackAfterFailures === 'number' ||
    typeof source.rewriteEnabled === 'boolean' ||
    typeof source.rewriteProvider === 'string' ||
    typeof source.rewriteModel === 'string' ||
    typeof source.tracePath === 'string' ||
    RETRIEVAL_VALUES.includes(source.retrieval as RetrievalPresentation);
  if (source.retrievalAgents !== null && typeof source.retrievalAgents === 'object' && !Array.isArray(source.retrievalAgents)) {
    const entries = Object.entries(source.retrievalAgents);
    const table: Record<string, RetrievalPresentation> = {};
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue;
      if (!RETRIEVAL_VALUES.includes(value as RetrievalPresentation)) continue;
      table[key] = value as RetrievalPresentation;
    }
    // Same rule as the compaction table: a request that made every row unusable
    // asked for no such clearing, so it must not clear anything.
    if (entries.length > 0 && Object.keys(table).length === 0) {
      throw new Error('every row in retrievalAgents was unusable: keys must be non-empty and values one of granular/batched/batched-only');
    }
    next.retrievalAgents = table;
    touched = true;
  }
  if (source.agents !== null && typeof source.agents === 'object' && !Array.isArray(source.agents)) {
    const entries = Object.entries(source.agents);
    const agents: Record<string, boolean> = {};
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue;
      if (typeof value !== 'boolean') continue;
      agents[key] = value;
    }
    // Dropping an unusable row is the right call when the caller also sent good
    // ones, and the panel does send the whole table. But when EVERY row was
    // unusable the result is an empty table, and submitting that would clear the
    // table on the strength of a request that asked for no such thing.
    // `{"agents":{"session-x":null}}` reached exactly that state.
    if (entries.length > 0 && Object.keys(agents).length === 0) {
      throw new Error('every row in agents was unusable: keys must be non-empty and values boolean');
    }
    next.agents = agents;
    touched = true;
  }
  return touched ? next : null;
}

/** The engine class the redirect built over the shipped backend, injected at apply time. */
let engineClass: Function | null = null;

/**
 * Inject the engine class the loader mounted for the `compaction-basic` row.
 *
 * Tests call this before {@link apply}; the profile's redirect package supplies
 * the class that actually ships.
 *
 * @param EngineClass - a CompactionEngine subclass.
 */
export function setEngineClass(EngineClass) {
  engineClass = EngineClass;
}

/** The engine class in effect; the redirect's class is resolved lazily. */
async function resolveEngineClass() {
  if (engineClass !== null) return engineClass;
  // The redirect package is named after the shipped backend it replaces, so the
  // module namespace holds both the backend's own exports and the plugin's
  // engine. Only the plugin's class is wanted here.
  const namespace = await import('@deepseek-ai/dsh-compaction-basic');
  // The redirect package is named after the shipped backend it replaces, so its
  // declarations describe the backend, not the engine this plugin adds on top.
  const redirect = namespace as unknown as Record<string, unknown>;
  engineClass = (redirect.ContextZipEngine ?? redirect.default) as Function;
  return engineClass;
}

/**
 * Compose the plugin.
 *
 * @param ctx - plugin context.
 * @returns the disposer that unloads everything this plugin added.
 */
export async function apply(ctx) {
  const noteStore = new NoteStore();
  // Keyed by session id, never by the Session object: the session handed to a
  // listener is a scope proxy, so object identity does not survive from
  // `session/created` to a tool call and a WeakMap keyed by it never matches.
  const reminded = new WeakSet();
  // Seq of the most recent assistant message, per session. `history_search`
  // bounds itself just below it so a search cannot match the turn asking for it.
  //
  // The assistant message is the right landmark rather than the last completed
  // step: a tool call always follows the assistant message that requested it, and
  // that message carries the model's own wording of the query. Anchoring on
  // `step/end` instead left the very first step of a session unbounded, where the
  // search still matched the assistant message and the call that produced it.
  const lastAssistantSeqs = new Map();
  let chain = Promise.resolve();

  // Every service outside `inject` may still be missing when this plugin
  // activates: the loader starts a row as soon as the four required services
  // exist, and `settings` in particular is composed later than this row. A
  // one-shot `ctx.get` here would therefore lose the settings namespace for the
  // whole process. `ctx.inject` starts a child fiber the moment the named
  // services appear, which is the supported way to depend on something optional.
  let scope = null;
  const optionalFibers = [];
  const whenAvailable = (names, callback) => {
    try {
      optionalFibers.push(ctx.inject(names, callback));
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] deferring on ${names.join(', ')} failed: ${String(error)}`);
    }
  };

  /**
   * One restriction layer per agent, so the presentation can be changed and lifted
   * without stacking masks: restrictions INTERSECT, so a second deny for a mode the
   * agent has left behind would never lift.
   */
  const retrievalLayers = new Map();

  /**
   * Sessions whose sweep tools are currently withheld by the retrieval throttle.
   *
   * Keyed by agent because the mask is; set from the tools layer, which owns the
   * per-turn ledger. Not persisted: a restart restores full tooling, which is the
   * safe direction to fail in.
   */
  const throttledAgents = new Set();

  /**
   * Apply one agent's retrieval presentation to what its model can see.
   *
   * `tools.restrict` is deliberately not callable from a context-global scope — the
   * registry throws "tools.restrict() requires a scoped context (agent.ctx)" — so
   * this runs per agent, and the layer is lifted the moment the setting changes.
   *
   * A failure is logged and swallowed: hiding a tool is a presentation choice, and a
   * session whose tools are all visible is a working session, not a broken one.
   *
   * @param agent - the agent whose next prompt assembly should see the new set.
   */
  const applyRetrievalVisibility = (agent) => {
    const previous = retrievalLayers.get(agent);
    if (previous !== undefined) {
      retrievalLayers.delete(agent);
      try {
        previous();
      } catch {
        // A layer already unwound with its scope is not an error.
      }
    }
    let mode;
    try {
      mode = resolveRetrieval(agent.session).retrieval;
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] reading the retrieval setting for one session failed: ${String(error)}`);
      return;
    }
    // `granular` hides the batch tool, which keeps the released behavior exactly.
    // `batched-only` hides the single-term search, so several terms and the stopping
    // rule have to travel in one call. `batched` denies nothing.
    const deny =
      mode === 'granular' ? ['history_find'] : mode === 'batched-only' ? ['history_search'] : [];
    // The throttle adds to the SAME layer rather than stacking its own. Restrictions
    // intersect, so a second layer could never be lifted while this one stayed.
    // `history_read` is deliberately never denied: it is the exact instrument, and the
    // measured cost of withholding the sweep tools is that 21% of cells find their
    // answer after the streak trips. Keeping reads keeps those reachable.
    if (throttledAgents.has(agent)) deny.push('history_find', 'history_search');
    const unique = [...new Set(deny)];
    if (unique.length === 0) return;
    try {
      retrievalLayers.set(agent, agent.ctx.tools.restrict({ deny: unique }));
    } catch (error) {
      ctx.logger?.warn?.(
        `[context-zip] the retrieval presentation for one session could not be applied: ${String(error)}`,
      );
    }
  };

  /** Re-apply the presentation to every live agent, after a settings edit. */
  const refreshRetrievalVisibility = () => {
    for (const agent of ctx.get('agents')?.list() ?? []) {
      if (retrievalLayers.has(agent) || resolveRetrievalSafe(agent)) applyRetrievalVisibility(agent);
    }
  };

  /**
   * Read the mode without letting a bad snapshot abort the sweep.
   *
   * The catch used to return without a word, so a session whose setting could not be
   * read silently kept whatever tools it had and nothing anywhere said so. A failure
   * that leaves a feature off has to be visible: the log is the only place that can
   * carry it here, because the sweep runs outside any one agent's turn.
   */
  const resolveRetrievalSafe = (agent) => {
    try {
      return resolveRetrieval(agent.session).retrieval !== 'batched';
    } catch (error) {
      ctx.logger?.warn?.(
        `[context-zip] the retrieval mode for one session could not be read, so its tool presentation was left unchanged: ${String(error)}`,
      );
      return false;
    }
  };

  whenAvailable(['settings'], (scoped) => {
    const settings = scoped.settings;
    scope = settings.register(SETTINGS_NS, ContextZipSettings, {
      base: { enabled: DEFAULT_ENABLED, agents: {} },
      applies: 'live',
    });
    const reportSwitch = (message) => ctx.logger?.info?.(`[context-zip] ${message}`);
    refreshSettings(scope, settings, reportSwitch);
    try {
      scope.watch(() => {
        refreshSettings(scope, settings, reportSwitch);
        // A presentation change has to reach sessions that are already open: the
        // restriction is a live mask, not a property frozen at creation.
        refreshRetrievalVisibility();
      });
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] watching the settings namespace failed: ${String(error)}`);
    }
  });

  /** Serialize every asynchronous bookkeeping step so two events never race. */
  const sequence = (task) => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // Resolved live, on every read, from the settings in force right now. Nothing
  // is frozen at session creation, so editing the settings changes what the
  // sessions already open do — including the override table, which is what makes
  // a session-id row reachable: the id exists the moment the session does, and
  // the very next `summarize()` honours the row.
  //
  // The cost is that a session's mode is not a property it carries; it is a
  // function of the settings at the moment you ask. Two sessions in one process
  // can therefore compact differently, and the same session can change its mind
  // between compactions.
  const modeFor = (session) => resolveMode(session);
  const isPluginMode = (session) => modeFor(session).compaction === 'plugin';

  // Resolve the backend only to fail loudly when the redirect is missing. The
  // engine instance itself is built by the `compaction-basic` row; constructing
  // a second one here would register the `compaction` service twice and crash
  // the profile.
  const EngineClass = await resolveEngineClass();
  if (typeof EngineClass !== 'function') {
    throw new Error('the compaction backend is unavailable: the compaction-basic row resolves to a package that exports no engine class');
  }
  const undoNotesReader = setSharedNotesReader((sessionId) => noteStore.read(sessionId));
  // The engine half reads this to decide which summarizer one session gets. It
  // is synchronous on purpose: `summarize()` must not await a filesystem read to
  // learn something the in-memory snapshot already knows.
  const undoModeReader = setSharedModeReader((session) => resolveMode(session).compaction);
  // 兜底档位。与上面两个 reader 一样是**同步**的：`summarize()` 已经失败在即，
  // 不该再为读一个内存里的设置去等文件系统。读不到就由引擎侧按保守档处理。
  const undoFallbackReader = setSharedFallbackReader(() => ({
    enabled: settingsState.value?.fallbackEnabled === true,
    after: settingsState.value?.fallbackAfterFailures,
  }));
  // 格式改写档位。同样同步：`summarize()` 走到这里时摘要已经写出来了，不该为了读
  // 一个内存里的设置去等文件系统；读不到就由引擎侧按"没开"处理。
  const undoRewriteReader = setSharedRewriteReader(() => ({
    enabled: settingsState.value?.rewriteEnabled === true,
    provider: settingsState.value?.rewriteProvider ?? '',
    model: settingsState.value?.rewriteModel ?? '',
  }));

  whenAvailable(['systemPrompt'], (scoped) => {
    // The one thing this plugin says about itself unprompted: how to answer when
    // the user notices that older context is gone. It holds for BOTH modes,
    // because a session compacted by the shipped backend also lost its earlier
    // text, and the review tools that read it back are registered either way.
    scoped.systemPrompt.section({
      name: 'context-zip:compacted-answer',
      order: COMPACTED_ANSWER_ORDER,
      text: () => COMPACTED_ANSWER_GUIDANCE,
    });
  });

  // One fiber per agent, holding that agent's scoped notes-guidance section.
  const guidanceFibers = new Map();
  const mountGuidance = (agent) => {
    if (guidanceFibers.has(agent)) return;
    try {
      // The section has to be registered inside the AGENT's scope, not globally.
      // `PromptSection.text` is evaluated with only `{scope, signal}` and carries
      // no session identity, so a global section cannot tell which session it is
      // being assembled for; a closure over `agent` can. Registering it per agent
      // is also what makes the scoped section shadow the global one, so the
      // decision is per session instead of per profile. This mirrors the shipped
      // `dsh-file-reference-local`, which solves the same problem the same way.
      const fiber = agent.ctx.inject(['systemPrompt'], (scoped) => {
        scoped.systemPrompt.section({
          name: 'context-zip:notes-guidance',
          order: NOTES_GUIDANCE_ORDER,
          // An empty string, not an absent section: the scoped section has to
          // exist to shadow anything a wider scope contributes under this name.
          text: () => (isPluginMode(agent.session) ? NOTES_GUIDANCE : ''),
        });
      });
      guidanceFibers.set(agent, fiber);
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] mounting the notes guidance failed: ${String(error)}`);
    }
  };

  /**
   * The one wire between the per-turn retrieval ledger and the per-agent mask.
   *
   * The ledger lives with the tools and the mask has to live with the agent, so neither
   * side can decide alone. The listener is what lets a zero-novelty streak reach the
   * tool roster, and what lifts it again when a search starts paying off.
   */
  setThrottleListener((session, narrowed) => {
    let agents;
    try {
      agents = ctx.get('agents')?.list() ?? [];
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

  ctx.on('agent/created', ({ agent }) => {
    mountGuidance(agent);
    applyRetrievalVisibility(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const layer = retrievalLayers.get(agent);
    if (layer !== undefined) {
      retrievalLayers.delete(agent);
      try {
        layer();
      } catch {
        // The scope is going away with it; a failed lift changes nothing.
      }
    }
    const fiber = guidanceFibers.get(agent);
    if (fiber === undefined) return;
    guidanceFibers.delete(agent);
    try {
      void fiber.dispose();
    } catch (error) {
      ctx.logger?.warn?.(`[context-zip] disposing the notes guidance failed: ${String(error)}`);
    }
  });

  ctx.on('session/event', (session, event) => {
    // A user message opens a turn, and the ledger is keyed by turn. Lifting here rather
    // than waiting for the next retrieval matters: the model would otherwise open a new
    // turn with the sweep tools still hidden and no way to ask for them back.
    if (event.type === 'user/message') {
      for (const agent of ctx.get('agents')?.list() ?? []) {
        if (agent?.session?.id !== session.id) continue;
        if (!throttledAgents.has(agent)) continue;
        throttledAgents.delete(agent);
        applyRetrievalVisibility(agent);
      }
    }
    if (event.type === 'compaction/summary') {
      void sequence(async () => {
        const segments = await loadSegments(ctx, session);
        const last = segments[segments.length - 1];
        if (last === undefined) return;
        const archived = await noteStore.archive(session.id, last.ordinal);
        if (archived !== null) ctx.logger?.debug?.(`[context-zip] archived working notes to ${archived}`);
      });
      return;
    }
    if (event.type === 'compaction/end') {
      const agent = ctx.get('agents')?.get(session.id);
      if (agent !== undefined) reminded.delete(agent);
      return;
    }
    if (event.type === 'assistant/message') {
      lastAssistantSeqs.set(session.id, event.seq);
      return;
    }
    if (event.type !== 'step/end') return;
    const agent = ctx.get('agents')?.get(session.id);
    if (agent === undefined || reminded.has(agent)) return;
    if (!isPluginMode(session)) return;
    // Reserve this cycle before the async measurement so two step boundaries
    // cannot both fire a reminder.
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
          `[context-zip] notes reminder delivered at ${Math.round(ratio * 100)}% context pressure`,
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
      return typeof seq === 'number' && seq > 0 ? seq - 1 : undefined;
    },
    warn: (message) => ctx.logger?.warn?.(`[context-zip] ${message}`),
  });
  const service = new ContextZipService(ctx);
  // One implementation behind both manual entrances. The slash command and the
  // settings-panel button must not be able to disagree about which session they
  // act on or how the count is measured, so neither builds its own.
  const manual = createManualActions(ctx);
  whenAvailable(['commands'], (scoped) => registerExportCommand(scoped));
  whenAvailable(['commands'], (scoped) => registerManualCompactCommand(scoped, manual));
  whenAvailable(['webServer'], (scoped) =>
    registerRoutes(scoped, {
      readSettings: () => settingsState.value ?? { enabled: DEFAULT_ENABLED, agents: {} },
      // The host read the memo is built over. This is the one place allowed to
      // call `ctx.get('sessionQuery')`; the memo reaches it through this closure,
      // so no route ever touches the host reader directly.
      readSessionTitles: (keys) => sessionTitlesFor(ctx, keys),
      // Called once, on the first panel request. The route answers from the memo
      // synchronously; the fold it starts runs behind the response and swallows
      // its own failures into the log.
      createTitles: (deps) =>
        createTitleMemo({
          read: deps.read,
          warn: (message) => ctx.logger?.warn?.(`[context-zip] ${message}`),
        }),
      writeSettings: async (patch) => {
        if (scope === null) throw new Error('no settings provider is composed');
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object');
        const current = scope.get() ?? { enabled: DEFAULT_ENABLED, agents: {} };
        const next = applySettingsPatch(current, patch);
        if (next === null) throw new Error('nothing to update');
        // 「保存设置时发一次最小请求探活，探不通则拒绝保存」——用户拍板的那一条。
        //
        // 只在这次保存真的把改写档位换成一条**完整且不同**的路由时探。面板每次保存
        // 都把整份设置发回来，所以若按「补丁里提到改写字段」判，改一次覆盖表也会顺带
        // 探一次：provider 不通时连覆盖表都存不进去，那是把探活的适用范围放大了。
        const rewriteProvider = String(next.rewriteProvider ?? '').trim();
        const rewriteModel = String(next.rewriteModel ?? '').trim();
        const rewriteChanged =
          current.rewriteEnabled !== next.rewriteEnabled ||
          String(current.rewriteProvider ?? '') !== rewriteProvider ||
          String(current.rewriteModel ?? '') !== rewriteModel;
        if (next.rewriteEnabled === true && rewriteProvider.length > 0 && rewriteModel.length > 0 && rewriteChanged) {
          // 清单先读一次只为把话说准：模型不在广告清单里**不是**拒绝理由（接口写明
          // 清单是建议性的、adapter 可以接受未列出的 id），所以在探通之后只记一条
          // 日志。真正的门是探活本身。
          let advertised = true;
          try {
            const catalog = await readModelCatalog(ctx.llm);
            const group = catalog.providers.find((entry) => entry.id === rewriteProvider);
            advertised = group !== undefined && group.models.some((model) => model.id === rewriteModel);
          } catch {
            // 清单读不到不影响探活判定，也不该让它挡住保存。
          }
          const signal =
            typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined;
          try {
            await probeModel(ctx.llm, rewriteProvider, rewriteModel, { signal });
          } catch (error) {
            throw new Error(
              `format rewrite probe failed for ${rewriteProvider}/${rewriteModel}: ${String(error?.message ?? error)}`,
            );
          }
          if (!advertised) {
            ctx.logger?.warn?.(
              `[context-zip] ${rewriteProvider} does not advertise ${rewriteModel}; the probe answered, so the route was accepted anyway`,
            );
          }
        }
        // The section is REPLACED, not patched. `scope.update` merges a nested
        // object into the stored one, so a key the caller left out kept its old
        // value and an empty object removed nothing: 删除 could not delete, and
        // the panel still said 已保存. (The merge does read `null` as a removal,
        // but writing one persists `null` into settings.yaml, where the schema
        // expects a boolean and the whole section would fail to load next time.)
        // `scope.replace` takes the finished value, so omission means deletion
        // and the file only ever holds valid entries.
        await scope.replace(next);
        return scope.get() ?? next;
      },
      listSegments: (sessionId) => service.listSegments(sessionId),
      // 面板的模型下拉框读这个。从活的注册表现读，所以 adapter 增删路由之后刷新
      // 面板就能看到，不需要重启，也不需要在插件里维护第二份清单。
      listModels: () => readModelCatalog(ctx.llm),
      // The manual entry, served by the same actions the slash command uses.
      readManualPlan: (sessionId) => manual.plan(sessionId),
      runManualCompaction: (sessionId) => manual.run(sessionId, undefined, undefined),
      readManualFailure: (sessionId) => manual.failure(sessionId),
      // The toolbar chip asks this before every render. Answered through the same
      // resolver the engine calls, so a session whose mode comes from its preset
      // key, or from the global switch, reports what will really happen.
      readModeFor: (sessionId) => {
        const session = ctx.get('sessions')?.get(sessionId);
        if (session === undefined) return null;
        const mode = resolveMode(session);
        return {
          compaction: mode.compaction,
          source: mode.source,
          revision: mode.revision ?? null,
        };
      },
      readEffectiveMode: () => {
        // Counts LIVE sessions by asking the same resolver the engine uses, so
        // the panel cannot disagree with behavior. Enumerating the store also
        // means a session closed and reopened is counted where it is now.
        const live = { on: 0, off: 0 };
        for (const session of ctx.get('sessions')?.list() ?? []) {
          if (resolveMode(session).compaction === 'plugin') live.on += 1;
          else live.off += 1;
        }
        return effectiveMode(live);
      },
    }),
  );

  ctx.logger?.info?.(
    `[context-zip] ready: ${SUMMARY_SOFT_TARGET_TOKENS}/${SUMMARY_HARD_CAP_TOKENS} token handoff summary, ` +
      `${NOTES_MAX_CHARS}-character notes, reminder at ${REMINDER_THRESHOLD_PERCENT}%`,
  );

  return () => {
    for (const fiber of optionalFibers) {
      try {
        fiber?.dispose?.();
      } catch {
        // One optional feature failing to unwind must not strand the rest.
      }
    }
    disposeTools();
    for (const layer of retrievalLayers.values()) {
      try {
        layer();
      } catch {
        // One layer failing to lift must not strand the rest.
      }
    }
    retrievalLayers.clear();
    for (const fiber of guidanceFibers.values()) {
      try {
        void fiber?.dispose?.();
      } catch {
        // A scope already unwound by its own agent disposal is not an error.
      }
    }
    guidanceFibers.clear();
    undoNotesReader();
    undoModeReader();
    undoFallbackReader();
    undoRewriteReader();
  };
}

/**
 * Resolve the effective mode for one session.
 *
 * A per-preset entry is consulted first, then the session's own id, then the
 * global switch — so one preset entry covers every session that preset creates
 * without naming each one. A missing settings provider resolves to the default.
 *
 * @param session - session being resolved.
 * @returns the mode, where it came from, and the settings revision.
 */
export function resolveMode(session) {
  return resolveModeFrom(settingsState, session);
}

/**
 * The whole mode decision, as a pure function of one settings state.
 *
 * Split out from {@link resolveMode} because this lookup is the heart of the
 * feature and the module-level state it normally reads is unreachable from a
 * test. Taking the state as an argument is what lets the preset key, the session
 * key, and their precedence be checked directly.
 *
 * @param state - resolved settings plus the record of which fields the user set.
 * @param session - session whose header and id name the override keys.
 * @returns the mode, where it came from, and the settings revision behind it.
 */
/**
 * How the history review tools are presented to one session.
 *
 * - `granular`   — one call per query term. `history_find` is hidden. This is the
 *                  behavior every released version had, and the default.
 * - `batched`    — `history_find` is added; the single-term tools stay.
 * - `batched-only` — `history_search` is hidden, so several terms and a stopping
 *                  rule have to go in one call.
 */
export type RetrievalPresentation = 'granular' | 'batched' | 'batched-only';

/** Every accepted value, for validating settings rows without a schema round trip. */
const RETRIEVAL_VALUES: readonly RetrievalPresentation[] = ['granular', 'batched', 'batched-only'];

/**
 * Resolve one session's retrieval presentation, the same way {@link resolveModeFrom}
 * resolves its compaction mode: session id first, then preset, then the global
 * value, read live so an edit reaches sessions that are already open.
 *
 * @param state - the settings snapshot, or null when no provider is composed.
 * @param session - the session asking.
 * @returns the presentation plus where it came from.
 */
export function resolveRetrievalFrom(state, session) {
  const fallback = { retrieval: 'granular' as RetrievalPresentation, source: 'default', revision: undefined };
  const value = state?.value ?? null;
  if (value === null) return fallback;
  const table = value.retrievalAgents ?? {};
  // Session id first, for the same reason the compaction table does it: the id is
  // the only key that can single out one session from its siblings.
  for (const key of [session.id, session.header.agentPreset]) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (Object.hasOwn(table, key)) {
      const row = table[key];
      if (row === 'granular' || row === 'batched' || row === 'batched-only') {
        return {
          retrieval: row,
          source: state.userRetrievalAgents?.has(key) === true ? 'settings' : 'default',
          revision: state.revision,
        };
      }
    }
  }
  const global = value.retrieval;
  const effective: RetrievalPresentation =
    global === 'batched' || global === 'batched-only' ? global : 'granular';
  return {
    retrieval: effective,
    source: state.userRetrieval === true ? 'settings' : 'default',
    revision: state.revision,
  };
}

/**
 * Resolve one session's retrieval presentation from the live snapshot.
 *
 * @param session - the session asking.
 * @returns the presentation in force right now.
 */
export function resolveRetrieval(session) {
  return resolveRetrievalFrom(settingsState, session);
}

export function resolveModeFrom(state, session) {
  const fallback = {
    compaction: DEFAULT_ENABLED ? 'plugin' : 'default',
    source: 'default',
    revision: undefined,
  };
  const value = state?.value ?? null;
  if (value === null) return fallback;
  const table = value.agents ?? {};
  // Session id FIRST, then the preset. The id key is the only one that can
  // single out one session from its siblings, so a preset row must never shadow
  // it: with the order reversed, two sessions sharing a preset could not be told
  // apart, which is the entire reason the id key exists. Session ids are
  // generated, never reused, so an id row cannot leak onto a different session.
  for (const key of [session.id, session.header.agentPreset]) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (Object.hasOwn(table, key)) {
      return {
        compaction: table[key] === true ? 'plugin' : 'default',
        source: state.userAgents?.has(key) === true ? 'settings' : 'default',
        revision: state.revision,
      };
    }
  }
  return {
    compaction: value.enabled === true ? 'plugin' : 'default',
    source: state.userEnabled === true ? 'settings' : 'default',
    revision: state.revision,
  };
}

/**
 * Resolve the live agent one manual compaction runs against.
 *
 * A manual compaction is not a read: `compactNow` reserves the agent's next-turn
 * admission with `runMaintenance`, so the target has to be the RUNNING agent, not
 * a session reconstructed from its stored log. That is the one place this entry
 * differs from `/zip-export`, which deliberately reaches sessions no process
 * holds.
 *
 * @param ctx - plugin context.
 * @param sessionId - named session, or a falsy value to let the host choose.
 * @returns the live agent.
 * @throws {ManualTargetError} when the name does not resolve or the choice is ambiguous.
 */
function liveAgentFor(ctx, sessionId) {
  const agents = ctx.get('agents');
  if (agents === undefined) {
    throw new ManualTargetError('no-live-session', 'the agent registry is not composed, so no session can be compacted on demand');
  }
  const wanted = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (wanted.length > 0) {
    const agent = agents.get(wanted);
    if (agent === undefined) {
      throw new ManualTargetError(
        'session-not-live',
        `${wanted} is not a live session in this process; a manual compaction needs the running agent, so open the session first`,
      );
    }
    return agent;
  }
  const live = agents.list() ?? [];
  if (live.length === 0) throw new ManualTargetError('no-live-session', 'this process has no live session to compact');
  if (live.length > 1) {
    // Refusing beats guessing. The endpoint that most often calls this is the
    // settings panel, which is a root-scoped seat with no session of its own; in
    // the ordinary case the panel names the session the page has open, and this
    // branch is only reached when it could not.
    const ids = live.map((agent) => agent?.session?.id).filter((id) => typeof id === 'string' && id.length > 0);
    throw new ManualTargetError(
      'session-required',
      `this process holds ${live.length} live sessions (${ids.join(', ')}), so the request has to name one`,
    );
  }
  return live[0];
}

/**
 * Build the manual-compaction actions over the live services.
 *
 * Everything is resolved at call time rather than at apply time: the compaction
 * service is supplied by another row and the agent registry is empty until a
 * session exists, so a snapshot taken during composition would be the wrong
 * answer for every later request.
 *
 * @param ctx - plugin context.
 * @returns the plan/run/read triple both manual entrances share.
 */
function createManualActions(ctx) {
  return {
    async plan(sessionId) {
      const agent = liveAgentFor(ctx, sessionId);
      const session = agent.session;
      // The same measurement the engine takes inside `compactNow`, which is what
      // makes the confirmation's count the count that will really be replaced.
      return planManualCompaction(session.id, session, ctx.tokenMeter.measure(session));
    },
    async run(sessionId, signal, commandId) {
      const agent = liveAgentFor(ctx, sessionId);
      // A fresh signal for the browser path: no client disconnect can be observed
      // from a route handler, and cancellation is not what a manual run needs.
      const abort = signal ?? new AbortController().signal;
      // Three ways to reach the backend, in the order that gets the realm-local one
      // first:
      //
      // 1. the agent's own context — right where a composition mounts the backend
      //    in the same realm as the agent;
      // 2. this plugin's context — the host-plane row (the headless profile keeps
      //    it enabled);
      // 3. the module-level seat the engine instance registers — the ONLY way in
      //    when the backend is isolated into an agent-preset realm, which is what
      //    the web profile does (its host-plane `compaction-basic` row is
      //    `disabled: true`, measured with `--dump-config`, and both `ctx.get`
      //    and `ctx.inject(['compaction'])` come back empty from the host through
      //    a real process probe).
      //
      // The engine is the plugin's own code either way, and it is the half that
      // runs inside that realm, so the seat is not a workaround around the seam —
      // it is the same module-level crossing `setSharedModeReader` already uses.
      const compaction = agent?.ctx?.get?.('compaction') ?? ctx.get('compaction');
      const result =
        compaction === undefined
          ? await runManualCompaction(agent, abort, commandId)
          : await compaction.compactNow(agent, abort, commandId);
      if (result === null) return { sessionId: agent.session.id, events: 0, tokens: 0, summarySeq: null };
      return {
        sessionId: agent.session.id,
        events: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
        tokens: Number(result.shadowedTokenCount ?? 0),
        summarySeq: typeof result.summarySeq === 'number' ? result.summarySeq : null,
      };
    },
    failure(sessionId) {
      // Read fresh, after the attempt: the engine increments the streak while the
      // failure unwinds, so a value captured before the run would be one short.
      return {
        failures: readFailureCount(sessionId),
        fallbackAfter: fallbackAfterValue(),
        fallbackEnabled: settingsState.value?.fallbackEnabled === true,
      };
    },
  };
}

/** The failure threshold in force, clamped the way the engine clamps it. */
function fallbackAfterValue() {
  const raw = Number(settingsState.value?.fallbackAfterFailures);
  return Number.isFinite(raw) ? Math.min(10, Math.max(0, Math.trunc(raw))) : DEFAULT_FALLBACK_AFTER_FAILURES;
}

/**
 * Describe the mode a session created right now would snapshot.
 *
 * The settings section renders this as "the mode you are in now". It deliberately
 * reports the NEW-session answer rather than any one session's frozen snapshot:
 * the panel is global, and existing sessions keep whatever they were created
 * under, which is why the live snapshot counts travel with it.
 *
 * @param live - how many live sessions hold each frozen mode.
 * @returns the mode, where it came from, and the live snapshot counts.
 */
export function effectiveMode(live) {
  const value = settingsState.value;
  const enabled = value === null ? DEFAULT_ENABLED : value.enabled === true;
  // Reports the GLOBAL switch, which is the answer for a new session that no
  // override names. It deliberately does not fold in the override table: that
  // table is keyed by preset and by session id, and the settings panel is
  // neither, so any single value it picked would be a claim about a session it
  // cannot identify. `overrides` is what keeps that honest — the panel can say
  // how many exceptions exist instead of implying there are none.
  return {
    compaction: enabled ? 'plugin' : 'default',
    source: settingsState.userEnabled ? 'settings' : 'default',
    revision: settingsState.revision,
    overrides: Object.keys(value?.agents ?? {}).length,
    live,
  };
}

/** Re-read the settings value and its revision. */
/**
 * Last reported switch state, so the log line below appears when the mode
 * changes rather than on every settings write.
 */
let reportedSwitch;

function refreshSettings(scope, settings, report) {
  try {
    settingsState.value = scope.get();
  } catch (error) {
    settingsState.value = null;
    return;
  }
  // Tracing is global rather than per session, so it is installed here instead of going
  // through the session-keyed lookups. A watch fires on every settings edit, so turning
  // the path on or off takes effect without a restart.
  try {
    setTracePath(settingsState.value?.tracePath ?? '');
  } catch {
    // A settings value that cannot be read leaves tracing exactly as it was.
  }
  try {
    setThrottleEnabled(settingsState.value?.throttle ?? DEFAULT_THROTTLE);
  } catch {
    // Same: an unreadable value leaves the throttle where it was.
  }
  try {
    const descriptor = settings.describe().find((entry) => entry.ns === SETTINGS_NS);
    settingsState.revision = typeof descriptor?.revision === 'number' ? descriptor.revision : undefined;
    const user = descriptor?.user;
    const section = user !== null && typeof user === 'object' ? user : null;
    settingsState.userEnabled = section !== null && Object.hasOwn(section, 'enabled');
    const agents = section !== null && section.agents !== null && typeof section.agents === 'object' ? section.agents : null;
    settingsState.userAgents = new Set(agents === null ? [] : Object.keys(agents));
    settingsState.userRetrieval = section !== null && Object.hasOwn(section, 'retrieval');
    const retrievalAgents =
      section !== null && section.retrievalAgents !== null && typeof section.retrievalAgents === 'object'
        ? section.retrievalAgents
        : null;
    settingsState.userRetrievalAgents = new Set(retrievalAgents === null ? [] : Object.keys(retrievalAgents));
  } catch {
    settingsState.revision = undefined;
    settingsState.userEnabled = false;
    settingsState.userAgents = new Set();
    settingsState.userRetrieval = false;
    settingsState.userRetrievalAgents = new Set();
  }
  // Said here rather than in the startup line: at startup `settings` may still be
  // composing, and a line that names the plugin and then says "shipped
  // compaction" reads as the current mode even when the switch is on.
  if (typeof report === 'function') {
    const mode = settingsState.value?.enabled === true ? 'plugin' : 'shipped';
    if (mode !== reportedSwitch) {
      reportedSwitch = mode;
      report(`compaction switch: ${mode} (${settingsState.userEnabled ? 'settings' : 'default'})`);
    }
  }
}

/**
 * Measure current context pressure as a fraction of the routed context window.
 *
 * @param ctx - plugin context.
 * @param agent - agent whose session is measured.
 * @returns the ratio, or null when no usable capacity is known.
 */
async function routedContextWindow(ctx, agent) {
  // The session's own `request/context` record FIRST. It is the harness's
  // statement of the route a request actually went out on, and a mid-session
  // model switch writes a new one. The agent's `options` are fixed when the agent
  // is built, so resolving the catalog by them keeps answering with the window of
  // the route the session STARTED on: measured on a session that switched from a
  // 400,000-token route to a 1,000,000-token one, the reminder fired at 320,000
  // tokens because 320,000 / 400,000 = 0.80 while the true ratio was 0.32. The
  // catalog is only the fallback, for a session that has issued no request yet.
  try {
    const window = latestContextWindow(await readSessionEvents(ctx, agent.session));
    if (window !== null) return window;
  } catch (error) {
    ctx.logger?.debug?.(`[context-zip] the session route record was unreadable: ${String(error)}`);
  }
  try {
    const info = await ctx.llm.resolveModelInfo(agent.options?.provider, agent.options?.model);
    const window = info?.context?.contextWindow;
    if (typeof window === 'number' && window > 0) return window;
  } catch {
    // No catalog answer; the caller reads a missing window as "not measurable".
  }
  return null;
}

/**
 * Measure current context pressure as a fraction of the routed context window.
 *
 * @param ctx - plugin context.
 * @param agent - agent whose session is measured.
 * @returns the ratio, or null when no usable capacity is known.
 */
async function pressureRatio(ctx, agent) {
  const window = await routedContextWindow(ctx, agent);
  if (window === null) return null;
  const measurement = ctx.tokenMeter.measure(agent.session);
  return measurement.totalTokens / window;
}

/**
 * Wrap the reminder copy in one plugin-sourced user message.
 *
 * The spec fixes this text verbatim, so the measured percentage is not prefixed
 * onto it; the caller logs the number instead.
 *
 * @param _ratio - measured context pressure, already recorded by the caller.
 * @returns one plugin-sourced user message carrying the fixed reminder.
 */
function reminderMessage(_ratio) {
  return createUserMessage({
    content: [{ type: 'text', text: NOTES_REMINDER_INSTRUCTION }],
    source: { kind: 'plugin', plugin: 'context-zip', form: 'notice', summary: 'context pressure reminder' },
  });
}

export default { name, inject, apply, ContextZipSettings, SETTINGS_NS, resolveMode, setEngineClass };
