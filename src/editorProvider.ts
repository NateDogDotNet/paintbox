import * as vscode from 'vscode';

/**
 * ImageDocument — the in-memory model for an open image file.
 *
 * TODO (Phase 3): Hold the raw file bytes so they can be posted into the
 * webview on open, and track dirty state so VS Code knows when to offer Save.
 */
class ImageDocument implements vscode.CustomDocument {
    readonly uri: vscode.Uri;

    constructor(uri: vscode.Uri) {
        this.uri = uri;
    }

    dispose(): void {
        // TODO (Phase 5): If we buffer a modified copy in memory, free it here.
    }
}

/**
 * PaintboxEditorProvider — CustomEditorProvider that embeds miniPaint in a
 * webview and bridges the open/edit/save round-trip to the server filesystem.
 *
 * Architecture (see docs/architecture.md for Mermaid sequence diagram):
 *   1. openCustomDocument   — read raw bytes from disk into ImageDocument
 *   2. resolveCustomEditor  — create webview, load miniPaint HTML, post bytes
 *   3. (user edits in miniPaint)
 *   4. saveCustomDocument   — receive postMessage from webview, writeFile to disk
 *
 * Phase map:
 *   Phase 2 — stub registration (current)
 *   Phase 3 — openCustomDocument: vscode.workspace.fs.readFile
 *           — resolveCustomEditor: webview HTML, postMessage with bytes
 *   Phase 4 — patch miniPaint File_save to postMessage result back to host
 *   Phase 5 — saveCustomDocument / saveCustomDocumentAs: vscode.workspace.fs.writeFile
 *   Phase 6 — format conversion (export PNG/JPG/WebP from miniPaint native .json)
 */
export class PaintboxEditorProvider
    implements vscode.CustomEditorProvider<ImageDocument>
{
    private static readonly VIEW_TYPE = 'paintbox.imageEditor';

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            PaintboxEditorProvider.VIEW_TYPE,
            new PaintboxEditorProvider(context),
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    // Emitter/event required by the CustomEditorProvider contract.
    private readonly _onDidChangeCustomDocument =
        new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ImageDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    // -------------------------------------------------------------------------
    // CustomEditorProvider interface
    // -------------------------------------------------------------------------

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<ImageDocument> {
        // TODO (Phase 3): Read file bytes here:
        //   const bytes = await vscode.workspace.fs.readFile(uri);
        //   Return an ImageDocument that holds those bytes.
        return new ImageDocument(uri);
    }

    async resolveCustomEditor(
        document: ImageDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        // TODO (Phase 2–3): Set webviewPanel.webview.html to the miniPaint
        // HTML loaded from vendor/minipaint/. Use webview.asWebviewUri() to
        // convert local paths to webview-safe URIs.
        //
        // TODO (Phase 3): After HTML is loaded, post the file bytes:
        //   webviewPanel.webview.postMessage({ type: 'load', bytes: [...document.bytes] });
        //
        // TODO (Phase 4–5): Listen for save messages from the webview:
        //   webviewPanel.webview.onDidReceiveMessage(msg => {
        //     if (msg.type === 'save') { ... writeFile ... }
        //   });

        webviewPanel.webview.html = this._getPlaceholderHtml(document.uri);
    }

    async saveCustomDocument(
        _document: ImageDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        // TODO (Phase 5): Receive the latest bytes from the webview (via a
        // pending Promise set up in resolveCustomEditor) and write them:
        //   await vscode.workspace.fs.writeFile(document.uri, bytes);
        throw new Error('Save not yet implemented — see docs/integration-plan.md Phase 5');
    }

    async saveCustomDocumentAs(
        _document: ImageDocument,
        _destination: vscode.Uri,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        // TODO (Phase 6): Same as saveCustomDocument but write to _destination.
        throw new Error('Save As not yet implemented — see docs/integration-plan.md Phase 6');
    }

    async revertCustomDocument(
        _document: ImageDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        // TODO (Phase 5): Re-read the file from disk and re-post into the webview.
    }

    async backupCustomDocument(
        _document: ImageDocument,
        _context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken
    ): Promise<vscode.CustomDocumentBackup> {
        // TODO (Phase 5): Write a backup copy to context.destination.
        return {
            id: _context.destination.toString(),
            delete: () => { /* no-op for now */ },
        };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private _getPlaceholderHtml(uri: vscode.Uri): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paintbox</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; color: #ccc; background: #1e1e1e; }
    code { background: #333; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h2>Paintbox — Image Editor</h2>
  <p>Editing: <code>${uri.fsPath}</code></p>
  <p>miniPaint not yet vendored. See <code>docs/integration-plan.md</code> Phase 1.</p>
</body>
</html>`;
    }
}
