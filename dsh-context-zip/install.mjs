#!/usr/bin/env node
/**
 * Install dsh-context-zip into a dsh profile.
 *
 * Two things have to agree for the compaction row to point at this plugin:
 *
 * 1. `dsh-context-zip` — the plugin itself: tools, settings section, routes, and
 *    the compaction engine it carries at `engine/`. The plugin reaches that
 *    engine through its own `./engine` subpath, so it loads with no second
 *    package installed beside it.
 * 2. `@deepseek-ai/dsh-compaction-basic` under the profile — the redirect that
 *    the `compaction-basic` row's name resolves to. It carries a copy of the
 *    shipped backend as `base.js`.
 *
 * The plugin is inert on its own; only the redirect changes what the harness
 * mounts. Every step is a plain file copy, so it is reversible by deleting the
 * two directories and the profile entry.
 *
 * Usage:
 *   node install.mjs --profile-dir <dir> [--uninstall | --purge | --check] [--home <dir>]
 *                    [--yes-unnamed-home]
 *
 * `--purge` removes `<home>/context-zip`, and that home is derived from
 * `--profile-dir`, never from the ambient `DSH_HOME`. Two clues, in order: the
 * profile's real path two levels up when that level is spelled `profiles`, and
 * otherwise the home the path is written under (`<home>/profiles/<name>` — the
 * harness resolves profiles lexically, so a `profiles/` symlink pointing at a
 * differently named directory still names its home). An `--home` that resolves to
 * a different home than the derived one is refused. Only when neither clue names
 * a home at all does `--home` become the answer, and there it is used as given,
 * unverified: `--purge` refuses to delete on that word alone unless
 * `--yes-unnamed-home` is passed, which is the one case that flag exists for. It
 * decides nothing when a home is derivable (the `--home` guard answers there) and
 * nothing for `--uninstall`, which deletes no store.
 *
 * @module dsh-context-zip/install
 */

import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = 'dsh-context-zip';
/**
 * Older releases installed the engine as a package of its own. The name is kept
 * only so installs and uninstalls still clear that leftover; the engine now
 * travels inside the plugin directory.
 */
const ENGINE = 'dsh-context-zip-engine';
const REDIRECT = '@deepseek-ai/dsh-compaction-basic';

/** Read `--flag value` pairs; unknown flags are ignored so the script stays forgiving. */
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const profileDir = resolve(String(args['profile-dir'] ?? '.'));
let pluginDir = join(profileDir, 'node_modules', PLUGIN);
let engineDir = join(profileDir, 'node_modules', ENGINE);
let redirectDir = join(profileDir, 'node_modules', REDIRECT);
const manifestPath = join(profileDir, 'package.json');


// ---------------------------------------------------------------------------
// Symlink-escape guards
//
// Symlinks are transparent to writers: `cp` and `writeFile` follow them, and a
// recursive `rm` deletes at the place they point to. Until these guards existed
// the installer had no idea it was writing or deleting outside the profile, and
// slice R3 proved it wrote four files into the harness home by symlinking the profile's
// `node_modules/@deepseek-ai` away.
//
// The first attempt guarded each target independently, which is not a closure:
// with `node_modules` pointing outside while two package names inside it point
// back in, every individual check passes and the recursive delete still lands
// outside. What follows therefore checks the CONTAINER once (see
// `resolveModulesRoot`) and builds every install target underneath the real path
// that check produced, so the whole install subtree is covered by one decision.
//
// The remaining per-path checks exist for the branches that do not go through
// that container (the manifest file, `--purge`'s store), plus the danger that
// `--uninstall` is pointed at a profile whose plugin was never installed here.
// ---------------------------------------------------------------------------

/** The profile's own real path; every guard compares against this one string. */
let realProfileCache;
async function realProfile() {
  realProfileCache ??= await realpath(profileDir).catch(() => resolve(profileDir));
  return realProfileCache;
}

/** Is `real` the profile itself or something under it? */
function isInsideProfile(real, realProfilePath) {
  return real === realProfilePath || real.startsWith(`${realProfilePath}${sep}`);
}

