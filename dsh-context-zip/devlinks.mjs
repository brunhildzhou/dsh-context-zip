/**
 * Plant the type checker's copy of every peer dependency.
 *
 * `tsc` resolves a bare specifier by walking `node_modules` upward from the file
 * that imports it, and it looks nowhere else. This package declares its fifteen
 * peers and installs none of them on purpose: at runtime every `@deepseek-ai/*`
 * import stays external and the composed profile's `node_modules` answers it, so
 * a local copy would only ever add a second one of a seam that must exist once
 * (see the header of `build.mjs` and `SHARED` below it). The type checker has no
 * such arrangement, so on a tree where the peers were never installed the second
 * ring of `npm run check` reports eighteen errors — ten `TS2307`, one `TS2664`
 * and five derived `TS2339` — that say nothing at all about this code.
 *
 * The fix has the same shape as the link `build.mjs` used to plant for the engine
 * package while that package still lived beside this one: plant a link in
 * `node_modules` before the tool that needs it runs. The links point
 * INTO the harness repository's own pnpm store rather than at the registry, so
 * nothing is downloaded, the version is the one the running harness actually
 * resolved, and the whole thing is undone by deleting the links again. The
 * repository's `tsconfig.json` is deliberately not touched: a `paths` entry
 * would tie the checker to one profile's absolute location and would have to be
 * rewritten per machine, which is exactly what this avoids.
 *
 * Idempotent. A second run finds each link already correct and rewrites nothing.
 *
 * It links every peer, plus the one package the peers' own declarations import
 * by name and that no peer carries a copy of; see {@link DECLARATION_ONLY}.
 *
 * Usage:
 *   node devlinks.mjs            # plant the links (npm run devlinks)
 *   node devlinks.mjs --undo     # remove the links this planted
 *
 * Environment:
 *   DSH_PEER_STORE  the pnpm store to link from, defaulting to the harness
 *                   repository found by walking up from this directory.
 *
 * @module dsh-context-zip/devlinks
 */

import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** This package's own `node_modules`, where every link is planted. */
const MODULES = join(here, 'node_modules');

/**
 * Packages that are not peers of this one, but that the peers' declarations
 * import by name.
 *
 * `@deepseek-ai/schemastery`'s own `lib/types/index.d.ts` opens with
 * `import { Binary, type Dict } from '@deepseek-ai/cosmokit'`, and that package
 * carries no `node_modules` of its own to answer it from. With no link the
 * import resolves to nothing, `noImplicitAny` is off, and the schema type this
 * package exports collapses in silence: measured, `lib/types/index.d.ts` loses
 * 3 KB and `ContextZipSettings` comes out as `z<any, any>`. With the link the
 * same pass emits the full `Schemastery.ObjectS<{...}>` with every switch named.
 *
 * It is a link and not a dependency because nothing at runtime asks THIS package
 * for cosmokit: schemastery reaches the copy it already has. It is here so the
 * declaration emitter can write the type down.
 */
const DECLARATION_ONLY = ['@deepseek-ai/cosmokit'];

/**
 * Locate the pnpm store the harness repository installed into.
 *
 * `DEEPSEEK-HARNESS/node_modules/.pnpm` is what the harness itself resolves its
 * dependencies from, so a link into it hands the checker the same bytes the
 * running process loads; a profile's `node_modules` would answer only for the
 * packages that profile happens to have composed, and a scratch profile under
 * the temporary directory is a test fixture that any rebuild may delete.
 *
 * The default is found rather than written down, so a checkout in another
 * directory works unchanged; `DSH_PEER_STORE` overrides it for a harness
 * installed somewhere else entirely.
 *
 * @returns the absolute store directory.
 */
async function peerStore() {
  const declared = process.env.DSH_PEER_STORE;
  if (declared !== undefined && declared !== '') {
    const given = resolve(declared);
    if (!existsSync(given)) throw new Error(`DSH_PEER_STORE points at ${given}, which does not exist`);
    return given;
  }
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, 'DEEPSEEK-HARNESS', 'node_modules', '.pnpm');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  throw new Error(
    `cannot find DEEPSEEK-HARNESS/node_modules/.pnpm above ${here}; set DSH_PEER_STORE to a pnpm store directory`,
  );
}

/**
 * pnpm's spelling of one package: a scoped name keeps its `@` and swaps the
 * slash for a `+`, so `@scope/name` becomes `@scope+name`; an unscoped name is
 * left as it is. The directory continues with `@version` and a hash of the peer
 * set it was built against.
 *
 * @param {string} name - the package name as `package.json` spells it.
 * @returns the directory-name prefix that package occupies in the store.
 */
function storePrefix(name) {
  return `${name.replace('/', '+')}@`;
}

/**
 * Split a pnpm version off a store directory name.
 *
 * `0.1.5-rc.2_hash` and `0.1.5` both appear; the peer hash starts at the FIRST
 * underscore, and a prerelease tag never contains one.
 *
 * @param {string} tail - the directory name with the package prefix removed.
 * @returns the version string.
 */
function versionOf(tail) {
  return tail.split('_')[0];
}

/**
 * Order two versions the way pnpm would, well enough to pick one.
 *
 * Only the case that actually arises matters: several builds of the SAME
 * package against different peer sets, where every candidate has the same
 * version and any of them would do. A real release outranks its own
 * prereleases, so `0.1.5` beats `0.1.5-rc.2`.
 *
 * @param {string} left - a version.
 * @param {string} right - another version.
 * @returns a negative number when `left` sorts first.
 */
