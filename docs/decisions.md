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

**2026-04-27 — Phase 6 Save As + format conversion: lift same-format guard, modal lossy warning, GIF/JSON cross-format throws**

Phase 6 enables cross-format Save As atop Phase 5's host-initiated
`requestSave` round-trip. `_writeViaWebview` already derives format from
`destination.fsPath` (Phase 5 §8 set this up specifically for cross-format
Save As), so the implementation is one method body's worth of UX gating
around the existing pipeline.

Sub-decisions (8 design defaults + 1 orchestrator override):

1. **Lossy-conversion warning UX** — modal `vscode.window.showWarningMessage`
   with single "Save Anyway" button (VS Code adds an automatic "Cancel").
   Fires only on cross-format `saveCustomDocumentAs`; same-format and
   `saveCustomDocument` skip it. Cancel/dismiss → strict-equality returns
   false → throws `'Paintbox: Save As cancelled.'`. Helper:
   `_confirmLossyConversion(sourceExt, destExt): Promise<boolean>`.

2. **JSON layered format** — skip in v1 entirely. Existing Gate 1 in
   `_writeViaWebview` already throws on `.json`. No `FORMAT_BY_EXT` entry,
   no new `package.json` selector. Asymmetric save-only would let users
   write files they couldn't reopen; rejected. Re-evaluate Phase 7+.

3. **GIF cross-format** — throws with "Save As to GIF across formats is not
   supported in v1." Same-format `.gif` → `.gif` (Ctrl-S round-trip) still
   works through `saveCustomDocument`. Justification: miniPaint's GIF branch
   (`save.js:619-624`) unconditionally iterates `config.layers` to build
   animation frames AND `gif.worker.js` is loaded via a relative
   `workerScript` path that's CSP-hostile under the webview sandbox. Two
   strikes, both upstream-coupled.

4. **Quality picker** — keep hardcoded `quality: 90` in `shim.ts`. Picker
   UI deferred to Phase 7. Phase 6 acceptance criterion does not require
   quality control; YAGNI.

5. **`.vscodeignore` Phase 4/5 reviewer bugs** — deferred to Phase 7
   packaging cleanup. Phase 6 added zero packaged files.

6. **Test 6f optional defensive test** — dropped. Warning logic is scoped
   to `saveCustomDocumentAs`; a regression that moved it elsewhere would
   also break other tests.

7. **`__pbTestGetMeta` rename to `peekMeta`** — deferred to Phase 7. Phase
   6 didn't touch `SaveCorrelator`.

8. **Reviewer-flagged race risk (parallel test runs)** — `installWarnStub`
   monkey-patches `vscode.window.showWarningMessage`; multiple Phase 6
   tests use it. Current Mocha runner is sequential; switch to per-stub
   Sinon if `--parallel` is added later.

**Orchestrator override (user-approved):** GIF cross-format throws BEFORE
the lossy-conversion warning, not after. The design's §1 diff sketch put
GIF after the warning; that means PNG → GIF would prompt the user with a
lossy warning, the user would click "Save Anyway", and THEN get "GIF not
supported" — bad UX. Concrete sequence in `saveCustomDocumentAs`: (1) compute
`sourceExt`/`destExt`/`sameFormat`; (2) GIF check throws fast; (3) lossy
warning on remaining cross-format paths; (4) `_writeViaWebview`. Test 6e
asserts `showWarningMessage` was NOT called when the GIF guard fires —
proving the override.

Test counts: Phase 5 had 23 passing; deleted Test 5f (Phase 6 deferral
assertion no longer accurate); added Tests 6a (mandatory cross-format JPEG
round-trip with source-PNG SHA-256 stability), 6b (Cancel aborts), 6c
(same-format skips warning), 6d (JSON Gate 1 unsupported-extension), 6e
(GIF throws before warning). Final: 27 passing.

Bundle `vendor/minipaint/dist/bundle.js` SHA-256 unchanged
(`d084e26…83356`). Phase 6 changes are host + tests only.

---

**2026-04-28 — Phase 6.5 init path: use upstream `window.FileOpen` / `window.FileSave` / `window.State` globals**

