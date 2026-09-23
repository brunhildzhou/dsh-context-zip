/**
 * Wiring the `compaction-basic` row to this plugin from inside a running harness.
 *
 * `install.mjs` does this on the command line, and it is the reference for every
 * guard here. A profile installed with `dsh plugin add` has the plugin but not the
 * redirect, and no terminal to run the script from, so the settings panel offers a
 * button that performs the same file copy. Because it runs inside the harness
 * process, the paths are not arguments any more and are derived instead:
 *
 * - the profile comes from the DSH context (`ctx.baseUrl`, which `dsh-app-boot`'s
 *   `boot()` sets to `dirname(<profile>/cordis.yml)`), never from `import.meta.url`.
 *   Node's ESM loader resolves a symlinked module through `realpath`, and a plugin
 *   installed by a package manager lives in the store behind a symlink, so walking
 *   up from this file would land in the store and not in the profile;
 * - the two redirect files come from this plugin's own directory, where the
 *   `redirect/` folder ships;
 * - `base.js` is a copy of the shipped backend TAKEN BEFORE ANYTHING IS WRITTEN.
 *   Resolving it afterwards would find this plugin's own redirect, whose package
 *   name is the same by design.
 *
 * The guards are the installer's, not a weaker version of them: the target is
 * proved to land inside the profile with every existing segment symlink-expanded,
 * and a package at that path that this plugin did not write is refused rather than
 * overwritten.
 *
 * @module dsh-context-zip/wire
 */
import type { ObservedState } from './threshold.ts';
/** The package name the `compaction-basic` row resolves. */
export declare const REDIRECT_PACKAGE = "@deepseek-ai/dsh-compaction-basic";
/**
 * Marker carried in the redirect's `version`.
 *
 * A package at the redirect path is this plugin's only when its version carries
 * this string; anything else is somebody's real backend. It is the whole reason
 * the redirect carries a version marker at all.
 */
export declare const REDIRECT_MARKER = "context-zip";
/** The stamp written beside `base.js`; key names match `install.mjs`. */
export declare const STAMP_FILE = "base.json";
/**
 * Refuse a target whose write would land outside the profile.
 *
 * Guards can be disabled by tests that need to exercise the refusal message, and
 * never by production callers.
 *
 * @param target - path about to be written or deleted.
 * @param label - how to name the path in the refusal.
 * @param profileReal - the profile's canonical path.
 * @returns the path the write physically lands on.
 */
export declare function assertPathInsideProfile(target: any, label: any, profileReal: any): Promise<any>;
/**
 * The profile directory the wiring writes into.
 *
 * Preference order is the context base URL first, then the harness home. Both
 * paths are validated; when neither answers, the refusal names what was checked
 * rather than falling back to a guess.
 *
 * @param baseUrl - the DSH context base URL (`ctx.baseUrl`), when the context has one.
 * @param pluginDir - this plugin's own directory.
 * @returns the absolute profile directory.
 */
export declare function resolveProfileDirectory(baseUrl: any, pluginDir: any): Promise<any>;
/**
 * Locate the installed base package by probing Node's own lookup paths.
 *
 * `require.resolve` cannot be used: the package may not export `./package.json`,
 * and this plugin's redirect would answer the specifier anyway. A candidate whose
 * version carries the redirect marker is skipped for the same reason, which is
 * what makes it safe to resolve the backend while a redirect is already in place.
 *
 * The profile's own lookup paths are tried FIRST, because on a healthy profile
 * the backend the `compaction-basic` row would load is the one beside the plugin,
 * and the checks below are about that copy. When none of them answers (a dangling
 * link after an upgrade is not a readable manifest) the harness's own lookup
 * paths are tried, so the shipped version stays knowable on 0.1.7. Both halves
 * read a manifest and reject the redirect marker; a run that finds neither still
 * throws rather than inventing a version.
 *
 * @param profileDir - the profile directory.
 * @returns the absolute package directory.
 */
export declare function basePackageDir(profileDir: any): Promise<string>;
/**
 * Whether the row is wired, and which backend the redirect wraps.
 *
 * A read may not fail over the version comparison: the stamp is what the panel
 * prints, and an unresolvable backend only means `stale` cannot be judged.
 *
 * Both versions travel: `version` is the stamp's (what the redirect was wired
 * against) and `current` is what the shipped backend carries now. The panel's
 * "update available" line names the pair, so a single field could not do it.
 *
 * @param options - `baseUrl` from the DSH context and this plugin's directory.
 * @returns the status the `GET` route answers with.
 */
