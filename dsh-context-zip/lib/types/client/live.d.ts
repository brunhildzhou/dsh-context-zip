/**
 * The settings panel's small decisions, kept out of the component.
 *
 * It lives in its own module, with no `react` import, for one reason: the client
 * entry is browser-only (the repository has no local copy of react), so the
 * runtime checks cannot import it. The decisions here are small but they are the
 * ones worth checking — when a failure replaces the last good reading, what the
 * panel prints as "last read at", whether a save may write over the table the
 * user is editing, and when the poll reads besides its interval.
 *
 * @module dsh-context-zip/client/live
 */
/**
 * How often the panel re-reads the live view.
 *
 * 5 seconds: the live-session count is a reference figure, not one to stare at.
 * The interval is written into the functional document.
 */
export declare const LIVE_POLL_MS = 5000;
/**
 * How long one read keeps the next one from going out.
 *
 * 1000 ms, argued from both ends.
 *
 * From below: the burst this exists for is the timer tick the browser releases
 * when the page becomes visible, and the `visibilitychange` listener. They land
 * in the same turn, milliseconds apart, but "milliseconds" is measured on an
 * idle machine — on a busy event loop, or a page that just came back from a
 * long sleep with a queue of work to drain, they can be spaced much further
 * out. Measured in Chrome 153 while making this change: the second read of the
 * pair arrived 494 ms after the first. A window of a few tens of milliseconds
 * would not have covered it.
 *
 * From above: it has to stay well under `LIVE_POLL_MS`. At 1000 ms it is one
 * fifth of the interval, so two consecutive timer ticks (5 000 ms apart) can
 * never fall inside one window. The cadence the panel promises cannot be
 * thinned by this rule; only a read that lands on top of a fresh one is
 * dropped. The cost is bounded on the other side too: if a return to the tab is
 * skipped, the reading on screen is by definition less than a second old.
 */
export declare const LIVE_DEDUPE_MS = 1000;
/**
 * How long the composer chip waits before re-reading a mode it could not read.
 *
 * The chip reads the mode the moment the composer mounts, and that read races
 * the host: the browser names a session the running process may not have
 * registered yet, and the route answers 404 `session-not-found`. A first read
 * that fails is normal and temporary, so a failure may not be final.
 *
 * 400 ms first, because the condition being waited out is the host registering a
 * session — a startup step, not a network round trip. It grows to a 30 s floor,
 * so a host that never answers costs two requests a minute and no more, while a
 * host that was merely slow is picked up almost immediately.
 */
export declare const MODE_RETRY_SCHEDULE_MS: number[];
/**
 * How long one chip read keeps the next one from going out.
 *
 * The same value and the same argument as {@link LIVE_DEDUPE_MS}: a return to
 * the tab releases a queued timer tick and fires the `visibilitychange`
 * listener in nearly the same turn, and the measured gap was 494 ms.
 */
export declare const MODE_DEDUPE_MS = 1000;
/**
 * The delay before the chip's next read, given how many have already failed.
 *
 * @param failures - consecutive failed reads so far; 0 before the first failure.
 * @param scheduleMs - the schedule to walk; the last entry repeats forever.
 * @returns milliseconds to wait.
 */
export declare function modeRetryDelay(failures: any, scheduleMs?: number[]): number;
/**
 * What a click on the composer chip means.
 *
 * `flip` when the chip knows which mode it is in, `retry` when it does not. The
 * second case is the whole point: the checkbox is disabled in exactly that
 * state, and a disabled checkbox swallows its own activation, so the click has
 * to be given a meaning somewhere it still arrives — the label around it.
 *
 * @param readable - whether the last read produced a mode.
 * @returns `'flip'` or `'retry'`.
 */
export declare function modeClickIntent(readable: any): "flip" | "retry";
/**
 * Read the chip's mode until the read lands.
 *
 * Why this exists at all: the chip used to read once per session id and treat
 * any failure as final. Measured in Chrome 153 before this rule existed, a
 * single failed read left the chip `data-failed="true"` with a disabled
 * checkbox, and it sent no further request in the following ten seconds: the
 * control looked like an off switch and did nothing when clicked, with no way
 * back except reloading the page.
 *
 * A success resets the counter, so the schedule describes consecutive failures
 * and not a session's whole history. Returning to the tab reads at once, because
 * that is when somebody can be looking at the chip again, and it is
 * de-duplicated by {@link liveReadDue} for the same reason the panel's poll is.
 * There is deliberately no attempt to keep reading while the page is hidden:
 * nobody is looking then, and the retry that matters is the one before the next
 * look.
 *
 * The environment is passed in (`doc`, `setTimer`, `clearTimer`, `now`) so the
 * runtime checks can drive it without a DOM.
 *
 * @param options - the read to run, the schedule, the de-duplication window, the
 *   clock, the environment, and a callback carrying the failure count.
 * @returns a stop function clearing the timer and the listener.
 */