Burn-in of v0.0.2 surfaced that the shim's `waitForMiniPaint` poll never
resolved: it was reading `window.app.File_open.file_open_data_url_handler`,
but miniPaint v4.14.3's compiled bundle never sets `window.app` (the upstream
`app` singleton is module-private and webpack minifies it to `v.A`). What
the bundle DOES expose, deliberately, is three module classes on window:
`window.FileOpen`, `window.FileSave`, `window.State`. The fix replaces the
`getApp()` accessor + `MiniPaintApp` interface with three smaller accessors
(`getFileOpen` / `getFileSave` / `getState`) and three smaller interfaces;
all live-code references to `app.X` are gone. Rejected alternative:
text-replacing `dist/bundle.js` to inject `window.app=v.A;` near the
existing assignments. Rejected because it adds a second fragile patch
surface, and the minified `v.A` token is not stable across upstream bumps —
purely positional, no semantic anchor. Upstream already exposes the
window globals as a public API; we use the entry point that's already
there. Test 3c was masking the failure (4s wait then assert "no error
toast" — the shim's 10s timeout fired AFTER the test had already
resolved); Phase 6.5 tightens it to a Promise.race over three signals
(`__pbTestOnReady` callback fires success, mocked `showErrorMessage`
fires failure, 12s timeout fires "did not signal ready") backed by a new
`PaintboxEditorProvider.__pbTestOnReady` test seam. New regression Test 3d
loads the compiled shim into a `vm` sandbox without `window.FileOpen` /
`FileSave` / `State` and asserts that `loadError` posts with the
diagnostic dump (hasFileOpen/hasFileSave/hasState/hasFileOpenHandler) AND
that no `webviewReady` posts — so if upstream stops exposing these
globals on a future bump, the test fails fast at CI time rather than at
burn-in. v0.0.2 diagnostic instrumentation (boot-error capture + verbose
timeout dump) preserved; the dump's surface fields swapped from `appKeys`
to the four `has*` flags. Bundle SHA-256 unchanged
(`d084e26…83356`); `patchMinipaintBundle.ts` patch surface stays at 8
sites. Test count 27 → 28. Bumped to v0.0.3.

Two minor adjacent changes folded into the same commit, disclosed
explicitly per Phase 6.5 reviewer ask: (1) `editorProvider.ts`'s
`case 'loadError':` body was rewrapped — the user-facing toast now uses
`path.basename(document.uri.fsPath)` instead of the full URI string
(toasts truncate long URIs unreadably), and an Extension Host
`console.error('[paintbox] loadError:', …)` log was added so the full
diagnostic JSON survives toast truncation. (2) `.gitignore` gained a
`temp/` entry to exclude a workspace-local burn-in scratch directory
(non-build output; never shipped in VSIX since `.vscodeignore` is
allow-list-style for `out/` + `vendor/`).

---

**2026-04-28 — Phase 6.6 restore four broken miniPaint features: Search Images, Export, in-app Save As, Print**

Burn-in of v0.0.3 confirmed Phase 6.5's init fix works end-to-end (real PNG
round-trip lands on disk), but four upstream miniPaint features remained
broken under the webview sandbox: Search Images (Pixabay API blocked by
CSP), File → Export (bytes posted with no requestId got logged-and-dropped
by the host), File → Save As inside the webview (same code path as Export),
and File → Print (literally `window.print()`, which VS Code webviews
silently block).

Sub-decisions:

1. **Search Images — CSP relax, no bundle patch (D1).** Added
   `https://pixabay.com https://*.pixabay.com` to BOTH `connect-src` (for
   the `$.getJSON` call to `pixabay.com/api/`) and `img-src` (for thumbnails
   and the eventual chosen image, which load from `*.pixabay.com` CDN
   subdomains and the root domain `/get/` paths). `script-src` deliberately
   unchanged — Pixabay never serves code into the webview, so no relaxation
   there. `default-src 'none'` stays in place; the additions are explicit
   per directive. The Pixabay API key embedded at `vendor/minipaint/src/js/config.js:16`
   is already public upstream — no new credential exposure.

   Rejected alternative: route Pixabay through the host (extension fetches,
   returns to webview). Adds complexity, no real security benefit, and
   would require re-implementing pagination + error handling. Simple CSP
   relaxation is the right scope.

