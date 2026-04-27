# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Scaffolded skeleton, not yet functional.** `src/` compiles and registers a `CustomEditorProvider`, but every save/load path is a TODO. Implementation work proceeds phase-by-phase per `docs/integration-plan.md` (Phases 1–7). Each phase has explicit entry/exit criteria — when picking up work, identify the current phase first and respect the boundaries.

## Commands

```bash
npm install              # one-time / after dep changes
npm run compile          # tsc -p ./   (output → out/)
npm run watch            # tsc --watch
npm run lint             # eslint src
npm run package          # vsce package --no-yarn  (produces paintbox-<version>.vsix)
npm run publish:ovsx     # ovsx publish; requires OVSX_PAT env var
```

To exercise the extension: open this repo in VS Code / code-server and press F5 → Extension Development Host. There is no test runner wired up yet (`npm test` references `out/test/runTest.js` which doesn't exist); add the `@vscode/test-electron` harness when introducing the first test.

## Architecture

The whole extension is a single round-trip across two execution contexts:

```
Server FS  ←→  Extension Host (Node, src/)  ←→  Webview (miniPaint, vendor/minipaint/)
              vscode.workspace.fs.{read,write}File          postMessage bridge
```

- **`src/extension.ts`** — `activate()` registers the provider. That's it.
- **`src/editorProvider.ts`** — `PaintboxEditorProvider` implements `CustomEditorProvider<ImageDocument>`. The four lifecycle methods (`openCustomDocument`, `resolveCustomEditor`, `saveCustomDocument`, `saveCustomDocumentAs`) are the only places that touch disk; everything else is the webview's problem.
- **`vendor/minipaint/`** — upstream miniPaint, committed copy at v4.14.3 (not a submodule). Currently empty (`.gitkeep`); Phase 1 populates it. The save hook (`File_save` in `src/actions/file/`) gets patched to `postMessage` instead of triggering a browser download.

The full sequence diagram and rationale for `postMessage` as the only bridge is in `docs/architecture.md`. Read that before touching the host↔webview boundary.

## Load-bearing decisions

These are decided and recorded in `docs/decisions.md` — treat as fixed unless the user asks to revisit:

- **Editor engine: miniPaint** (MIT, ~30 tools, single-file deployable). Not Photopea (closed, browser-only ext doesn't save), not luna-paint (commercial), not tui.image-editor (unmaintained).
- **Vendoring: committed copy in `vendor/minipaint/`**, not a git submodule. The save hook requires patching miniPaint source — a committed copy keeps that patch inline and reviewable. Upstream bumps are a deliberate `cp -r` + `git diff`.
- **Custom editor priority: `"option"`** in `package.json` (`contributes.customEditors`). paintbox shows up in "Open With" but does not hijack the default image preview. Only flip to `"default"` if explicitly asked.
- **`retainContextWhenHidden: true`** on the webview. miniPaint holds layer state in JS memory; destroying the webview on tab-hide loses unsaved work. Required, don't drop it.
- **Target: Open VSX**, not the Microsoft Marketplace. code-server can't reach the MS Marketplace. Publisher is `NateDogDotNet`.

## Conventions specific to this repo

- The Node host is mandatory. Never add a `browser` entry point to `package.json` — the whole reason this extension exists is that `browser`-only extensions can't write to the server filesystem in code-server. `main: "./out/extension.js"` is load-bearing.
- All webview asset paths must go through `webview.asWebviewUri()`; bare `file://` URIs are blocked. `enableLocalResourceRoots` must include `vendor/minipaint/` once Phase 3 starts.
- `docs/decisions.md` is a chronological log — new decisions append to the bottom (newest last), no ADR ceremony.
- Adding a third-party dependency means updating `THIRD_PARTY_LICENSES.md` to keep MIT compliance intact in the published VSIX.
- `.vscodeignore` excludes `src/`, `docs/`, `tsconfig.json` from the VSIX. If you add runtime assets outside `out/` and `vendor/`, double-check they aren't being stripped — `vsce ls` before publishing.

## Working preferences

The user values KISS, YAGNI, TDD, and best practices. In this codebase that means:

- Match the phased plan — don't implement Phase 5 logic while ostensibly fixing Phase 3. If a phase boundary is in the way, propose moving it explicitly.
- No speculative abstractions for "future formats" or "future editors." miniPaint + the six declared MIME types is the scope.
- When introducing test infrastructure (no tests exist yet), wire it up before or alongside the feature it covers, not after.