/**
 * What `target` physically looks like, plus how to keep checking it.
 *
 * The typed path may already contain symlinks ABOVE the point where the walk can
 * start: `<home>/profiles/web` is often a symlink to `<home>/profiles/web-real`,
 * and then the deepest existing ancestor is the real profile while `target` still
 * reads through the link. Resolving that ancestor (`realpath`) and re-appending
 * the part that does not exist yet is what makes the answer mean "where the write
 * physically lands", which is the only question that matters here.
 *
 * This is deliberately NOT the same as accepting the path as typed whenever it
 * resolves inside the profile: that was measured to wave through a target whose
 * real location is in another tree, because a symlinked `profiles/` makes the two
 * spellings name different parent directories.
 *
 * @param target - the absolute path about to be written or deleted.
 * @returns the flattened path, the deepest existing ancestor, and the segments
 *   from that ancestor down to the target.
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
 * Refuse a target whose write would land outside the profile, and return where it
 * physically lands.
 *
 * `realpath` on the whole target is not enough: a target that does not exist yet
 * reports ENOENT and would be waved through even when the reason it does not
 * exist is that a parent symlink points outside. Flattening the existing prefix
 * and then walking the rest answers the question that matters — "if I create
 * this, where does the write land?" — and a dangling symlink is refused rather
 * than silently skipped, which used to produce a half-install that died later on
 * a bare ENOTDIR.
 *
 * @param target - the path this call is about to write or delete.
 * @param label - how to name the path in the refusal.
 * @returns the path the write will physically land on, with every existing
 *   prefix inside the profile.
 */
async function assertPathInsideProfile(target, label) {
  const profileReal = await realProfile();
  const absolute = resolve(target);
  const { flattened, anchor, rest } = await flattenPath(absolute);
  if (!isInsideProfile(flattened, profileReal)) {
    throw new Error(
      `${label} is ${absolute}, which resolves to ${flattened}, outside the profile ${profileReal}.\n` +
        'This installer writes and deletes through symlinks. Refusing before anything is written ' +
        'or deleted.\n' +
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
      // Not created yet. Whatever is deeper does not exist either, and creating
      // it writes here, which the checks above already cleared.
      break;
    }
    current = candidate;
    if (stats.isSymbolicLink()) {
      let resolved;
      try {
        resolved = await realpath(current);
      } catch {
        throw new Error(
          `${label} is hidden behind the symlink ${current}, which points at nothing that exists.\n` +
            'This installer writes and deletes through symlinks, so it cannot tell where that ' +
            'would land. Refusing.\n' +
            'Fix: replace that symlink with a real directory, or point it at an existing ' +
            'directory inside the profile.',
        );
      }
      if (!isInsideProfile(resolved, profileReal)) {
        throw new Error(
          `${label} is hidden behind the symlink ${current}, which resolves to ${resolved}, ` +
            `outside the profile ${profileReal}.\n` +
            'This installer writes and deletes through symlinks, and a recursive delete there ' +
            'would reach outside the profile. Refusing before anything is written or deleted.\n' +
            'Fix: make the directory that holds it a real directory and symlink each package ' +
            'inside that directory individually, instead of symlinking the directory as a whole.',
        );
      }
    }
  }
  return flattened;
}

/** Convenience for the current target set: always the plugin's own directories. */
async function assertInsideProfile(target, label) {
  return assertPathInsideProfile(target, label);
}

/**
 * File version: the directory can be perfectly legal while the file itself is a
 * symlink out of the tree.
 *
 * Measured (`manifest_link_outside`): `<profile>/package.json` was a symlink to
 * another tree's `package.json`, and `writeFile` rewrote that file. Guarding the
 * directory alone cannot see this, so the file's own real path is checked too.
 * A file that does not exist yet has no symlink to follow and passes.
 *
 * @param file - the file this call is about to write.
 * @param label - how to name the file in the refusal.
 */
async function assertFileInsideProfile(file, label) {
  await assertPathInsideProfile(file, label);
  const profileReal = await realProfile();
  let resolved;
  try {
    resolved = await realpath(resolve(file));
  } catch {
    return;
  }
  if (!isInsideProfile(resolved, profileReal)) {
    throw new Error(
      `${label} is a symlink to ${resolved}, which is outside the profile ${profileReal}.\n` +
        'Refusing to write through it: the write would land in another tree.\n' +
        'Fix: replace the symlink with a real file, or install into the profile that file ' +
        'belongs to.',
    );
  }
}

/**
 * Resolve `<profile>/node_modules` ONCE and refuse profiles where it leads out of
 * the profile.
 *
 * This is the closure the per-path guards could not give: with the container
 * pinned to one verified real path, every later target is built underneath it,
 * so a directory entry inside it (a package name that is itself a symlink to
 * somewhere else) can no longer smuggle an operation out of the tree — that
 * entry is part of the resolved subtree and moves with it.
 *
 * `node_modules` may also be a symlink that stays inside the profile (a profile
 * may keep packages in `vendor/`). That is allowed and the returned path is the
 * real one, so the install writes where the symlink actually points.
 *
 * @returns the real path of the profile's `node_modules`.
 */
