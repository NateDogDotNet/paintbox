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
//
// Design contract: see .orchestrator/phase3-design.md §6 + phase4-design.md §5.
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
        // declared selectors. Phase 5 enforces the policy.
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
            try {
                // eslint-disable-next-line no-console
                console.log('[paintbox] saveResult dispatch', {
                    fname: fname, format: format, mime: mime, size: blob.size,
                });
            } catch {
                // logging is best-effort; never block the save path
            }
            blob.arrayBuffer().then(
                (buf) => {
                    vscode.postMessage({
                        type: 'saveResult',
                        bytes: Array.from(new Uint8Array(buf)),
                        format: format,
                        filename: fname,
                        mime: mime,
                    });
                },
                (err: unknown) => {
                    vscode.postMessage({
                        type: 'saveError',
                        error: err instanceof Error ? err.message : String(err),
                        filename: fname,
                    });
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