function compareVersions(left, right) {
  const parts = (value) => value.split('-')[0].split('.').map((piece) => Number.parseInt(piece, 10));
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const prerelease = (value) => (value.includes('-') ? 0 : 1);
  return prerelease(left) - prerelease(right);
}

/**
 * Every copy of one package in the store that can be linked.
 *
 * @param {string} store - the pnpm store directory.
 * @param {string} name - the package name.
 * @returns {Promise<{version: string, target: string}[]>} candidates, unsorted.
 */
async function storeCandidates(store, name) {
  const prefix = storePrefix(name);
  const found = [];
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    // The store entry is a directory holding the peer set's `node_modules`; the
    // package itself sits inside that, which is what the link must point at.
    const target = join(store, entry.name, 'node_modules', name);
    if (!existsSync(join(target, 'package.json'))) continue;
    found.push({ version: versionOf(entry.name.slice(prefix.length)), target });
  }
  return found;
}

/**
 * What the link at `node_modules/<name>` is right now.
 *
 * A REAL directory is reported as `occupied` and left alone: npm puts one there
 * the moment anyone runs `npm install` without omitting peers, and silently
 * deleting an installed dependency is not this script's business.
 *
 * @param {string} link - the absolute link path.
 * @param {string} target - where it should point.
 * @returns {Promise<'absent'|'correct'|'stale'|'occupied'>} the state.
 */
async function linkState(link, target) {
  let stats;
  try {
    stats = await lstat(link);
  } catch {
    return 'absent';
  }
  if (!stats.isSymbolicLink()) return 'occupied';
  const points = resolve(dirname(link), await readlink(link));
  return points === target ? 'correct' : 'stale';
}

/**
 * Plant one link, replacing a stale one.
 *
 * @param {string} link - the absolute link path.
 * @param {string} target - the absolute package directory.
 * @returns {Promise<'linked'|'correct'|'occupied'>} what was done.
 */
async function plant(link, target) {
  const state = await linkState(link, target);
  if (state === 'correct') return 'correct';
  if (state === 'occupied') return 'occupied';
  if (state === 'stale') await rm(link, { recursive: true, force: true });
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, 'dir');
  return 'linked';
}

/**
 * Remove the link at this path, but only when it is a link.
 *
 * @param {string} link - the absolute link path.
 * @returns {Promise<boolean>} whether something was removed.
 */
async function unplant(link) {
  let stats;
  try {
    stats = await lstat(link);
  } catch {
    return false;
  }
  if (!stats.isSymbolicLink()) return false;
  await rm(link, { force: true });
  return true;
}

/**
 * Group peer names by scope, so the printed undo command stays one line each.
 *
 * @param {string[]} names - the package names.
 * @returns {Map<string, string[]>} scope, or `''` for unscoped names, to the
 *   names under it with the scope stripped.
 */
function byScope(names) {
  const groups = new Map();
  for (const name of names) {
    const slash = name.indexOf('/');
    const scope = slash === -1 ? '' : name.slice(0, slash);
    const members = groups.get(scope) ?? [];
    members.push(slash === -1 ? name : name.slice(slash + 1));
    groups.set(scope, members);
  }
  return groups;
}

const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const peers = Object.keys(manifest.peerDependencies ?? {}).sort();
const wanted = [...peers, ...DECLARATION_ONLY].sort();
const undo = process.argv.includes('--undo');
const store = await peerStore();

await mkdir(MODULES, { recursive: true });

const report = { linked: [], correct: [], occupied: [], missed: [], removed: [] };

if (undo) {
  for (const name of wanted) {
    if (await unplant(join(MODULES, name))) report.removed.push(name);
  }
} else {
  for (const name of wanted) {
    const candidates = await storeCandidates(store, name);
    if (candidates.length === 0) {
      report.missed.push(name);
      continue;
    }
    candidates.sort((left, right) => compareVersions(right.version, left.version));
    const chosen = candidates[0];
    const outcome = await plant(join(MODULES, name), chosen.target);
    const note = DECLARATION_ONLY.includes(name) ? '  (declarations only)' : '';
    report[outcome].push({ entry: `${name}@${chosen.version}${note}`, target: chosen.target });
  }
}

const lines = [
  undo
    ? `devlinks: removed ${report.removed.length} link${report.removed.length === 1 ? '' : 's'} from ${MODULES}`
    : `devlinks: ${report.linked.length} linked, ${report.correct.length} already correct, ${report.occupied.length} left alone, ${report.missed.length} with no local copy`,
  `  store  ${store}`,
];
if (!undo) {
  for (const { entry, target } of report.linked) lines.push(`  link   ${entry}  ->  ${target}`);
  for (const { entry } of report.correct) lines.push(`  ok     ${entry}`);
  for (const { entry } of report.occupied) lines.push(`  kept   ${entry}  (a real directory, not a link this script owns)`);
  for (const name of report.missed) {
    lines.push(`  none   ${name}  (not in the store: it stays unresolved for tsc until it is installed)`);
  }
  lines.push('', 'Undo with `node devlinks.mjs --undo`, or by hand from this directory:');
  for (const [scope, members] of byScope(wanted)) {
    const where = scope === '' ? 'node_modules' : `node_modules/${scope}`;
    lines.push(`  rm -f ${where}/${scope === '' ? `{${members.join(',')}}` : '*'}`);
    if (scope !== '') lines.push(`  rmdir ${where} 2>/dev/null || true`);
  }
} else {
  for (const name of report.removed) lines.push(`  gone   ${name}`);
}
lines.push('');
process.stdout.write(lines.join('\n'));