2. **Export + in-app Save As — handle unsolicited saveResult (D2).** Phase
   5 originally chose to log-and-ignore saveResults with no matching
   requestId — overwriting a workspace file in response to a button click
   the user thought meant "download" was a trust violation. Phase 6.6
   replaces "log and drop" with `vscode.window.showSaveDialog`: the user
   explicitly picks a destination path before any byte hits disk. The
   dialog's `defaultUri` is the open document's parent directory + the
   filename miniPaint suggested (`vscode.Uri.joinPath(documentUri, '..',
   filename)`); user can override the extension via the dialog's "All
   files" filter (appended last). Cancel → silent no-op (no toast); success
   → `Paintbox: saved <basename>` info toast; writeFile error → error
   toast. No new map needed — the message handler closure already captures
   `document.uri`, which is the right parent for unsolicited saves on this
   panel (multi-editor case is naturally handled).

   Filter mapping is a const lookup keyed by either the `format` string
   miniPaint emits ('PNG', 'JPG', etc.) OR the `mime` string ('image/png',
   etc.), so the host accepts whichever the bridge attaches. JSON
   ('miniPaint layered') and TIFF/AVIF are accepted on this path even
   though they're not in `package.json`'s `customEditors` selector — the
   user opted into the export, so we honor it.

3. **Print — sentinel requestId rerouting through the existing bridge
   (D4).** miniPaint's `print.js` is literally `window.print()`. VS Code
   webviews silently block this. Two-part fix:

   - **Shim:** monkey-patch `window.print` inside the IIFE, AFTER
     `window.__pbBridge` is installed and BEFORE the bundle runs. The
     patched function stashes `__pbPendingRequestId='__print__'` then
     calls `window.FileSave.save_action({name:'print.png', type:'PNG',
     quality:90, layers:'All', delay:400, calc_size:false}, /*autoname*/
     true)`. The bridge attaches the sentinel to the resulting saveResult
     via the existing path; no new message types.

   - **Host:** `case 'saveResult':` checks for `requestId === '__print__'`
     after the correlator-match path and before the unsolicited path. Hit
     writes bytes to `path.join(os.tmpdir(), 'paintbox-print-' +
     crypto.randomUUID() + '.png')`, then calls
     `vscode.env.openExternal(vscode.Uri.file(tmpPath))`. Toast on
     success: `Paintbox: opened in your default image viewer for
     printing`. On openExternal rejection (no GUI session, no handler —
     plausible in code-server): fallback toast `Paintbox: print artifact
     saved at ${tmpPath}` so the user can fetch the file manually.

   Rejected alternative: render canvas inline and call
   `iframe.contentWindow.print()`. Tested in earlier ad-hoc; webviews
   still block. A custom in-webview print preview is large scope.

4. **Test additions (28 → 33 passing).** Five tests:
   - **6.6a (extension.test.ts unit):** assert `buildWebviewHtml` CSP
     contains pixabay in `img-src` and `connect-src` AND NOT in
     `script-src`; regression guard against tightening.
   - **6.6b (save.test.ts integration):** stub `showSaveDialog` to return
     a tmp Uri; synthesize saveResult with no requestId; assert file
     written, SHA-256 matches webview bytes, info toast asserted.
   - **6.6c (save.test.ts integration):** stub `showSaveDialog` to return
     `undefined`; synthesize saveResult; assert no file written, no toast
     of any kind.
   - **6.6d (save.test.ts integration):** stub `vscode.env.openExternal`;
     synthesize saveResult with `requestId:'__print__'`; assert tmp PNG
     written under `os.tmpdir()` matching `paintbox-print-*.png`,
     openExternal called with that Uri, info toast asserted.
   - **6.6e (extension.test.ts vm-sandbox unit):** load compiled shim;
     stub `window.FileSave.save_action`; call patched `window.print()`;
     assert `__pbPendingRequestId === '__print__'` and save_action was
     called with the expected payload + `autoname=true`.

   Test 4b was minimally updated to stub `vscode.window.showSaveDialog`
   to return `undefined`, since its synthetic saveResult-with-no-requestId
   now routes to the unsolicited handler instead of the dropped
   log-and-ignore path. The test's intent ("messageHandler doesn't throw
   on saveResult/saveError") is preserved. No structural regex check
   changes were required.

