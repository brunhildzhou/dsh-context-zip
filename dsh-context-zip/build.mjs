/**
 * Build script for dsh-context-zip.
 *
 * Two bundles, because the two halves are loaded by different runtimes:
 *
 * - `lib/index.js` is the host half. It is plain ESM; every `@deepseek-ai/*`
 *   import stays external and resolves through the profile's node_modules, so
 *   the process keeps exactly one copy of cordis and of every seam it injects.
 * - `engine/lib/*.js` is the compaction-backend package, built for the
 *   profile-local redirect that answers the `compaction-basic` row.
 * - `lib/client.js` is the browser half. The web shell's module table loads it
 *   through `window.__ModuleLoader__.load`, so the bundle is CommonJS wrapped in
 *   that registration call, with react and sibling client packages left to the
 *   loader's own `require`.
 * - `lib/types/**` is what `package.json` promises an editor and any other
 *   TypeScript plugin that imports this package. See {@link emitAllDeclarations}.
 *
 * esbuild is resolved from the local `node_modules` when `npm install` ran, and
 * from the npm cache otherwise, so the build works with no network access.
 *
 * Run with `npm run build`.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The engine package is a sibling of this plugin, not an installed dependency,
 * so the local build sees it through a link in this directory. A composed
 * profile resolves the real package instead.
 */

/** Load esbuild from the project, then from any cached copy. */
async function loadEsbuild() {
  const local = join(here, 'node_modules/esbuild/lib/main.js');
  if (existsSync(local)) return (await import(pathToFileURL(local).href)).default ?? (await import(pathToFileURL(local).href));
  const cacheRoot = join(process.env.HOME ?? '/root', '.npm/_npx');
  if (existsSync(cacheRoot)) {
    for await (const candidate of glob('*/node_modules/esbuild/lib/main.js', { cwd: cacheRoot })) {
      try {
        const module = await import(pathToFileURL(join(cacheRoot, candidate)).href);
        return module.default ?? module;
      } catch {
        // Try the next cached copy.
      }
    }
  }
  throw new Error('esbuild is unavailable: run `npm install` here, or `npx --offline esbuild@0.25.12 --version` to seed the cache');
}

const { build } = await loadEsbuild();

await mkdir(join(here, 'node_modules'), { recursive: true });

/**
 * The engine lives inside this package, but every importer reaches it through
 * the package's own `./engine` subpath: the built plugin uses that specifier and
 * so does the profile-local redirect, so both resolve to one and the same file.
 * It must never be inlined; see {@link SHARED}.
 */
const ENGINE_SPECIFIERS = ['dsh-context-zip/engine', 'dsh-context-zip/engine/prompt'];

/**
 * Shared esbuild settings.
 *
 * The engine package is EXTERNAL, exactly like every `@deepseek-ai/*` package,
 * because the redirect loads it too: a composed profile resolves both importers
 * to the one installed copy, so a process keeps one engine module and the
 * module-level reader the plugin registers is the one the mounted engine reads.
 * Bundling it here instead would give the plugin a private second copy whose
 * module state the redirect's engine never sees, which silently disconnects
 * every value the two halves are supposed to share.
 *
 */
const SHARED = {
  bundle: true,
  sourcemap: false,
  logLevel: 'warning',
  resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
  external: ['@deepseek-ai/*', ...ENGINE_SPECIFIERS],
};

/** Packages the browser loader already provides to every client bundle. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-remotes',
];

/** Head of the module-table registration the client bundle must carry. */const CLIENT_BANNER = `window.__ModuleLoader__.load({
  id: "dsh-context-zip",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`;

/** Tail closing that registration. */
const CLIENT_FOOTER = `    return module.exports;
  }
});`;