export declare function startModeReadRetry(options: any): () => void;
/**
 * The health of the poll as the panel renders it.
 *
 * `failures` is a run length, not a total: one success clears it, because what
 * the panel has to say is "the numbers above may be out of date", and a single
 * successful read makes that untrue again.
 *
 * @param at - wall clock of the last successful read, in milliseconds.
 * @returns the initial health, healthy and dated now.
 */
export declare function initialLiveHealth(at: any): {
    failures: number;
    lastOk: any;
};
/**
 * Fold one poll outcome into the health.
 *
 * A success while already healthy returns the SAME object, so React bails out of
 * the re-render: nothing the panel shows depends on the timestamp until a
 * failure has something to date. A failure never moves `lastOk` — that field
 * answers "how old is what you are looking at", so it has to keep pointing at
 * the last read that actually landed.
 *
 * @param previous - health before this poll.
 * @param healthy - whether this poll produced a usable answer.
 * @param at - wall clock of this poll, in milliseconds.
 * @returns the health to render from.
 */
export declare function liveHealthAfter(previous: any, healthy: any, at: any): any;
/**
 * Format a wall clock as `HH:MM:SS` in the viewer's local zone.
 *
 * Built from the date parts rather than `toLocaleTimeString`, so the reading is
 * always 24-hour and always the same shape: the sentence it goes into says
 * "last read at", and a locale-dependent suffix would make two panels show two
 * different-looking facts.
 *
 * @param ms - milliseconds since the epoch.
 * @returns the local time, zero-padded, seconds precision.
 */
export declare function clockText(ms: any): string;
/**
 * Convert the settings map into editable rows.
 *
 * @param agents - the stored `agents` map, keyed by session id or preset name.
 * @returns one row per key, in the order the host serialized them.
 */
/**
 * Where the settings panel puts a help bubble, given the question mark it belongs
 * to.
 *
 * The panel writes these coordinates onto a `position: fixed` box, which is the
 * point: the host renders a section inside an `overflow-y: auto` scroller, and an
 * absolutely positioned bubble is clipped by it. The box hangs below the anchor
 * and is pulled back to the anchor's right edge, which is the rule the approved
 * preview uses; when that would run past the bottom of the viewport and there is
 * room above, it flips over the anchor instead. Either way it is clamped inside
 * the margin, so a question mark near an edge still gets a readable bubble.
 *
 * Kept here, in the DOM-free module, so the arithmetic is checkable without a
 * browser: the caller passes rectangles and gets a box back.
 *
 * @param anchor - the question mark's `getBoundingClientRect()` edges.
 * @param viewport - the window's inner width and height.
 * @param size - the bubble's measured width and height.
 * @param gap - distance kept between the anchor and the bubble.
 * @param margin - smallest distance kept from any viewport edge.
 * @returns the `left`, `top` and clamped `width` to write back.
 */
export declare function helpBubblePlacement(anchor: any, viewport: any, size: any, gap?: number, margin?: number): {
    left: number;
    top: number;
    width: number;
};
export declare function toRows(agents: any): {
    key: string;
    value: boolean;
}[];
/**
 * A host title map, cleaned into "session id -> non-empty title".
 *
 * The host omits every id it has no title for, so this mostly guards the shape
 * of what did arrive: a payload that is not a table, or an entry whose title is
 * not a non-empty string, must not put an empty name on a row.
 *
 * @param source - the `titles` field of a host payload.
 * @returns the cleaned table.
 */
export declare function titlesFrom(source: any): {};
/**
 * Fold one `/live` tick into the panel state.
 *
 * Two things arrive on this tick and neither may be dropped.
 *
 * `effective` is the reading the poll exists for. `titles` is the plugin's title
 * memo: the first `/settings` answers with whatever it already held (often
 * nothing, and the row prints the session id), and the fold that names those rows
 * runs behind that response and lands on the memo a second or two later. The poll
 * is the only thing still asking after the panel has opened, so this is where
 * those names actually reach the screen — before this, names were read once at
 * mount and once after a save, which is why a session renamed while the panel was
 * open kept its old label until the panel was reopened.
 *
 * A payload that omits `titles` entirely is not an empty table: an older host
 * answers without the field, and wiping the names on screen for that would be a
 * downgrade, not a degrade.
 *
 * @param previous - the state on screen.
 * @param payload - the parsed `/live` body.
 * @returns the next state; the same object when nothing changed.
 */
