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

import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

import { inspectThreshold, planThreshold, thresholdDrift, thresholdWriteMatches } from './threshold.ts';
import type { ObservedState } from './threshold.ts';

/** The package name the `compaction-basic` row resolves. */
export const REDIRECT_PACKAGE = '@deepseek-ai/dsh-compaction-basic';

/**
 * Marker carried in the redirect's `version`.
 *
 * A package at the redirect path is this plugin's only when its version carries
 * this string; anything else is somebody's real backend. It is the whole reason
 * the redirect carries a version marker at all.
 */
export const REDIRECT_MARKER = 'context-zip';

/** The stamp written beside `base.js`; key names match `install.mjs`. */
export const STAMP_FILE = 'base.json';

/** The plugin package's own name, used to reject it as a profile. */
const PLUGIN_NAME = 'dsh-context-zip';

/** Best-effort canonical form; the lexical path when nothing exists there. */
async function canonical(target) {
  return realpath(target).catch(() => resolve(target));
}

/** Is `real` the root itself or something under it? */
function isInside(real, root) {
  return real === root || real.startsWith(`${root}${sep}`);
}

/**
 * Where a path physically lands, plus the deepest existing ancestor checked.
 *
 * The typed path may already contain symlinks ABOVE the point where the walk can
 * start (`<home>/profiles/web` is often a symlink to `<home>/profiles/web-real`),
 * so the deepest existing ancestor is resolved and the missing suffix re-appended.
 * That answers "if I create this, where does the write land", which is the only
 * question that matters for a write-through-symlink.
 *
 * @param target - absolute path about to be written.
 * @returns the flattened path, the deepest existing ancestor, and the rest.
 */
async function flattenPath(target) {
  const parts = [];
  let probe = target;
  for (;;) {
    try {
      return { flattened: join(await realpath(probe), ...parts), anchor: probe, rest: parts };
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return { flattened: target, anchor: probe, rest: [] };
      parts.unshift(basename(probe));
      probe = parent;
    }
  }
}

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
export async function assertPathInsideProfile(target, label, profileReal) {
  const absolute = resolve(target);
  const { flattened, anchor, rest } = await flattenPath(absolute);
  if (!isInside(flattened, profileReal)) {
    throw new Error(
      `${label} is ${absolute}, which resolves to ${flattened}, outside the profile ${profileReal}. ` +
        'This route writes through symlinks. Refusing before anything is written. ' +
        'Fix: make the affected directory a real directory and symlink each package inside it ' +
        'individually, instead of symlinking the directory as a whole.',
    );
  }
  let current = anchor;
  for (const segment of rest) {
    const candidate = join(current, segment);
    let stats;
    try {
      stats = await lstat(candidate);
    } catch {
      // Not created yet: whatever is deeper does not exist either, and creating it
      // writes here, which the checks above already cleared.
      break;
    }
    current = candidate;
    if (stats.isSymbolicLink()) {
      let resolved;
      try {
        resolved = await realpath(current);
      } catch {
        throw new Error(
          `${label} is hidden behind the symlink ${current}, which points at nothing that exists. ` +
            'This route writes through symlinks, so it cannot tell where that would land. Refusing.',
        );
      }
      if (!isInside(resolved, profileReal)) {
        throw new Error(
          `${label} is hidden behind the symlink ${current}, which resolves to ${resolved}, ` +
            `outside the profile ${profileReal}. This route writes through symlinks. ` +
            'Refusing before anything is written. ' +
            'Fix: make the directory that holds it a real directory and symlink each package ' +
            'inside that directory individually, instead of symlinking the directory as a whole.',
        );
      }
    }
  }
  return flattened;
}

/**
 * Why `dir` is not a profile, or `null` when it looks like one.
 *
 * The decisive case is the trap this module exists to avoid: when the context
 * base happens to be the plugin's own directory (inside a package manager's
 * store), `dir/package.json` names this plugin. A profile's manifest does not.
 *
 * @param dir - candidate profile directory.
 * @param pluginDir - this plugin's own directory.
 * @returns a human reason, or `null`.
 */