/**
 * The declaration files `package.json` promises, and the two passes that make
 * them.
 *
 * `exports["."].types` points at `lib/types/index.d.ts` and
 * `exports["./client"].types` at `lib/types/client/index.d.ts`, and until this
 * step existed nothing produced either: a consumer imported the package, found
 * a `types` path that was not on disk, and silently dropped to the JavaScript
 * with every type in the package gone. The pointers are the package's public
 * promise, so the build is what has to satisfy them.
 *
 * Two passes, because `rootDir` decides where a source file lands and the two
 * entry points live in different subtrees. One pass over the whole project would
 * flatten `src/index.ts` to `lib/types/src/index.d.ts`, which is not the path
 * anything reads. Each pass therefore gets its own project file with `rootDir`
 * and `outDir` set, and both merely `extends ./tsconfig.json` — the checker's own
 * configuration is not touched by any of this.
 *
 * A tree without typescript is the one case that must be classified rather than
 * guessed at. {@link emitAllDeclarations} below owns that decision: it removes a
 * declaration tree only after proving it can put it back, and fails when the
 * manifest promises a declaration this tree cannot produce.
 *
 * The engine runs FIRST, and its declarations are an input rather than a
 * deliverable. `src/` reaches the engine through the `dsh-context-zip/engine`
 * alias `tsconfig.json` points at `engine/index.ts`, and a `.ts` input outside
 * `rootDir` is `TS6059`: the host pass cannot have `rootDir: "src"` while an
 * engine source file is in its program. Pointing that alias at the engine's own
 * emitted declarations instead keeps the engine out of the host program, costs
 * no accuracy, and matches how the engine is actually consumed — the runtime
 * imports it through the package's own subpath too.
 *
 * tsc reports every type error it knows about during these passes too. That is
 * not what this step is for and it must not fail the build twice for one
 * mistake: the second ring of `npm run check` owns those errors, and `npm run
 * build` (which the runtime checks and `install.mjs` both depend on) has to keep
 * working while a type error is open. What this step does promise is the three
 * files below, so it fails only when one of them is missing afterwards.
 */
const DECLARATION_PASSES = [
  { project: 'tsconfig.types.engine.json', produced: 'engine/lib/types/index.d.ts' },
  { project: 'tsconfig.types.json', produced: 'lib/types/index.d.ts' },
  { project: 'tsconfig.types.client.json', produced: 'lib/types/client/index.d.ts' },
];

/** The tsc this tree would use for the declaration passes. */
function typescriptBinary() {
  return join(here, 'node_modules', 'typescript', 'bin', 'tsc');
}

/** Whether one promised declaration is on disk right now. */
function declarationPresent(produced) {
  return existsSync(join(here, produced));
}

/**
 * Whether every declaration the passes promise is on disk right now.
 *
 * This is what tells the two "no typescript" situations apart:
 *
 * - **not needed here**: the toolchain is missing, but the declarations are
 *   already in the tree (the delivery tree gets them from the source tree's
 *   build). Nothing has to be produced, so nothing may be deleted either;
 * - **needed but not producible**: the toolchain is missing AND a promised
 *   declaration is missing, so this build cannot satisfy `package.json` and
 *   must say so instead of exiting 0 with the pointers dangling.
 *
 * @returns {string[]} the promised declarations that are missing.
 */
function missingDeclarations() {
  return DECLARATION_PASSES.map((pass) => pass.produced).filter((produced) => !declarationPresent(produced));
}

/**
 * Run one declaration pass, then report whether it produced its file.
 *
 * Only called when {@link typescriptBinary} exists; the caller decides what a
 * tree without typescript means before anything is removed.
 *
 * @param {{project: string, produced: string}} pass - the project file to run
 *   and the file its output has to contain.
 * @returns {true} when the promised file exists.
 */
