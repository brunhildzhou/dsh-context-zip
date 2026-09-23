# dsh-context-zip

[![npm version](https://img.shields.io/npm/v/dsh-context-zip)](https://www.npmjs.com/package/dsh-context-zip)
[![npm downloads](https://img.shields.io/npm/dm/dsh-context-zip)](https://www.npmjs.com/package/dsh-context-zip)
[![license](https://img.shields.io/github/license/brunhildzhou/dsh-context-zip)](./LICENSE)
[![stars](https://img.shields.io/github/stars/brunhildzhou/dsh-context-zip)](https://github.com/brunhildzhou/dsh-context-zip)

**A context-compaction plugin for the DeepSeek Harness (DSH): it takes over the harness's built-in compaction summarizer, writes a fixed five-section handoff summary instead, and keeps every compacted span readable in a segment index.** Version `0.1.5`, MIT licensed. See [dsh-context-zip on npm](https://www.npmjs.com/package/dsh-context-zip). [中文](./README.md)

## At a glance

- **Five-section handoff summary**: the compaction step goes through this plugin, and each summary follows `Goal and intent`, `Decisions`, `Current state`, `Next steps`, `Anchors`.
- **Nothing lost to compaction**: every compaction is recorded as a segment, and the original text reads back by segment number or event number.
- **Retrieval tools and export**: `history_segments`, `history_read`, `history_search`, `history_find` read only their own session, plus a read-only service and a `/zip-export` command.
- **Optional extras**: model working notes, a mechanical summary fallback, and a layout-only rewrite of prose summaries, all off by default; one settings panel controls everything above.

## Install and update

Two routes. Pick one.

**Route A: install from npm.** The plugin starts and the panel opens, but compaction stays inactive (the row redirect is missing). Fix: in the settings panel, open the ContextZip section, press the button on the right end of the backend row, then restart the harness once.

```bash
dsh plugin --profile web add dsh-context-zip
```

To update, run it again with the version swapped in:

```bash
dsh plugin --profile web add dsh-context-zip@<version>
```

Measured fact: pnpm leaves the redirect alone, so the takeover is a one-time step and later updates do not need a second one.

**Route B: install from a source checkout.** This installs the plugin and the redirect in one step. Start the profile at least once first, then run:

```bash
node install.mjs --profile-dir <profile directory>
```

For example `node install.mjs --profile-dir <harness home>/profiles/web`. Full flags, uninstall, and rollback are in `docs/安装与卸载.md`.

## Which step it takes over

DSH compacts a session when the context nears the window limit. The built-in implementation writes a free-form summary and the original text is hard to find afterwards. This plugin replaces that row:

```
Automatic compaction fires
  │
  ├─ Not taken over: the shipped backend writes a free-form summary
  │
  └─ Taken over: this plugin writes the five-section handoff summary
        ├─ The summary lands on disk (the only authority after compaction)
        └─ The original text enters the segment index (readable by segment / event)
```

The takeover is a row replacement, not a second mount. The plugin changes no DSH code and writes no events into session logs.

## Capabilities

| Capability | Notes | Default |
|---|---|---|
| Compaction takeover | Five-section handoff summary, soft target 3072 tokens, hard cap 6144 | Off (new sessions use the shipped backend; switch it in the panel) |
| Segment index | One segment per compaction, listing segment number, replaced events, summary event | Always on |
| Retrieval tools | `history_segments`, `history_read`, `history_search`, `history_find`, own session only | Always on |
| Working notes | `notes_write` / `notes_read` / `notes_search`, draft capped at 6000 characters, merged into the next summary | Off |
| Mechanical fallback | After enough consecutive failures (default 5), a ledger summary lands the compaction | Off |
| Layout-only rewrite | One extra call that re-lays out a heading-less summary without resending the original text | Off |
| Retrieval throttle | Receipts, incremental filtering, narrowing, read caps; its effect was never established | Off |
| Settings panel | A ContextZip section: compaction method, summary fallback, summary re-layout, experiments and diagnostics, compaction segments; plus a compaction-mode chip beside the composer | Always on |
| Export and manual compaction | Read-only `contextZip` service with a `/zip-export` command; the `/zip-compact` command is not gated by the master switch | Always on |

The backend row reads as one line: a title with a question-mark bubble on the left, a main line plus a sub line in the middle, a button on the right end. Nine states: Inactive, Taking over, Active, Update available, Restart required, Taken (the row still reads Inactive; the sub line says the slot is already occupied), Incomplete, Unknown, Could not take over.

## Screenshots

Four states of the backend row:

![Inactive](docs/images/panel-wire-inactive.png)
![Taking over](docs/images/panel-wire-taking.png)
![Active](docs/images/panel-wire-active.png)
![Restart required](docs/images/panel-wire-restart.png)

A retrieval-tool transcript and a five-section handoff summary:

![history_segments output](docs/images/tool-history-segments.png)
![Five-section summary](docs/images/summary-five-sections.png)

The four state shots come from a temporary DSH instance on a hidden virtual desktop (temporary `DSH_HOME`, port 3190), not from a user's machine; the conversations in the last two are driven by a local stub model and only show what the interface looks like, not what the plugin can do. Per-image provenance and redaction notes are in `docs/截图清单.md`.

## Compatibility and boundaries

- **Host**: DeepSeek Harness, peer range `>=0.1.5-rc.2 <0.2.0-0 || >=0.1.6-0 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0`; tested against `0.1.5-rc.2`, `0.1.6-alpha.2` and `0.1.7-alpha.1`, other 0.1.x versions were not tested one by one.
- **Node.js**: `^22.19.0 || >=24.0.0` (`engines` in `dsh-context-zip/package.json`).
- **Peer dependencies** resolve from the profile's `node_modules` and are not installed with this plugin.
- **UI languages**: Chinese and English, two string tables with matching key sets.
- **DSH only**; the plugin cannot run standalone.
- `redirect/` is a local redirect package that reuses the `@deepseek-ai/dsh-compaction-basic` name to route calls into this plugin. It is not an official package (`private: true`), and the installer refuses to overwrite the real one.
- After a harness upgrade the redirect can fall behind; re-check with `--check` and refresh it by reinstalling.
- Remaining boundaries (unproven throttle, session names updating within 60 seconds at most, an unbounded title memo, a read-only per-session override table, an installer that keeps no snapshots) are in `docs/局限性与已知问题.md`.

## Verifying it yourself

The plugin ships a runtime check suite: 1358 checks pass with both `--installed` and `--deliverable` given. How to run it and what it covers is in `evidence/套件说明.md`.

## Repository layout

The repository root is the release bundle: `README.md` / `README.en.md`, the plugin directory `dsh-context-zip/`, `docs/`, `evidence/`, `RELEASE-NOTES.md`, `LICENSE`. The full guide is in `docs/仓库布局.md`; start from `docs/` for anything functional.

## If it works for you

A star on [GitHub](https://github.com/brunhildzhou/dsh-context-zip) is welcome, and so is an issue telling us what does not work.

## License and thanks

MIT; the full text is in `LICENSE`. The runtime is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The comparison with peer plugins, including where this one falls short, is in `docs/同类插件对比.md`.