async function resolveModulesRoot() {
  const modules = resolve(join(profileDir, 'node_modules'));
  const profileReal = await realProfile();
  const { flattened } = await flattenPath(modules);
  if (!isInsideProfile(flattened, profileReal)) {
    throw new Error(
      `${modules} resolves to ${flattened}, which is outside the profile ${profileReal}.\n` +
        'This profile uses a symlink that points out of its own tree, and this installer ' +
        'writes and deletes through symlinks. Refusing before anything is written or deleted, ' +
        'because a recursive delete there would reach outside the profile.\n' +
        'Fix: make node_modules a real directory and symlink each package inside it ' +
        'individually, instead of symlinking node_modules as a whole.',
    );
  }
  if (flattened === profileReal) {
    throw new Error(
      `${modules} resolves to the profile directory itself (${profileReal}), not to a directory ` +
        'inside it. Refusing to install into the profile root.\n' +
        'Fix: make node_modules a real directory instead of a symlink to the profile.',
    );
  }
  return flattened;
}

/**
 * The three directories this script installs into, under the verified container.
 *
 * Resolving the container is only half the job: the targets are the container
 * PLUS `@deepseek-ai/dsh-compaction-basic`, and that package name can itself be
 * a symlink out of the profile. Building the path by `join` therefore rebuilds
 * the escape the container check just cleared — measured while fixing this very
 * bug, the guard passed on `node_modules` and the four redirect files still
 * landed outside. So every target is validated on its OWN segments and returned
 * in its canonical form.
 *
 * The uninstall branch cannot assume `node_modules` exists (a profile that never
 * had the plugin still has to uninstall cleanly), so it keeps the lexical paths
 * when there is nothing to resolve; deleting a path that is not there is a
 * no-op, and anything that IS there was checked by `assertDeletable`.
 *
 * @returns the plugin, engine, and redirect directories.
 */
async function pluginTargets() {
  try {
    const modulesRoot = await resolveModulesRoot();
    return {
      pluginDir: await resolveWithin(modulesRoot, PLUGIN, 'the plugin directory'),
      engineDir: await resolveWithin(modulesRoot, ENGINE, 'the engine directory'),
      redirectDir: await resolveWithin(modulesRoot, REDIRECT, 'the redirect directory'),
    };
  } catch (error) {
    if (!missingPathError(error)) throw error;
    return {
      pluginDir: join(profileDir, 'node_modules', PLUGIN),
      engineDir: join(profileDir, 'node_modules', ENGINE),
      redirectDir: join(profileDir, 'node_modules', REDIRECT),
    };
  }
}

/**
 * Join `name` onto `root` after proving the result cannot leave the profile, and
 * return the canonical path the write will actually land on.
 *
 * A package directory that is a symlink to another spot INSIDE the profile is
 * legal (that is the layout this installer recommends, one symlink per package),
 * and returning the canonical path means the copy lands where the symlink points
 * instead of piling a real directory on top of the user's link.
 *
 * @param root - a container the guards have already cleared.
 * @param name - the package directory name to join onto it.
 * @param label - how to name the path in a refusal.
 * @returns the canonical target path.
 */
async function resolveWithin(root, name, label) {
  const target = join(root, name);
  return assertPathInsideProfile(target, label);
}

/**
 * Refuse to delete a plugin directory that resolves out of the profile.
 *
 * `--uninstall` and `--purge` delete recursively, and the uninstall branch has no
 * container of its own to pin: one path at a time is what it needs, but the check
 * has to run before the first `rm`, including for the engine directory. The
 * original version guarded the plugin and redirect directories only, so a profile
 * whose `node_modules` pointed outside while those two names were symlinked back
 * inside lost a real directory that lived outside the profile (measured, 4.4).
 *
 * @param dir - a directory about to be deleted recursively.
 * @param label - how to name it in the refusal.
 */
async function assertDeletable(dir, label) {
  await assertPathInsideProfile(dir, label);
}

// Checked before ANY write, because the install path creates the redirect
// package first and reads this manifest afterwards: a mistyped `--profile-dir`
// used to leave a half-installed redirect behind and then die on a bare ENOENT
// that never said what was wrong with the path.
if (!existsSync(manifestPath)) {
  throw new Error(
    `${profileDir} does not look like a DSH profile: no package.json there. ` +
      'Pass the profile directory itself, for example <harness home>/profiles/web.',
  );
}