export declare function readWireStatus(options: any): Promise<{
    wired: boolean;
    version: any;
    copiedAt: any;
    stale: boolean;
    foreign: boolean;
    partial?: undefined;
    current?: undefined;
    patch?: undefined;
    patchObserved?: undefined;
    patchDrift?: undefined;
} | {
    wired: boolean;
    version: any;
    copiedAt: any;
    stale: boolean;
    partial: boolean;
    foreign?: undefined;
    current?: undefined;
    patch?: undefined;
    patchObserved?: undefined;
    patchDrift?: undefined;
} | {
    wired: boolean;
    version: any;
    current: any;
    copiedAt: any;
    stale: boolean;
    foreign: boolean;
    patch: any;
    patchObserved: ObservedState;
    patchDrift: boolean;
    partial?: undefined;
}>;
/**
 * Perform the wiring: write the redirect into the profile.
 *
 * Order is the whole design. The shipped backend is resolved BEFORE the first
 * write, because once the redirect is in place that specifier resolves to this
 * plugin. The occupant is checked before anything is removed, because deleting
 * somebody's real backend and then failing is worse than declining up front.
 * Nothing is reported as done until every file is written.
 *
 * @param options - `baseUrl` from the DSH context and this plugin's directory.
 * @returns the stamp that was written.
 */
export declare function wireCompactionRow(options: any): Promise<{
    wired: boolean;
    version: string;
    copiedAt: string;
    source: any;
    patch: import("./threshold.ts").PatchState;
}>;
/**
 * Whether a settings file under `home` still carries this plugin's old section.
 *
 * `settings.yaml.imported` is the file the 0.1.7 upgrade leaves behind;
 * `settings.yaml` is checked too for a profile that has not been renamed yet.
 * READ-ONLY by construction: the only filesystem call here is `readFile`, so a
 * status read can never write into the harness home.
 *
 * @param home - the DSH home directory.
 * @returns true only when one of the two files has the section.
 */
export declare function importedSettingsPending(home: any): Promise<boolean>;
/**
 * Which problem a `/wire` read should draw attention to, or `null` when the row
 * is in one of the two healthy shapes (active, or a write in flight).
 *
 * The order is the whole function. A stale redirect outranks a pending restart
 * because it is the one the reconnect button fixes; a foreign occupant answers
 * `null` because there is nothing here this plugin may repair; and `restart`
 * needs positive evidence, exactly like the panel's own `wireStatusFrom`.
 *
 * @param status - the `GET` read's status fields.
 * @param processStartedAt - when this harness process began.
 * @returns one kind, or `null`.
 */
export declare function attentionKind(status: any, processStartedAt: any): "update" | "incomplete" | "inactive" | "restart";
/**
 * The `attention` field the `/wire` route answers with, or `null`.
 *
 * `null` is the healthy answer the client reads as "draw no question mark", so
 * every branch that cannot be established honestly returns it: an unnameable home
 * or profile (the prompt's own template needs both real values), and a healthy
 * status. `migrate` outranks `inactive` and is the only kind that reads the
 * filesystem, because a profile whose settings never came across needs its
 * settings moved before a takeover would mean anything.
 *
 * @param options - the status, the process start, the profile directory, whether
 *   this plugin's own row carries any user value, and an optional forced kind for
 *   the two states the read itself cannot see (`unknown`, `failed`).
 * @returns `{ kind, home, profile }`, or `null`.
 */
export declare function readAttention(options: any): Promise<{
    kind: string;
    home: string;
    profile: string;
}>;
declare const _default: {
    resolveProfileDirectory: typeof resolveProfileDirectory;
    readWireStatus: typeof readWireStatus;
    wireCompactionRow: typeof wireCompactionRow;
    basePackageDir: typeof basePackageDir;
    attentionKind: typeof attentionKind;
    importedSettingsPending: typeof importedSettingsPending;
    readAttention: typeof readAttention;
    REDIRECT_PACKAGE: string;
};
export default _default;
