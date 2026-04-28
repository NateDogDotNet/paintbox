import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { buildWebviewHtml } from './webviewHtml';
import { SaveCorrelator } from './saveCorrelator';

/**
 * ImageDocument — the in-memory model for an open image file.
 *
 * Phase 3 stores no bytes here: the host re-reads from disk on every load
 * (initial open AND retry) so the document remains a thin URI wrapper. Phase 5
 * adds an optional `backupUri` for hot-exit recovery (CustomDocumentBackup
 * round-trip; see Phase 5 design §7).
 */
class ImageDocument implements vscode.CustomDocument {
    readonly uri: vscode.Uri;
    /** Derived from extension on open; informational for the load message. */
    readonly mime: string;
    /**
     * Hot-exit backup URI. When non-null, the load path reads from here
     * instead of `uri`. Set by `openCustomDocument` from `openContext.backupId`.
     */
    backupUri: vscode.Uri | undefined;

    constructor(uri: vscode.Uri, mime: string) {
        this.uri = uri;
        this.mime = mime;
        this.backupUri = undefined;
    }

    dispose(): void {
        // No buffered state.
    }
}

/**
 * Phase 3 file extension → MIME map. Covers exactly the four extensions
 * declared in `package.json` `contributes.customEditors[].selector`. Anything
 * else (e.g. `.tiff`) gets a synthesized `image/octet-stream` and the shim
 * surfaces a defensive error overlay (see Phase 3 design §9 Q1).
 *
 * Phase 6.8 dropped `.gif` and `.bmp`: miniPaint's GIF encoder uses a
 * Web Worker that the webview's CSP blocks, and most browsers don't ship
 * a native BMP encoder. Rather than fail at save time, paintbox no longer
 * claims those formats — VS Code's default image preview still opens them.
 */
const MIME_BY_EXT: Record<string, string> = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
};

/**
 * Phase 5 file extension → {format, mime} map. The format string is what
 * miniPaint's `save_action` accepts (line 480 of vendor save.js splits on
 * space, so `'PNG'` is sufficient). MIME is what we expect back on
 * `saveResult.mime`; mismatch → Gate 2 reject (design §8).
 *
 * Lives next to MIME_BY_EXT but kept distinct: MIME_BY_EXT serves the OPEN
 * path (load message) where we don't need miniPaint's format key; FORMAT_BY_EXT
 * serves the SAVE path (requestSave message).
 */
const FORMAT_BY_EXT: Record<string, { format: 'PNG'|'JPG'|'WEBP'; mime: string }> = {
    '.png':  { format: 'PNG',  mime: 'image/png'  },
    '.jpg':  { format: 'JPG',  mime: 'image/jpeg' },
    '.jpeg': { format: 'JPG',  mime: 'image/jpeg' },
    '.webp': { format: 'WEBP', mime: 'image/webp' },
};

const SAVE_TIMEOUT_MS = 30_000;

/**
 * Phase 6.6 §D2: filter map for `vscode.window.showSaveDialog` when the
 * webview emits an unsolicited saveResult (Export / in-app Save As). Keys
 * are miniPaint format strings AND MIME strings — the webview message may
 * carry either, so we accept both. `'All files'` is appended last by the
 * caller so the user can override the suggested extension.
 */
const SAVE_DIALOG_FILTERS: Record<string, { [k: string]: string[] }> = {
    'PNG':         { 'PNG image':         ['png'] },
    'image/png':   { 'PNG image':         ['png'] },
    'JPG':         { 'JPEG image':        ['jpg', 'jpeg'] },
    'image/jpeg':  { 'JPEG image':        ['jpg', 'jpeg'] },
    'WEBP':        { 'WebP image':        ['webp'] },
    'image/webp':  { 'WebP image':        ['webp'] },
    // Phase 6.8: GIF + BMP entries dropped — those formats are no longer
    // claimed by paintbox (see MIME_BY_EXT note).
    'JSON':        { 'miniPaint layered': ['json'] },
    'application/json': { 'miniPaint layered': ['json'] },
    'TIFF':        { 'TIFF image':        ['tiff'] },
    'image/tiff':  { 'TIFF image':        ['tiff'] },
    'AVIF':        { 'AVIF image':        ['avif'] },
    'image/avif':  { 'AVIF image':        ['avif'] },
};

