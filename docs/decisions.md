# Decisions Log

Lightweight running record of decisions made for this project. Personal tool — no ADRs,
just a chronological list with rationale.

---

**2026-04-27 — Chose miniPaint as the editor engine**

Candidates evaluated:
- **miniPaint** (viliusle/miniPaint) — MIT, actively maintained (v4.14.3 pushed 2026-04-20,
  3.3K stars), full photo-editor scope (layers, ~30 tools, filters, selections), single-file
  HTML/JS deployable, clean save hook surface. SELECTED.
- **Photopea** — no open-source version; photopea.com is proprietary. The VS Code extension
  ships browser-only (`browser` entry, no `main`) — save doesn't reach the filesystem.
  REJECTED: licensing + architectural mismatch.
- **tui.image-editor** — MIT, but unmaintained (last commit 2022), no layers. REJECTED.
- **Filerobot Image Editor** — MIT, maintained, but React-centric UI — heavier integration
  surface than miniPaint's standalone HTML. REJECTED (prefer simpler integration).
- **luna-paint** (tyriar.luna-paint) — architecturally exactly right (CustomEditorProvider,
  Node host, proper save round-trip). Commercial license. REJECTED.

---

**2026-04-27 — Chose `paintbox` as the extension/package name**

Short, npm-publishable, evokes the concept without naming the upstream library.
`vscode-minipaint` was too close to the upstream project name. `canvas-code` was too
generic. `paintbox` is distinct, memorable, available on npm as of 2026-04-27.

---

**2026-04-27 — Custom editor priority: `option`**

Confirmed: `priority: "option"` in `contributes.customEditors`. paintbox appears in
"Open With" but does not hijack VS Code's default image preview. Users opt in per-file.
Change to `"default"` if you want paintbox to take over automatically.

---

**2026-04-27 — miniPaint vendoring: committed copy at v4.14.3**

Committed copy in `vendor/minipaint/` at the pinned version, not a git submodule.
Reasoning: the save-hook patch modifies miniPaint's `File_save` source — patching
a submodule requires either a separate fork repo or a detached-HEAD commit, neither of
which is visible to anyone reading this repo. A committed copy keeps the patch inline
and obvious. miniPaint is single-file deployable with no build step to maintain.
Pinned-version reproducibility is trivial: the version is whatever Nathan copied in.
Upstream updates become a deliberate `cp -r` + `git diff` review, which is the right
workflow when local patches sit on top. MIT compliance is identical either way;
`THIRD_PARTY_LICENSES.md` handles attribution regardless.

---

**2026-04-27 — Target Open VSX, not Microsoft Marketplace**

code-server uses Open VSX by default. Microsoft Marketplace is restricted to official
VS Code builds. Publishing to Open VSX makes the extension installable directly from
the Extensions panel in code-server without manual VSIX sideloading.

---

**2026-04-27 — miniPaint upstream copyright is `Copyright (c) ViliusL`**

The earlier placeholder in `THIRD_PARTY_LICENSES.md` named `Vilius Sutkus '89`, an
unrelated developer. miniPaint's actual upstream author is `ViliusL`
(https://github.com/viliusle). The vendored `MIT-LICENSE.txt` (v4.14.3) was used
verbatim; the embedded license block in `THIRD_PARTY_LICENSES.md` now matches it
byte-for-byte (no inserted "The MIT License (MIT)" header — upstream omits it,
so we omit it). On future upstream bumps, diff `vendor/minipaint/MIT-LICENSE.txt`
and re-sync the embedded copy if upstream changes.

---

**2026-04-27 — Test harness: @vscode/test-electron + Mocha (TDD UI)**

Wired up `@vscode/test-electron` (^2.4.0) with `mocha` (^10.4.0) and
`@types/mocha` (^10.0.6) for the first automated test, alongside the Phase 2
extension shell. Three files under `src/test/`: `runTest.ts` (driver),
`suite/index.ts` (Mocha runner), `suite/extension.test.ts` (Phase 2 smoke
test). The smoke test asserts: extension activates, `vscode.openWith` resolves
the `paintbox.imageEditor` view type without throwing, and `_getPlaceholderHtml`
returns the expected marker + file URI. Headless containers need a display —
run `Xvfb :99 -screen 0 1024x768x24 -nolisten tcp & DISPLAY=:99 npm test` if
no display is available; `xvfb-run` requires `xauth` which is not installed in
all environments. `.vscodeignore` excludes `**/*.test.ts` and `out/test/**` so
tests do not ship in the VSIX.

---

**2026-04-27 — Phase 3 OPEN-side: read upstream `index.html`, inject via host transforms (no upstream patch)**

The OPEN side of the round-trip does NOT patch `vendor/minipaint/`. miniPaint's
`File_open_class.file_open_data_url_handler(dataUrl)` is a public method (line
213 of `vendor/minipaint/src/js/modules/file/open.js`), so the shim can call
it directly via `window.app.File_open` after detecting initialization. The
host's `buildWebviewHtml` reads upstream `index.html` synchronously via
`fs.readFileSync`, applies three transforms (inject `<base href>` + CSP
`<meta>` after `<head>`; set `data-state="loading"` on `<body>`; inject chrome
`<style>`/markup + shim `<script>` before `</body>`), and returns the string.
This contrasts with the SAVE side (Phase 4), which has no public extension
point and DOES require patching `vendor/minipaint/src/js/modules/file/save.js`.

Asset URI rewriting uses a single `<base href="<asWebviewUri-of-vendor/minipaint/>/">`
because miniPaint's bundled `style-loader` injects `<style>` tags at runtime
with relative `url('images/icons/*.svg')` — invisible to per-attribute
rewriting at host build time. CSP is pragmatic v1: `default-src 'none'`,
`style-src 'unsafe-inline'` (required by style-loader), `script-src
${webview.cspSource}` only (no `unsafe-eval` per bundle audit). Tighten in
Phase 7 if upstream adds inline scripts.

Wire protocol for the Phase 3 host↔webview round-trip:
host→webview `{type:'load', dataUrl, filename, mime}`; webview→host
`{type:'webviewReady'}`, `{type:'ready'}`, `{type:'loadError', error}`,
`{type:'retry'}`. Data-URL chosen over byte-array because miniPaint's
`file_open_data_url_handler` consumes it natively (single conversion) and
serializes ~6× smaller than a JSON-encoded number array.

Full design rationale and the chrome HTML/CSS/JS spec live at
`.orchestrator/phase3-design.md` (orchestrator artifact, gitignored).

---

**2026-04-27 — Phase 3 webview shim is TypeScript with a second tsconfig**

`src/webview/shim.ts` compiles via a separate `tsconfig.webview.json`
(`module: "none"`, `target: "ES2020"`, `lib: ["ES2020","DOM"]`, `types: []`).
The host build (`tsconfig.json`) excludes `src/webview/**` so it never
accidentally re-emits the shim under CommonJS — a CommonJS preamble
(`Object.defineProperty(exports, "__esModule", …)`) crashes in a browser
context where `exports` is undefined. Single `npm run compile` step is
preserved by chaining: `tsc -p ./ && tsc -p tsconfig.webview.json`.
`tsconfig.webview.json` is added to `.vscodeignore` so it does not ship in
the VSIX. The shim is wrapped in an IIFE and uses no `import`/`export`
statements — interaction with the VS Code webview API and miniPaint goes
through `acquireVsCodeApi()` (declared via `declare function`) and
`(window as unknown as {…}).app` access.

---

*(Add new entries at the bottom, newest last.)*
