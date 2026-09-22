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
 * `/wire` is the one route that writes outside the settings namespace: it points
 * the `compaction-basic` row at this plugin by putting a redirect package into the
 * profile's `node_modules`. Its `GET` answers whether that has happened. Its `POST`
 * does the write, and the work itself lives in `./wire.ts` so the guards stay in one
 * readable place. BOTH answers carry `processStartedAt` — when this harness process
 * began — so the panel can compare it against the stamp's `copiedAt` and tell a
 * redirect written after this process loaded (a restart is pending) from one written
 * before it. The `POST` answer needs it for the same reason the `GET` does: the
 * stamp it just wrote is newer than this process by construction, so without the
 * field the panel would judge the takeover already in effect until the next `GET`.
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
 * @param options - the settings scope, the segment reader, the mode reader, the
 *   title memo factory, and the two wire callbacks.
 * @returns the disposers, or [] when no web server is composed.
 */
export declare function registerRoutes(ctx: any, options: any): any[];
declare const _default: {
    registerRoutes: typeof registerRoutes;
    ROUTE_PREFIX: string;
};
export default _default;