/**
 * Resolve the harness home the same way the plugin's own storage does.
 *
 * `DSH_HOME` wins when set; otherwise the harness default is used. Kept local so
 * the installer carries no dependency on a package that only resolves inside a
 * profile.
 *
 * @returns the absolute harness home directory.
 */
function harnessHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

/**
 * The harness home that owns the profile being operated on.
 *
 * `--profile-dir` names `<home>/profiles/<name>`, so the owning home sits two
 * levels up. The ambient `DSH_HOME` deliberately does NOT decide this. It names
 * whichever home the current shell is configured for, and in the ordinary
 * isolated-test workflow that is a DIFFERENT home from the one holding the
 * profile: following the environment there makes `--purge` delete another
 * home's working notes while leaving the target's own data in place. Deleting
 * from the wrong home is the worst thing this script can do, so the profile
 * wins, an unrecognisable shape is refused rather than guessed, and a
 * disagreement with the environment is printed instead of resolved silently.
 *
 * @param profileDir - the resolved profile directory from `--profile-dir`.
 * @param explicit - the `--home` override, when the caller supplied one.
 * @returns the owning home and where it came from, or null when it cannot be
 *   derived and no override was given.
 */
function homeForProfile(profileDir, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { home: resolve(explicit), from: '--home' };
  }
  const parent = dirname(profileDir);
  if (basename(parent) !== 'profiles') return null;
  return { home: dirname(parent), from: '--profile-dir' };
}

/**
 * The owning home, derived through the canonical profile path, and through the
 * spelling the caller used when the canonical path cannot name it.
 *
 * Two levels up from the REAL profile, and the middle level has to be spelled
 * `profiles`. Resolving the ancestry first is what keeps this consistent with the
 * directories that are actually deleted: deriving from the path as typed is how
 * one home's uninstall deletes another home's notes.
 *
 * The canonical path cannot name the home when the level that physically holds
 * the profile is not spelled `profiles` — `<home>/profiles` may be a symlink to
 * `<other>/profiles-real`, and then the REAL profile is
 * `<other>/profiles-real/<name>` and no ancestor carries the name. That is not a
 * reason to give up, because the spelling does name it: the harness resolves a
 * profile as `join(resolveDshHome(), 'profiles', name)` LEXICALLY (measured in
 * `@deepseek-ai/dsh-app-boot`: `resolveProfileDir` and `PROFILES_DIR`; no
 * `realpath` anywhere on that path), so a home spelled `<home>/profiles/<name>` is
 * a home that can actually run this profile, and `<home>/context-zip` is where
 * that run keeps its data. Measured: in that layout install succeeds, and a purge
 * that fell back to `--home` deleted `<home>/context-zip` while the canonical
 * guess `<other>/context-zip` — a home that cannot even see this profile, since
 * `<other>/profiles/<name>` does not exist — stayed behind. Deriving the typed
 * home here also keeps the `--home` guard working in this layout: naming a
 * different home is refused instead of silently trusted.
 *
 * The order matters. The canonical answer wins whenever it exists, because a home
 * that physically holds a `profiles/` directory is stronger evidence than a
 * spelling — with `<home>/profiles` symlinked to `<other>/profiles`, both homes
 * can run the profile and only the physical one says which tree the profile's own
 * `profiles/` directory lives in. The typed answer is used only when the canonical
 * path names nothing at all.
 *
 * @returns the owning home and where it came from, or null when neither the
 *   canonical path nor the typed spelling is shaped `<home>/profiles/<name>`.
 */
async function owningHome() {
  const real = await realProfile();
  const profiles = dirname(real);
  if (profiles === real) return null;
  const home = dirname(profiles);
  if (home === profiles) return null;
  if (basename(profiles) === 'profiles') return { home, from: '--profile-dir' };
  return homeForProfile(profileDir, void 0);
}

