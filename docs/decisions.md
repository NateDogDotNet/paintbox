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

*(Add new entries at the bottom, newest last.)*
