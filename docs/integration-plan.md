# Integration Plan

Phased build-out from skeleton to published extension. Each phase has clear entry and
exit criteria so work sessions can start and stop cleanly.

---

## Phase 1 — Vendor miniPaint

**Goal:** Get the miniPaint source into the repo and confirm it loads in a browser.

**Tasks:**
1. Download the v4.14.3 release and copy into `vendor/minipaint/`.
   Vendoring strategy is committed copy — decision recorded in `docs/decisions.md`.
   ```bash
   cd /tmp
   curl -L https://github.com/viliusle/miniPaint/archive/refs/tags/v4.14.3.tar.gz \
     | tar xz
   cp -r miniPaint-4.14.3/* /path/to/paintbox/vendor/minipaint/
   ```
3. Confirm miniPaint opens locally: `cd vendor/minipaint && npx serve .` → open in browser.
4. Confirm `MIT-LICENSE.txt` is present in `vendor/minipaint/` (required for
   `THIRD_PARTY_LICENSES.md` completeness).
5. Remove `vendor/.gitkeep`.

**Success criteria:**
- `vendor/minipaint/index.html` exists and opens in a browser with a working editor.
- `MIT-LICENSE.txt` present.
- `THIRD_PARTY_LICENSES.md` updated with exact copyright line from that file.

---

## Phase 2 — Extension Shell: CustomEditorProvider

**Goal:** The extension activates, registers the provider, and opens a webview for
image files (placeholder HTML, no miniPaint yet).

**Tasks:**
1. `npm install` to pull `@types/vscode` and `typescript`.
2. Confirm `npm run compile` succeeds with no errors.
3. Press F5 in VS Code / code-server — Extension Development Host opens.
4. Open any `.png` file → right-click → "Open With" → "Paintbox Image Editor."
5. Webview appears with the placeholder HTML (`_getPlaceholderHtml`).

**Success criteria:**
- `npm run compile` exits 0.
- Placeholder webview opens when a `.png` is opened via "Open With."
- Extension activates without errors in the Debug Console.

---

## Phase 3 — Open File: Read Bytes → Webview

**Goal:** When an image opens, its actual pixels appear in miniPaint.

**Tasks:**
1. In `openCustomDocument`: read file bytes with `vscode.workspace.fs.readFile(uri)`.
   Store as `Uint8Array` on `ImageDocument`.
2. In `resolveCustomEditor`: replace `_getPlaceholderHtml` with actual miniPaint HTML
   loaded from `vendor/minipaint/index.html` (use `webview.asWebviewUri` for asset paths).
3. After webview loads, post the file bytes:
   ```ts
   webviewPanel.webview.postMessage({ type: 'load', bytes: Array.from(document.bytes) });
   ```
4. In miniPaint's webview wrapper (a thin JS shim injected alongside miniPaint):
   ```js
   window.addEventListener('message', e => {
     if (e.data.type === 'load') {
       // Convert bytes to Blob, call miniPaint's open-file API
     }
   });
   ```
5. Confirm: open a PNG → miniPaint renders it.

**Success criteria:**
- Opening a `.png` via "Open With > Paintbox Image Editor" shows the image in miniPaint.
- The VS Code status bar shows no errors.

**Notes:**
- `webview.asWebviewUri` is required for all local file paths — bare `file://` URIs are
  blocked by the webview sandbox.
- `enableLocalResourceRoots` must include `vendor/minipaint/` to allow asset loading.

---

## Phase 4 — Patch miniPaint Save Action

**Goal:** When the user triggers Save inside miniPaint, the bytes come back to the
extension host via `postMessage` instead of triggering a browser download.

**Tasks:**
1. Audit `vendor/minipaint/src/actions/file/` (specifically `file_save.js` or equivalent)
   to find the export/download trigger point.
2. Patch or monkey-patch that trigger to call:
   ```js
   const vscode = acquireVsCodeApi();
   vscode.postMessage({ type: 'saveResult', format: 'png', bytes: [...new Uint8Array(buffer)] });
   ```
   instead of triggering `<a download>`.
3. Decide patch strategy: direct source edit (simpler) vs runtime override via the
   injected shim (more upgrade-friendly).
4. Add a message listener on the extension host side (inside `resolveCustomEditor`) that
   resolves the pending save promise when `saveResult` arrives.

**Success criteria:**
- Pressing Ctrl+S in the webview triggers a `saveResult` message visible in the
  Debug Console.
- No browser download dialog appears.

---

## Phase 5 — Host-Side Write: Close the Round-Trip

**Goal:** Ctrl+S writes the image back to the server filesystem.

**Tasks:**
1. In `saveCustomDocument`: await the pending `saveResult` promise (set up in Phase 4).
   ```ts
   const bytes = await this._pendingSave.get(document.uri);
   await vscode.workspace.fs.writeFile(document.uri, new Uint8Array(bytes));
   ```
2. Implement `revertCustomDocument`: re-read from disk, re-post into webview.
3. Implement `backupCustomDocument` if VS Code hot-exit backup is needed.
4. Mark document clean after successful write so VS Code clears the dirty indicator.

**Success criteria:**
- Open an image → edit → Ctrl+S → check the file on disk changed (use `ls -la` or
  compare checksums before/after).
- The tab's dot (dirty indicator) clears after save.
- No "Save failed" error in the VS Code notification area.

---

## Phase 6 — Save As and Format Conversion

**Goal:** "Save As" works; user can change format (PNG → JPG, etc.).

**Tasks:**
1. Implement `saveCustomDocumentAs(document, destination, ...)`.
2. Infer target format from `destination` file extension; post format hint to webview.
3. miniPaint already supports exporting PNG/JPG/WebP/GIF/BMP/PSD — leverage its export
   API with the appropriate format parameter.
4. Handle the `.pmp` native format (miniPaint's JSON layer format) — decide whether to
   register it as a supported MIME type or leave it as manual export only.

**Success criteria:**
- File > Save As... in VS Code opens the file picker; choosing a `.jpg` destination
  saves a JPEG to that path.
- Original file is unchanged.

---

## Phase 7 — Package and Publish to Open VSX

**Goal:** Extension installable from the Open VSX registry in any code-server instance.

**Tasks:**
1. Update `package.json`: set `publisher` to actual Open VSX publisher name (replace
   `wegener` placeholder — create account at open-vsx.org first).
2. Remove `"private": true` from `package.json`.
3. Write a changelog entry in `CHANGELOG.md` for v0.1.0.
4. `npm run package` → inspect the `.vsix` contents (`unzip -l paintbox-0.1.0.vsix`)
   to confirm `THIRD_PARTY_LICENSES.md` and miniPaint assets are included.
5. Create an Open VSX PAT, set `OVSX_PAT` env var.
6. `npm run publish:ovsx`.
7. Install from Open VSX in a fresh code-server instance to confirm.

**Pre-publish checklist:**
- [ ] MIT license file present
- [ ] THIRD_PARTY_LICENSES.md present and accurate
- [ ] miniPaint MIT-LICENSE.txt bundled in vendor/
- [ ] README has screenshot or demo GIF
- [ ] No hardcoded dev paths or secrets
- [ ] `vsce ls` shows no unexpected files included

**Success criteria:**
- Extension page live on open-vsx.org.
- Installable via Extensions panel in code-server without manual VSIX upload.
