# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-28

First publishable release. Captures the full Phase 1 → Phase 6.9 build-out: a
working `CustomEditorProvider` that opens images, hands them to a vendored
miniPaint webview, and writes edits back to disk via
`vscode.workspace.fs.writeFile` — closing the save round-trip that
code-server users couldn't get from the existing Photopea / luna-paint
options.

### Added

- **Extension scaffold** (`63e25fb`) — initial Node-host extension with
  `package.json`, `tsconfig.json`, `tsconfig.webview.json`, `LICENSE`,
  empty `src/extension.ts` and `src/editorProvider.ts`.
- **Repo policy decisions** (`bea16b7`) — publisher `NateDogDotNet`,
  custom-editor `priority: "option"`, vendoring strategy. Recorded in
  `docs/decisions.md`.
- **Project guide** (`b792db7`) — `CLAUDE.md` with project status,
  architecture, conventions.
- **Phase 1 — miniPaint vendoring** (`82a20dc`, `1b52740`, `55f4ba6`) —
  committed copy of miniPaint v4.14.3 at `vendor/minipaint/`, with the save
  hook path documented for downstream phases.
- **Phase 2 — test harness** (`176640e`) — wired `@vscode/test-electron`
  plus the first smoke test verifying the extension activates.
- **Phase 3 — open path** (`3f637a7`) — file bytes flow from disk into the
  miniPaint webview on `openCustomDocument`; `enableLocalResourceRoots`
  scoped to `vendor/minipaint/`; `retainContextWhenHidden: true` for layer
  state persistence across tab switches.
- **Phase 4 — save hook** (`e882219`) — patched
  `File_save_class` in the miniPaint bundle so Save posts bytes to the
  extension host instead of triggering a browser download.
- **Phase 5 — host-side write** (`afbc41a`) — `saveCustomDocument` writes
  the posted bytes back to the source URI via
  `vscode.workspace.fs.writeFile`. Save round-trip closed.
- **Phase 6 — Save As** (`a38ef1f`) — cross-format Save As with a
  lossy-conversion warning when the user picks a different MIME from the
  source.
- **Phase 6.6 — UI surface restored** (`80535d2`) — re-enabled Search
  Images, Export, in-app Save As, and Print after they were inadvertently
  pruned during earlier patching.
- **Listing assets** — new `images/icon.png` (128×128, adapted from
  miniPaint logo-colors, MIT-licensed by ViliusL) and
  `images/screenshot.png` (Playwright auto-capture; re-runnable via
  `bash scripts/screenshot.sh`).
- **CHANGELOG.md** (this file) — Keep-a-Changelog format from v0.1.0
  forward.
- **Lint pipeline** — `eslint` + `@typescript-eslint/*` devDependencies,
  `.eslintrc.json`, `.eslintignore`. `npm run lint` now passes.

### Changed

- **Phase 6.5 — miniPaint init wiring** (`d07d2b8`) — switched the webview
  shim from a custom init handshake to upstream's `window.FileOpen`,
  `window.FileSave`, and `window.State` globals. Less surface area, fewer
  patch sites.
- **Phase 6.7 — Print and GIF/BMP UX** (`6894f9b`) — Print toast simplified
  to a one-line "use OS print dialog from your browser" hint;
  GIF and BMP limitations documented in the README rather than failing at
  save time.
- **Phase 6.8 — Save dropdown** (`7c72e6c`) — hid GIF and BMP from
  miniPaint's Save-As format dropdown; the worker-based GIF encoder is
  blocked by webview CSP and most browsers ship no native BMP encoder.
- **Phase 6.9 — File menu** (`957e32f`) — hid Print from the File menu;
  webview-hosted Print never reaches a real OS dialog so removing it is
  cleaner than a workaround.
- **Identity rebrand (Phase 7a)** — `package.json` `displayName` from
  `Paintbox — Image Editor` to `miniPaint — Image Editor for VS Code`;
  description rewritten to lead with attribution; added `homepage`,
  `bugs`, `icon`; removed `private` flag. The npm id and repo name remain
  `paintbox`.
- **README rewrite (Phase 7a)** — new attribution-leading first paragraph;
  screenshot embedded; `Vilius Sutkus '89` corrected to `ViliusL`
  throughout.
- **`.vscodeignore`** — full rewrite: removed `THIRD_PARTY_LICENSES.md`
  (legal + intellectual-honesty bug); added `.orchestrator/**`,
  `temp/**`, `*.vsix`, `paintbox-*.vsix`, `scripts/**`,
  `vendor/minipaint/{tools,examples,...}` pruning; fixed
  `*.map` → `**/*.map`. Cuts VSIX size from ~5 MB to ~2.6 MB and file
  count from ~329 to <200.

### Fixed

- **`.gitignore`** (`c079ef9`, `99ee0fa`) — excluded `.orchestrator/` and
  `.playwright-mcp/` orchestrator scratch directories from version
  control.
- **`THIRD_PARTY_LICENSES.md`** — added a leading paragraph clarifying
  miniPaint as the substantive work; corrected attribution to `ViliusL`.

### Security

- **Dependency audit (Phase 7a)** — `npm audit` reports 7 transitive
  vulnerabilities (5 moderate, 2 high) all in the `mocha` ↔
  `serialize-javascript` and `@vscode/vsce` ↔ `@azure/identity` ↔ `uuid`
  chains. All are dev-time only (build/test/publish tooling); none ship
  in the published VSIX. Documented for follow-up; not blocking v0.1.0.

[0.1.0]: https://github.com/NateDogDotNet/paintbox/releases/tag/v0.1.0