export declare function mergeLivePayload(previous: any, payload: any): any;
/**
 * What the table shows after a save landed.
 *
 * The panel saves the WHOLE settings object, but only one control is the table.
 * A save triggered by a switch carries `{ ...value, fallbackEnabled }`, and
 * `value` is the last thing the host stored: it does not contain the rows the
 * user has typed and not saved yet. Writing the host's answer over the table on
 * that path deletes work in progress, and the panel would even say "saved" while
 * doing it. Measured in a browser before this rule existed: a typed row went
 * from `rowCount: 1` to `0` when the fallback switch was flipped.
 *
 * So the table is refreshed by the table's own save and by nothing else. For
 * every other group the previous array is returned unchanged, which also lets
 * React bail out of the re-render.
 *
 * @param group - which control started the save; `'agents'` is the table's own
 *   Save button, `'main'` and `'rewrite'` are the immediate-save switches.
 * @param previousRows - the rows currently on screen.
 * @param serverValue - the value the host answered with.
 * @returns the rows to render.
 */
export declare function rowsAfterSave(group: any, previousRows: any, serverValue: any): any;
/**
 * How long the panel's one save button holds its confirmation or failure face.
 *
 * The copy button's own feedback uses the same window, so the panel keeps one
 * rhythm: a state the user did not ask for is withdrawn after 1.5 s instead of
 * staying on screen until the next interaction.
 */
export declare const SAVE_FEEDBACK_MS = 1500;
/**
 * The nine wiring states, judged in one fixed order.
 *
 * Nine, because six things the panel can know are distinct and the old four-phase
 * model folded three of them into one sentence. The order is the whole function:
 * the first rule that matches wins, so a read that failed outranks everything —
 * a payload that never arrived says nothing about `foreign`, `wired` or `stale`,
 * and guessing "unwired" from a failed read is exactly the mistake the read route
 * was built to avoid. `taken` outranks the two unwired states because a foreign
 * package is a fact about the path that a retry cannot change, and `incomplete`
 * outranks plain `inactive` because it is the one unwired shape the button DOES
 * fix (`partial` is this plugin's own redirect marker with no stamp beside it).
 *
 * `taking` and `failed` are the panel's own action, not the payload's: a write in
 * flight and a write that was refused are local facts with no field on `GET
 * /dsh-context-zip/wire`, so the caller passes them in. They sit after the two
 * unwired states on purpose — a request can only be "taking over" a row that the
 * read already reports as wired.
 *
 * `restart` is the one state that needs positive evidence, and it no longer reads
 * `effective`. `/live`'s `effective.compaction` comes from the settings switch, so
 * it reports what the NEXT compaction would use and says nothing about whether THIS
 * process loaded the redirect; it said "restart" even when the running process had
 * already picked the plugin up. The real signal is a pair of timestamps from the
 * `GET /dsh-context-zip/wire` body: the stamp's `copiedAt` (when the redirect was
 * written) and `processStartedAt` (when the running process began). `restart` means
 * `wired` is true and `copiedAt` is strictly LATER than `processStartedAt` — the
 * redirect landed after this process loaded, so only a restart can pick it up.
 *
 * Missing or unparseable timestamps do NOT answer `restart`: a value that never
 * arrived says nothing, and "waiting on a restart" is a claim that needs proof. The
 * row falls back to `active` instead, which is the reading that matches a healthy
 * wiring. `active` is therefore `wired` true, not `stale`, and not `restart`.
 *
 * The `effective` argument the old signature took is gone entirely, so a panel
 * that could not read `/live` no longer answers `unknown` for a healthy wiring,
 * and the row needs no extra request to decide `restart`.
 *
 * @param payload - the `GET /dsh-context-zip/wire` body, carrying `copiedAt` and
 *   `processStartedAt`.
 * @param action - `'taking'` while a wire request is in flight, `'failed'` when
 *   one failed; anything else means no action is pending.
 * @returns one of `unknown`, `taken`, `incomplete`, `inactive`, `taking`,
 *   `failed`, `update`, `restart`, `active`.
 */