/** Is `candidate` on a path that fails because it is really not there? */
function missingPathError(error) {
  return error instanceof Error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Best-effort canonical form; falls back to the lexical path when nothing exists there. */
async function canonicalOrSelf(target) {
  return realpath(target).catch(() => resolve(target));
}

/**
 * The store `--purge` is about to delete recursively.
 *
 * The store is the ONE thing this script deletes that lives outside the profile
 * by design (`<home>/context-zip`), so the profile-relative guard cannot speak
 * about it. What can: a store belongs to the home that OWNS the profile being
 * uninstalled, and the owning home is derived from the profile's canonical path —
 * or, when that path carries no `profiles` level, from the spelling the caller
 * used (see `owningHome`). Deriving it from the path as typed is how one home's
 * uninstall deletes another home's notes — measured, with `profiles/` symlinked:
 * the plugin directories were removed from the real tree while the store was
 * removed from the tree the typed path pointed at.
 *
 * `--home` may name where the data lives (that is its documented job, and the
 * uninstall message follows it), but it does not get to aim a recursive delete
 * at another home's store. A `--home` that resolves to the owning home — the
 * same directory named a different way, which is exactly what a symlinked
 * `profiles/` produces — is accepted and the delete lands on the owning home's
 * store. A `--home` that resolves elsewhere is refused. Whether that other home
 * happens to hold a `context-zip/` at this instant is a fact about the
 * filesystem, not a reason to aim a recursive delete at it.
 *
 * @returns the store to remove, or null when there is nothing to remove.
 */
async function storeToPurge() {
  const explicit = typeof args.home === 'string' && args.home.length > 0 ? resolve(args.home) : null;
  const owner = await owningHome();
  const storeHome = owner === null ? null : await canonicalOrSelf(owner.home);

  if (storeHome === null && explicit === null) {
    throw new Error(
      `cannot tell which harness home owns ${profileDir}, so --purge refuses to remove a store. ` +
        'Expected a path shaped <home>/profiles/<name>, or pass --home <dir>.',
    );
  }
  // The store lives under the home derived from the profile. `--home` answers
  // only when nothing at all could be derived from the profile path, and then it
  // is used as given — there is no second opinion to check it against.
  const store = join(storeHome ?? explicit, 'context-zip');
  if (explicit === null || storeHome === null) return store;

  const explicitHome = await canonicalOrSelf(explicit);
  if (explicitHome === storeHome) return store;

  // A profile whose home IS derivable has one owning home, and `--home` naming
  // another one is refused: that is the defect this guard exists for, and "it
  // happens not to hold a store right now" is a fact about the filesystem at
  // this instant, not a reason to aim a recursive delete at another home.
  throw new Error(
    `--home ${explicit} resolves to ${explicitHome}, which is not the home that owns ${profileDir} ` +
      `(${storeHome}).\n` +
      'Refusing to --purge: a store under the named home belongs to whichever profile lives ' +
      "there, and deleting it is how one home's uninstall destroys another home's notes.\n" +
      `Fix: drop --home to purge ${store}, or point --profile-dir at the profile inside ` +
      `${explicitHome}.`,
  );
}

/**
 * `--purge` on a profile whose path names no home needs one explicit yes more.
 *
 * `owningHome` runs two derivation clues, both off `--profile-dir`: the `profiles`
 * level of the real path, and the level as spelled. When neither names a home,
 * `--home` is the only thing pointing at a store — and it is exactly as reliable
 * as the caller's typing. Until this guard existed the branch printed one `note`
 * line and then deleted `<--home>/context-zip` recursively. The note is honest;
 * it is not a check. Measured case (an acceptance item): a mistyped `--home`
 * in this shape removes another home's notes and exports, irreversibly, and the
 * only trace of the mistake is one line of a success message.
 *
 * The switch is required ONLY in this shape, which is what makes it readable: a
 * derivable home is checked against `--home` by `storeToPurge` and needs no flag,
 * and `--uninstall` deletes no store at all. The flag never substitutes for
 * `--home` either — with no home named there is nothing to delete, switch or not.
 *
 * Called before the first `rm` of the uninstall branch, not where the store is
 * removed: a refusal that has already uninstalled the profile is a half action,
 * and the caller's next move (re-run with the flag) would find nothing left to
 * uninstall.
 */
async function assertPurgeHomeAgreed() {
  if (args.purge !== true) return;
  if ((await owningHome()) !== null) return;
  const named = typeof args.home === 'string' && args.home.length > 0 ? resolve(args.home) : null;
  const shape =
    `${profileDir} is not shaped <home>/profiles/<name>: neither its real path nor the path as ` +
    'spelled has a level named `profiles`, so no home can be derived from it';
  if (named === null) {
    throw new Error(
      `${shape}, and no --home was given either, so --purge has nothing to aim at.\n` +
        'Refusing: --yes-unnamed-home confirms a home the caller names; it cannot name one.\n' +
        'Fix: pass --home <dir> to name the home, and --yes-unnamed-home to confirm that ' +
        '<dir>/context-zip is the store to delete.',
    );
  }
  if (args['yes-unnamed-home'] === true) return;
  throw new Error(
    `${shape}, and nothing backs the --home named below.\n` +
      `Refusing to --purge: it would delete ${join(named, 'context-zip')} RECURSIVELY, every file ` +
      'under it (working notes and exports), and the only thing pointing there is the word --home.\n' +
      `Fix: add --yes-unnamed-home to confirm that ${join(named, 'context-zip')} is the store to ` +
      'delete, or fix --home to name the right one.',
  );
}

/**
 * What currently sits at the redirect path. Only a package carrying this
 * plugin's version marker was put there by this installer; anything else is
 * somebody's real backend, and removing it would delete a package this
 * installer never created. The version marker is the only thing that tells the
 * two apart, which is why the redirect carries one.
 *
 * @returns 'ours' when the redirect is installed, 'foreign' for another
 *   package, 'absent' when nothing is there.
 */
async function redirectOccupant() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(redirectDir, 'package.json'), 'utf8'));
  } catch {
    return 'absent';
  }
  return String(manifest.version ?? '').includes('context-zip') ? 'ours' : 'foreign';
}

