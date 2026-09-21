/**
 * The panel's session-name memo, and the one batch read it is filled from.
 *
 * Two halves of the same problem live here.
 *
 * {@link sessionTitlesFor} is the read: it asks the host's
 * `sessionQuery.readTitleSnapshots` for a batch of ids and keeps the ids that
 * came back with a usable title. It is a fold of session event logs on the host
 * side, so it is the expensive call — the panel's table has 7 keys and one of
 * those logs was measured at 31 MB, which put 2.35 s into a single
 * `GET /dsh-context-zip/settings`.
 *
 * {@link createTitleMemo} is what keeps that cost off the request path. The
 * panel opens on whatever names the memo already holds (often nothing, and the
 * row prints the session id exactly as it did before titles existed), while a
 * refresh runs in the background and the poll that is already ticking every 5
 * seconds picks the names up a second or two later. The memo is also why the
 * cost is not paid per request at all: within the TTL a warm memo answers
 * without touching the host.
 *
 * @module dsh-context-zip/session-titles
 */

/**
 * How long a refreshed title map is trusted.
 *
 * 60 seconds. A title is not a fact that has to be current to the second — it is
 * the label on a row — and this is the number that bounds how often the folds
 * can be paid while a panel is open. The poll reads the memo, not the host, so a
 * longer TTL here shows up as nothing at all on screen; it only delays a rename
 * made in another window from appearing. 60 s at a 5 s poll means at most one
 * fold a minute for an open panel, against one per request before.
 */
export const TITLE_TTL_MS = 60_000;

/**
 * Whether the host is willing to answer title reads for a key.
 *
 * `undefined` means the host said nothing about the key at all: `sessionQuery`
 * did not return a row for it. That is retried while the key is wanted, because
 * a row can appear later (a session opened after the first read). A key the host
 * did return without a usable title is remembered as such and not asked again
 * inside the memo's life — asking a second time would fold the same log for the
 * same answer.
 */
const NO_TITLE = Symbol('no-title');

/**
 * Collapse session event logs into a title per session id, via the host's batch
 * reader.
 *
 * 名字走 `sessionQuery.readTitleSnapshots` 而不是 `sessionTitle`。`sessionTitle`
 * 是挂在活会话上的服务，它内部拿 `ctx.sessions.get(id)` 核对身份，对不上的直接抛
 * 「is not live in this store」；而面板列的是整张覆盖表，绝大多数行对应的会话此刻
 * 根本没打开（真机实测：表里 7 个会话，同一刻活着的只有 2 个），走那条路等于大部分
 * 行都只能印会话号。`sessionQuery` 认的是「活的或落过盘的」，同一次调用里逐条把两
 * 个来源合起来看，所以名字不会因为会话关掉就消失。
 *
 * 一次批量取，不逐条读：整张表的键一次发出去，逐条读会对着同一份语料开 N 次观察。
 * 返回的每一项自带状态，某一条读失败只让它自己缺席，其余照常返回，所以不会因为一个
 * 坏会话把整张表的标题全丢掉。
 *
 * 取不到就只是不进 map：标题从没生成过、键根本不是会话（覆盖表也收 agent 预设名）、
 * 服务没装、整次调用抛错，落点都一样——面板印会话号，和标题存在之前的表现一致。
 *
 * @param ctx - plugin context.
 * @param keys - session ids to name.
 * @returns session id -> title, omitting every id that has no title.
 */
