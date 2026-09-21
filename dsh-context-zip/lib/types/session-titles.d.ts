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
export declare const TITLE_TTL_MS = 60000;
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
export declare function sessionTitlesFor(ctx: any, keys: any): Promise<{}>;
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
export declare function createTitleMemo(options: any): {
    titles: (keys: any) => {};
    refresh: (keys: any, stale?: boolean) => boolean;
    ttlMs: any;
};
declare const _default: {
    TITLE_TTL_MS: number;
    createTitleMemo: typeof createTitleMemo;
};
export default _default;