/**
 * Refuse to delete a foreign package sitting at the redirect path.
 *
 * Without this the install path removes that directory first and only then
 * looks for the shipped backend, so a profile that keeps its own copy at that
 * exact path loses the copy and then aborts with "cannot locate a shipped
 * @deepseek-ai/dsh-compaction-basic". Destroying somebody else's package and
 * failing afterwards is strictly worse than declining up front.
 *
 * @param action - verb for the refusal message, e.g. "install over".
 * @throws when the path holds a package this installer did not put there.
 */
async function assertRedirectIsOurs(action) {
  if ((await redirectOccupant()) !== 'foreign') return;
  throw new Error(
    `${redirectDir} holds a real @deepseek-ai/dsh-compaction-basic, not this plugin's redirect: ` +
      `refusing to ${action} a package this installer did not put there. Move that copy up to ` +
      `${join(dirname(profileDir), 'node_modules')} (the shared level, where this installer expects ` +
      `to find the shipped backend) and re-run.`,
  );
}

if (args.uninstall === true || args.purge === true) {
  await assertRedirectIsOurs('uninstall');
  ({ pluginDir, engineDir, redirectDir } = await pluginTargets());
  // Every recursive delete is guarded, engine included: the original version
  // guarded the plugin and redirect directories only, so a profile whose
  // `node_modules` pointed outside while those two names pointed back in lost a
  // real directory that lived outside the profile (uninstall bypass, measured).
  await assertDeletable(pluginDir, 'the plugin directory');
  await assertDeletable(engineDir, 'the engine directory');
  await assertDeletable(redirectDir, 'the redirect directory');
  // The manifest is written here too, and a symlinked manifest is how a write
  // escapes a directory-level guard.
  await assertFileInsideProfile(manifestPath, 'the profile manifest');
  // Checked here rather than at the store removal below, so a `--purge` that
  // cannot say which home it owns refuses while the profile is still standing.
  await assertPurgeHomeAgreed();
  await rm(pluginDir, { recursive: true, force: true });
  await rm(engineDir, { recursive: true, force: true });
  await rm(redirectDir, { recursive: true, force: true });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PLUGIN);
  await writeFile(manifestPath, JSON.stringify(manifest, void 0, 2) + '\n');

  // The plugin keeps its own state OUTSIDE the profile, under the harness home:
  // notes drafts and archives, and exported markdown. The compaction mode is not
  // stored anywhere — it is resolved from settings on every use.
  // None of it lives in a session log, which is exactly why uninstalling cannot
  // damage a session. It is still this plugin's data, so `--purge` takes it and
  // the default uninstall says plainly that it did not.
  //
  // The report has to name the home the DELETE will use, or it becomes its own
  // kind of lie. Two measured ways it used to: with `profiles/` symlinked to a
  // level still spelled `profiles`, the message announced the spelling while
  // `storeToPurge` removed the canonical home's store; and the plain uninstall's
  // "re-run with --purge to remove X" promised X while `--purge` would remove Y.
  // So both paths now follow the derivation, and `--home` only decides anything
  // when nothing could be derived — where it is the only answer there is.
  const derived = await owningHome();
  const named = typeof args.home === 'string' && args.home.length > 0 ? resolve(args.home) : null;
  const owner = derived ?? homeForProfile(profileDir, args.home);
  if (owner === null) {
    throw new Error(
      [
        `cannot tell which harness home owns ${profileDir}.`,
        'Expected a path shaped <home>/profiles/<name>.',
        "Pass --home <dir> to say which home's plugin data belongs to it.",
      ].join(' '),
    );
  }
  const store = join(owner.home, 'context-zip');
  const lines = [`uninstalled ${PLUGIN} from ${profileDir}`];
  const envHome = harnessHome();
  if (process.env.DSH_HOME !== void 0 && envHome !== owner.home) {
    lines.push(
      `  note DSH_HOME is ${envHome}, which is not this profile's home`,
      `  this profile's data lives under ${owner.home} (${owner.from}), and that is what is reported below`,
    );
  }
  if (derived !== null && named !== null) {
    const namedReal = await canonicalOrSelf(named);
    if (namedReal !== (await canonicalOrSelf(derived.home))) {
      lines.push(`  note --home ${named} is not the home that owns this profile, so it decides nothing here`);
    }
  }
  if (args.purge === true && derived === null) {
    // Nothing about the profile path says which home owns it, so `--home` is the
    // only answer there is. `assertPurgeHomeAgreed` already made the caller say
    // yes to that in writing; this line keeps the report from looking derived.
    lines.push(
      `  note ${profileDir} is not shaped <home>/profiles/<name>, so --home ${owner.home} is used as given`,
    );
  }
  if (args.purge === true) {
    // Guarded separately from the three directories above: the store lives
    // outside the profile on purpose, so "is it inside the profile" cannot be
    // the question. `storeToPurge` answers the question that can be asked — does
    // this store belong to the home that owns this profile — and returns null
    // when there is nothing to delete.
    const purgeStore = await storeToPurge();
    if (purgeStore === null) {
      lines.push(`  --home names a home that does not hold ${store}: nothing was removed`);
    } else {
      await rm(purgeStore, { recursive: true, force: true });
      lines.push(`  removed ${purgeStore}`);
    }
  } else {
    lines.push(
      `  kept ${store} (working notes and exports)`,
      '  kept the context-zip settings namespace, so a reinstall resumes where this left off',
      `  re-run with --purge to remove ${store} as well`,
      '  the settings namespace has no delete API: clear its entry in settings.yaml by hand to drop it too',
    );
  }
  lines.push('  session logs were never written to by this plugin, so there is nothing to undo there', '');
  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

