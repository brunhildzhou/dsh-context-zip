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

import { describeSegment } from './segments.ts';
import { isSessionKey } from './session-key.ts';

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-context-zip';

/** Largest accepted request body. */
const MAX_BODY_BYTES = 16 * 1024;

/** Largest accepted query string. */
const MAX_QUERY_CHARS = 512;

/** Session ids this plugin accepts on its read route. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/u;

/**
 * Every SESSION KEY in the two override tables.
 *
 * Both override tables are keyed by session id or preset name, and only the
 * first kind can have a title — the title reader folds a session log, and no
 * session exists under a preset name. Sending those keys along was work bought
 * for nobody and, measured, a large part of why a settings open cost seconds;
 * the shape that tells the two apart is `isSessionKey`, the same one the panel
 * renders by, so the two halves cannot disagree about which rows those are.
 *
 * @param value - the settings value the panel is about to render.
 * @returns the session-id keys of both override tables, de-duplicated.
 */
function listedSessionKeys(value) {
  const keys = [...Object.keys(value?.agents ?? {}), ...Object.keys(value?.retrievalAgents ?? {})];
  return [...new Set(keys.filter((key) => isSessionKey(key)))];
}

/**
 * The title map to answer a read with, without ever waiting on a fold.
 *
 * `titles` is the plugin's memo: it answers from what it already holds and
 * starts a background refresh for anything it does not. A route that awaited
 * the fold put 2.35 s of session-log parsing in front of `GET /settings`; the
 * panel can render its rows without a name (it prints the session id, which is
 * what it did before titles existed), and the poll that is already ticking every
 * 5 s carries the names in a second or two later.
 *
 * The memo is built lazily and ONCE, on the first request, from whatever
 * `options.createTitles` composes. Building it eagerly in {@link registerRoutes}
 * would call `sessionQuery` at load time, before the settings section exists;
 * building it per request would be a cache that never hits, which is the bug it
 * is here to fix.
 *
 * @param state - the lazily built memo, held across requests.
 * @param options - the route options, which may carry the memo factory.
 * @param keys - session-id keys the panel is about to render.
 * @returns session id -> title; `{}` when no memo can be composed.
 */
function titlesNow(state, options, keys) {
  if (typeof options?.createTitles !== 'function') return {};
  try {
    if (state.memo === null) {
      const memo = options.createTitles({
        read: (batch) => options.readSessionTitles(batch),
        warn: (message) => options.warn?.(message),
      });
      state.memo = memo !== null && typeof memo.titles === 'function' ? memo : undefined;
    }
    return state.memo?.titles(keys) ?? {};
  } catch (error) {
    // A read route may not fail because a name could not be produced.
    options.warn?.(`session titles memo failed: ${String(error?.message ?? error)}`);
    return {};
  }
}

/**
 * The `attention` field for one `/wire` answer, or `null`.
 *
 * Optional on purpose: a composition that supplied only the status read still
 * gets the same payload shape, with `null` meaning "nothing to draw attention
 * to". A failure inside the read is swallowed the same way, so the question mark
 * can never take the wire route down with it.
 *
 * @param options - the route options, which may carry `readAttention`.
 * @param input - the status fields, the process start, and the forced kind for a
 *   read failure (`unknown`) or a refused write (`failed`).
 * @returns the attention object, or `null`.
 */
async function attentionNow(options, input) {
  if (typeof options?.readAttention !== 'function') return null;
  try {
    const attention = await options.readAttention(input);
    return attention !== null && typeof attention === 'object' ? attention : null;
  } catch {
    return null;
  }
}

/**
 * Register the browser-facing routes.
 *
 * @param ctx - plugin context carrying `webServer`.
 * @param options - the settings scope, the segment reader, the mode reader, the
 *   title memo factory, the two wire callbacks, and the optional attention read.
 * @returns the disposers, or [] when no web server is composed.
 */