export declare function wireStatusFrom(payload: any, action: any): "unknown" | "taken" | "incomplete" | "inactive" | "taking" | "failed" | "update" | "restart" | "active";
/**
 * What the row's two lines and its one button say, for one status.
 *
 * The copy lives in the locale table and the composition lives here, for the
 * usual reason: this module has no react import, so the runtime checks can render
 * every branch's wording without a browser.
 *
 * `main` is the state word, `sub` is the one line of detail under it, and
 * `action` is the button's label or `''` when the status offers no button. The
 * three no-button statuses are the ones with nothing left to click: `active` (in
 * effect), `restart` (waiting on a restart only the user performs) and `taken`
 * (another package's slot, left alone).
 *
 * The one locale-dependent join is the comma between the version and the time in
 * the `active` line: Chinese uses the full-width `，` and English `, `. Every
 * other separator is already inside the table's own template (`updateTpl`). Each
 * owner drops an absent segment rather than leaving its separator dangling:
 * `active` omits the time when `stampText` has none (`基于内置 0.1.5-rc.2，` was
 * the shape of that bug), and `updateTpl` omits a version it was not given.
 *
 * Both lines that name the stamp's version — the `active` line and the `update`
 * template's snapshot — print the locale's `versionUnknown` sentence when the
 * stamp carries no version, so a missing field never becomes an empty slot
 * (`基于内置 ，09-22 00:08` was the shape of that bug).
 *
 * @param status - one of the nine statuses, or `'loading'` before the read lands.
 * @param payload - the shape the line reads: `version`, `copiedAt`, `current`, and
 *   on a failed write the server's `error`.
 * @param strings - the active locale's string table.
 * @param locale - `'zh'` or `'en'`; picks the one punctuation mark above.
 * @returns the two lines and the button label.
 */
export declare function wireText(status: any, payload: any, strings: any, locale?: string): {
    main: any;
    sub: any;
    action: any;
};
/**
 * Which face the wiring row's status dot wears, one per status.
 *
 * The dot is the row's only non-text mark and it carries one real bit of state:
 * whether this plugin is on the compaction row. The face is returned rather than
 * drawn so the stylesheet stays the single place that maps a state to a colour
 * and a shape, and so the mapping is checkable without a browser.
 *
 * Three faces, because the dot answers one question: is it in effect. `on` is a
 * filled primary ring (in effect), `error` is a filled error ring (the takeover
 * failed), `busy` is an open ring with the breathing halo (a write is in flight).
 * Everything else — not yet in effect, unreadable, waiting on a restart, another
 * package's slot — is the open ring: the sentence beside it names the reason, and
 * a dot that claimed more than the sentence could be wrong.
 *
 * @param status - one of the nine statuses, or `'loading'`.
 * @returns `busy`, `on`, `error`, or `off`.
 */
export declare function wireFace(status: any): "busy" | "on" | "error" | "off";
/**
 * Clean one `/wire` payload's `attention` field into a usable object, or `null`.
 *
 * Anything that is not an object with a non-empty `kind` is `null`: an older
 * server that does not send the field, a failed read that never reached the
 * server, and a malformed answer all have to mean "draw no question mark", which
 * is exactly what a missing field means. `home` and `profile` are read as strings
 * because the prompt template interpolates them; a value of the wrong type would
 * print `undefined` into a command.
 *
 * @param attention - the `attention` value from a `/wire` payload.
 * @returns `{ kind, home, profile }`, or `null`.
 */
export declare function attentionOf(attention: any): {
    kind: any;
    home: any;
    profile: any;
};
/**
 * What the fourth question mark's bubble shows, for one attention kind.
 *
 * The bubble is "one line of current state + the repair prompt + a copy button",
 * and the copy button copies the PROMPT BODY alone: the state line is context for
 * the reader, not part of what an agent should receive. `restart` is the one kind
 * with no prompt: only the user may restart the host, so there is nothing an agent
 * could be asked to do and no button to press. `{home}`, `{profile}` and `{port}`
 * come from the server's `attention` and the page's own location, so the text the
 * user copies holds real paths rather than placeholders.
 *
 * @param attention - the `/wire` payload's `attention` value.
 * @param strings - the active locale's string table.
 * @param port - the page's port, as a string.
 * @returns `{ kind, state, body, note, copyText }`, or `null` when there is
 *   nothing to draw.
 */