async function profileRejection(dir, pluginDir) {
  const real = await canonical(dir);
  const pluginReal = await canonical(pluginDir);
  if (real === pluginReal) return 'it is the directory this plugin itself lives in';
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return 'there is no readable package.json there';
  }
  if (manifest?.name === PLUGIN_NAME) return 'its package.json names this plugin';
  return null;
}

/**
 * The profile whose `node_modules` really holds this plugin, found through the
 * harness home, or `null` when that is not answerable.
 *
 * This is the fallback for a context that carries no usable base URL. It does not
 * guess: a candidate counts only when `<candidate>/node_modules/dsh-context-zip`
 * resolves to the very directory this module is running from, and it answers only
 * when exactly one candidate does. Zero or several answers mean the fallback
 * declines, and the caller reports that instead of writing somewhere plausible.
 *
 * @param pluginDir - this plugin's own directory.
 * @returns the absolute profile directory, or `null`.
 */
async function profileFromHome(pluginDir) {
  const profiles = join(dshHomePath(), 'profiles');
  let names;
  try {
    names = await readdir(profiles);
  } catch {
    return null;
  }
  const pluginReal = await canonical(pluginDir);
  const matches = [];
  for (const name of names) {
    const dir = join(profiles, name);
    let here;
    try {
      here = await realpath(join(dir, 'node_modules', PLUGIN_NAME));
    } catch {
      continue;
    }
    if (here !== pluginReal) continue;
    if ((await profileRejection(dir, pluginDir)) !== null) continue;
    matches.push(dir);
  }
  return matches.length === 1 ? matches[0] : null;
}

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
export async function resolveProfileDirectory(baseUrl, pluginDir) {
  const typed = typeof baseUrl === 'string' && baseUrl.length > 0 ? toDirectory(baseUrl) : null;
  if (typed !== null) {
    const rejection = await profileRejection(typed, pluginDir);
    if (rejection === null) return typed;
    const fromHome = await profileFromHome(pluginDir);
    if (fromHome !== null) return fromHome;
    throw new Error(
      `the DSH context base URL is ${typed}, and that is not a profile: ${rejection}. ` +
        `No profile under ${join(dshHomePath(), 'profiles')} holds this plugin either, so the ` +
        'profile cannot be named. Refusing to write: guessing a profile would put the redirect ' +
        'in somebody else\'s tree. Re-run `node install.mjs --profile-dir <profile>` instead.',
    );
  }
  const fromHome = await profileFromHome(pluginDir);
  if (fromHome !== null) return fromHome;
  throw new Error(
    'the DSH context carries no base URL, and no profile under ' +
      `${join(dshHomePath(), 'profiles')} holds this plugin, so the profile cannot be named. ` +
      'Refusing to write: guessing a profile would put the redirect in somebody else\'s tree. ' +
      'Re-run `node install.mjs --profile-dir <profile>` instead.',
  );
}

/**
 * Turn a context base URL (or a plain absolute path) into a directory candidate.
 *
 * @param candidate - `file:` URL or path.
 * @returns the absolute directory path, or `null` when it is neither.
 */
