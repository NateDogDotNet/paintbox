import * as vscode from 'vscode';
import * as path from 'path';
import { buildWebviewHtml } from './webviewHtml';

/**
 * ImageDocument — the in-memory model for an open image file.
 *
 * Phase 3 stores no bytes here: the host re-reads from disk on every load
 * (initial open AND retry) so the document remains a thin URI wrapper. Phase 5
 * will introduce dirty tracking and pending save state.
 */
class ImageDocument implements vscode.CustomDocument {
    readonly uri: vscode.Uri;
    /** Derived from extension on open; informational for the load message. */
    readonly mime: string;

    constructor(uri: vscode.Uri, mime: string) {
        this.uri = uri;
        this.mime = mime;
    }

    dispose(): void {
        // No buffered state in Phase 3.
    }
}

/**
 * Phase 3 file extension → MIME map. Covers exactly the six extensions
 * declared in `package.json` `contributes.customEditors[].selector`. Anything
 * else (e.g. `.tiff`) gets a synthesized `image/octet-stream` and the shim
 * surfaces a defensive error overlay (see Phase 3 design §9 Q1).
 */
const MIME_BY_EXT: Record<string, string> = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.bmp':  'image/bmp',
};

function deriveMime(uri: vscode.Uri): string {
    const ext = path.extname(uri.fsPath).toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * PaintboxEditorProvider — CustomEditorProvider that embeds miniPaint in a
 * webview and bridges the open/edit/save round-trip to the server filesystem.
 *
 * Architecture (see docs/architecture.md for Mermaid sequence diagram):
 *   1. openCustomDocument   — derive MIME, return ImageDocument (bytes are
 *                             read on demand by the load round-trip)
 *   2. resolveCustomEditor  — set localResourceRoots, set webview.html via
 *                             buildWebviewHtml, wire postMessage handler
 *   3. (user edits in miniPaint)
 *   4. saveCustomDocument   — Phase 5
 *
 * Phase map:
 *   Phase 2 — stub registration (done)
 *   Phase 3 — open file: read bytes → webview (this commit)
 *   Phase 4 — patch miniPaint File_save to postMessage result back to host
 *   Phase 5 — saveCustomDocument / saveCustomDocumentAs writeFile
 *   Phase 6 — format conversion (Save As)
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
        // Phase 3: bytes are NOT cached on the document. Each load posts a
        // fresh read, so retry is consistent with disk state and we don't
        // burn memory on every open. Phase 5 will revisit if the round-trip
        // demands a buffer.
        return new ImageDocument(uri, deriveMime(uri));
    }

    async resolveCustomEditor(
        document: ImageDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const extensionUri = this._context.extensionUri;

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'vendor', 'minipaint'),
                vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
            ],
        };

        const filename = path.basename(document.uri.fsPath);

        webviewPanel.webview.html = buildWebviewHtml(
            webviewPanel.webview,
            extensionUri,
            { filename }
        );

        const postLoad = async (): Promise<void> => {
            try {
                const bytes = await vscode.workspace.fs.readFile(document.uri);
                const dataUrl =
                    `data:${document.mime};base64,` +
                    Buffer.from(bytes).toString('base64');
                await webviewPanel.webview.postMessage({
                    type: 'load',
                    dataUrl,
                    filename,
                    mime: document.mime,
                });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                // Surface the full URI in the error path per Phase 3 design §9 Q2.
                vscode.window.showErrorMessage(
                    `Paintbox: failed to read ${document.uri.toString()}: ${message}`
                );
            }
        };

        const messageSub = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || typeof msg !== 'object') return;
            switch (msg.type) {
                case 'webviewReady':
                    await postLoad();
                    return;
                case 'retry':
                    await postLoad();
                    return;
                case 'ready':
                    // Phase 3: nothing to do; Phase 5 may resolve a pending Promise.
                    return;
                case 'loadError':
                    vscode.window.showErrorMessage(
                        `Paintbox: ${String(msg.error || 'unknown error')} (${document.uri.toString()})`
                    );
                    return;
            }
        });

        webviewPanel.onDidDispose(() => {
            messageSub.dispose();
        });
    }

    async saveCustomDocument(
        _document: ImageDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        // Phase 5: receive the latest bytes from the webview (via a pending
        // promise set up in resolveCustomEditor) and write them to disk.
        throw new Error('Save not yet implemented — see docs/integration-plan.md Phase 5');
    }

    async saveCustomDocumentAs(
        _document: ImageDocument,
        _destination: vscode.Uri,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        // Phase 6: same as saveCustomDocument but writes to _destination.
        throw new Error('Save As not yet implemented — see docs/integration-plan.md Phase 6');
    }

    async revertCustomDocument(
        _document: ImageDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        // Phase 5: re-read the file from disk and re-post into the webview.
    }

    async backupCustomDocument(
        _document: ImageDocument,
        _context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken
    ): Promise<vscode.CustomDocumentBackup> {
        // Phase 5: write a backup copy to context.destination.
        return {
            id: _context.destination.toString(),
            delete: () => { /* no-op for now */ },
        };
    }
}
