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
//       by calling window.FileSave.save_action({…}, false) directly, bypassing
//       miniPaint's modal export popup;
//     • install a dirty-tracking hook (monkey-patch window.State.do_action)
//       that posts {type:'dirty'} once per save epoch;
//     • forward `requestId` through the __pbBridge.saveAs intercept so the
//       host's saveResult correlator can match the response;
//     • reset the dirty gate when the host posts {type:'saved'}.
//   Phase 6.5 — switch the polling target from `window.app.File_open` (never
//   set by miniPaint v4.14.3's bundle) to upstream-exposed `window.FileOpen`
//   / `window.FileSave` / `window.State`. See .orchestrator/phase6.5-design.md.
//
// Design contract: see .orchestrator/phase3-design.md §6 + phase4-design.md §5
// + phase5-design.md §1 and §2 + phase6.5-design.md §2.
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

// Phase 6.5: miniPaint v4.14.3's compiled bundle never sets `window.app`. The
// upstream `app` singleton is module-private (webpack minifies it to `v.A`).
// What the bundle DOES expose, deliberately, are three module classes on
// window: `window.FileOpen`, `window.FileSave`, `window.State`. The shim uses
// THOSE directly. See .orchestrator/phase6.5-design.md §2 for the byte-dump
// evidence and rejected-alternative rationale.
interface MiniPaintFileOpen {
    file_open_data_url_handler?: (dataUrl: string) => unknown;
}
interface MiniPaintFileSave {
    // miniPaint's `save_action(user_response, autoname)` is the non-popup
    // entry point. Its `user_response` shape is read from
    // vendor/minipaint/src/js/modules/file/save.js (see Phase 5 design §2).
    save_action?: (user_response: unknown, autoname: boolean) => unknown;
}
interface MiniPaintState {
    do_action?: (action: unknown) => unknown;
}

interface LoadMessage {
    type: 'load';
    dataUrl: string;
    filename: string;
    mime: string;
}

type HostMessage = LoadMessage | { type: string; [k: string]: unknown };

(function pbShim(): void {
    // v0.0.2 burn-in diagnostics: capture any global errors fired BEFORE
    // miniPaint finishes init. These are appended to the waitForMiniPaint
    // timeout error so the user can see what actually broke without needing
    // to switch DevTools iframe context.
    const __pbBootErrors: string[] = [];
    window.addEventListener('error', (e: ErrorEvent) => {
        __pbBootErrors.push(`error: ${e.message || '?'} @ ${e.filename || '?'}:${e.lineno || '?'}`);
    });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        const r = e.reason as { message?: string } | string | undefined;
        const msg = (r && typeof r === 'object' && r.message) ? r.message : String(r);
        __pbBootErrors.push(`unhandledrejection: ${msg}`);
    });

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
        // Phase 4 forwards these even though they're not in package.json's
        // declared selectors. Phase 5's host-side Gate 2 rejects MIME mismatches.
        // Phase 6.8 dropped 'gif' and 'bmp' — paintbox no longer claims those
        // formats; the host's Gate 1 rejects them anyway. Kept TIFF/AVIF/JSON
        // because the unsolicited-saveResult path (Export) still allows them.
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

    // Phase 6.6 §D4 — Print intercept.
    // VS Code webviews silently block `window.print()`; miniPaint's print.js
    // is literally `window.print()`, so File → Print does nothing. Reroute it
    // through the existing save bridge with a sentinel requestId. The host's
    // saveResult handler picks up `requestId === '__print__'`, writes a tmp
    // PNG, and asks VS Code to open it in the user's default image viewer
    // (which has its own Print menu).
    //
    // Installed BEFORE the bundle runs (we're inside the IIFE that runs from
    // the head <script>), so by the time miniPaint's File_print_class binds
    // its menu item, our patched `window.print` is already in place.
    (window as { print?: () => void }).print = function pbPrint(): void {
        const fileSave = (window as unknown as { FileSave?: MiniPaintFileSave }).FileSave;
        if (!fileSave || typeof fileSave.save_action !== 'function') {
            // Called too early — bundle hasn't installed FileSave yet. Fail
            // soft; the print menu fires after init in practice, but be
            // defensive against future ordering changes.
            // eslint-disable-next-line no-console
            console.warn('[paintbox] window.print called before FileSave was available; skipping');
            return;
        }
        (window as unknown as { __pbPendingRequestId?: string }).__pbPendingRequestId = '__print__';
        fileSave.save_action({
            name: 'print.png',
            type: 'PNG',
            quality: 90,
            layers: 'All',
            delay: 400,
            calc_size: false,
        }, /* autoname */ true);
    };

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

    function getFileOpen(): MiniPaintFileOpen | undefined {
        return (window as unknown as { FileOpen?: MiniPaintFileOpen }).FileOpen;
    }
    function getFileSave(): MiniPaintFileSave | undefined {
        return (window as unknown as { FileSave?: MiniPaintFileSave }).FileSave;
    }
    function getState(): MiniPaintState | undefined {
        return (window as unknown as { State?: MiniPaintState }).State;
    }

    function waitForMiniPaint(timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const tick = (): void => {
                const fileOpen = getFileOpen();
                if (
                    fileOpen &&
                    typeof fileOpen.file_open_data_url_handler === 'function'
                ) {
                    resolve();
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    // v0.0.2 burn-in: dump everything we know about the
                    // miniPaint init state so the failure is self-diagnosing.
                    // Phase 6.5: surface dump now reflects the upstream
                    // window globals the shim actually depends on.
                    const fileSave = getFileSave();
                    const state = getState();
                    const dump = {
                        docReady: document.readyState,
                        hasFileOpen: !!fileOpen,
                        hasFileSave: !!fileSave,
                        hasState: !!state,
                        hasFileOpenHandler:
                            !!(fileOpen && typeof fileOpen.file_open_data_url_handler === 'function'),
                        bootErrors: __pbBootErrors.slice(0, 6),
                        scripts: Array.from(document.scripts).map(
                            (s) => s.src || '(inline)'
                        ).slice(0, 12),
                    };
                    reject(new Error(
                        'miniPaint init timeout (' + timeoutMs + 'ms). ' +
                        JSON.stringify(dump)
                    ));
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
     * Phase 5 §1 / Phase 6.5: install the dirty-tracking monkey-patch on
     * `window.State.do_action`. Falls back to a one-shot pointerdown listener
     * if `State.do_action` is missing (defensive against upstream drift).
     */
    function installDirtyHook(): void {
        const state = getState();
        if (!state || typeof state.do_action !== 'function') {
            // eslint-disable-next-line no-console
            console.warn('[paintbox] window.State.do_action unavailable; falling back to pointerdown dirty trigger');
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
            const fileSave = getFileSave();
            if (!fileSave || typeof fileSave.save_action !== 'function') {
                throw new Error('miniPaint FileSave API is unavailable');
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
                const fileOpen = getFileOpen();
                if (!fileOpen || !fileOpen.file_open_data_url_handler) {
                    throw new Error('miniPaint FileOpen API is unavailable');
                }
                fileOpen.file_open_data_url_handler(dataUrl);
                // miniPaint's open path is async-ish (Image.onload). The
                // double-rAF heuristic gives the browser time to decode the
                // <img> and miniPaint time to commit a layer before we declare
                // ready. Phase 3 design §6 notes the upgrade path if this
                // proves flaky (monkey-patch window.State.do_action).
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
                // (so window.State.do_action is in scope).
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
