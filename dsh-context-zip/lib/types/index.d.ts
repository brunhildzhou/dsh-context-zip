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
import { type ContextFormed } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { sessionTitlesFor } from './session-titles.ts';
export { sessionTitlesFor };
/**
 * This plugin's own message-source kind, declared into the harness's
 * merge-extensible map. See `./producer.ts` for why the value is
 * `plugin:context-zip` and why the retired literal must never come back.
 *
 * `& ContextFormed` rather than a hand-written `form` union, so the forms stay
 * the harness's closed set (`instructions`, `notice` + `summary`, or none).
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'plugin:context-zip': {
            readonly kind: 'plugin:context-zip';
            /** Stable id of the plugin that produced the message. */
            readonly plugin: string;
        } & ContextFormed;
    }
}
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
 * The namespace schema the 0.1.5/0.1.6 settings service registers.
 *
 * Unchanged from before this port, and still the schema the older line resolves:
 * that is what keeps a user on the older line exactly where they were.
 */
export declare const ContextZipSettings: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>, "defined">;
    retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only", "defined">;
    retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, "defined">;
    throttle: z<boolean, boolean, "defined">;
    fallbackEnabled: z<boolean, boolean, "defined">;
    fallbackAfterFailures: z<number, number, "defined">;
    rewriteEnabled: z<boolean, boolean, "defined">;
    rewriteProvider: z<string, string, "defined">;
    rewriteModel: z<string, string, "defined">;
    tracePath: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>, "defined">;
    retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only", "defined">;
    retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, "defined">;
    throttle: z<boolean, boolean, "defined">;
    fallbackEnabled: z<boolean, boolean, "defined">;
    fallbackAfterFailures: z<number, number, "defined">;
    rewriteEnabled: z<boolean, boolean, "defined">;
    rewriteProvider: z<string, string, "defined">;
    rewriteModel: z<string, string, "defined">;
    tracePath: z<string, string, "defined">;
}>>, "plain">;
/**
 * Whether this process can carry live config at all.
 *
 * False means the profile resolved a schemastery older than the one that added
 * `volatile()`. The settings document then has no field to show for this plugin,
 * which costs the generated form and the settings-service write path — the row
 * config still loads, and the plugin's own panel writes through the
 * configuration editor instead. See `apply`.
 */
export declare const CONFIG_IS_LIVE: boolean;
/**
 * The plugin's own row schema, and the settings form 0.1.7-alpha.1 projects.
 *
 * Every field is marked live so the settings document has something to show:
 * `volatileForm` drops any field that is not live, and a plugin with no live
 * field gets no entry in the document at all. Built from {@link settingsFields}
 * rather than written out again, because a second copy is a second place for a
 * default or a description to drift.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    [k: string]: any;
}>>, Schemastery.ObjectT<NoInfer<{
    [k: string]: any;
}>>, "plain">;
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
 * `config` is the plugin's own profile row, resolved against {@link Config} by
 * the Loader. From 0.1.7-alpha.1 that row IS the settings store, so the second
 * parameter is a real settings source and not decoration; on the older line it
 * carries whatever the row wrote (normally nothing) and the registered namespace
 * stays the source of truth.
 *
 * @param ctx - plugin context.
 * @param config - the resolved row config, with schema defaults already applied.
 * @returns the disposer that unloads everything this plugin added.
 */
export declare function apply(ctx: any, config: any): Promise<() => void>;
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
/**
 * Pick this plugin's own row out of the configuration editor's read.
 *
 * The editor's `configuration()` is where the settings service gets the user
 * layer in the first place: `describe()` runs each entry's `override` through
 * the form and reports the result as `user`. Reading the same `override` here
 * therefore reaches the same stored section without the form, which matters
 * because that form is exactly what refuses this plugin's row when the
 * schemastery in the process has no `volatile()`. Rows are matched by
 * `entry.options.id`, the id `describe()` reports as `ns`.
 *
 * The editor is an optional service, so every step of the reach is guarded: a
 * profile with none composed, or a read that throws, answers `undefined` and
 * leaves the caller with the all-empty user layer it reported before.
 *
 * @param ctx - plugin context.
 * @param ns - the id `describe()` reports this plugin under.
 * @returns the row's override, or `undefined` when it cannot be read.
 */
export declare function rowOverrideFrom(ctx: any, ns: any): any;
/**
 * Work out which settings fields the STORED user section actually names.
 *
 * Two sources can carry it, and they agree whenever both exist: the descriptor's
 * `user` layer, and the configuration editor's `override` for the same row, which
 * is the input that layer is projected from. The descriptor comes first because
 * it is the service's own answer; the override is the fallback for a row the
 * service will not describe at all. The caller passes `undefined` for a source it
 * could not read, and "neither" answers all-empty, which is what a provider with
 * no user layer has always reported.
 *
 * @param descriptorUser - the `user` layer of the settings descriptor.
 * @param override - the configuration editor's override for this plugin's row.
 * @returns the fields the stored user section names.
 */
export declare function userLayerFrom(descriptorUser: any, override: any): {
    rowConfigured: boolean;
    userEnabled: boolean;
    userAgents: Set<string>;
    userRetrieval: boolean;
    userRetrievalAgents: Set<string>;
};
/**
 * The default plugin object.
 *
 * `Config` has to be HERE, not merely a named export: the Loader normalizes an
 * ESM module with `exports.default ?? exports`, so once a default object exists
 * the Loader's `runtime.Config` is read off it and a named `Config` beside it is
 * never seen. Without this key 0.1.7-alpha.1 has no schema to project and the
 * plugin gets no row in the settings document at all.
 */
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
    Config: z<Schemastery.ObjectS<NoInfer<{
        [k: string]: any;
    }>>, Schemastery.ObjectT<NoInfer<{
        [k: string]: any;
    }>>, "plain">;
    ContextZipSettings: z<Schemastery.ObjectS<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>, "defined">;
        retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only", "defined">;
        retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, "defined">;
        throttle: z<boolean, boolean, "defined">;
        fallbackEnabled: z<boolean, boolean, "defined">;
        fallbackAfterFailures: z<number, number, "defined">;
        rewriteEnabled: z<boolean, boolean, "defined">;
        rewriteProvider: z<string, string, "defined">;
        rewriteModel: z<string, string, "defined">;
        tracePath: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        agents: z<import("@deepseek-ai/cosmokit").Dict<boolean, string>, import("@deepseek-ai/cosmokit").Dict<boolean, string>, "defined">;
        retrieval: z<"granular" | "batched" | "batched-only", "granular" | "batched" | "batched-only", "defined">;
        retrievalAgents: z<import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, import("@deepseek-ai/cosmokit").Dict<"granular" | "batched" | "batched-only", string>, "defined">;
        throttle: z<boolean, boolean, "defined">;
        fallbackEnabled: z<boolean, boolean, "defined">;
        fallbackAfterFailures: z<number, number, "defined">;
        rewriteEnabled: z<boolean, boolean, "defined">;
        rewriteProvider: z<string, string, "defined">;
        rewriteModel: z<string, string, "defined">;
        tracePath: z<string, string, "defined">;
    }>>, "plain">;
    SETTINGS_NS: string;
    resolveMode: typeof resolveMode;
    setEngineClass: typeof setEngineClass;
};
export default _default;
