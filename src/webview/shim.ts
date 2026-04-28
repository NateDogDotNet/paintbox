// Paintbox webview shim. Runs INSIDE the miniPaint webview (browser context).
//
// Purpose:
//   Phase 3 — bridge host ↔ miniPaint for the OPEN side of the round-trip.
//   The host posts {type:'load', dataUrl, filename, mime}; this shim hands the
//   data-URL to miniPaint's File_open API and reports back ready/loadError.
//   Phase 4 — install window.__pbBridge.saveAs(blob, fname) BEFORE the bundle
//   runs. The patched bundle's `(window.__pbBridge||p()).saveAs(...)` call
//   sites then route bytes via postMessage instead of triggering a browser
//   download. See .orchestrator/phase4-design.md §5.
//   Phase 5 — close the round-trip:
//     • handle host→webview {type:'requestSave', requestId, format, filename}
//       by calling app.File_save.save_action({…}, false) directly, bypassing
//       miniPaint's modal export popup;
//     • install a dirty-tracking hook (monkey-patch app.State.do_action) that
//       posts {type:'dirty'} once per save epoch;
//     • forward `requestId` through the __pbBridge.saveAs intercept so the
//       host's saveResult correlator can match the response;
//     • reset the dirty gate when the host posts {type:'saved'}.
//
// Design contract: see .orchestrator/phase3-design.md §6 + phase4-design.md §5
// + phase5-design.md §1 and §2.
//
// IMPORTANT — build constraints:
//   This file compiles via tsconfig.webview.json (module:"none", target:"ES2020").
//   It MUST NOT contain `import` / `export` statements; otherwise tsc emits a
//   CommonJS preamble that crashes in the browser. All globals are referenced
//   via `(window as any)` or `declare global`. Wrap in an IIFE so locals don't
//   leak into miniPaint's namespace.

declare function acquireVsCodeApi(): {
    postMessage: (message: unknown) => void;
    getState: () => unknown;
    setState: (state: unknown) => void;
};

interface MiniPaintApp {
    File_open?: {
        file_open_data_url_handler?: (dataUrl: string) => unknown;
    };
    File_save?: {
        // miniPaint's `save_action(user_response, autoname)` is the
        // non-popup entry point. Its `user_response` shape is read from
        // vendor/minipaint/src/js/modules/file/save.js (see Phase 5 design §2).
        save_action?: (user_response: unknown, autoname: boolean) => unknown;
    };
    State?: {
        do_action?: (action: unknown) => unknown;
    };
}

interface LoadMessage {
    type: 'load';
    dataUrl: string;
    filename: string;
    mime: string;
}

type HostMessage = LoadMessage | { type: string; [k: string]: unknown };

