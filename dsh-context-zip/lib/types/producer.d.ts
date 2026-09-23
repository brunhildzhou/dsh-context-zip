/**
 * The message-source kind every message this plugin produces carries.
 *
 * 0.1.7-alpha.1 deleted the shared catch-all `plugin` kind and made
 * `MessageSourceMap` merge-extensible instead: "each producer declares its own
 * `kind` in its own module; there is no shared catch-all `plugin` kind"
 * (`@deepseek-ai/dsh-llm/lib/types/message.d.ts`, above `MessageSourceMap`).
 *
 * The retired literal is not merely undocumented, it is REFUSED at the session
 * format boundary: native V4 admission throws
 * `format v4 message requires a producer-owned source kind` for any persisted
 * message whose `source.kind` is exactly `plugin`
 * (`@deepseek-ai/dsh-session-format-v3-to-v4`, `source()`), and that check runs
 * both on the way into the log and on the way out of it. A message with the
 * retired kind therefore does not degrade, it fails the whole turn and never
 * lands: the injection is claimed by the agent loop, the append throws, and the
 * plugin's own `try`/`catch` around `agent.inject(...)` cannot see it.
 *
 * The harness's own convention for a third-party producer is `plugin:<name>`:
 * its V3 migration rewrites every released `{ kind: 'plugin', plugin: X }` row
 * to `kind: 'plugin:X'` (`producerKind()`), so this is also the spelling the
 * rows already on disk carry after a migration, and new messages then agree
 * with them.
 *
 * The `plugin` field stays. Admission only ever looks at `kind`, and the
 * mechanical summary filters this plugin's own instruction messages by
 * `source.plugin` (`engine/engine.ts`, `buildMechanicalSummary`).
 *
 * @module
 */
/** The kind of every message this plugin produces. */
export declare const PRODUCER_KIND = "plugin:context-zip";
