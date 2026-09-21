/**
 * The plugin's own HTTP routes, used by the settings section in the browser.
 *
 * The section cannot call host services directly, so these routes are the wire
 * between the two halves. They are deliberately narrow: read the settings
 * namespace, patch it, read the effective mode on its own, list one session's
 * segment directory, and report one session's compaction mode. All of them are
 * loopback-only, and the write route additionally requires the JSON content type
 * so a cross-site form post cannot reach it.
 *
 * `settings` and `live` answer two different reads on purpose. The panel loads
 * `settings` once (it needs `value` to render the form) and then polls `live`
 * every few seconds; the poll only ever merges `effective` and the title map, so
 * serializing `value` — the agents table, which grows with the user's overrides —
 * on every tick was payload the reader discarded. `titles` is on BOTH on purpose:
 * the full read answers from the memo the moment the panel opens, and the poll is
 * how the names that memo fetches behind that answer reach a panel that is
 * already on screen.
 *
 * @module dsh-context-zip/routes
 */
/** Route prefix owned by this plugin. */
export declare const ROUTE_PREFIX = "/dsh-context-zip";
/**
 * Register the browser-facing routes.
 *
 * @param ctx - plugin context carrying `webServer`.
 * @param options - the settings scope, the segment reader, the mode reader, and
 *   the title memo factory.
 * @returns the disposers, or [] when no web server is composed.
 */
export declare function registerRoutes(ctx: any, options: any): any[];
declare const _default: {
    registerRoutes: typeof registerRoutes;
    ROUTE_PREFIX: string;
};
export default _default;