Bundle `vendor/minipaint/dist/bundle.js` SHA-256 unchanged
(`d084e26…83356`); `patchMinipaintBundle.ts` patch surface stays at 8
sites. Phase 6.6 is host + shim + tests + CSP only — zero bundle bytes
changed. Bumped to v0.0.4.

---

**2026-04-28 — Phase 6.7 simplify Print toast; document GIF + BMP as upstream limits**

Burn-in of v0.0.4 surfaced three remaining defects in the Phase 6.6 feature
restoration:

1. **Export GIF** silently does nothing — miniPaint's `gif.worker.js` is
   CSP-hostile under the webview sandbox (existing carry-over to Phase 7+).
2. **Export BMP** errors with "Browser does not support…" — Chrome and most
   browsers don't natively support `canvas.toBlob('image/bmp')`. miniPaint
   defers to the browser, so there's no in-browser workaround.
3. **Print** showed a success toast ("opened in your default image viewer for
   printing") but no viewer ever opened. Root cause: `vscode.env.openExternal`
   resolves `true` to mean "I tried to dispatch the URI"; in code-server
   (server-side extension host with no graphical session), that dispatch goes
   nowhere. The toast was lying to the user.

**Option A (KISS) chosen over deeper Print fix.** Considered routing print
through a VS Code command that opens the tmp PNG in a real preview pane, or
spawning a host-side print spooler — both are scope creep for a v1 image
editor. The simpler fix: the saved-path toast was already the fallback when
`openExternal` rejected; we promote it to the only branch and add a "Reveal
in Explorer" action button so the user can jump to the artifact in the file
tree. `revealFileInOS` is the right command — it works in code-server (opens
the VS Code file-explorer pane to the file) and also in local VS Code (opens
the OS file manager). No more lying success toast; the toast text alone is
self-sufficient if `revealFileInOS` doesn't behave as expected on a given
host.

`_handlePrintSaveResult` collapsed from two branches (success/fallback) to
one: writeFile to tmp → `showInformationMessage(<path>, 'Reveal in
Explorer')` → if user clicks, `executeCommand('revealFileInOS', tmpUri)`.
`vscode.env.openExternal` is gone from the print path entirely.

**GIF + BMP documented as upstream limits, not paintbox bugs.** A new
"Known limitations" section in `README.md` enumerates all three (GIF, BMP,
Print) with workarounds. Framed as environment-imposed quirks of running
miniPaint inside a webview, with an explicit pointer to the issue tracker
for everything else. No code changes for GIF/BMP — these stay as-is until
Phase 7+ revisits CSP policy or upstream miniPaint adds a native BMP
encoder.

**Test 6.6d rewritten in place** (test count stays at 33). The old
assertion shape was "openExternal called once + toast text matches /default
image viewer for printing/"; the new shape is "showInformationMessage called
with text matching /print artifact saved at/ AND with 'Reveal in Explorer'
as a button-label arg AND simulating the user clicking that button invokes
`vscode.commands.executeCommand('revealFileInOS', tmpUri)`". Test name
updated to "6.6d — __print__ requestId writes tmp PNG and surfaces
actionable toast" to match the new behavior. The simulated-button-click +
`executeCommand` assertion is the nice-to-have suggested in the brief —
included because it adds coverage of the action handler at no test-harness
complexity cost (just a third stub on `vscode.commands.executeCommand`).

Bundle `vendor/minipaint/dist/bundle.js` SHA-256 unchanged
(`d084e26…83356`); `patchMinipaintBundle.ts` patch surface stays at 8
sites; `src/webview/shim.ts` unchanged; `src/webviewHtml.ts` CSP unchanged.
Phase 6.7 is host + tests + docs only — zero bundle bytes, zero shim bytes,
zero CSP bytes changed. Bumped to v0.0.5.

---

**2026-04-28 — Phase 6.8 hide GIF + BMP from SAVE_TYPES dropdown; drop selectors**

Burn-in of v0.0.5 confirmed Phase 6.7's print fix and TIFF round-trip work.
Two formats remained broken: Export GIF (silent fail — gif.worker.js is
CSP-hostile under the webview sandbox) and Export BMP (browser doesn't
support `canvas.toBlob('image/bmp')`). User chose **Option A — hide vs.
real-fix**: rather than relax CSP for a worker URL or vendor a JS-side BMP
encoder, paintbox stops claiming these formats entirely.

Three coordinated changes:

1. **Bundle text-replace patch (phase 2 of `patchMinipaintBundle`).** A
   second precise-substring patch removes `GIF:"Graphics Interchange
   Format",BMP:"Windows Bitmap",` from miniPaint's `SAVE_TYPES` dict so the
   GIF + BMP entries no longer appear in the Save / Export dropdown. Same
   fail-loud convention as the Phase 4 `p().saveAs(` patch: assert exactly
   1 occurrence before patching, throw on 0 or >1. Header bumped to v2
   (`PAINTBOX-BUNDLE-PATCH v2: p\(\)\.saveAs\( replaced 8x; SAVE_TYPES
   GIF+BMP entries removed`). `verifyPatchedBundle` now asserts 0 occurrences
   of either entry AND that the adjacent `TIFF:"Tag Image File Format"`
   entry survives — regression guard against an overshot substring patch.

   Why text-replace and not a source patch: same reasoning as Phase 4 —
   `vendor/minipaint/src/js/modules/file/save.js` is not loaded at runtime
   (`index.html` only loads `dist/bundle.js`). A source-only patch would be
   dead text. Bundle stays byte-identical to upstream
   (`d084e26…83356`); the patched bundle in `out/webview/` is the only
   mutated artifact.

2. **Drop `*.gif` + `*.bmp` from `package.json` customEditor selectors.**
   Cleaner story than "you can edit a `.gif` but only with PNG export."
   Users opening a GIF or BMP get VS Code's default image preview — same
   experience they had before paintbox was installed. Symmetric updates:
   `MIME_BY_EXT` and `FORMAT_BY_EXT` (editorProvider.ts) drop the entries;
   `SAVE_DIALOG_FILTERS` drops them too; the shim's `MIME_BY_EXT` drops
   them. Gate 1 in `_writeViaWebview` now rejects `.gif`/`.bmp` destinations
   with the friendly "extension not supported" error — that's the §3
   mitigation for any user who has a stale `.gif`/`.bmp` paintbox tab open
   from before the upgrade and hits Ctrl-S.

3. **§3 investigation finding.** miniPaint's `save_action`
   (`vendor/minipaint/src/js/modules/file/save.js:484-488`) DOES iterate
   `this.SAVE_TYPES` to detect type from filename — but only as a fallback
   when `user_response.type` is unset, and our shim always sets it
   explicitly. So removing GIF/BMP from SAVE_TYPES doesn't break
   `save_action`'s explicit-`type` path. In-place save of a `.gif`/`.bmp`
   file would still hit the broken GIF / BMP encoder branch IF it reached
   `save_action`, but the host's Gate 1 (FORMAT_BY_EXT lookup) rejects
   first, before the request ever leaves the host. No separate Gate 2 MIME
   check required.

**Test additions / updates (33 → 34).** Test 4c updated to assert the v2
header, the GIF + BMP entries gone, and the TIFF regression guard. New Test
6.8a reads `package.json` from disk and walks
`contributes.customEditors[0].selector` to assert `*.gif`/`*.bmp` are
absent and the four supported patterns (`*.png`/`*.jpg`/`*.jpeg`/`*.webp`)
remain. Test 6e (existing GIF cross-format Save As guard) still passes
unchanged: the cross-format guard in `saveCustomDocumentAs` fires before
Gate 1, so the original error message (`Save As to GIF across formats is
not supported`) survives.

README "Known limitations" replaced the two GIF + BMP bullets with a single
paragraph explaining VS Code's default image preview now handles those
formats. Print bullet unchanged.

Bundle `vendor/minipaint/dist/bundle.js` SHA-256 unchanged
(`d084e26…83356`); the second patch surface is in `out/webview/` only.
`patchMinipaintBundle.ts` patch surface count: 8 saveAs sites + 1
SAVE_TYPES site. Bumped to v0.0.6.

---

*(Add new entries at the bottom, newest last.)*
