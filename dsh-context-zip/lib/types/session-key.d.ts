/**
 * What one override-table key looks like when it names a session.
 *
 * Both override tables (`agents`, `retrievalAgents`) are keyed by session id OR
 * by agent-preset name, and the two are told apart by shape alone: a session id
 * is what the harness mints, `session-` followed by up to 120 id characters; a
 * preset name is whatever the user typed into `agents:` in `settings.yaml`.
 *
 * The shape lives here, in one module, because two halves need the same answer
 * and had drifted into asking in different places. The panel already filtered
 * rows by this shape before rendering them, while the host asked the title
 * reader about EVERY key in both tables — a preset name was sent to
 * `sessionQuery.readTitleSnapshots`, which then folded session logs looking for
 * a session that cannot exist under that name. One home means the host can skip
 * those keys before the call and the panel keeps hiding those rows, with no way
 * for the two judgements to disagree.
 *
 * @module dsh-context-zip/session-key
 */
/** One override-table key that names a session, rather than an agent preset. */
export declare const SESSION_KEY: RegExp;
/**
 * Whether an override-table key names a session.
 *
 * Only strings are sessions: a settings file read back through YAML gives
 * strings, and anything else is a malformed row rather than a row whose name
 * this plugin should look up.
 *
 * @param key - one key of the `agents` or `retrievalAgents` table.
 * @returns whether the key names a session.
 */
export declare function isSessionKey(key: any): boolean;
declare const _default: {
    SESSION_KEY: RegExp;
    isSessionKey: typeof isSessionKey;
};
export default _default;
