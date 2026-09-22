/**
 * Profile-local redirect for the `compaction-basic` row.
 *
 * The include layer treats a row's `name` as a guard, never as an override, so a
 * plugin cannot rename that row from its own bundle patch. Resolving the row's
 * specifier to this package is the supported way to take the row's place.
 *
 * The shipped backend is bundled beside this file as `base.js` so the specifier
 * `@deepseek-ai/dsh-compaction-basic` resolves here only, and never again from
 * inside the plugin. `install.mjs` refreshes that copy from the mounted
 * installation, so the redirect always wraps the backend version the profile is
 * actually running.
 *
 * @module @deepseek-ai/dsh-compaction-basic (context-zip redirect)
 */
import { BasicCompactionEngine } from './base.js';
import { createContextZipEngine } from 'dsh-context-zip/engine';

/** The shipped backend with dsh-context-zip's five-section, notes-aware summarizer. */
export const ContextZipEngine = createContextZipEngine(BasicCompactionEngine);

export default ContextZipEngine;