/**
 * Locate the installed base package by probing Node's own lookup paths.
 *
 * `require.resolve` cannot be used: the package may not export `./package.json`,
 * and the redirect would answer the specifier anyway.
 *
 * @returns the absolute package directory.
 */
async function basePackageDir() {
  const require = createRequire(join(profileDir, 'package.json'));
  for (const base of require.resolve.paths('@deepseek-ai/dsh-compaction-basic') ?? []) {
    const candidate = join(base, '@deepseek-ai', 'dsh-compaction-basic');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
    } catch {
      // Not this one; keep walking outward exactly as Node would.
      continue;
    }
    // An installed redirect answers this very specifier, and it sits NEARER than
    // the real package, so a plain resolve finds the plugin and reports it as its
    // own backend. The version marker is what tells the two apart, which is why
    // the redirect carries one.
    if (String(manifest.version ?? '').includes('context-zip')) continue;
    return candidate;
  }
  throw new Error(`cannot locate a shipped @deepseek-ai/dsh-compaction-basic from ${profileDir}`);
}

if (args.check === true) {
  // Runs before anything is deleted: the stamp lives inside the redirect
  // directory that the install path removes first.
  const stampPath = join(redirectDir, 'base.json');
  let current;
  try {
    current = JSON.parse(await readFile(stampPath, 'utf8'));
  } catch {
    process.stdout.write(`no redirect stamp at ${stampPath}: ${PLUGIN} is not installed in ${profileDir}\n`);
    process.exit(2);
  }
  const shippedDir = await basePackageDir();
  const shipped = JSON.parse(await readFile(join(shippedDir, 'package.json'), 'utf8'));
  const shippedVersion = String(shipped.version ?? 'unknown');
  const drift = current.version !== shippedVersion;
  process.stdout.write(
    [
      `redirect wraps  ${current.package}@${current.version}  (copied ${current.copiedAt})`,
      `harness ships   ${shippedVersion}  at ${shippedDir}`,
      drift
        ? 'STALE: the backend changed since this redirect was installed; re-run without --check to refresh it'
        : 'in sync',
      '',
    ].join('\n'),
  );
  process.exit(drift ? 1 : 0);
}

