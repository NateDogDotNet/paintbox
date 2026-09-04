# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**v0.1.0 — built and working.** The round-trip is closed: open an image, edit it in miniPaint, hit Save, and `saveCustomDocument` writes the bytes back to the source URI with `vscode.workspace.fs.writeFile`. Phases 1 through 7a of `docs/integration-plan.md` are done and `CHANGELOG.md` records what landed in each. `npm run compile` and `npm run lint` both pass clean; `src/` carries no TODO or not-implemented markers.

What remains is Phase 7b — publishing to Open VSX. Treat the publishing checklist at the end of `docs/integration-plan.md` as stale rather than authoritative: several boxes are unticked but already satisfied (LICENSE, `THIRD_PARTY_LICENSES.md`, README screenshot). Verify each one against the repo instead of trusting the box.

Phases still have explicit entry/exit criteria. When extending the work, say which phase you are in and respect the boundaries.

## Commands

```bash
npm install              # one-time / after dep changes
npm run compile          # tsc -p ./   (output → out/)
npm run watch            # tsc --watch
npm run lint             # eslint src
npm run package          # vsce package --no-yarn  (produces paintbox-<version>.vsix)
npm run publish:ovsx     # ovsx publish; requires OVSX_PAT env var
```

To exercise the extension: open this repo in VS Code / code-server and press F5 → Extension Development Host.

`npm test` runs the `@vscode/test-electron` harness (wired up in Phase 2); `pretest` compiles first. Three suites live in `src/test/suite/` — `extension.test.ts` (activation), `save.test.ts` (the write path), and `correlator.test.ts` (a pure unit test of `SaveCorrelator`, deliberately free of any `vscode` import). The driver downloads a real VS Code build and needs a display: in a container, use `xvfb-run -a npm test`.

## Architecture

The whole extension is a single round-trip across two execution contexts:

```
Server FS  ←→  Extension Host (Node, src/)  ←→  Webview (miniPaint, vendor/minipaint/)
              vscode.workspace.fs.{read,write}File          postMessage bridge
```

- **`src/extension.ts`** — `activate()` registers the provider and calls `verifyPatchedBundle()`. That's it.
- **`src/editorProvider.ts`** — `PaintboxEditorProvider` implements `CustomEditorProvider<ImageDocument>`. The four lifecycle methods (`openCustomDocument`, `resolveCustomEditor`, `saveCustomDocument`, `saveCustomDocumentAs`) are the only places that touch disk; everything else is the webview's problem.
- **`src/saveCorrelator.ts`** — maps `requestId` strings to pending save promises, with timeouts. Extracted out of the provider on purpose so it stays unit-testable without importing `vscode`.
- **`src/webviewHtml.ts`** — pure function that reads upstream `vendor/minipaint/index.html` and applies the transforms that make it work in a webview (a `<base href>` pointing at the vendored dir is the load-bearing one — style-loader emits relative `url()` references that nothing else rewrites).
- **`src/patchMinipaintBundle.ts`** + **`scripts/patch-bundle.js`** — the build-time bundle patch, run by `npm run compile`, never at activation. It reroutes miniPaint's 8 `p().saveAs(` call sites through `window.__pbBridge` and strips GIF/BMP from `SAVE_TYPES`. It asserts exactly 8 call sites and throws otherwise, so an upstream bump fails loudly instead of silently half-patching. The VSIX ships pre-patched.
- **`src/webview/shim.ts`** — runs inside the webview. Installs `window.__pbBridge` before the bundle loads, hands incoming bytes to miniPaint's `File_open`, and drives `FileSave.save_action` on a save request so no export modal appears.
- **`vendor/minipaint/`** — upstream miniPaint, committed copy at v4.14.3 (not a submodule). Vendored in Phase 1. Its `File_save_class` (`vendor/minipaint/src/js/modules/file/save.js`) carries an inline `PAINTBOX-PATCH` marker; the `dist/bundle.js` rewrite happens at build time, not in the committed source.

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
- Tests exist (`src/test/suite/`). New behaviour lands with its test in the same change, not after.