function deriveMime(uri: vscode.Uri): string {
    const ext = path.extname(uri.fsPath).toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Per-pending-save metadata stashed inside the SaveCorrelator. Used by
 * cancelByPredicate to filter pending saves when a webview is disposed
 * (only reject saves for THAT URI).
 */
interface PendingMeta {
    uri: vscode.Uri;
    expectedMime: string;
    expectedFormat: 'PNG' | 'JPG' | 'WEBP';
}

/**
 * PaintboxEditorProvider — CustomEditorProvider that embeds miniPaint in a
 * webview and bridges the open/edit/save round-trip to the server filesystem.
 *
 * Architecture (see docs/architecture.md for Mermaid sequence diagram):
 *   1. openCustomDocument   — derive MIME, return ImageDocument; honor
 *                             openContext.backupId for hot-exit recovery.
 *   2. resolveCustomEditor  — set localResourceRoots, set webview.html via
 *                             buildWebviewHtml, wire postMessage handler
 *   3. (user edits in miniPaint; shim posts {type:'dirty'} once per epoch)
 *   4. saveCustomDocument   — host posts {type:'requestSave', requestId, …};
 *                             webview replies {type:'saveResult', requestId,
 *                             bytes, mime, …}; host writes bytes to disk;
 *                             posts {type:'saved', requestId} back to webview
 *                             so shim resets its dirty epoch.
 *
 * Phase map:
 *   Phase 2 — stub registration (done)
 *   Phase 3 — open file: read bytes → webview (done)
 *   Phase 4 — patch miniPaint File_save to postMessage result back to host (done)
 *   Phase 5 — saveCustomDocument / saveCustomDocumentAs / revert / backup
 *             (this commit)
 *   Phase 6 — cross-format Save As + format conversion
 */
export class PaintboxEditorProvider
    implements vscode.CustomEditorProvider<ImageDocument>
{
    private static readonly VIEW_TYPE = 'paintbox.imageEditor';

    /**
     * Test seam (Phase 5 §10): tests reach the most-recently-instantiated
     * provider via this static accessor. The provider is a singleton via VS
     * Code's `registerCustomEditorProvider`, so this is well-defined for
     * production. Tests that `new` a provider directly also publish to here
     * so `__pbTestGetActive()` returns their instance.
     */
    private static _activeInstance: PaintboxEditorProvider | undefined;
    static __pbTestGetActive(): PaintboxEditorProvider | undefined {
        return PaintboxEditorProvider._activeInstance;
    }

    /**
     * Phase 6.5 test seam: register a callback fired the first time ANY
     * resolved editor receives a `{type:'ready'}` message. Returns a
     * Disposable that removes the callback. Used by Test 3c to assert the
     * miniPaint init round-trip actually completed (vs. waiting blindly on
     * a setTimeout). Naming convention matches `__pbTestGetMeta`.
     */
    private static readonly _readyCallbacks = new Set<(uri: vscode.Uri) => void>();
    static __pbTestOnReady(cb: (uri: vscode.Uri) => void): vscode.Disposable {
        PaintboxEditorProvider._readyCallbacks.add(cb);
        return new vscode.Disposable(() => {
            PaintboxEditorProvider._readyCallbacks.delete(cb);
        });
    }

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

    /** Phase 5: per-document webview panel registry. Populated in
     * `resolveCustomEditor`, cleared in `onDidDispose`. */
    private readonly _webviewByUri = new Map<string, vscode.WebviewPanel>();

    /** Phase 5: dirty-tracking gate. Once-per-save epoch; `case 'dirty'`
     * fires `_onDidChangeCustomDocument` exactly once until the next save
     * clears the entry. */
    private readonly _dirtyEpochByUri = new Map<string, boolean>();

    /** Phase 5: requestId-keyed pending-save correlator. */
    private readonly _correlator = new SaveCorrelator<PendingMeta>();

    constructor(private readonly _context: vscode.ExtensionContext) {
        PaintboxEditorProvider._activeInstance = this;
    }

    // -------------------------------------------------------------------------
    // CustomEditorProvider interface
    // -------------------------------------------------------------------------

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<ImageDocument> {
        const doc = new ImageDocument(uri, deriveMime(uri));
        // Phase 5 §7: honor hot-exit backup. When VS Code restarts after a
        // crash, openContext.backupId is the URI of the backup file we wrote
        // in `backupCustomDocument`. Read from THAT file instead of the
        // possibly-stale on-disk URI.
        if (openContext.backupId) {
            try {
                doc.backupUri = vscode.Uri.parse(openContext.backupId);
            } catch {
                // Defensive: if the backupId isn't a parseable URI, fall back
                // to the document URI (Phase 7 may revisit on Windows path
                // edge cases).
                doc.backupUri = undefined;
            }
        }
        return doc;
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

        // Register the panel so saveCustomDocument can find it by URI.
        const uriKey = document.uri.toString();
        this._webviewByUri.set(uriKey, webviewPanel);

        const messageSub = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || typeof msg !== 'object') return;
            switch (msg.type) {
                case 'webviewReady':
                    await this._postLoadToWebview(webviewPanel, document);
                    return;
                case 'retry':
                    await this._postLoadToWebview(webviewPanel, document);
                    return;
                case 'ready':
                    // Phase 6.5 test seam: notify any registered ready
                    // listeners. Production code path is unchanged; the Set
                    // is empty unless tests subscribed. Callbacks are
                    // best-effort — a throwing test seam must not break the
                    // production message loop.
                    for (const cb of PaintboxEditorProvider._readyCallbacks) {
                        try { cb(document.uri); } catch { /* never throw out of message handler */ }
                    }
                    return;
                case 'loadError': {
                    const fullErr = String(msg.error || 'unknown error');
                    // v0.0.2 burn-in: the full diagnostic JSON may be longer
                    // than the toast can show. Always log to the Extension
                    // Host channel so it's recoverable from the Output panel.
                    console.error('[paintbox] loadError:', fullErr, '(', document.uri.toString(), ')');
                    vscode.window.showErrorMessage(
                        `Paintbox: ${fullErr} (${path.basename(document.uri.fsPath)})`
                    );
                    return;
                }
                case 'dirty': {
                    // Phase 5 §1: shim's once-per-save gate guarantees at most
                    // one dirty per epoch, but gate again here in case of
                    // ordering races (defensive).
                    const key = document.uri.toString();
                    if (this._dirtyEpochByUri.get(key)) return;
                    this._dirtyEpochByUri.set(key, true);
                    this._onDidChangeCustomDocument.fire({
                        document,
                        label: 'Edit',
                        // VS Code undo/redo bridging is a no-op (default 8).
                        // miniPaint owns its in-canvas undo stack; bridging is
                        // a Phase 6+ concern.
                        undo: () => { console.debug('[paintbox] VS Code undo not bridged to miniPaint (Phase 6+)'); },
                        redo: () => { console.debug('[paintbox] VS Code redo not bridged to miniPaint (Phase 6+)'); },
                    });
                    return;
                }
                case 'saveResult': {
                    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
                    // Path 1 — host-initiated save: a pending correlator entry
                    // exists for this requestId. Run Gate 2 (MIME match) and
                    // hand bytes to the correlator.
                    const meta = requestId
                        ? this._correlator.__pbTestGetMeta(requestId)
                        : undefined;
                    if (meta) {
                        const arrivedMime = String(msg.mime || '');
                        if (arrivedMime !== meta.expectedMime) {
                            this._correlator.cancel(requestId, new Error(
                                `Paintbox: expected ${meta.expectedMime} but webview produced ${arrivedMime || '(unknown)'}. ` +
                                'Save aborted to avoid writing the wrong format to disk.'
                            ));
                            return;
                        }
                        const bytesArr = Array.isArray(msg.bytes) ? (msg.bytes as number[]) : null;
                        if (!bytesArr || bytesArr.length === 0) {
                            this._correlator.cancel(requestId, new Error(
                                'Paintbox: webview returned empty bytes; save aborted.'
                            ));
                            return;
                        }
                        this._correlator.handleSaveResult(requestId, new Uint8Array(bytesArr));
                        return;
                    }
                    // Path 2 — unsolicited save (Phase 6.6 §D2): user clicked
                    // File → Export or File → Save As inside the webview. No
                    // pending host request. Prompt the user for a destination
                    // via showSaveDialog and write the bytes there. NEVER
                    // write silently — the user thinks "download", not
                    // "overwrite the workspace file."
                    await this._handleUnsolicitedSaveResult(msg, document.uri);
                    return;
                }
                case 'saveError': {
                    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
                    const errStr = String(msg.error || 'unknown error');
                    if (requestId) {
                        const matched = this._correlator.handleSaveError(requestId, errStr);
                        if (matched) return;
                        // Default 4: log-only when no pending match.
                        // eslint-disable-next-line no-console
                        console.log('[paintbox] saveError without pending request — ignored', { requestId, error: errStr });
                        return;
                    }
                    // No requestId — surface as a user-visible error.
                    vscode.window.showErrorMessage(`Paintbox: save error — ${errStr}`);
                    return;
                }
            }
        });

        webviewPanel.onDidDispose(() => {
            messageSub.dispose();
            // Reject any saves in flight for THIS URI.
            this._correlator.cancelByPredicate(
                (meta) => !!meta && meta.uri.toString() === uriKey,
                new Error('Paintbox: editor closed before save completed.')
            );
            this._webviewByUri.delete(uriKey);
            this._dirtyEpochByUri.delete(uriKey);
        });
    }

    async saveCustomDocument(
        document: ImageDocument,
        cancellation: vscode.CancellationToken
    ): Promise<void> {
        return this._writeViaWebview(document, document.uri, cancellation);
    }

    async saveCustomDocumentAs(
        document: ImageDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken
    ): Promise<void> {
        // Phase 6 §1: cross-format Save As is now supported. The same
        // sourceExt/destExt/sameFormat calc serves both the GIF guard and
        // the lossy-conversion warning below.
        const sourceExt = path.extname(document.uri.fsPath).toLowerCase();
        const destExt = path.extname(destination.fsPath).toLowerCase();
        const sameFormat = (sourceExt === destExt) ||
            (sourceExt === '.jpg' && destExt === '.jpeg') ||
            (sourceExt === '.jpeg' && destExt === '.jpg');

        // Phase 6 §4 (orchestrator override): hard failures FIRST. GIF
        // cross-format is unsupported because miniPaint's GIF branch
        // unconditionally animates from layers and the gif.worker.js path
        // is CSP-hostile under the webview sandbox. Failing fast — BEFORE
        // the lossy warning — avoids prompting the user for an outcome
        // we'd then refuse to deliver.
        if (destExt === '.gif' && !sameFormat) {
            throw new Error(
                'Paintbox: Save As to GIF across formats is not supported in v1. ' +
                "miniPaint's GIF export builds an animation from layers; " +
                'cross-format flattening to a static GIF requires upstream changes. ' +
                'Use PNG or WEBP instead.'
            );
        }

        // Phase 6 §2: lossy-conversion warning fires only on supported
        // cross-format paths. User-cancelled → throw to abort cleanly.
        if (!sameFormat) {
            const proceed = await this._confirmLossyConversion(sourceExt, destExt);
            if (!proceed) {
                throw new Error('Paintbox: Save As cancelled.');
            }
        }

        return this._writeViaWebview(document, destination, cancellation);
    }

    /**
     * Phase 6 §2: ask the user before a cross-format Save As that may lose
     * information (alpha → white fill, JPEG re-encode, etc.).
     *
     * Modal `showWarningMessage` with a single positive button. VS Code
     * renders an automatic "Cancel" button alongside; both Cancel and
     * dismiss (Esc / X) resolve to `undefined`, so the strict-equality
     * check correctly returns `false` for any non-affirmative outcome.
     */
    private async _confirmLossyConversion(
        sourceExt: string,
        destExt: string
    ): Promise<boolean> {
        const message =
            `Paintbox: Save As will convert ${sourceExt} to ${destExt}. ` +
            'This may flatten transparency, reduce image quality, or lose other ' +
            'format-specific data. Continue?';
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Save Anyway'
        );
        return choice === 'Save Anyway';
    }

    async revertCustomDocument(
        document: ImageDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const uriKey = document.uri.toString();
        const panel = this._webviewByUri.get(uriKey);
        if (!panel) {
            throw new Error('Paintbox: no active webview for this document; cannot revert.');
        }
        // Reject in-flight saves for this URI (revert supersedes them).
        this._correlator.cancelByPredicate(
            (meta) => !!meta && meta.uri.toString() === uriKey,
            new Error('Paintbox: revert cancelled in-flight save.')
        );
        // Clear backup pointer — revert always reads the live disk state.
        document.backupUri = undefined;
        await this._postLoadToWebview(panel, document);
        this._dirtyEpochByUri.delete(uriKey);
        // Reset shim's dirty epoch so the next edit re-fires.
        panel.webview.postMessage({ type: 'saved' }).then(undefined, () => { /* noop */ });
    }

    async backupCustomDocument(
        document: ImageDocument,
        context: vscode.CustomDocumentBackupContext,
        cancellation: vscode.CancellationToken
    ): Promise<vscode.CustomDocumentBackup> {
        // Phase 5 default 3: fresh export. Reuses _writeViaWebview, redirected
        // to context.destination. The format follows the document's URI
        // extension — backups round-trip the original format.
        await this._writeViaWebview(document, context.destination, cancellation);
        return {
            id: context.destination.toString(),
            delete: async (): Promise<void> => {
                try {
                    await vscode.workspace.fs.delete(context.destination);
                } catch {
                    // VS Code sometimes calls delete after the file is
                    // already gone; ENOENT is fine.
                }
            },
        };
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Read disk bytes (preferring `backupUri` for hot-exit recovery), encode
     * as a base64 data-URL, and post a `load` message to the webview. Shared
     * between `resolveCustomEditor` (initial open / retry) and
     * `revertCustomDocument`.
     */
    private async _postLoadToWebview(
        panel: vscode.WebviewPanel,
        document: ImageDocument
    ): Promise<void> {
        try {
            const readUri = document.backupUri || document.uri;
            const bytes = await vscode.workspace.fs.readFile(readUri);
            const dataUrl =
                `data:${document.mime};base64,` +
                Buffer.from(bytes).toString('base64');
            await panel.webview.postMessage({
                type: 'load',
                dataUrl,
                filename: path.basename(document.uri.fsPath),
                mime: document.mime,
            });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
                `Paintbox: failed to read ${document.uri.toString()}: ${message}`
            );
        }
    }

    /**
     * Single host-initiated save pipeline:
     *   1. derive format from `destination` extension (Gate 1 of design §8);
     *   2. find the per-URI webview;
     *   3. register a pending entry in the correlator with a 30s timeout;
     *   4. post `requestSave` to the webview;
     *   5. await the bytes; if MIME validates, write to disk;
     *   6. clear dirty gate; tell shim the save completed.
     *
     * Reused by `saveCustomDocument`, `saveCustomDocumentAs` (same-format),
     * and `backupCustomDocument`.
     */
    private async _writeViaWebview(
        document: ImageDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken
    ): Promise<void> {
        // Gate 1 (design §8): pre-flight format validation.
        const ext = path.extname(destination.fsPath).toLowerCase();
        const formatEntry = FORMAT_BY_EXT[ext];
        if (!formatEntry) {
            throw new Error(
                `Paintbox: cannot save to "${destination.fsPath}" — extension "${ext}" is not supported. ` +
                'Supported extensions: .png, .jpg, .jpeg, .webp.'
            );
        }
        const { format, mime } = formatEntry;

        const uriKey = document.uri.toString();
        const panel = this._webviewByUri.get(uriKey);
        if (!panel) {
            throw new Error('Paintbox: no active webview for this document.');
        }

        if (cancellation.isCancellationRequested) {
            throw new Error('Paintbox: save cancelled.');
        }

        const requestId = crypto.randomUUID();

        // Register the pending entry FIRST so the correlator is armed when we
        // post requestSave.
        const bytesPromise = this._correlator.register(requestId, SAVE_TIMEOUT_MS, {
            uri: document.uri,
            expectedMime: mime,
            expectedFormat: format,
        });

        // Wire cancellation token. If cancelled mid-flight, reject the
        // pending and abandon the save. (Mocha-driven tests pass a fresh
        // CancellationTokenSource; production gets VS Code's token.)
        const cancelSub = cancellation.onCancellationRequested(() => {
            this._correlator.cancel(requestId, new Error('Paintbox: save cancelled.'));
        });

        let bytes: Uint8Array;
        try {
            // Post requestSave AFTER the pending entry exists, so the shim's
            // synchronous reply (in tests) or asynchronous reply (in production
            // miniPaint) can find the entry.
            const post = panel.webview.postMessage({
                type: 'requestSave',
                requestId,
                format,
                filename: path.basename(destination.fsPath),
            });
            // VS Code's postMessage returns a Thenable<boolean>. If the panel
            // is disposed mid-flight, the thenable rejects.
            Promise.resolve(post).then(undefined, (err: unknown) => {
                this._correlator.cancel(requestId, new Error(
                    `Paintbox: failed to message webview — ${err instanceof Error ? err.message : String(err)}`
                ));
            });

            bytes = await bytesPromise;
        } finally {
            cancelSub.dispose();
        }

        // Disk write. Failures here surface verbatim through VS Code's
        // "Save failed: <message>" toast.
        try {
            await vscode.workspace.fs.writeFile(destination, bytes);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Paintbox: failed to write file — ${msg}`);
        }

        // Successful write to the document's own URI clears the dirty gate.
        // (Save As to a different destination doesn't change the document's
        // dirty state — VS Code calls saveCustomDocumentAs as a copy
        // operation. Backups also don't clear the dirty state.)
        if (destination.toString() === uriKey) {
            this._dirtyEpochByUri.delete(uriKey);
            // Tell the shim to reset its `pbDirtyDispatched` gate so the
            // next edit re-fires `dirty`.
            panel.webview.postMessage({ type: 'saved', requestId })
                .then(undefined, () => { /* best-effort */ });
        }
    }

    /**
     * Phase 6.6 §D2: handle a webview-initiated saveResult that has no matching
     * host request (Export / in-app Save As). Prompt the user via
     * `showSaveDialog`, then write the bytes to the chosen destination.
     *
     *   • `defaultUri` = sibling of the open document, with miniPaint's
     *     suggested filename. This puts the export next to the source file in
     *     the workspace, which is what users expect.
     *   • Cancelled dialog (returns undefined) → silent no-op. The user
     *     opted out; no toast.
     *   • writeFile failure → error toast. VS Code's own modal save flow
     *     surfaces these via "Save failed:"; for unsolicited saves there's no
     *     such envelope, so the toast is the only signal.
     */
    private async _handleUnsolicitedSaveResult(
        msg: { [k: string]: unknown },
        documentUri: vscode.Uri
    ): Promise<void> {
        const filename = String(msg.filename || 'image.png');
        const formatKey = String(msg.format || msg.mime || '');
        const filterEntry = SAVE_DIALOG_FILTERS[formatKey];
        const filters: { [k: string]: string[] } = {
            ...(filterEntry || {}),
            // 'All files' last per Phase 6.6 brief — lets the user override
            // the suggested extension.
            'All files': ['*'],
        };

        const parentDir = vscode.Uri.joinPath(documentUri, '..');
        const defaultUri = vscode.Uri.joinPath(parentDir, filename);

        const target = await vscode.window.showSaveDialog({ defaultUri, filters });
        if (!target) {
            // User cancelled; no toast (Phase 6.6 §D2: silent no-op).
            return;
        }

        const bytesArr = Array.isArray(msg.bytes) ? (msg.bytes as number[]) : [];
        try {
            await vscode.workspace.fs.writeFile(target, new Uint8Array(bytesArr));
            vscode.window.showInformationMessage(
                `Paintbox: saved ${path.basename(target.fsPath)}`
            );
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Paintbox: save failed: ${errMsg}`);
        }
    }

    // -------------------------------------------------------------------------
    // Test seams
    // -------------------------------------------------------------------------

    /**
     * Returns true iff `_dirtyEpochByUri` has an entry for the given URI.
     * Test seam for Test 5b's "dirty cleared after save" assertion.
     */
    __pbTestIsDirty(uri: vscode.Uri): boolean {
        return this._dirtyEpochByUri.get(uri.toString()) === true;
    }
}
