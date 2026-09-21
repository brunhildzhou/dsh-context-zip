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
import z from '@deepseek-ai/schemastery';
import { sessionTitlesFor } from './session-titles.ts';
export { sessionTitlesFor };
/** Plugin name as it appears in the composed tree and the logs. */
export declare const name = "dsh-context-zip";
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
export declare const inject: string[];
export declare const SETTINGS_NS = "context-zip";
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
export declare const ContextZipSettings: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>>;
    retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only">;
    retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>>;
    throttle: z<boolean, boolean>;
    fallbackEnabled: z<boolean, boolean>;
    fallbackAfterFailures: z<number, number>;
    rewriteEnabled: z<boolean, boolean>;
    rewriteProvider: z<string, string>;
    rewriteModel: z<string, string>;
    tracePath: z<string, string>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>>;
    retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only">;
    retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>>;
    throttle: z<boolean, boolean>;
    fallbackEnabled: z<boolean, boolean>;
    fallbackAfterFailures: z<number, number>;
    rewriteEnabled: z<boolean, boolean>;
    rewriteProvider: z<string, string>;
    rewriteModel: z<string, string>;
    tracePath: z<string, string>;
}>>;
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
export declare function applySettingsPatch(current: SettingsValue, patch: unknown): SettingsValue | null;
/**
 * Inject the engine class the loader mounted for the `compaction-basic` row.
 *
 * Tests call this before {@link apply}; the profile's redirect package supplies
 * the class that actually ships.
 *
 * @param EngineClass - a CompactionEngine subclass.
 */
export declare function setEngineClass(EngineClass: any): void;
/**
 * Compose the plugin.
 *
 * @param ctx - plugin context.
 * @returns the disposer that unloads everything this plugin added.
 */
export declare function apply(ctx: any): Promise<() => void>;
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
export declare function resolveMode(session: any): {
    compaction: string;
    source: string;
    revision: any;
};
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
/**
 * Resolve one session's retrieval presentation, the same way {@link resolveModeFrom}
 * resolves its compaction mode: session id first, then preset, then the global
 * value, read live so an edit reaches sessions that are already open.
 *
 * @param state - the settings snapshot, or null when no provider is composed.
 * @param session - the session asking.
 * @returns the presentation plus where it came from.
 */
export declare function resolveRetrievalFrom(state: any, session: any): {
    retrieval: any;
    source: string;
    revision: any;
};
/**
 * Resolve one session's retrieval presentation from the live snapshot.
 *
 * @param session - the session asking.
 * @returns the presentation in force right now.
 */
export declare function resolveRetrieval(session: any): {
    retrieval: any;
    source: string;
    revision: any;
};
export declare function resolveModeFrom(state: any, session: any): {
    compaction: string;
    source: string;
    revision: any;
};
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
export declare function effectiveMode(live: any): {
    compaction: string;
    source: string;
    revision: number;
    overrides: number;
    live: any;
};
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
    ContextZipSettings: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>>;
        retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only">;
        retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>>;
        throttle: z<boolean, boolean>;
        fallbackEnabled: z<boolean, boolean>;
        fallbackAfterFailures: z<number, number>;
        rewriteEnabled: z<boolean, boolean>;
        rewriteProvider: z<string, string>;
        rewriteModel: z<string, string>;
        tracePath: z<string, string>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>>;
        retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only">;
        retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>>;
        throttle: z<boolean, boolean>;
        fallbackEnabled: z<boolean, boolean>;
        fallbackAfterFailures: z<number, number>;
        rewriteEnabled: z<boolean, boolean>;
        rewriteProvider: z<string, string>;
        rewriteModel: z<string, string>;
        tracePath: z<string, string>;
    }>>;
    SETTINGS_NS: string;
    resolveMode: typeof resolveMode;
    setEngineClass: typeof setEngineClass;
};
export default _default;