function toDirectory(candidate) {
  if (candidate.startsWith('file:')) {
    try {
      return fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  return resolve(candidate);
}

/**
 * Resolve `<profile>/node_modules` once and refuse profiles where it leads out.
 *
 * Pinning the container is what makes the later per-path checks a closure: with
 * `node_modules` pointing outside while a package name inside it points back in,
 * every individual check passes and the write still lands outside.
 *
 * @param profileDir - the profile directory.
 * @param profileReal - its canonical path.
 * @returns the real path of the profile's `node_modules`.
 */
async function resolveModulesRoot(profileDir, profileReal) {
  const modules = resolve(join(profileDir, 'node_modules'));
  const { flattened } = await flattenPath(modules);
  if (!isInside(flattened, profileReal)) {
    throw new Error(
      `${modules} resolves to ${flattened}, which is outside the profile ${profileReal}. ` +
        'This route writes through symlinks. Refusing before anything is written. ' +
        'Fix: make node_modules a real directory and symlink each package inside it individually.',
    );
  }
  if (flattened === profileReal) {
    throw new Error(
      `${modules} resolves to the profile directory itself (${profileReal}), not to a directory ` +
        'inside it. Refusing to write into the profile root.',
    );
  }
  return flattened;
}

/**
 * The redirect directory, in the canonical form the write will land on.
 *
 * @param profileDir - the profile directory.
 * @param profileReal - its canonical path.
 * @returns the absolute redirect directory.
 */
async function redirectTarget(profileDir, profileReal) {
  const modulesRoot = await resolveModulesRoot(profileDir, profileReal);
  const target = join(modulesRoot, REDIRECT_PACKAGE);
  return assertPathInsideProfile(target, 'the redirect directory', profileReal);
}

/**
 * What currently sits at the redirect path.
 *
 * @param redirectDir - the redirect directory.
 * @returns 'ours', 'foreign', or 'absent'.
 */
async function redirectOccupant(redirectDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(redirectDir, 'package.json'), 'utf8'));
  } catch {
    return 'absent';
  }
  return String(manifest.version ?? '').includes(REDIRECT_MARKER) ? 'ours' : 'foreign';
}

/** The stamp written by a previous wiring, or `null` when there is none. */
async function readStamp(redirectDir) {
  try {
    const stamp = JSON.parse(await readFile(join(redirectDir, STAMP_FILE), 'utf8'));
    return stamp !== null && typeof stamp === 'object' ? stamp : null;
  } catch {
    return null;
  }
}

/**
 * The `node_modules` directories the harness process itself would resolve from.
 *
 * A 0.1.7 upgrade rewrites the harness's own store and re-links only the harness
 * tree. Measured on this machine after the 0.1.7 install: the profile-level
 * `profiles/node_modules/@deepseek-ai/dsh-compaction-basic` link still points at
 * the removed `0.1.5-rc.2` store directory, so Node's profile lookup paths find
 * nothing at all, while the backend the harness actually ships sits in the same
 * pnpm store as the running harness. Skipping the host half therefore made the
 * shipped version unreadable exactly when it had changed, which is the one moment
 * the comparison exists for.
 *
 * The anchor is the running process's entry point (`process.argv[1]`), resolved
 * through symlinks: the harness bin is a real path here, and a launcher that
 * reaches it through a symlink still lands in the store. Every ancestor's
 * `node_modules` and pnpm's `.pnpm/node_modules` hoist are probed. Nothing is
 * guessed from the home directory: a directory counts only when a readable
 * manifest is found there, and the version-marker check in
 * {@link basePackageDir} still rejects this plugin's own redirect.
 *
 * @returns candidate `node_modules` directories, nearest ancestor first.
 */