// Nothing below this line reads or writes through an unchecked path. The first
// attempt at this fix wired its checks into the UNINSTALL branch only —
// `rm(pluginDir)` appears twice in the file and the edit took the first one — so
// the R3 scenario kept working: four files written through a symlink into another
// tree, and the recursive delete silently removing whatever was already there.
// Wiring is the part that has to be verified, not just the check function.
//
// The container first: resolve `node_modules` once and build every target
// underneath that single verified real path. Per-path checks alone are not a
// closure — `node_modules` pointing outside with two package names inside it
// pointing back in passed every one of them. This now runs BEFORE the redirect
// occupant check as well, so even that read goes through a validated path.
({ pluginDir, engineDir, redirectDir } = await pluginTargets());

// Read the shipped backend BEFORE the redirect is installed: once the redirect
// occupies that specifier, resolving it again would find the redirect itself.
// A redirect left by an earlier run therefore has to go first, but only after
// confirming it really is the redirect.
await assertRedirectIsOurs('install over');
// The manifest is not under `node_modules`, and a symlinked file escapes a
// directory-level guard, so it is checked on its own.
await assertFileInsideProfile(manifestPath, 'the profile manifest');
await rm(redirectDir, { recursive: true, force: true });
const baseDir = await basePackageDir();
const baseManifest = JSON.parse(await readFile(join(baseDir, 'package.json'), 'utf8'));

if (baseManifest.version?.includes('context-zip') === true) {
  throw new Error(
    `${baseDir} is a previous redirect, not the shipped backend: remove ${redirectDir} and re-run so the real package resolves again`,
  );
}
const baseEntry = join(baseDir, baseManifest.exports?.['.']?.default ?? baseManifest.main);
const baseSource = await readFile(baseEntry);
const baseVersion = String(baseManifest.version ?? 'unknown');

// `base.js` is a COPY taken now. Upgrade the harness later and the redirect keeps
// wrapping the backend as it was at this moment, silently. The stamp is what
// makes that visible; `--check` compares it against what resolves today.
const stamp = { package: '@deepseek-ai/dsh-compaction-basic', version: baseVersion, source: baseDir, copiedAt: new Date().toISOString() };

await rm(pluginDir, { recursive: true, force: true });
await rm(engineDir, { recursive: true, force: true });
await rm(redirectDir, { recursive: true, force: true });
await mkdir(join(profileDir, 'node_modules'), { recursive: true });

// Development-only trees never travel into a profile: `node_modules` is the dev
// toolchain, and `graphify-out` is generated analysis that would add hundreds of
// kilobytes of JSON and HTML to every install for no runtime benefit.
//
// `test/build` is deliberately NOT excluded: it is the built test entry, and
// `test/run.mjs --installed <this very directory>` reads it from here.
const DEV_ONLY = /[\\/](node_modules|\.git|graphify-out)([\\/]|$)/u;
await cp(here, pluginDir, {
  recursive: true,
  // The filter is asked about the root as well, and the root can itself live under a
  // `node_modules` directory: that is exactly where npm and pnpm put an installed
  // copy. Testing the absolute path rejects the root, skips the whole copy, and
  // leaves the profile with the plugin directory deleted (it was removed just above)
  // while still printing a success line. Test the path relative to the root instead.
  filter: (source) => {
    const inner = relative(here, source);
    if (inner === '') return true;
    return !DEV_ONLY.test(inner) && !source.endsWith('install.mjs');
  },
});
// The engine is not copied on its own: it lives inside the plugin directory and
// the plugin imports it through `dsh-context-zip/engine`.
await mkdir(join(redirectDir), { recursive: true });
await cp(join(here, 'redirect', 'package.json'), join(redirectDir, 'package.json'));
await cp(join(here, 'redirect', 'index.js'), join(redirectDir, 'index.js'));
await writeFile(join(redirectDir, 'base.js'), baseSource);
await writeFile(join(redirectDir, 'base.json'), JSON.stringify(stamp, void 0, 2) + '\n');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes(PLUGIN)) manifest.dsh.profile.bundles.push(PLUGIN);
await writeFile(manifestPath, JSON.stringify(manifest, void 0, 2) + '\n');

process.stdout.write(
  [
    `installed into ${profileDir}`,
    `  ${PLUGIN}       (the plugin)`,
    `  ${REDIRECT}  (row redirect, wrapping ${baseVersion} from ${baseDir})`,
    `  profile bundle list now: ${manifest.dsh.profile.bundles.join(', ')}`,
    'restart the harness for the row swap to take effect',
    '',
  ].join('\n'),
);
