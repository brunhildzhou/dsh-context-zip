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
export const LIVE_POLL_MS = 5000;

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
export const LIVE_DEDUPE_MS = 1000;

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
export const MODE_RETRY_SCHEDULE_MS = [400, 1000, 2500, 5000, 10000, 30000];

/**
 * How long one chip read keeps the next one from going out.
 *
 * The same value and the same argument as {@link LIVE_DEDUPE_MS}: a return to
 * the tab releases a queued timer tick and fires the `visibilitychange`
 * listener in nearly the same turn, and the measured gap was 494 ms.
 */
export const MODE_DEDUPE_MS = 1000;

/**
 * The delay before the chip's next read, given how many have already failed.
 *
 * @param failures - consecutive failed reads so far; 0 before the first failure.
 * @param scheduleMs - the schedule to walk; the last entry repeats forever.
 * @returns milliseconds to wait.
 */
export function modeRetryDelay(failures, scheduleMs = MODE_RETRY_SCHEDULE_MS) {
  const steps = Array.isArray(scheduleMs) && scheduleMs.length > 0 ? scheduleMs : MODE_RETRY_SCHEDULE_MS;
  // Failure one takes step one, failure two step two, and a long run stays on
  // the last step. Zero and nonsense both mean "about to make the first
  // attempt", so they take step one as well.
  const nth = Number.isFinite(failures) && failures >= 1 ? Math.floor(failures) : 1;
  return steps[Math.min(nth - 1, steps.length - 1)];
}

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
export function modeClickIntent(readable) {
  return readable ? 'flip' : 'retry';
}

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
export function startModeReadRetry(options) {
  const {
    read,
    scheduleMs = MODE_RETRY_SCHEDULE_MS,
    dedupeMs = MODE_DEDUPE_MS,
    now = Date.now,
    doc,
    setTimer,
    clearTimer,
    onAttempt,
  } = options ?? {};
  let stopped = false;
  let failures = 0;
  let timer = null;
  /** Wall clock of the last read this loop let out; none before the first. */
  let lastReadAt = Number.NEGATIVE_INFINITY;

  const run = async () => {
    if (stopped) return;
    lastReadAt = now();
    let landed = false;
    try {
      landed = (await read()) === true;
    } catch {
      landed = false;
    }
    if (stopped) return;
    if (landed) {
      failures = 0;
      onAttempt?.(0);
      return;
    }
    failures += 1;
    onAttempt?.(failures);
    timer = setTimer(() => {
      timer = null;
      void run();
    }, modeRetryDelay(failures, scheduleMs));
  };

  const onVisibilityChange = () => {
    if (doc?.visibilityState !== 'visible') return;
    if (!liveReadDue(lastReadAt, now(), dedupeMs)) return;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    // A person is looking again, so this attempt starts the schedule over.
    failures = 0;
    onAttempt?.(0);
    void run();
  };

  void run();
  doc?.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

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
export function initialLiveHealth(at) {
  return { failures: 0, lastOk: at };
}

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
export function liveHealthAfter(previous, healthy, at) {
  if (healthy) return previous.failures === 0 ? previous : initialLiveHealth(at);
  return { failures: previous.failures + 1, lastOk: previous.lastOk };
}

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
export function clockText(ms) {
  const at = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

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
export function helpBubblePlacement(anchor, viewport, size, gap = 8, margin = 12) {
  const width = Math.max(0, Math.min(size.width, viewport.width - margin * 2));
  const left = Math.max(margin, Math.min(anchor.right - width, viewport.width - width - margin));
  let top = anchor.bottom + gap;
  if (top + size.height > viewport.height - margin && anchor.top - gap - size.height > margin) {
    top = anchor.top - gap - size.height;
  }
  return { left, top: Math.max(margin, top), width };
}

export function toRows(agents) {
  return Object.entries(agents ?? {}).map(([key, value]) => ({ key, value: value === true }));
}

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
export function titlesFrom(source) {
  const clean = {};
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return clean;
  for (const [id, title] of Object.entries(source)) {
    if (typeof title === 'string' && title.trim().length > 0) clean[id] = title.trim();
  }
  return clean;
}

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
export function mergeLivePayload(previous, payload) {
  if (previous === null || previous === undefined) return previous;
  const titles = payload !== null && typeof payload === 'object' && 'titles' in payload
    ? titlesFrom(payload.titles)
    : previous.titles;
  const effective = payload?.effective ?? previous.effective;
  const sameTitles = sameTitleMap(previous.titles, titles);
  const sameEffective = JSON.stringify(previous.effective) === JSON.stringify(effective);
  if (sameTitles && sameEffective) return previous;
  return { ...previous, titles, effective };
}

/** Whether two title maps carry the same names, so a tick can avoid a re-render. */
function sameTitleMap(left, right) {
  const a = left ?? {};
  const b = right ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

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
export function rowsAfterSave(group, previousRows, serverValue) {
  if (group !== 'agents') return previousRows;
  return toRows(serverValue?.agents ?? {});
}

/**
 * How long the panel's one save button holds its confirmation or failure face.
 *
 * The copy button's own feedback uses the same window, so the panel keeps one
 * rhythm: a state the user did not ask for is withdrawn after 1.5 s instead of
 * staying on screen until the next interaction.
 */
export const SAVE_FEEDBACK_MS = 1500;

/** Canonical text for one settings value: object keys sorted, at every level. */
function settingsShape(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(settingsShape).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${settingsShape(value[key])}`)
    .join(',')}}`;
}

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
export function sameSettings(a, b) {
  return settingsShape(a) === settingsShape(b);
}

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
export function saveButtonEnabled(dirty, phase, loaded) {
  return loaded === true && phase !== 'saving' && dirty === true;
}

/**
 * Which face the panel's one save button wears.
 *
 * @param phase - `'idle' | 'saving' | 'saved' | 'failed'`; anything else reads as
 *   `'idle'` so a stray string cannot leave the button unlabelled.
 * @returns `'save'`, `'saving'`, `'check'` (the landed tick) or `'failed'`.
 */
export function saveButtonFace(phase) {
  return phase === 'saving' ? 'saving' : phase === 'saved' ? 'check' : phase === 'failed' ? 'failed' : 'save';
}

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
export function liveReadDue(lastReadAt, at, windowMs = LIVE_DEDUPE_MS) {
  return at - lastReadAt >= windowMs;
}

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
export function startLivePoll(options) {
  const {
    read,
    intervalMs = LIVE_POLL_MS,
    dedupeMs = LIVE_DEDUPE_MS,
    now = Date.now,
    doc,
    setTimer,
    clearTimer,
  } = options ?? {};
  /** Wall clock of the last read this module let out; none before the first. */
  let lastReadAt = Number.NEGATIVE_INFINITY;
  const dispatch = () => {
    const at = now();
    if (!liveReadDue(lastReadAt, at, dedupeMs)) return;
    lastReadAt = at;
    void read();
  };
  const timer = setTimer(() => dispatch(), intervalMs);
  const onVisibilityChange = () => {
    // Only the return trip reads. A page going hidden has nothing to show, and
    // reading on the way out would be one more request in the throttled window.
    if (doc?.visibilityState !== 'visible') return;
    dispatch();
  };
  doc?.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    clearTimer(timer);
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