function emitDeclarations(pass) {
  const tsc = typescriptBinary();
  const result = spawnSync(process.execPath, [tsc, '-p', join(here, pass.project)], {
    cwd: here,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (output !== '') {
    const count = output.split('\n').filter((line) => line.includes(': error TS')).length;
    process.stdout.write(`  declarations: ${pass.project} reported ${count} type error(s); tsc emits anyway\n`);
  }
  if (!declarationPresent(pass.produced)) {
    throw new Error(`${pass.project} did not produce ${pass.produced}:\n${output}`);
  }
  return true;
}

/**
 * Emit every declaration `package.json` points at.
 *
 * Both output directories are removed first so a renamed or deleted source file
 * cannot leave a stale declaration behind for a consumer to import — but the
 * removal happens **only after** the tree has proved it can put them back:
 *
 * 1. no typescript, no declarations on disk → fail. This build cannot satisfy
 *    `exports[*].types` at all, and saying nothing would ship a package whose
 *    declared entry point types are missing (2026.09.19, D7);
 * 2. no typescript, declarations present → leave them exactly as they are. This
 *    is the delivery tree: `plugloop.sh` supplies the declaration trees from the
 *    source build, and the delete-then-skip this replaced is what emptied
 *    `lib/types` there while the build still exited 0;
 * 3. typescript present → remove both trees and regenerate. After the passes,
 *    every promised declaration is re-checked, because a pass that silently
 *    produced nothing is the same dangling pointer as a pass that never ran.
 */
function emitAllDeclarations() {
  if (!existsSync(typescriptBinary())) {
    const missing = missingDeclarations();
    if (missing.length > 0) {
      throw new Error(
        `typescript is not installed at ${join(here, 'node_modules', 'typescript')}, and these declarations are missing:\n` +
          `${missing.map((produced) => `  - ${produced}`).join('\n')}\n` +
          'package.json points `exports[*].types` at them, so this build cannot honestly report success. ' +
          'Run `npm install` here, or supply the declaration trees from a tree that has typescript.',
      );
    }
    process.stdout.write(
      `  declarations: skipped (typescript is not installed here); the ${DECLARATION_PASSES.length} promised trees are already present and were left untouched\n`,
    );
    return;
  }
  rmSync(join(here, 'lib', 'types'), { recursive: true, force: true });
  rmSync(join(here, 'engine', 'lib', 'types'), { recursive: true, force: true });
  for (const pass of DECLARATION_PASSES) emitDeclarations(pass);
  const missing = missingDeclarations();
  if (missing.length > 0) {
    throw new Error(`the declaration passes ran but these promised files are still missing:\n${missing.map((produced) => `  - ${produced}`).join('\n')}`);
  }
}

async function main() {
  await mkdir(join(here, 'lib'), { recursive: true });

  for (const [entry, outfile] of [
    ['engine/index.ts', 'engine/lib/index.js'],
    ['engine/engine.ts', 'engine/lib/engine.js'],
    ['engine/prompt.ts', 'engine/lib/prompt.js'],
  ]) {
    await build({
      entryPoints: [join(here, entry)],
      outfile: join(here, outfile),
      ...SHARED,
      format: 'esm',
      platform: 'node',
      target: 'node22',
    });
  }

  // The runtime checks import the built plugin, so they are bundled here too.
  await build({
    entryPoints: [join(here, 'test/entry.ts')],
    outfile: join(here, 'test/build/lib/segments.js'),
    ...SHARED,
    format: 'esm',
    platform: 'node',
    target: 'node22',
  });

  await build({
    entryPoints: [join(here, 'src/index.ts')],
    outfile: join(here, 'lib/index.js'),
    ...SHARED,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'info',
  });

  await build({
    entryPoints: [join(here, 'client/index.ts')],
    outfile: join(here, 'lib/client.body.js'),
    ...SHARED,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    logLevel: 'info',
    external: CLIENT_EXTERNALS,
  });

  const body = await readFile(join(here, 'lib/client.body.js'), 'utf8');
  const wrapped = `${CLIENT_BANNER}\n${body}\n${CLIENT_FOOTER}\n`;
  await writeFile(join(here, 'lib/client.js'), wrapped, 'utf8');
  await writeFile(join(here, 'lib/client.body.js'), '', 'utf8');

  emitAllDeclarations();
}

await main();
