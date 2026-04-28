# paintbox

A VS Code extension that embeds [miniPaint](https://github.com/viliusle/miniPaint) as a
custom editor — layers, filters, selections, and proper save-to-disk — inside code-server.

## Why this exists

code-server users don't have great options for image editing inside the IDE:

- **Photopea extension** — ships browser-only (`browser` entry point, no `main`). Webview
  renders but saves don't write back to the filesystem. Unusable for real work.
- **luna-paint** (`tyriar.luna-paint`) — architecturally sound, but commercial license.
- **Photopea web** (photopea.com) — works great, zero IDE integration. No save-to-disk
  round-trip from within the editor.

The fix is a Node-host extension with a real `CustomEditorProvider`. Open an image, edit
it with a full-featured layered editor, hit Save — the file on the server's filesystem
updates. That's it.

miniPaint was chosen over other candidates (tui.image-editor, Filerobot, Pinta) because:
it's MIT licensed, actively maintained (v4.14.3 shipped 2026-04-20), has ~30 tools plus
layers and filters, deploys as a single-file HTML/JS bundle, and exposes a clean hook
surface for intercepting the save action.

## Architecture in one paragraph

The extension registers a `CustomEditorProvider` for common image MIME types. When VS
Code opens an image, the provider spins up a webview pointed at the bundled miniPaint
HTML. The file bytes are posted into the webview on open. When the user saves,
miniPaint's `File_save` module fires a `postMessage` back to the extension host, which
writes the result with `vscode.workspace.fs.writeFile`. Saves land on the server's
filesystem. Details and a sequence diagram are in [`docs/architecture.md`](docs/architecture.md).

## Status

**Scaffolded — not yet functional.** The extension skeleton compiles; the editor
integration is not implemented. See [`docs/integration-plan.md`](docs/integration-plan.md)
for the phased build-out.

## Development

### Prerequisites

- Node.js 18+
- VS Code or code-server

### Local dev

```bash
git clone https://github.com/NateDogDotNet/paintbox
cd paintbox
npm install
npm run compile
# Press F5 in VS Code / code-server to launch the Extension Development Host
```

### Build a VSIX

```bash
npm run package
# Produces paintbox-<version>.vsix
```

### Publish to Open VSX

```bash
# Set OVSX_PAT environment variable first
npm run publish:ovsx
```

Open VSX is the target registry (not Microsoft Marketplace) so the extension works in
any code-server installation.

## Known limitations

These are environment-imposed quirks of running miniPaint inside a VS Code webview, not bugs in paintbox itself:

- **GIF and BMP files** open with VS Code's default image preview, not paintbox. miniPaint encodes GIFs via a Web Worker that the webview's CSP blocks, and most browsers don't ship a native BMP encoder. Rather than fail at save time, paintbox no longer claims these formats; right-click → Open With → Image Preview to view them.
- **Print** writes a temporary PNG and shows a toast with the path plus a "Reveal in Explorer" button. There's no system print dialog inside a webview running on a remote server. Open the file from your local machine (or from the VS Code file tree) and print from there.

For everything else, file an issue: https://github.com/NateDogDotNet/paintbox/issues

## miniPaint credit

This extension is powered by **miniPaint** by Vilius Sutkus '89.  
Source: https://github.com/viliusle/miniPaint  
License: MIT

miniPaint is vendored at `vendor/minipaint/` (committed copy, pinned to v4.14.3). Its
license notice is preserved in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)
and bundled inside the VSIX.

## License

MIT. See [LICENSE](LICENSE).