async function hostLookupBases() {
  const entry = process.argv?.[1];
  if (typeof entry !== 'string' || entry.length === 0) return [];
  let started;
  try {
    started = await realpath(entry);
  } catch {
    started = resolve(entry);
  }
  const bases = [];
  for (let dir = dirname(started); ; dir = dirname(dir)) {
    bases.push(join(dir, 'node_modules'));
    bases.push(join(dir, 'node_modules', '.pnpm', 'node_modules'));
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  return bases;
}

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
export async function basePackageDir(profileDir) {
  const require = createRequire(join(profileDir, 'package.json'));
  const bases = [...(require.resolve.paths(REDIRECT_PACKAGE) ?? [])];
  for (const base of await hostLookupBases()) {
    if (!bases.includes(base)) bases.push(base);
  }
  for (const base of bases) {
    const candidate = join(base, REDIRECT_PACKAGE);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (String(manifest.version ?? '').includes(REDIRECT_MARKER)) continue;
    return candidate;
  }
  throw new Error(`cannot locate a shipped ${REDIRECT_PACKAGE} from ${profileDir}`);
}

/**
 * The `source` an installed redirect recorded, when that path still holds a real
 * package.
 *
 * @param redirectDir - where the redirect would be.
 * @returns the recorded package directory, or `null`.
 */
async function recordedBackendDir(redirectDir) {
  let stamp;
  try {
    stamp = JSON.parse(await readFile(join(redirectDir, STAMP_FILE), 'utf8'));
  } catch {
    return null;
  }
  const source = typeof stamp.source === 'string' ? stamp.source : null;
  if (source === null) return null;
  try {
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    // A recorded path that now carries a redirect is not the shipped backend.
    if (String(manifest.version ?? '').includes(REDIRECT_MARKER)) return null;
    return source;
  } catch {
    return null;
  }
}

/**
 * Where the shipped backend can be read from.
 *
 * `basePackageDir` answers only while the profile's own copy of the specifier is
 * still the real package. An installed redirect REPLACES that copy, and under a
 * package manager's layout the real one sits in the store, off every lookup
 * path. Without this fallback the button could wire a row exactly once and never
 * repair it, because re-wiring reads the very thing the redirect displaced. The
 * stamp records where that copy came from, and that is the one pointer left.
 *
 * @param profileDir - the profile whose `node_modules` is searched.
 * @param redirectDir - where an existing redirect would be.
 * @returns the absolute package directory.
 * @throws when neither the lookup path nor the stamp answers.
 */
async function wireBackendDir(profileDir, redirectDir) {
  try {
    return await basePackageDir(profileDir);
  } catch (error) {
    const recorded = await recordedBackendDir(redirectDir);
    if (recorded !== null) return recorded;
    throw new Error(
      `${String(error?.message ?? error)}. A redirect is installed at ${redirectDir}, so this profile ` +
        'no longer resolves that specifier, and the source its stamp recorded is gone too. Plant a copy ' +
        `of the real package at ${join(dirname(profileDir), 'node_modules', '@deepseek-ai', 'dsh-compaction-basic')} and press the button again.`,
    );
  }
}

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
export async function readWireStatus(options) {
  const { baseUrl, pluginDir } = options ?? {};
  const profileDir = await resolveProfileDirectory(baseUrl, pluginDir);
  const profileReal = await canonical(profileDir);
  const redirectDir = await redirectTarget(profileDir, profileReal);
  const occupant = await redirectOccupant(redirectDir);
  if (occupant !== 'ours') {
    // A package this plugin did not write is reported as unwired AND flagged, so
    // the panel can say why the button is not simply going to fix it.
    return { wired: false, version: null, copiedAt: null, stale: false, foreign: occupant === 'foreign' };
  }
  const stamp = await readStamp(redirectDir);
  if (stamp === null) {
    // Our package marker without the stamp: a half state. Reported as unwired so
    // the button offers to write it again.
    return { wired: false, version: null, copiedAt: null, stale: false, partial: true };
  }
  const version = typeof stamp.version === 'string' ? stamp.version : null;
  let stale = false;
  // The version the shipped backend carries right now, as opposed to the one the
  // stamp recorded when the redirect was written. The panel's "update available"
  // line names both, so the two cannot be the same field.
  let current = null;
  try {
    const shippedDir = await basePackageDir(profileDir);
    const shipped = JSON.parse(await readFile(join(shippedDir, 'package.json'), 'utf8'));
    current = String(shipped.version ?? 'unknown');
    stale = current !== version;
  } catch {
    // The backend could not be located; that is not a status read failure.
  }
  // The threshold edit is read back from the bytes, never assumed from the stamp:
  // a `base.js` that lost the patch behaves like an unpatched backend, and being
  // able to tell those two apart is the whole reason the state is recorded.
  let patchObserved: ObservedState | null = null;
  let patchDrift = false;
  try {
    const text = await readFile(join(redirectDir, 'base.js'), 'utf8');
    patchObserved = inspectThreshold(text);
    patchDrift = thresholdDrift(stamp.patch, text);
  } catch {
    // An unreadable `base.js` is not a failed status read; it is drift.
    patchDrift = true;
  }
  return {
    wired: true,
    version,
    current,
    copiedAt: typeof stamp.copiedAt === 'string' ? stamp.copiedAt : null,
    stale,
    foreign: false,
    patch: typeof stamp.patch === 'string' ? stamp.patch : null,
    patchObserved,
    patchDrift,
  };
}

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
export async function wireCompactionRow(options) {
  const { baseUrl, pluginDir } = options ?? {};
  const profileDir = await resolveProfileDirectory(baseUrl, pluginDir);
  const profileReal = await canonical(profileDir);
  const redirectDir = await redirectTarget(profileDir, profileReal);

  const occupant = await redirectOccupant(redirectDir);
  if (occupant === 'foreign') {
    throw new Error(
      `${redirectDir} holds a real ${REDIRECT_PACKAGE}, not this plugin's redirect: refusing to ` +
        'overwrite a package this plugin did not put there. Move that copy up to ' +
        `${join(dirname(profileDir), 'node_modules')} (the shared level, where the backend is ` +
        'expected) and press the button again.',
    );
  }

  // Resolve the backend first, and before anything is removed: a refusal has to
  // leave a working wiring standing. `wireBackendDir` also covers the re-wiring
  // case, where the redirect itself is what hides the real package.
  const baseDir = await wireBackendDir(profileDir, redirectDir);
  const baseManifest = JSON.parse(await readFile(join(baseDir, 'package.json'), 'utf8'));
  if (String(baseManifest.version ?? '').includes(REDIRECT_MARKER)) {
    throw new Error(
      `${baseDir} is a previous redirect, not the shipped backend: remove ${redirectDir} and ` +
        'press the button again so the real package resolves.',
    );
  }
  const baseEntry = join(baseDir, baseManifest.exports?.['.']?.default ?? baseManifest.main);
  const baseSource = await readFile(baseEntry, 'utf8');
  const version = String(baseManifest.version ?? 'unknown');
  // The threshold decision, made before anything is removed: a backend carrying
  // neither recognised form has to stop the button while the previous wiring is
  // still standing. The command line can pass `--stock-backend` to wire such a
  // backend on purpose; the button has no arguments, so it refuses and says why.
  const plan = planThreshold(baseSource, { allowStock: false });

  // The two copied files are read before the target is cleared, so a plugin tree
  // that somehow lost `redirect/` fails while the old redirect is still standing.
  const sourceDir = join(pluginDir, 'redirect');
  const sourceIndex = join(sourceDir, 'index.js');
  const sourceManifest = join(sourceDir, 'package.json');
  try {
    await stat(sourceIndex);
    await stat(sourceManifest);
  } catch (error) {
    throw new Error(
      `this plugin's own redirect files are missing under ${sourceDir}: ` +
        `${String(error?.message ?? error)}. Reinstall the plugin package and press the button again.`,
    );
  }

  const stamp = {
    package: REDIRECT_PACKAGE,
    version,
    source: baseDir,
    copiedAt: new Date().toISOString(),
    patch: plan.state,
  };
  await rm(redirectDir, { recursive: true, force: true });
  await mkdir(redirectDir, { recursive: true });
  await cp(sourceManifest, join(redirectDir, 'package.json'));
  await cp(sourceIndex, join(redirectDir, 'index.js'));
  await writeFile(join(redirectDir, 'base.js'), plan.text);
  // The bytes are the contract: a file that is not what the plan decided removes
  // the redirect rather than leaving an unverified backend where the row loads it.
  const written = await readFile(join(redirectDir, 'base.js'), 'utf8');
  if (!thresholdWriteMatches(written, plan)) {
    await rm(redirectDir, { recursive: true, force: true });
    throw new Error(
      `wrote ${join(redirectDir, 'base.js')} but read back ${inspectThreshold(written)}: ` +
        'removed the redirect rather than leave an unverified backend in place',
    );
  }
  await writeFile(join(redirectDir, STAMP_FILE), JSON.stringify(stamp, void 0, 2) + '\n');
  return { wired: true, version, copiedAt: stamp.copiedAt, source: baseDir, patch: plan.state };
}

/**
 * The settings file a 0.1.7 upgrade renames the live one into.
 *
 * The upgrade migrates only a whitelist of sections, so a plugin's own section
 * can be left in this file and never reach the profile row that now holds plugin
 * settings. That is the state the `migrate` attention kind exists to name.
 */
const IMPORTED_SETTINGS = 'settings.yaml.imported';

/** The live settings file, still readable until the upgrade moves it. */
const LIVE_SETTINGS = 'settings.yaml';

/**
 * A top-level `context-zip:` key in a settings file.
 *
 * A lexical scan, not a parse: the plugin has no YAML parser on purpose (it must
 * load on a profile that never installed one) and the question is only whether
 * the section is still written there. Column zero is what makes it top-level, and
 * a missing or unreadable file is not a match — never a guess.
 */
const SETTINGS_SECTION_RE = /^["']?context-zip["']?[ \t]*:/mu;

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
export async function importedSettingsPending(home) {
  if (typeof home !== 'string' || home.length === 0) return false;
  for (const name of [IMPORTED_SETTINGS, LIVE_SETTINGS]) {
    try {
      const text = await readFile(join(home, name), 'utf8');
      if (SETTINGS_SECTION_RE.test(text)) return true;
    } catch {
      // Absent or unreadable: that file says nothing about a pending migration.
    }
  }
  return false;
}

/**
 * Whether the redirect was written after the running process began.
 *
 * The same judgment the panel makes in `client/live.ts`, kept server-side so the
 * `attention` field and the row's own status cannot disagree. Both timestamps
 * must parse; anything less is not evidence.
 *
 * @param copiedAt - the stamp's ISO time.
 * @param processStartedAt - when this harness process began.
 * @returns true only with two parseable times and `copiedAt` later.
 */
function copiedAfterStart(copiedAt, processStartedAt) {
  if (typeof copiedAt !== 'string' || copiedAt.length === 0) return false;
  if (typeof processStartedAt !== 'string' || processStartedAt.length === 0) return false;
  const copied = Date.parse(copiedAt);
  const started = Date.parse(processStartedAt);
  if (Number.isFinite(copied) === false || Number.isFinite(started) === false) return false;
  return copied > started;
}

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
export function attentionKind(status, processStartedAt) {
  const wired = status?.wired === true;
  if (wired && status?.stale === true) return 'update';
  if (wired !== true) {
    if (status?.foreign === true) return null;
    return status?.partial === true ? 'incomplete' : 'inactive';
  }
  if (copiedAfterStart(status?.copiedAt, processStartedAt)) return 'restart';
  return null;
}

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
export async function readAttention(options) {
  const { status, processStartedAt, profileDir, rowConfigured, kind: forced } = options ?? {};
  let home;
  try {
    home = dshHomePath();
  } catch {
    return null;
  }
  if (typeof home !== 'string' || home.length === 0) return null;
  const profile = typeof profileDir === 'string' && profileDir.length > 0 ? basename(profileDir) : '';
  if (profile.length === 0) return null;
  const kind = typeof forced === 'string' && forced.length > 0 ? forced : attentionKind(status, processStartedAt);
  if (kind === null) return null;
  if (kind === 'inactive' && rowConfigured === false) {
    let pending = false;
    try {
      pending = await importedSettingsPending(home);
    } catch {
      // An unreadable home answers `inactive`, the status the row already shows.
      pending = false;
    }
    if (pending) return { kind: 'migrate', home, profile };
  }
  return { kind, home, profile };
}

export default {
  resolveProfileDirectory,
  readWireStatus,
  wireCompactionRow,
  basePackageDir,
  attentionKind,
  importedSettingsPending,
  readAttention,
  REDIRECT_PACKAGE,
};