export async function sessionTitlesFor(ctx, keys) {
  const titles = {};
  const wanted = [];
  const seen = new Set();
  for (const key of keys ?? []) {
    if (typeof key !== 'string' || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    wanted.push(key);
  }
  if (wanted.length === 0) return titles;
  const query = ctx.get('sessionQuery');
  // 服务没装、或装了但没这个方法（宿主版本对不上）都走同一条降级路，不抛。
  if (query === undefined || typeof query.readTitleSnapshots !== 'function') return titles;
  let results;
  try {
    results = await query.readTitleSnapshots(wanted);
  } catch {
    return titles;
  }
  if (!Array.isArray(results)) return titles;
  for (const result of results) {
    const id = result?.sessionId;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (result.status !== 'fulfilled') continue;
    const raw = result.value?.title?.title;
    const title = typeof raw === 'string' ? raw.trim() : '';
    if (title.length > 0) titles[id] = title;
  }
  return titles;
}

/**
 * Build the panel's title memo over one batch reader.
 *
 * The returned `titles(keys)` is SYNCHRONOUS on purpose: the settings route must
 * answer on the memo it has, never on a fold. When the wanted keys are not fully
 * covered — first open, past the TTL, or a key set that grew — it starts a
 * background refresh and returns what it holds right now. `refresh(keys)` is the
 * awaiting form, for a caller that really wants the fold (and for the checks).
 *
 * Re-entrancy is per refresh, not a global lock: a refresh already in flight has
 * exactly the keys it was started for, and a key that arrives meanwhile goes
 * into the next one. Every failure is swallowed into `warn` — a memo read by a
 * poll route may not be able to reject, or the request path grows an unhandled
 * rejection out of a background task.
 *
 * @param options - the batch reader, and where failures are logged.
 * @returns the memo.
 */
export function createTitleMemo(options) {
  const read = options?.read;
  const warn = typeof options?.warn === 'function' ? options.warn : () => {};
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(options?.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TITLE_TTL_MS;
  /** Id -> title, holding only ids that have one. */
  let resolved = {};
  /** Ids that had a title as of the last refresh; empty when the memo is cold. */
  let supported = new Set();
  /** Ids the host returned without a usable title; never asked again inside a life. */
  let absent = new Set();
  /**
   * When the last refresh finished.
   *
   * `-Infinity`, not 0: "never refreshed" has to be older than any clock for the
   * staleness test to fire, and a memo built over a clock that starts at 0 (the
   * checks do that, so their TTL can be driven without waiting a minute) treated
   * a 0 timestamp as fresh and never folded at all.
   */
  let refreshedAt = Number.NEGATIVE_INFINITY;
  /** Keys the memo wants covered. Grows when a request names a new key. */
  let wanted = new Set();
  /** Keys already sent to the reader whose answer has not landed yet. */
  let inFlight = new Set();
  /** Queued batches: `{ stale, keys }`. */
  let pending = [];

  /**
   * Fold one batch and fold its answer into the memo.
   *
   * The map is MERGED, not replaced: the read answers per key, and a key the
   * batch did not answer for must keep whatever the memo already held for it.
   * Replacing outright would drop a name the panel is showing because one
   * unrelated id failed.
   *
   * A batch tagged `stale` is the one exception, and it is the whole point of
   * the TTL: that read was started precisely because the covering map is due for
   * a fresh look, so ids it does not support are dropped rather than kept
   * forever. An id the fresh read supported but this batch did not cover keeps
   * its title — the read is per key set, and one deleted id must not blank the
   * rest of the table.
   *
   * @param batch - the queued batch.
   */
  const fold = async (batch) => {
    const keys = batch.keys;
    if (keys.length === 0) return {};
    for (const id of keys) {
      inFlight.add(id);
      wanted.add(id);
    }
    let titles;
    try {
      // No reader means nothing can be folded; it is the same degrade as a reader
      // that throws, and it must not turn into a rejection nobody handles.
      titles = typeof read === 'function' ? await read(keys) : {};
    } catch (error) {
      warn(`session titles read failed: ${String(error?.message ?? error)}`);
      return {};
    } finally {
      for (const id of keys) inFlight.delete(id);
    }
    if (titles === null || typeof titles !== 'object') return {};
    if (batch.stale) {
      // Rebuild the covering set from this one answer; everything it does not
      // support leaves the map and is not asked about again inside this life.
      supported = new Set();
      absent = new Set();
    }
    for (const id of keys) {
      const title = typeof titles[id] === 'string' ? titles[id].trim() : '';
      if (title.length > 0) {
        resolved[id] = title;
        supported.add(id);
        absent.delete(id);
      } else if (!supported.has(id)) {
        resolved = { ...resolved };
        delete resolved[id];
        absent.add(id);
      }
    }
    if (batch.stale) {
      // A title the fresh read no longer reports is gone; the memo may not keep
      // printing a name the host just stopped answering for.
      for (const id of Object.keys(resolved)) {
        if (wanted.has(id) && !supported.has(id)) {
          resolved = { ...resolved };
          delete resolved[id];
        }
      }
    }
    refreshedAt = now();
    return titles;
  };

  /**
   * Run the queued batches in order.
   *
   * Keys that arrived while a refresh was folding are drained in the SAME call
   * rather than left for a later one, so a burst of panels produces one extra
   * round instead of one per request.
   */
  const runRefresh = async () => {
    try {
      while (pending.length > 0) {
        const [batch, ...rest] = pending;
        pending = rest;
        await fold(batch);
      }
    } catch (error) {
      // `fold` swallows its own failures; this is the belt for anything else a
      // reader could throw synchronously.
      warn(`session titles refresh failed: ${String(error?.message ?? error)}`);
    }
  };

  /** Whether the memo already holds a final answer for one key. */
  const known = (id) => supported.has(id) || absent.has(id);

  /**
   * Start one background refresh for one key set.
   *
   * `stale` re-reads the whole covering set, so the memo's "we already have an
   * answer for this id" test must NOT apply — that is exactly what is being
   * thrown away. Without the flag, a refresh past the TTL found every id already
   * answered and folded nothing, which is how the TTL became a no-op.
   *
   * `busy` is the whole re-entrancy guard: while a refresh is in flight the
   * request adds its keys to `pending` and returns, so N concurrent opens of the
   * panel still produce ONE call to the host per key.
   */
  let busy = false;
  const refresh = (keys, stale = false) => {
    const unknown = [];
    for (const id of keys ?? []) {
      if (typeof id !== 'string' || id.length === 0) continue;
      wanted.add(id);
      if (inFlight.has(id)) continue;
      if (stale === false && known(id)) continue;
      if (!unknown.includes(id)) unknown.push(id);
    }
    if (unknown.length === 0) return busy;
    pending.push({ stale, keys: unknown });
    if (busy) return true;
    busy = true;
    void runRefresh().finally(() => {
      busy = false;
      // A key can arrive in the gap between the last drain and this clear.
      if (pending.length > 0) refresh([]);
    });
    return true;
  };

  /**
   * Read the memo for one key set, and refresh in the background when it does
   * not cover it.
   *
   * @param keys - session ids the panel is about to render.
   * @returns the titles held right now; never waits for a fold.
   */
  const titles = (keys) => {
    const asked = [];
    for (const id of keys ?? []) {
      if (typeof id !== 'string' || id.length === 0) continue;
      wanted.add(id);
      if (!asked.includes(id)) asked.push(id);
    }
    if (asked.length > 0) {
      if (now() - refreshedAt >= ttlMs) {
        // Past the TTL the whole covering map is due for its next look, not just
        // the keys this one request happens to name.
        refreshedAt = now();
        refresh([...wanted], true);
      } else if (asked.some((id) => !known(id))) {
        // Cold, or the key set grew. Only the uncovered keys are folded.
        refresh(asked, false);
      }
    }
    return { ...resolved };
  };

  return { titles, refresh, ttlMs };
}

export default { TITLE_TTL_MS, createTitleMemo };