export function registerRoutes(ctx, options) {
  // `webServer` is not in the plugin's required inject list, and Cordis refuses
  // a property read for a service that was not injected, so it is resolved here.
  const webServer = ctx.get('webServer');
  if (webServer === undefined) return [];
  // One memo per registration, shared by `/settings` and `/live`: the poll is what
  // delivers the names the first read started fetching.
  const titles = { memo: null, options };
  return [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/settings`,
      handler: (req, res) => {
        if (!isLoopback(req) || req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        // `effective` is what the section renders as "the mode you are in now":
        // the value a NEW session would snapshot, plus how many sessions this
        // process is holding on a different frozen snapshot.
        // `titles` is what lets the panel print a session name instead of a bare
        // id. It comes from the plugin's title memo, which answers with what it
        // holds and refreshes behind the response: the reader is
        // `sessionQuery.readTitleSnapshots`, and one fold of the 7-key table was
        // measured at 2.35 s, which is a panel-open cost, not a form value. The
        // memo is keyed on session ids only, so a preset name is never sent to
        // the reader at all. An id with no title is simply absent from the map
        // and the panel falls back to the id.
        const value = options.readSettings();
        return respond(res, 200, {
          ok: true,
          value,
          effective: options.readEffectiveMode(),
          titles: titlesNow(titles, options, listedSessionKeys(value)),
        });
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/live`,
      handler: (req, res) => {
        if (!isLoopback(req) || req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        // The settings panel polls this while it is open. It answers the same
        // `effective` view the full read carries, deliberately omits `value`:
        // the poll merges `effective` and nothing else, so the settings value
        // (and the agents table inside it) was serialized on every tick for a
        // reader that threw it away. It does carry `titles`: the memo is built
        // behind the first `/settings` response, and this is the tick that hands
        // the names to a panel that is already open. Kept a separate route rather
        // than a flag on `/settings` because that route is also the one the panel
        // loads before it has anything to render, and that read does want `value`.
        const nextTitles = titlesNow(titles, options, listedSessionKeys(options.readSettings()));
        return respond(res, 200, { ok: true, effective: options.readEffectiveMode(), titles: nextTitles });
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/settings/update`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return respond(res, 403, { ok: false, error: 'forbidden' });
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          return respond(res, 415, { ok: false, error: 'content-type-must-be-json' });
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' });
        }
        try {
          const value = await options.writeSettings(body);
          return respond(res, 200, { ok: true, value });
        } catch (error) {
          return respond(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/wire`,
      handler: async (req, res) => {
        // One path, two verbs: `GET` reports whether the compaction row is wired to
        // this plugin, `POST` wires it. The write is a real filesystem change, so
        // the same loopback and JSON-content-type gates the settings write uses
        // apply to it; the read is gated like every other read.
        if (!isLoopback(req)) return respond(res, 403, { ok: false, error: 'forbidden' });
        if (req.method === 'GET') {
          try {
            const status = await options.readWireStatus();
            // The start time rides on the read: the panel judges "restart required"
            // from the pair (copiedAt, processStartedAt), not from `effective`.
            const processStartedAt = processStartedAtNow();
            // `attention` is a classification of the very fields above, so it is
            // computed from the same read and carries the home and profile the
            // panel's prompt template needs. `null` is the healthy answer and the
            // only value that draws no question mark.
            const attention = await attentionNow(options, { status, processStartedAt });
            return respond(res, 200, { ok: true, ...status, processStartedAt, attention });
          } catch (error) {
            // A status read that cannot name the profile is answered as a failure:
            // the panel says "cannot read" instead of drawing a wrong "unwired".
            const processStartedAt = processStartedAtNow();
            const attention = await attentionNow(options, { kind: 'unknown' });
            return respond(res, 500, {
              ok: false,
              error: String(error?.message ?? error),
              processStartedAt,
              attention,
            });
          }
        }
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          return respond(res, 415, { ok: false, error: 'content-type-must-be-json' });
        }
        try {
          const result = await options.wireRow();
          // Same computed start time as the GET, for the same judgment. The stamp
          // `wireRow` just wrote is newer than this process by construction, so the
          // answer has to carry the other side of the comparison: without it the
          // panel's optimistic verdict is "already in effect" until the next GET,
          // and the user who just pressed the button is told the wrong thing.
          const processStartedAt = processStartedAtNow();
          // The kind is re-classified from what was just written, so a successful
          // takeover reports `restart` and the question mark changes with the row.
          const attention = await attentionNow(options, { status: result, processStartedAt });
          return respond(res, 200, { ok: true, ...result, processStartedAt, attention });
        } catch (error) {
          // Every refusal and every write failure travels as its own message: the
          // panel's job is to show the reason, and a generic "failed" would hide
          // the difference between "occupied by a real package" and "disk error".
          // The start time rides along so both answers of this route are computed
          // the same way; the failed branch reads only `error`.
          const processStartedAt = processStartedAtNow();
          const attention = await attentionNow(options, { kind: 'failed' });
          return respond(res, 500, {
            ok: false,
            error: String(error?.message ?? error),
            processStartedAt,
            attention,
          });
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/mode`,
      handler: (req, res) => {
        if (!isLoopback(req) || req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const raw = url.searchParams.get('sessionId') ?? '';
        if (raw.length > MAX_QUERY_CHARS || !SESSION_ID_RE.test(raw)) {
          return respond(res, 400, { ok: false, error: 'invalid-session-id' });
        }
        // Answered by the same resolver the engine calls before every compaction,
        // so the toolbar chip cannot drift from what compaction actually does: a
        // second implementation in the browser would have to guess the preset
        // fallback and the precedence between it and the session key.
        const mode = options.readModeFor(raw);
        if (mode === null) return respond(res, 404, { ok: false, error: 'session-not-found' });
        return respond(res, 200, { ok: true, mode });
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/models`,
      handler: async (req, res) => {
        if (!isLoopback(req) || req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        // Answered from the live LLM registry on every request, so a provider an
        // adapter registered after this page loaded shows up on the next open.
        // Provider-level failures travel in `failures` instead of failing the
        // whole read: one broken adapter must not hide the other providers.
        try {
          const catalog = await options.listModels();
          return respond(res, 200, { ok: true, providers: catalog.providers, failures: catalog.failures });
        } catch (error) {
          return respond(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/segments`,
      handler: async (req, res) => {
        if (!isLoopback(req) || req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const raw = url.searchParams.get('sessionId') ?? '';
        if (raw.length > MAX_QUERY_CHARS || !SESSION_ID_RE.test(raw)) {
          return respond(res, 400, { ok: false, error: 'invalid-session-id' });
        }
        try {
          const segments = await options.listSegments(raw);
          return respond(res, 200, {
            ok: true,
            lines: segments.map((segment) => describeSegment(segment)),
          });
        } catch (error) {
          return respond(res, 404, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/compact/plan`,
      handler: async (req, res) => {
        if (!isLoopback(req) || req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const raw = url.searchParams.get('sessionId') ?? '';
        // An ABSENT id is allowed here and only here: the settings panel is a
        // root-scoped seat with no session of its own, so it may leave the choice
        // to the host. A PRESENT id still has to be a syntactically valid one.
        if (raw.length > MAX_QUERY_CHARS || (raw.length > 0 && !SESSION_ID_RE.test(raw))) {
          return respond(res, 400, { ok: false, error: 'invalid-session-id' });
        }
        try {
          const plan = await options.readManualPlan(raw.length > 0 ? raw : null);
          return respond(res, 200, {
            ok: true,
            ...plan,
            failure: readManualFailure(options, plan.sessionId),
          });
        } catch (error) {
          return respond(res, manualStatus(error), {
            ok: false,
            error: typeof error?.code === 'string' ? error.code : 'plan-failed',
            message: String(error?.message ?? error),
          });
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/compact`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return respond(res, 403, { ok: false, error: 'forbidden' });
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          return respond(res, 415, { ok: false, error: 'content-type-must-be-json' });
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' });
        }
        const named = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        if (named.length > MAX_QUERY_CHARS || (named.length > 0 && !SESSION_ID_RE.test(named))) {
          return respond(res, 400, { ok: false, error: 'invalid-session-id' });
        }
        try {
          const outcome = await options.runManualCompaction(named.length > 0 ? named : null);
          return respond(res, 200, { ok: true, ...outcome, failure: readManualFailure(options, outcome.sessionId) });
        } catch (error) {
          // The failure body carries everything the reader needs to decide whether
          // to retry: the stable code, the backend diagnostic, and the count. A
          // bare "compaction failed" would leave that decision to a guess.
          return respond(res, 500, {
            ok: false,
            error: 'compaction-failed',
            code: typeof error?.code === 'string' ? error.code : 'unknown',
            message: String(error?.message ?? error),
            sessionId: named,
            failure: readManualFailure(options, named),
          });
        }
      },
    }),
  ];
}

/** Map one planning failure onto the status the browser half branches on. */
function manualStatus(error) {
  switch (error?.code) {
    case 'session-required':
      return 409;
    case 'invalid-session-id':
      return 400;
    default:
      return 404;
  }
}

/**
 * Read the consecutive-failure bookkeeping without letting it fail the response.
 *
 * The count is decoration on a successful plan and the retry hint on a failed
 * run; neither is worth replacing the real answer with an error about itself.
 */
function readManualFailure(options, sessionId) {
  if (typeof options.readManualFailure !== 'function' || typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }
  try {
    return options.readManualFailure(sessionId) ?? null;
  } catch {
    return null;
  }
}

/**
 * When this harness process began, computed at answer time and never stored.
 *
 * `Date.now()` minus `process.uptime()` is the one signal that tells a redirect
 * written BEFORE this process loaded from one written after it: the panel's
 * "restart required" is exactly `copiedAt > processStartedAt`. Both answers of the
 * `/wire` route compute it here rather than sharing a stored value, because a
 * stored copy would survive a restart and lie about which process is running.
 *
 * @returns this process's start as an ISO timestamp.
 */
function processStartedAtNow() {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** Whether a request arrived over the loopback interface. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Read one bounded JSON body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (data.length === 0) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Send one JSON response. */
function respond(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export default { registerRoutes, ROUTE_PREFIX };