export declare function attentionPrompt(attention: any, strings: any, port?: string): {
    kind: any;
    state: string;
    body: any;
    note: any;
    copyText: any;
};
/**
 * One `MM-DD HH:mm` local rendering of a stamp's ISO time.
 *
 * `clockText` alone would print a time of day with no date, and the stamp is a
 * moment that can be days old — the one thing a reader of "wired since" needs is
 * which day. The year is dropped: the stamp is a moment in the recent past, and
 * the minutes alone are what a reader compares against "now". An unparseable or
 * absent stamp renders as an empty string rather than `NaN:NaN`.
 *
 * @param iso - the stamp's `copiedAt` value.
 * @returns the local timestamp, or `''`.
 */
export declare function stampText(iso: any): string;
/**
 * Whether two settings values carry the same settings.
 *
 * The panel holds a draft beside the last value the host stored and asks this to
 * decide whether its one save button is live. Comparing serialized text directly
 * would call two equal objects different the moment a key moved, and the host
 * promises no key order; so keys are sorted at every level and only the sorted
 * shape is compared.
 *
 * @param a - one settings value.
 * @param b - the other.
 * @returns true when the two carry the same settings.
 */
export declare function sameSettings(a: any, b: any): boolean;
/**
 * Whether the panel's one save button is live.
 *
 * Three states keep it dead: nothing loaded yet, a save already in flight, and a
 * draft that matches what the host last stored. Everything else means there is
 * something to save.
 *
 * @param dirty - the draft differs from the last stored value.
 * @param phase - the button's own face; `'saving'` while a write is in flight.
 * @param loaded - the panel has read a settings value.
 * @returns true when a click may start a save.
 */
export declare function saveButtonEnabled(dirty: any, phase: any, loaded: any): boolean;
/**
 * Which face the panel's one save button wears.
 *
 * @param phase - `'idle' | 'saving' | 'saved' | 'failed'`; anything else reads as
 *   `'idle'` so a stray string cannot leave the button unlabelled.
 * @returns `'save'`, `'saving'`, `'check'` (the landed tick) or `'failed'`.
 */
export declare function saveButtonFace(phase: any): "failed" | "saving" | "check" | "save";
/**
 * Whether a read may go out now, given when the last one was dispatched.
 *
 * The timestamp compared against is the moment the previous read was STARTED,
 * not the moment it answered. An unanswered read has to count: the burst this
 * rule exists for is a pending timer tick and the visibility listener firing in
 * the same turn, and at that instant the first of the two is still in flight, so
 * a rule that waited for an answer would suppress nothing at all. The other
 * consequence — a read that goes on to fail also opens the window — is
 * acceptable because the window is a fifth of the interval: the next attempt is
 * a few seconds away regardless, and the panel has its own failure notice.
 *
 * @param lastReadAt - wall clock the previous read was dispatched at; reads
 *   before the first one use `-Infinity`, which this arithmetic accepts.
 * @param at - wall clock now.
 * @param windowMs - how long a read holds the door shut.
 * @returns true when the read may go out.
 */
export declare function liveReadDue(lastReadAt: any, at: any, windowMs?: number): boolean;
/**
 * Start the live poll: one read every interval, plus one read the moment the
 * tab comes back to the foreground.
 *
 * Why the extra read at all, when the browser usually runs the pending timer
 * as soon as the page is visible again: that courtesy is Chrome's, not a
 * promise any specification makes, and it is exactly the thing that makes a
 * stale panel look healthy — the numbers do not move while the tab is hidden,
 * and nothing on screen says so. Waiting for a browser to hand the timer back
 * means the panel's freshness depends on an implementation detail. Reading on
 * the transition makes it depend on the panel instead, and costs one request
 * per return to the tab.
 *
 * The courtesy is also why the two reads have to be de-duplicated rather than
 * one of them removed: the listener's read and the timer's tick describe the
 * same transition, and a return was measured sending two requests — the
 * listener's in the event's own task, the tick's up to half a second later.
 * `LIVE_DEDUPE_MS` drops the second one; the timer itself is re-armed only at
 * start and cleared only at stop, so its cadence is untouched.
 *
 * What is deliberately NOT here: any attempt to keep the 5-second cadence while
 * the page is hidden. Throttling a hidden page is power saving, not a fault;
 * nobody is reading the panel then, and the numbers are re-read before anyone
 * can be looking at them again.
 *
 * The environment is passed in (`doc`, `setTimer`, `clearTimer`, `now`) so the
 * runtime checks can drive it without a DOM.
 *
 * @param options - the read to run, the interval, the de-duplication window,
 *   the clock, and the environment.
 * @returns a stop function clearing the timer and the listener.
 */
export declare function startLivePoll(options: any): () => void;
