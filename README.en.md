# dsh-context-zip

A context-compaction plugin for the DeepSeek Harness (DSH). It replaces the harness's built-in compaction summarizer with a five-section handoff summary and keeps every compacted span readable by event number.

Version `0.1.0`, licensed under MIT.

## What this is

DSH compacts a session when the context approaches the window limit. The built-in implementation has the model write a free-form summary, and the original text can then be recovered only by digging it out. This plugin takes over that step:

- The summary follows a fixed five-section form, so a later model can locate old information by section.
- Every compaction is recorded as a segment, and its segment number, the events it replaced, and the summary event number can all be listed.
- Nothing is deleted. A model or a human can read the original text back by segment number or event number.
- The model may keep short working notes, which are merged into the next summary.
- A settings panel controls all of the above.

The plugin changes no DSH code. It mounts itself through a bundle patch and takes over the `compaction-basic` row by resolving that row's specifier to a profile-local package of the same name.

## Who it is for

- Users running long DSH sessions who care whether compacted text can still be found.
- Users who want a different summarizer in their own DSH deployment without patching DSH.
- Users who need readable material for auditing what compaction did.

## Dependencies

- **Host**: DeepSeek Harness. The plugin works only inside a DSH host and cannot run standalone.
- **Node.js**: `^22.19.0 || >=24.0.0` (see `engines` in `dsh-context-zip/package.json`).
- **Host-provided packages**: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-query`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-token-meter`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, and `react`. These are `peerDependencies`, resolved from the profile's `node_modules`; they are not installed along with this plugin.
- **Install precondition**: `install.mjs` has to find a real `@deepseek-ai/dsh-compaction-basic` on the profile's resolution path so that it can copy a `base.js`. That package is normally supplied by `$DSH_HOME/profiles/node_modules`, and the harness creates that directory on its first start. A brand-new profile that has never been started must be started once before installation.
- **Host versions**: tested against DSH `0.1.5-rc.2` and `0.1.6-alpha.2`. The package declares `>=0.1.5-rc.2 <0.2.0-0 || >=0.1.6-0 <0.2.0-0`; other 0.1.x versions were not tested individually.

## Three installation steps
**`dsh plugin add` works and the plugin starts, but compaction will not take effect.** It installs the plugin package only, so the line redirect is missing and the compaction row still resolves to the shipped backend. Use the command below, and make sure the profile has been started at least once; alternatively, press "Wire compaction" in the ContextZip section of the settings panel after starting, then restart the harness.



1. Build.

   ```bash
   npm install
   npm run check        # build.mjs + tsc --noEmit + node --check on both bundles
   ```

2. Install into a profile.

   ```bash
   node install.mjs --profile-dir <profile directory>
   ```

   For example `node install.mjs --profile-dir <harness home>/profiles/web`.

   **You may also install with `dsh plugin add dsh-context-zip`, but that installs the plugin package only.** The panel opens and the plugin starts, yet **compaction does not take effect**: the line redirect is missing. Press "Wire compaction" in the ContextZip section. It writes the redirect into the profile's `node_modules/@deepseek-ai/dsh-compaction-basic/` with the same files and the same guards as `install.mjs` (the target must land inside the profile; a real package already there is refused, not overwritten). On success the status line becomes "Wired" and says "Restart the harness for it to take effect"; the restart is the user's to perform.

3. Restart the host. DSH composes a profile at startup, so the row swap takes effect only on restart.

For fuller flag documentation, uninstall, and rollback, see `docs/安装与卸载.md`.

## What it does

### Takes over compaction

Automatic compaction switches to this plugin's five-section summary. The sections are `Goal and intent`, `Decisions`, `Current state`, `Next steps`, and `Anchors`. The summary's soft target is 3072 tokens and its hard cap is 6144 (`engine/prompt.ts`).

The takeover is a row replacement, not a second mount. `compaction` is a single-slot service, and loading two implementations raises an error immediately, so the plugin has to take the place of the shipped `compaction-basic` row. The mechanism and the reason for it are described in `dsh-context-zip/README.md`.

Taking over does not force every session to use it. A per-session switch sets which summarizer a new session uses: with it on, automatic compaction uses this plugin; with it off, the summary step goes back to the built-in backend. Four things are identical in the two modes: which span is compacted, how much of the tail is kept, how an over-limit attempt is retried, and how the log is written. The only difference is the wording of the summary and the notes. The mode is read live, so changing the setting also affects sessions that are already open.

### Merges working notes into the summary

Working notes are off by default. When enabled, the model can record intent and decisions with `notes_write` and read the draft and its archive back with `notes_read` and `notes_search`; the next compaction feeds that draft to the summarizer as material about intent. The summary remains the only authority: facts come from the history, intent comes from the notes. The draft is capped at 6000 characters, and one reminder fires when context pressure reaches 75% (`NOTES_MAX_CHARS`, `REMINDER_THRESHOLD_PERCENT`).

Notes live under `<harness home>/context-zip/`, separate from session logs.

### Retrieval tools

Four tools operate on the session's own history. They read only their own session and never cross into another session or another agent:

| Tool | What it does |
|---|---|
| `history_segments` | Lists this session's compaction segments: segment number, replaced events, summary event number |
| `history_read` | Reads original text back by segment, by event number, or by event number plus a character offset |
| `history_search` | Full-text search over the session history, with a cursor for paging |
| `history_find` | Tries several query terms in a single call, optionally filtering with a regular expression |

The search bound of `history_search` is "before the assistant message that requested this search", so a search never matches itself and never matches the reasoning of the current step. The cursor carries that bound inside itself, so paging does not repeat a page.

A read-only service named `contextZip` and a `/zip-export <session>` command export segments to Markdown for human review.

### Retrieval throttling

Off by default (`throttle`). When on, it does four things: attaches a receipt to each retrieval, does not return events already read in full, pauses the search tools after two consecutive retrievals that added nothing new, and caps the length of a single read while the result set is narrowed. The ledger and the `tracePath` trace file are not governed by this switch and run either way, so an unthrottled baseline stays measurable.

The effect of throttling was never established. See `docs/局限性与已知问题.md`.

### Mechanical fallback

Off by default (`fallbackEnabled`). When on, and once compaction attempts have failed consecutively as many times as the configured count (`fallbackAfterFailures`, default 5, clamped to 0 through 10), the plugin substitutes a ledger summary assembled from session events so that the compaction goes through. Every line of that summary comes from the events themselves. With the switch off, the attempts run out and the failure is reported; the old conversation stays as it is.

### Layout-only rewrite

Off by default (`rewriteEnabled`). For a summary that the shape gate judges to have no subheading structure, the plugin makes one extra call that changes layout only. That call re-lays out the prose into the five sections, does not resend the compacted conversation, pins the reasoning effort to the lowest level the model declares, and verifies that every path token the rewrite introduces and the original did not have actually exists (`introducedPaths` / `sameFileSpelling` / `rewriteGuardBlocks`). The rewritten text is discarded when a token cannot be vouched for. A failed call, unreadable model metadata, or a guard rejection each costs only the layout improvement; none of them can fail the compaction.

### Settings panel

The panel gains a `ContextZip` section with five blocks: compaction mode, mechanical fallback, layout rewrite, experiments and troubleshooting (collapsed by default), and compaction segments. The row at the lower left of the composer gains a small chip showing which backend the current session will use for its next compaction; clicking it switches backends and writes the per-session override row.

The per-session override table is read-only in the panel: the only ways to write to it are that chip and a manual edit of `settings.yaml`.

## Verifying it yourself

The plugin ships a runtime check suite. It currently contains 1130 checks. The suite checks the build output, so it has to be pointed at an installed copy. The full description is in `evidence/套件说明.md`; the shortest path is:

```bash
node build.mjs
node install.mjs --profile-dir <test profile>
node test/run.mjs --installed <test profile>/node_modules/dsh-context-zip --deliverable <this directory>
```

Both flags are required. `--installed` lets the checks resolve `@deepseek-ai/*` and reach the harness's shipped compaction backend; running against this directory alone fails at load time with a missing package, or makes the load guard report a false failure. `--deliverable` makes the same run also verify that the declaration files pointed at by `exports[*].types` in this directory's `package.json` actually exist.

## Boundaries and known issues

- DSH is the only supported host; the plugin cannot run standalone.
- Working notes are off by default.
- The effect of retrieval throttling was never established, and it is off by default.
- Session names in the settings panel can take up to 60 seconds to update.
- The title memo has no capacity limit.
- The per-session override table is read-only in the panel.
- The installer only copies files; it does not build. After upgrading DSH, run `--check` to see whether the redirect has fallen behind.
> Note: `redirect/` is a **local redirect package**. It deliberately reuses the name `@deepseek-ai/dsh-compaction-basic` so the harness's backend call lands on this plugin instead. It is **not an official DeepSeek package**; it is marked `private: true`, and the installer refuses to overwrite the real package.

The evidence and impact for each item are in `docs/局限性与已知问题.md`.

## License

MIT. The full text is in `LICENSE`.

## Directory guide

| Location | Contents |
|---|---|
| `README.md` | Chinese version |
| `README.en.md` | This file |
| `RELEASE-NOTES.md` | Notes for this release |
| `LICENSE` | Full MIT license text |
| `docs/功能文档.md` | Feature-to-code index (Chinese) |
| `docs/结构与文件职责.md` | What each file is responsible for (Chinese) |
| `docs/安装与卸载.md` | Installer flags, uninstall, rollback (Chinese) |
| `docs/局限性与已知问题.md` | Boundaries, known issues, and their evidence (Chinese) |
| `docs/同类插件对比.md` | Comparison with peer plugins (Chinese) |
| `evidence/套件说明.md` | How to run the check suite and what it covers (Chinese) |
| `evidence/对照测试方案.md` | The compaction-effect comparison plan (Chinese) |
| `evidence/对照测试最终报告.md` | Results of that comparison (Chinese) |
| `evidence/token消耗与性价比分析.md` | Token-consumption statistics (Chinese) |
| `evidence/独立验收报告汇编.md` | Raw independent acceptance reports (Chinese) |
| `evidence/验收台账.md` | Acceptance-slice status table (Chinese) |
| `dsh-context-zip/` | The plugin itself; this is the directory to install |