(function pbShim(): void {
    // Phase 4 §8 Test 4a test seam: allow tests to inject a fake vscode handle
    // before the shim's IIFE runs (by setting `window.__pbTestVsCode`).
    // Production code never sets this global, so production behavior is
    // identical to the prior `acquireVsCodeApi()`-only call. The test seam
    // keeps a single call site for `acquireVsCodeApi` (Phase 3 carry-over §1).
    const vscode = (window as unknown as {
        __pbTestVsCode?: ReturnType<typeof acquireVsCodeApi>;
    }).__pbTestVsCode || acquireVsCodeApi();

    // Phase 5 §1 — once-per-save dirty gate. Reset when the host posts
    // {type:'saved'}. Initialized false; first state-action (or first
    // pointerdown fallback) flips it true and posts {type:'dirty'}.
    let pbDirtyDispatched = false;
    function signalDirty(): void {
        if (pbDirtyDispatched) return;
        pbDirtyDispatched = true;
        try { vscode.postMessage({ type: 'dirty' }); } catch { /* noop */ }
    }

    // Phase 4 — bridge for miniPaint's filesaver.saveAs intercept (§5).
    // Defined synchronously inside the IIFE so window.__pbBridge is present
    // before the bundle's `set_events()` keyboard binding fires.
    interface PbBridge {
        saveAs: (blob: Blob, fname: string) => void;
    }
    const MIME_BY_EXT: { [k: string]: string } = {
        'png': 'image/png',
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'gif': 'image/gif',
        // Phase 4 forwards these even though they're not in package.json's
        // declared selectors. Phase 5's host-side Gate 2 rejects MIME mismatches.
        'tiff': 'image/tiff', 'avif': 'image/avif', 'json': 'application/json',
    };
    function deriveMimeFromBlob(blob: Blob, fname: string): string {
        if (blob.type) return blob.type;
        const dot = fname.lastIndexOf('.');
        if (dot < 0) return 'application/octet-stream';
        const ext = fname.slice(dot + 1).toLowerCase();
        return MIME_BY_EXT[ext] || 'application/octet-stream';
    }
    function deriveFormatFromFilename(fname: string): string {
        const dot = fname.lastIndexOf('.');
        if (dot < 0) return 'UNKNOWN';
        const ext = fname.slice(dot + 1).toLowerCase();
        if (ext === 'jpg' || ext === 'jpeg') return 'JPG';
        return ext.toUpperCase();
    }
    const pbBridge: PbBridge = {
        saveAs(blob: Blob, fname: string): void {
            const mime = deriveMimeFromBlob(blob, fname);
            const format = deriveFormatFromFilename(fname);
            // Phase 5 §2: pluck the host-stashed requestId (set by the
            // requestSave handler immediately before save_action). Clear it
            // so a subsequent user-initiated save doesn't accidentally
            // inherit the previous host-initiated save's id.
            const win = window as unknown as { __pbPendingRequestId?: string };
            const requestId = win.__pbPendingRequestId;
            win.__pbPendingRequestId = undefined;
            try {
                // eslint-disable-next-line no-console
                console.log('[paintbox] saveResult dispatch', {
                    fname: fname, format: format, mime: mime, size: blob.size,
                    requestId: requestId || '(none)',
                });
            } catch {
                // logging is best-effort; never block the save path
            }
            blob.arrayBuffer().then(
                (buf) => {
                    const payload: { [k: string]: unknown } = {
                        type: 'saveResult',
                        bytes: Array.from(new Uint8Array(buf)),
                        format: format,
                        filename: fname,
                        mime: mime,
                    };
                    if (requestId) payload.requestId = requestId;
                    vscode.postMessage(payload);
                },
                (err: unknown) => {
                    const errPayload: { [k: string]: unknown } = {
                        type: 'saveError',
                        error: err instanceof Error ? err.message : String(err),
                        filename: fname,
                    };
                    if (requestId) errPayload.requestId = requestId;
                    vscode.postMessage(errPayload);
                }
            );
        },
    };
    (window as unknown as { __pbBridge: PbBridge }).__pbBridge = pbBridge;

    type State = 'loading' | 'ready' | 'error';
    interface SetStatePayload {
        filename?: string;
        error?: string;
    }

    function setState(next: State, payload: SetStatePayload = {}): void {
        if (document.body) {
            document.body.dataset.state = next;
        }
        if (payload.filename !== undefined) {
            const cap = document.getElementById('pb_caption');
            if (cap) cap.textContent = payload.filename;
        }
        if (payload.error !== undefined) {
            const errEl = document.getElementById('pb_error_message');
            if (errEl) errEl.textContent = payload.error;
        }
    }

    function getApp(): MiniPaintApp | undefined {
        return (window as unknown as { app?: MiniPaintApp }).app;
    }

    function waitForMiniPaint(timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const tick = (): void => {
                const app = getApp();
                if (
                    app &&
                    app.File_open &&
                    typeof app.File_open.file_open_data_url_handler === 'function'
                ) {
                    resolve();
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('miniPaint failed to initialize within ' + timeoutMs + 'ms'));
                    return;
                }
                setTimeout(tick, 50);
            };
            tick();
        });
    }

    function errToString(err: unknown): string {
        if (err instanceof Error) return err.message;
        if (typeof err === 'string') return err;
        try {
            return JSON.stringify(err);
        } catch {
            return String(err);
        }
    }

    /**
     * Phase 5 §1: install the dirty-tracking monkey-patch on
     * `app.State.do_action`. Falls back to a one-shot pointerdown listener
     * if `app.State.do_action` is missing (defensive against upstream drift).
     */
    function installDirtyHook(): void {
        const app = getApp();
        const state = app && app.State;
        if (!app || !state || typeof state.do_action !== 'function') {
            // eslint-disable-next-line no-console
            console.warn('[paintbox] app.State.do_action unavailable; falling back to pointerdown dirty trigger');
            document.addEventListener('pointerdown', signalDirty, { once: true });
            return;
        }
        const original = state.do_action.bind(state);
        state.do_action = function patched(action: unknown): unknown {
            try { signalDirty(); } catch { /* never block edits */ }
            return original(action);
        };
    }

    /**
     * Phase 5 §2: handle a host-initiated save. The host stashes the
     * requestId on a per-save global so the bridge's saveAs can attach it
     * to the eventual saveResult message. Then we call save_action directly
     * with a synthesized user_response — bypassing miniPaint's modal popup.
     */
    function handleRequestSave(m: { [k: string]: unknown }): void {
        const requestId = String(m.requestId || '');
        const format = String(m.format || 'PNG');     // 'PNG'|'JPG'|...
        const filename = String(m.filename || 'image.png');
        try {
            const app = getApp();
            const fileSave = app && app.File_save;
            if (!app || !fileSave || typeof fileSave.save_action !== 'function') {
                throw new Error('miniPaint File_save API is unavailable');
            }
            // Stash requestId so the bridge attaches it to the eventual
            // saveResult / saveError. Cleared by the bridge after first use.
            (window as unknown as { __pbPendingRequestId?: string }).__pbPendingRequestId = requestId;
            // user_response shape per save.js:463 (see Phase 5 design §2).
            //   name: filename WITH extension (save_action auto-appends if
            //         missing, but our host always sends one).
            //   type: bare key — line 480 splits on space, so 'PNG' works.
            //   quality: 1-100; ignored for PNG/BMP/GIF.
            //   layers: 'All' = composite; we save the flattened canvas.
            //   delay: 400 (miniPaint's default GIF frame delay).
            //   calc_size: false — skip the dialog's "estimated size" preview.
            fileSave.save_action({
                name: filename,
                type: format,
                quality: 90,
                layers: 'All',
                delay: 400,
                calc_size: false,
            }, /* autoname */ false);
        } catch (err: unknown) {
            const errMsg = errToString(err);
            // Clear the stashed requestId on synchronous failure (the bridge
            // never gets a chance to consume it).
            (window as unknown as { __pbPendingRequestId?: string }).__pbPendingRequestId = undefined;
            const payload: { [k: string]: unknown } = {
                type: 'saveError',
                error: errMsg,
                filename,
            };
            if (requestId) payload.requestId = requestId;
            vscode.postMessage(payload);
        }
    }

    function init(): void {
        // Initial state — body[data-state] is also pre-set in the HTML, so
        // this is belt-and-braces in case markup changes.
        setState('loading');

        // Neutralise miniPaint's logo <a href="#">. With <base href> set, "#"
        // would resolve to the base URL with empty fragment and some browsers
        // treat that as a navigation.
        document.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as Element | null;
            if (!target || typeof target.closest !== 'function') return;
            const a = target.closest('a.logo');
            if (a) e.preventDefault();
        });

        const retryBtn = document.getElementById('pb_retry');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                setState('loading');
                vscode.postMessage({ type: 'retry' });
            });
        }

        window.addEventListener('message', (e: MessageEvent) => {
            const msg = e.data as HostMessage | undefined;
            if (!msg || typeof msg !== 'object') return;
            // Phase 5: handle host-initiated requestSave and `saved` ack.
            if (msg.type === 'requestSave') {
                handleRequestSave(msg as { [k: string]: unknown });
                return;
            }
            if (msg.type === 'saved') {
                pbDirtyDispatched = false;
                return;
            }
            if (msg.type !== 'load') return;

            const loadMsg = msg as LoadMessage;
            const dataUrl = String(loadMsg.dataUrl || '');
            const filename = String(loadMsg.filename || '');

            // Defensive: data-URL we don't recognize. Phase 3 §9 Q1: selector
            // pre-filters in package.json constrain this to the six declared
            // image MIMEs, but if a user opens an unknown extension via Open
            // With, surface a clean error instead of throwing inside miniPaint.
            if (!dataUrl.startsWith('data:image/')) {
                const err = 'Unsupported image format (data-URL did not start with data:image/)';
                setState('error', { error: err });
                vscode.postMessage({ type: 'loadError', error: err });
                return;
            }

            setState('loading', { filename });
            try {
                const app = getApp();
                if (!app || !app.File_open || !app.File_open.file_open_data_url_handler) {
                    throw new Error('miniPaint File_open API is unavailable');
                }
                app.File_open.file_open_data_url_handler(dataUrl);
                // miniPaint's open path is async-ish (Image.onload). The
                // double-rAF heuristic gives the browser time to decode the
                // <img> and miniPaint time to commit a layer before we declare
                // ready. Phase 3 design §6 notes the upgrade path if this
                // proves flaky (monkey-patch app.State.do_action).
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                        // After a fresh load, the canvas matches disk: clear
                        // the dirty epoch so the NEXT real edit re-fires.
                        pbDirtyDispatched = false;
                        setState('ready');
                        vscode.postMessage({ type: 'ready' });
                    })
                );
            } catch (err: unknown) {
                const errMsg = errToString(err);
                setState('error', { error: errMsg });
                vscode.postMessage({ type: 'loadError', error: errMsg });
            }
        });

        waitForMiniPaint(10000).then(
            () => {
                // Phase 5 §1: arm dirty tracking AFTER miniPaint is ready
                // (so app.State.do_action is in scope).
                installDirtyHook();
                vscode.postMessage({ type: 'webviewReady' });
            },
            (err: unknown) => {
                const errMsg = errToString(err);
                setState('error', { error: errMsg });
                vscode.postMessage({ type: 'loadError', error: errMsg });
            }
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
