# Architecture: Paintbox VS Code Extension

## Problem Statement

VS Code / code-server's web extension host cannot write back to the server filesystem.
Extensions that ship only a `browser` entry point (e.g., the Photopea extension) can
render a webview, but any "Save" action writes to the browser's memory — not the file
on disk. For a code-server user on a remote machine, that's a dead end.

The fix: a Node-host extension with `main` (not `browser`). The Node host has full
access to `vscode.workspace.fs`, which routes writes through VS Code's filesystem layer
to the actual server disk.

## Core Pattern: CustomEditorProvider + Webview Bridge

VS Code's `CustomEditorProvider` API lets an extension take ownership of how certain
file types are opened. Instead of VS Code's default text editor, the extension renders
a webview. The webview can contain any HTML/JS — in this case, miniPaint.

The extension host and the webview communicate via `postMessage` / `onDidReceiveMessage`.
This is the only sanctioned channel between the two execution contexts. File bytes travel
over this channel in both directions.

## Sequence: Open → Edit → Save

```mermaid
sequenceDiagram
    participant FS as Server Filesystem
    participant Host as Extension Host (Node)
    participant API as VS Code API
    participant WV as Webview (miniPaint)

    Note over FS,WV: OPEN
    API->>Host: resolveCustomEditor(uri, webviewPanel)
    Host->>FS: workspace.fs.readFile(uri)
    FS-->>Host: raw bytes (Uint8Array)
    Host->>WV: webview.postMessage({type:'load', bytes:[...]})
    WV->>WV: miniPaint initializes, loads image from bytes

    Note over FS,WV: EDIT (entirely in webview — extension host is idle)
    WV->>WV: User applies layers, filters, edits

    Note over FS,WV: SAVE (Ctrl+S / File > Save)
    API->>Host: saveCustomDocument(document, cancellation)
    Host->>WV: webview.postMessage({type:'requestSave', format:'png'})
    WV->>WV: miniPaint File_save exports to Blob/ArrayBuffer
    WV->>Host: webview.postMessage({type:'saveResult', bytes:[...]})
    Host->>FS: workspace.fs.writeFile(uri, Uint8Array)
    FS-->>Host: write confirmed
    Host-->>API: saveCustomDocument resolves (file marked clean)
```

## Component Inventory

| Component | File | Purpose |
|-----------|------|---------|
| Extension entry | `src/extension.ts` | `activate()` — registers the provider |
| Editor provider | `src/editorProvider.ts` | Implements `CustomEditorProvider<ImageDocument>` |
| Image document | `src/editorProvider.ts` (inner class) | In-memory model; holds bytes + dirty state |
| miniPaint bundle | `vendor/minipaint/` | Upstream HTML/JS (Phase 1, not yet vendored) |
| Webview HTML | built in `resolveCustomEditor` | Wraps miniPaint, adds postMessage bridge |

## Key Design Decisions

### Why `postMessage` for the save round-trip

The webview runs in a sandboxed iframe. It cannot call Node APIs directly. `postMessage`
is the only bridge. The extension host side holds a `Promise` that resolves when the
`saveResult` message arrives; `saveCustomDocument` awaits that promise.

### Why `retainContextWhenHidden: true`

miniPaint holds all layer data in its JavaScript state. If the webview is destroyed when
the tab loses focus, all unsaved layer data is lost. `retainContextWhenHidden` keeps the
webview process alive while the tab is hidden.

### Why `priority: "option"` in contributes.customEditors

`priority: "option"` means paintbox shows up as an alternative, not the default, when
opening image files. The user explicitly selects "Open With > Paintbox Image Editor."
This avoids hijacking the default image preview for every PNG in the workspace.
Change to `"default"` if you want it to take over by default.

### Why Open VSX, not Microsoft Marketplace

code-server does not have access to the Microsoft VS Code Marketplace. Open VSX
(open-vsx.org) is the open registry that code-server ships configured to use.
Publishing to Open VSX makes the extension installable directly from the Extensions
panel in any code-server instance.

### miniPaint vendoring: submodule vs copy

Decision deferred to Phase 1. Options:
- **Git submodule** — stays in sync with upstream, cleaner for tracking version bumps.
  Downside: contributors need `git submodule update --init`.
- **Committed copy** — simpler, no submodule ceremony, but version drift is manual.

Recommendation: start with a committed copy at the pinned version (v4.14.3), since
the save-hook patch modifies miniPaint's source. A submodule with a patched branch
works but adds complexity.

### miniPaint save hook surface

The `File_save` module in miniPaint is the interception point. The webview wrapper
needs to intercept the save action before miniPaint writes to the browser's download
stream and redirect the output bytes to `postMessage`. Specific approach depends on
which miniPaint API surface is stable across versions — audit `src/actions/file/` in
the miniPaint source before implementing.
