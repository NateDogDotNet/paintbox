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

**2026-04-27 — Phase 4 SAVE-side: bundle text-replace + shim bridge (build-time-only patch)**

The SAVE side cannot reach miniPaint via a public extension point —
`File_save_class` calls a bundled `filesaver.saveAs(blob, fname)` whose import
is webpack-minified into `p().saveAs(...)` inside `dist/bundle.js`. The
vendored `src/js/modules/file/save.js` is NOT loaded at runtime;
`vendor/minipaint/index.html` only loads `dist/bundle.js`. Source-only patches
would be dead text.

Strategy: hybrid (D-prime in `.orchestrator/phase4-design.md` §1).
1. **Bundle text-replace (load-bearing).** `scripts/patch-bundle.js` (chained
   from `npm run compile`) reads `vendor/minipaint/dist/bundle.js`, rewrites
   the 8 `p().saveAs(` call sites to
   `((typeof window!=="undefined"&&window.__pbBridge)||p()).saveAs(`, and
   writes `out/webview/minipaint-bundle.patched.js`. Integrity check throws
   if the call-site count is not exactly 8 — upstream bumps fail loud at
   build time. `vendor/minipaint/dist/bundle.js` itself stays byte-identical
   to upstream v4.14.3 (verifiable via sha256sum).
2. **Source paperwork patch.** `vendor/minipaint/src/js/modules/file/save.js`
   has its `filesaver` import wrapped with a `__pbBridge`-aware shim,
   bracketed by `// PAINTBOX-PATCH-BEGIN` / `// PAINTBOX-PATCH-END` markers.
   NOT load-bearing at runtime, but a future `npm run build` from upstream
   would produce a paintbox-friendly bundle.
3. **Shim bridge.** `src/webview/shim.ts` installs
   `window.__pbBridge.saveAs(blob, fname)` inside its IIFE. The bridge
   marshals to `Array.from(new Uint8Array(buf))` and posts
   `{type:'saveResult', bytes, format, filename, mime}` via the
   closure-captured `vscode` handle from `acquireVsCodeApi()` (single call
   site preserved per Phase 3 carry-over). The shim `<script>` is injected
   in the webview HTML immediately BEFORE the patched-bundle `<script>` so
   `__pbBridge` exists before any keyboard binding fires.

**Override decision (orchestrator-approved): build-time patch only.**
`activate()` calls `verifyPatchedBundle(extensionPath)` BEFORE registering
the editor provider; if the artifact is missing/corrupt, activation throws.
No filesystem writes in the activation hot path. The VSIX ships pre-patched
because `vsce package` runs through the existing toolchain that depends on
`npm run compile`.

**Override decision (orchestrator-approved):** `patchMinipaintBundle.ts`
lives in `src/` (host build, `tsconfig.json`), NOT `src/webview/` (browser
build with `lib: [ES2020, DOM]`, `types: []`). The helper uses Node
`fs`/`path`.

Bytes encoding: `number[]` (`Array.from(uint8)`) — JSON-serialization-safe
across the host boundary. Phase 7 may revisit if 50MB+ saves become routine.

The bundle source-map is copied alongside but offsets shift by the
PAINTBOX-BUNDLE-PATCH header (~60 bytes) plus per-call-site insertions; this
makes source-map lookups slightly off past the first call site. Acceptable
for now; Phase 7 may revisit if stack traces become noisy.

---

**2026-04-27 — Phase 5 host-side write: requestId-correlated round-trip via SaveCorrelator**

Phase 5 closes the save loop: VS Code → `saveCustomDocument` → host posts
`{type:'requestSave', requestId, format, filename}` → shim calls
`app.File_save.save_action(user_response, false)` directly (bypassing
miniPaint's modal export popup) → patched bundle's
`__pbBridge.saveAs(blob, fname)` intercepts → bridge attaches `requestId`
(stashed pre-call on `window.__pbPendingRequestId`) and posts `saveResult`
→ host's correlator matches by `requestId`, validates MIME against the
document's expected MIME (Gate 2), writes bytes via
`vscode.workspace.fs.writeFile`, clears the dirty gate, posts
`{type:'saved'}` to reset the shim's epoch.

Key sub-decisions (all 10 design defaults, user-approved):
1. Dirty tracking via runtime monkey-patch of `app.State.do_action` in the
   shim. Once-per-save gate (`pbDirtyDispatched`); reset on host's `saved`
   message. Defensive fallback to first-pointerdown if `app.State` is
   absent at shim init.
2. `saveCustomDocumentAs`: same-format only in Phase 5; cross-format
   throws `"Paintbox: Save As across formats is implemented in Phase 6"`.
3. Backup: fresh export to `context.destination` via the same
   `_writeViaWebview` pipeline. `openCustomDocument` honors
   `openContext.backupId` by stashing it on `document.backupUri`; the
   shared post-load helper reads from that URI when present.
4. User-initiated saves (File menu inside webview) without a `requestId`:
   logged and ignored. Never write to disk on an unsolicited bridge emit
   — silently overwriting a workspace file in response to a button click
   the user thought meant "download" is a trust violation.
5. 30s timeout per save, hard-coded in `SaveCorrelator.register`.
6. `crypto.randomUUID()` for `requestId` — Node stdlib, no collisions.
7. `.vscodeignore` Phase 4 reviewer bugs deferred to Phase 7 — not
   touched.
8. VS Code undo/redo callbacks on `_onDidChangeCustomDocument`: no-op
   stubs with `console.debug`. miniPaint's in-canvas Ctrl-Z continues to
   work (webview keyboard ownership). Phase 6+ may bridge if the niche
   case (Edit > Undo from menubar with webview unfocused) becomes a
   complaint.
9. Test seams: static `__pbTestGetActive()` accessor on the provider;
   instance-level `__pbTestIsDirty(uri)`. Tests reach the correlator via
   the provider; correlator exposes `__pbTestGetMeta(requestId)` for the
   provider's onMessage handler to peek meta before `handleSaveResult`
   consumes the entry (used for Gate 2 MIME check). Reviewer flagged the
   accessor name lies about its production use — Phase 6 to rename.
10. `pixel-2x2.png` fixture committed as a real 76-byte binary PNG with
    distinct row0=[red,green] / row1=[blue,white] pixels; full byte
    string documented in `src/test/suite/save.test.ts` for auditability.

Correlation logic extracted to `src/saveCorrelator.ts` so Test 5a is a
pure unit test (no `vscode` import). Provider composes a
`SaveCorrelator<PendingMeta>` instance; `cancelByPredicate(meta-pred,
error)` is used to reject in-flight saves on webview disposal and on
revert. Test 5b proves the round-trip with a SHA-256 disk-vs-webview-bytes
assertion on a real `os.tmpdir()` file.

Phase 4's saveResult log line was removed when Phase 5 took over the case
branch; the structural `case 'saveResult'` / `case 'saveError'` regex
checks in test 4b still hold. Bundle
`vendor/minipaint/dist/bundle.js` SHA-256 unchanged (`d084e26…83356`).
Phase 5 changes are host + shim only.

---

*(Add new entries at the bottom, newest last.)*
