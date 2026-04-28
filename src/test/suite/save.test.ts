import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as vm from 'vm';
import * as vscode from 'vscode';

/**
 * Phase 4 + Phase 5 tests (see .orchestrator/phase4-design.md §8 and
 * .orchestrator/phase5-design.md §10).
 *
 *   4a — UNIT: window.__pbBridge.saveAs(blob, fname) serializes to a
 *        `saveResult` postMessage with the expected fields. Runs the shim
 *        IIFE in a sandboxed VM with a minimal browser stub.
 *   4b — INTEGRATION: bypass-popup. resolveCustomEditor receives a
 *        `saveResult` message synthesized as if the bridge had posted it,
 *        and editorProvider's switch case fires without throwing.
 *   (4c lives in extension.test.ts — activation integrity check.)
 *
 *   5a (in correlator.test.ts) — UNIT: SaveCorrelator pure correlation logic.
 *   5b — INTEGRATION (MANDATORY): real disk round-trip. Synthesize the bridge's
 *        saveResult into the in-flight saveCustomDocument; assert that the
 *        bytes written to disk match (SHA-256) the bytes the bridge emitted.
 *   5c — INTEGRATION: saveError surfaces a Paintbox-prefixed Error from
 *        saveCustomDocument's promise.
 *   5d — INTEGRATION: a saveResult with a wrong MIME (e.g. image/tiff for a
 *        .png document) rejects the save AND leaves the disk file unchanged
 *        (SHA-256 before == SHA-256 after).
 *   5e — INTEGRATION: revertCustomDocument re-reads disk and re-posts a
 *        `load` message whose dataUrl decodes to the new on-disk bytes
 *        (SHA-256 of decoded base64 == SHA-256 of disk fixture).
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SHIM_PATH = path.join(REPO_ROOT, 'out', 'webview', 'shim.js');
const FIXTURE_1x1_PNG = path.join(REPO_ROOT, 'src', 'test', 'suite', 'fixtures', 'pixel.png');
// Phase 5 §10 Test 5e: 2x2 PNG fixture, distinguishable from the 1x1 fixture
// by SHA-256. Generated via Node `zlib.deflateSync` over a 4-pixel RGBA
// scanline buffer; full byte string (76 bytes, hex):
//   89504e470d0a1a0a 0000000d49484452 0000000200000002 0806000000 72b60d24
//   0000001349444154 78 9c 63 f8 cf c0 f0 1f 0c 19 18 fe 83 01 00 49 c8 09 f7
//   1463329d         00000000494e44ae 426082
// Pixels: row0 = [red, green]; row1 = [blue, white], all 8-bit RGBA.
const FIXTURE_2x2_PNG = path.join(REPO_ROOT, 'src', 'test', 'suite', 'fixtures', 'pixel-2x2.png');

suite('Paintbox Phase 4 — Save (bridge → host)', () => {

    // ---------- Test 4a: __pbBridge.saveAs serializes to saveResult --------

    test('4a — __pbBridge.saveAs posts saveResult with expected fields', async () => {
        // Confirm the compiled shim exists.
        assert.ok(
            fs.existsSync(SHIM_PATH),
            `expected compiled shim at ${SHIM_PATH}`
        );
        const shimSource = fs.readFileSync(SHIM_PATH, 'utf8');

        // Capture postMessage calls in a fake vscode handle.
        const posted: Array<{ [k: string]: unknown }> = [];
        const fakeVscode = {
            postMessage: (m: { [k: string]: unknown }) => { posted.push(m); },
            getState: () => undefined,
            setState: (_s: unknown) => undefined,
        };

        // Minimal Blob-ish stub for the sandbox: real Buffer-backed
        // arrayBuffer(). Promise resolves with a real ArrayBuffer.
        class FakeBlob {
            private _buf: Uint8Array;
            public type: string;
            public size: number;
            constructor(parts: Uint8Array[], opts?: { type?: string }) {
                let total = 0;
                for (const p of parts) total += p.length;
                const out = new Uint8Array(total);
                let off = 0;
                for (const p of parts) { out.set(p, off); off += p.length; }
                this._buf = out;
                this.size = out.length;
                this.type = (opts && opts.type) || '';
            }
            arrayBuffer(): Promise<ArrayBuffer> {
                // Detach from Buffer's underlying pool.
                const ab = new ArrayBuffer(this._buf.length);
                new Uint8Array(ab).set(this._buf);
                return Promise.resolve(ab);
            }
        }

        // Document/window stubs that the shim's IIFE references at parse-time
        // BEFORE init() runs. The shim wraps everything in a function and
        // only TOUCHES document inside callbacks — but `document.readyState`
        // is read synchronously to decide DOMContentLoaded vs immediate.
        // We use 'loading' so init() is deferred and we can inspect __pbBridge
        // before init runs.
        const eventListeners: Record<string, Array<(e: unknown) => void>> = {};
        const fakeDocument = {
            readyState: 'loading',
            body: { dataset: {} as Record<string, string> },
            getElementById: (_id: string) => null,
            addEventListener: (
                ev: string,
                cb: (e: unknown) => void,
                _opts?: unknown
            ) => {
                (eventListeners[ev] = eventListeners[ev] || []).push(cb);
            },
        };
        const fakeWindow: { [k: string]: unknown } = {
            addEventListener: (
                ev: string,
                cb: (e: unknown) => void,
                _opts?: unknown
            ) => {
                (eventListeners[ev] = eventListeners[ev] || []).push(cb);
            },
            __pbTestVsCode: fakeVscode,
        };

        const sandbox: { [k: string]: unknown } = {
            window: fakeWindow,
            document: fakeDocument,
            Blob: FakeBlob,
            Uint8Array,
            Promise,
            setTimeout,
            requestAnimationFrame: (cb: () => void) => { cb(); },
            console: { log: () => undefined, error: () => undefined, warn: () => undefined },
            // The shim references acquireVsCodeApi via `declare function`, but
            // Test 4a's seam means the shim should use __pbTestVsCode FIRST.
            // acquireVsCodeApi is therefore unreachable; provide a stub that
            // throws so we catch any regression where the seam is removed.
            acquireVsCodeApi: () => {
                throw new Error('acquireVsCodeApi() should not be called when __pbTestVsCode is set');
            },
        };
        // Make `globalThis` in the sandbox match `window` so any
        // `(window as any)` access patterns resolve.
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(shimSource, sandbox, { filename: 'shim.js' });

        // The shim's IIFE has now run. window.__pbBridge must exist.
        const pbBridge = (fakeWindow as { __pbBridge?: { saveAs: (b: unknown, f: string) => void } }).__pbBridge;
        assert.ok(pbBridge, 'window.__pbBridge was not installed by the shim');
        assert.strictEqual(typeof pbBridge.saveAs, 'function', '__pbBridge.saveAs is not a function');

        // PNG magic header bytes.
        const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const blob = new (sandbox.Blob as typeof FakeBlob)([PNG_MAGIC], { type: 'image/png' });

        pbBridge.saveAs(blob, 'test.png');

        // Wait for blob.arrayBuffer() promise to resolve and the bridge to post.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        assert.strictEqual(posted.length, 1, `expected exactly 1 postMessage; saw ${posted.length}: ${JSON.stringify(posted)}`);
        const msg = posted[0];
        assert.strictEqual(msg.type, 'saveResult', 'message type should be saveResult');
        assert.strictEqual(msg.format, 'PNG', 'format should be PNG');
        assert.strictEqual(msg.filename, 'test.png', 'filename echoes through');
        assert.strictEqual(msg.mime, 'image/png', 'mime should be image/png');
        assert.ok(Array.isArray(msg.bytes), 'bytes should be an array');
        // Re-spread into a host-realm array. The shim runs inside vm context
        // and produces a cross-realm Array; deepStrictEqual is reference-equal
        // on prototype, so a same-shape comparison would fail otherwise.
        const bytes = [...(msg.bytes as number[])];
        assert.strictEqual(bytes.length, 8, 'bytes length should match input blob');
        assert.deepStrictEqual(
            bytes,
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            'bytes should match PNG magic header'
        );
    });

    // ---------- Test 4b: bypass-popup integration ---------------------------

    test('4b — host onDidReceiveMessage handles saveResult/saveError without throwing', async () => {
        // Drive the host message path WITHOUT spinning up a real webview.
        // Synthesize a `saveResult` (no matching pending requestId — under
        // Phase 6.6 §D2 this routes to the unsolicited-save path, so we stub
        // showSaveDialog to return undefined / cancel) and a `saveError` —
        // both must complete without throwing.

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const providerModule = require('../../editorProvider');
        const Provider = providerModule.PaintboxEditorProvider;
        assert.ok(Provider, 'PaintboxEditorProvider not exported');

        const ext = vscode.extensions.getExtension('NateDogDotNet.paintbox');
        await ext!.activate();

        const extensionUri = vscode.Uri.file(REPO_ROOT);
        const fakeContext = {
            extensionUri,
            extensionPath: REPO_ROOT,
            subscriptions: [] as vscode.Disposable[],
        } as unknown as vscode.ExtensionContext;

        const provider = new Provider(fakeContext);

        const fixtureUri = vscode.Uri.file(FIXTURE_1x1_PNG);

        const document = await provider.openCustomDocument(
            fixtureUri,
            { backupId: undefined } as unknown as vscode.CustomDocumentOpenContext,
            new vscode.CancellationTokenSource().token
        );

        type PostedMessage = { type: string; [k: string]: unknown };
        let messageHandler: ((msg: PostedMessage) => void | Promise<void>) | undefined;

        const fakeWebview = {
            cspSource: 'vscode-webview://fake',
            options: {} as vscode.WebviewOptions,
            html: '',
            asWebviewUri: (uri: vscode.Uri) =>
                vscode.Uri.parse(`https://fake-webview.test${uri.path}`),
            onDidReceiveMessage: (cb: (msg: PostedMessage) => void | Promise<void>) => {
                messageHandler = cb;
                return new vscode.Disposable(() => { messageHandler = undefined; });
            },
            postMessage: async (_msg: PostedMessage) => true,
        };
        const fakePanel = {
            webview: fakeWebview,
            onDidDispose: (_cb: () => void) => new vscode.Disposable(() => undefined),
        } as unknown as vscode.WebviewPanel;

        await provider.resolveCustomEditor(
            document,
            fakePanel,
            new vscode.CancellationTokenSource().token
        );
        assert.ok(messageHandler, 'host did not register an onDidReceiveMessage handler');

        // Phase 6.6: stub showSaveDialog so the unsolicited-save path
        // resolves to "cancel" (no toast, no write). The original
        // showSaveDialog in test mode would either hang or pop a real dialog.
        const origShowSaveDialog = vscode.window.showSaveDialog;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showSaveDialog = async () => undefined;

        let savedThrow: unknown = undefined;
        try {
            await Promise.resolve(messageHandler!({
                type: 'saveResult',
                bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
                format: 'PNG',
                filename: 'pixel.png',
                mime: 'image/png',
            }));
            await Promise.resolve(messageHandler!({
                type: 'saveError',
                error: 'simulated error',
                filename: 'pixel.png',
            }));
        } catch (err) {
            savedThrow = err;
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showSaveDialog = origShowSaveDialog;
        }
        assert.strictEqual(
            savedThrow,
            undefined,
            `messageHandler threw on saveResult/saveError synthesis: ${String(savedThrow)}`
        );

        // Smoke: editorProvider's switch still has the case branches.
        const epSrc = fs.readFileSync(
            path.join(REPO_ROOT, 'out', 'editorProvider.js'),
            'utf8'
        );
        assert.ok(
            /case ['"]saveResult['"]/.test(epSrc),
            'expected editorProvider switch to have a saveResult case'
        );
        assert.ok(
            /case ['"]saveError['"]/.test(epSrc),
            'expected editorProvider switch to have a saveError case'
        );
    });
});

// ---------- Phase 5 tests (5b mandatory; 5c, 5d, 5e supporting) -----------

suite('Paintbox Phase 5 — Save (host writes bytes to disk)', () => {
    /**
     * Provider/webview test harness shared across tests 5b–5e.
     *
     * Each test opens a fresh tmp file, instantiates a provider, attaches a
     * fake WebviewPanel, and exercises the public CustomEditorProvider API.
     * The fake webview captures every host→webview postMessage so tests can:
     *   • intercept the next `requestSave` and synthesize the response
     *     (used by 5c, 5d, 5b);
     *   • capture the next `load` message (used by 5e).
     */
    interface PostedMessage { type: string; [k: string]: unknown }

    interface Harness {
        provider: {
            openCustomDocument: (
                uri: vscode.Uri,
                openCtx: vscode.CustomDocumentOpenContext,
                tok: vscode.CancellationToken
            ) => Promise<unknown>;
            resolveCustomEditor: (
                doc: unknown,
                panel: vscode.WebviewPanel,
                tok: vscode.CancellationToken
            ) => Promise<void>;
            saveCustomDocument: (doc: unknown, tok: vscode.CancellationToken) => Promise<void>;
            saveCustomDocumentAs: (
                doc: unknown,
                dest: vscode.Uri,
                tok: vscode.CancellationToken
            ) => Promise<void>;
            revertCustomDocument: (doc: unknown, tok: vscode.CancellationToken) => Promise<void>;
            backupCustomDocument: (
                doc: unknown,
                ctx: vscode.CustomDocumentBackupContext,
                tok: vscode.CancellationToken
            ) => Promise<vscode.CustomDocumentBackup>;
            __pbTestIsDirty: (uri: vscode.Uri) => boolean;
        };
        document: { uri: vscode.Uri; mime: string };
        messageHandler: (m: PostedMessage) => void | Promise<void>;
        posted: PostedMessage[];
        cleanup: () => Promise<void>;
        // Test seams.
        interceptNextRequestSave: (cb: (requestId: string) => void) => void;
        captureNextLoad: () => Promise<PostedMessage>;
    }

    async function makeHarness(fixturePath: string, fixtureBaseName: string): Promise<Harness> {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const providerModule = require('../../editorProvider');
        const Provider = providerModule.PaintboxEditorProvider;

        const ext = vscode.extensions.getExtension('NateDogDotNet.paintbox');
        await ext!.activate();

        const extensionUri = vscode.Uri.file(REPO_ROOT);
        const fakeContext = {
            extensionUri,
            extensionPath: REPO_ROOT,
            subscriptions: [] as vscode.Disposable[],
        } as unknown as vscode.ExtensionContext;
        const provider = new Provider(fakeContext);

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paintbox-5-'));
        const tmpFile = path.join(tmpDir, fixtureBaseName);
        await fs.promises.copyFile(fixturePath, tmpFile);
        const tmpUri = vscode.Uri.file(tmpFile);

        const document = await provider.openCustomDocument(
            tmpUri,
            { backupId: undefined } as unknown as vscode.CustomDocumentOpenContext,
            new vscode.CancellationTokenSource().token
        );

        const posted: PostedMessage[] = [];
        let messageHandler: ((msg: PostedMessage) => void | Promise<void>) | undefined;
        const requestSaveInterceptors: Array<(requestId: string) => void> = [];
        let nextLoadResolver: ((m: PostedMessage) => void) | null = null;

        const fakeWebview = {
            cspSource: 'vscode-webview://fake',
            options: {} as vscode.WebviewOptions,
            html: '',
            asWebviewUri: (uri: vscode.Uri) =>
                vscode.Uri.parse(`https://fake-webview.test${uri.path}`),
            onDidReceiveMessage: (cb: (msg: PostedMessage) => void | Promise<void>) => {
                messageHandler = cb;
                return new vscode.Disposable(() => { messageHandler = undefined; });
            },
            postMessage: async (msg: PostedMessage) => {
                posted.push(msg);
                if (msg.type === 'load' && nextLoadResolver) {
                    const r = nextLoadResolver; nextLoadResolver = null;
                    r(msg);
                }
                if (msg.type === 'requestSave' && requestSaveInterceptors.length > 0) {
                    const cb = requestSaveInterceptors.shift()!;
                    // Defer so the saveCustomDocument promise registers before
                    // we feed back the synthetic saveResult/saveError.
                    setTimeout(() => cb(String(msg.requestId)), 0);
                }
                return true;
            },
        };
        const fakePanel = {
            webview: fakeWebview,
            onDidDispose: (_cb: () => void) => new vscode.Disposable(() => undefined),
        } as unknown as vscode.WebviewPanel;

        await provider.resolveCustomEditor(
            document,
            fakePanel,
            new vscode.CancellationTokenSource().token
        );
        assert.ok(messageHandler, 'host did not register onDidReceiveMessage');

        return {
            provider: provider as Harness['provider'],
            document: document as Harness['document'],
            messageHandler: messageHandler!,
            posted,
            cleanup: async () => {
                try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); }
                catch { /* best-effort */ }
            },
            interceptNextRequestSave: (cb) => { requestSaveInterceptors.push(cb); },
            captureNextLoad: () => new Promise<PostedMessage>((resolve) => {
                // Drain any 'load' already queued.
                const existing = posted.find((m) => m.type === 'load');
                if (existing) { resolve(existing); return; }
                nextLoadResolver = resolve;
            }),
        };
    }

    function sha256(buf: Uint8Array | Buffer): string {
        return crypto.createHash('sha256').update(buf).digest('hex');
    }

    // ---------- Test 5b — MANDATORY round-trip with disk SHA-256 match ----

    test('5b — saveCustomDocument writes webview bytes to disk (SHA-256 match)', async function () {
        this.timeout(15_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'roundtrip.png');
        try {
            // Pre-flight: file on disk is the 1x1 fixture.
            const beforeBytes = await fs.promises.readFile(h.document.uri.fsPath);
            assert.strictEqual(beforeBytes.length, 67, 'pre-flight: 1x1 fixture is 67 bytes');

            // Bytes the "webview" will emit. We use the 2x2 fixture so the
            // file genuinely changes — disk-before != disk-after proves the
            // write actually happened, beyond just SHA-256-equality.
            const webviewBytes = await fs.promises.readFile(FIXTURE_2x2_PNG);
            const webviewSha = sha256(webviewBytes);
            assert.notStrictEqual(webviewSha, sha256(beforeBytes),
                'sanity: 2x2 fixture must differ from 1x1 fixture');

            // Intercept the next requestSave: when the host posts it, we
            // simulate the bridge replying with the 2x2 fixture's bytes.
            h.interceptNextRequestSave((requestId) => {
                Promise.resolve(h.messageHandler({
                    type: 'saveResult',
                    requestId,
                    bytes: Array.from(webviewBytes),
                    format: 'PNG',
                    filename: 'roundtrip.png',
                    mime: 'image/png',
                })).catch(() => undefined);
            });

            // Drive saveCustomDocument directly (Phase 4 precedent — bypass
            // keyboard synthesis).
            await h.provider.saveCustomDocument(
                h.document,
                new vscode.CancellationTokenSource().token
            );

            // Assert: the on-disk file equals the bytes the webview emitted.
            const onDiskBytes = await fs.promises.readFile(h.document.uri.fsPath);
            const onDiskSha = sha256(onDiskBytes);
            // ── load-bearing assertion (Test 5b) ──
            assert.strictEqual(
                onDiskSha,
                webviewSha,
                `on-disk SHA-256 ${onDiskSha} must equal webview-emitted SHA-256 ${webviewSha}`
            );
            // Belt-and-braces: byte-equal too.
            assert.strictEqual(onDiskBytes.length, webviewBytes.length,
                'on-disk byte length must equal webview-emitted length');
            assert.ok(
                Buffer.from(onDiskBytes).equals(Buffer.from(webviewBytes)),
                'on-disk bytes must equal webview-emitted bytes byte-for-byte'
            );

            // Dirty gate cleared.
            assert.strictEqual(
                h.provider.__pbTestIsDirty(h.document.uri),
                false,
                'document should be clean after successful save'
            );

            // Host posted a `saved` message back to the webview (resets shim
            // dirty epoch).
            const savedMsg = h.posted.find((m) => m.type === 'saved');
            assert.ok(savedMsg, `expected a 'saved' message back to webview; saw: ${JSON.stringify(h.posted.map(m => m.type))}`);
        } finally {
            await h.cleanup();
        }
    });

    // ---------- Test 5c — saveError surfaces as a Paintbox-prefixed Error --

    test('5c — saveError rejects saveCustomDocument with Paintbox-prefixed Error', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'err.png');
        try {
            h.interceptNextRequestSave((requestId) => {
                Promise.resolve(h.messageHandler({
                    type: 'saveError',
                    requestId,
                    error: 'simulated encoder failure',
                    filename: 'err.png',
                })).catch(() => undefined);
            });

            let rejection: Error | null = null;
            try {
                await h.provider.saveCustomDocument(
                    h.document,
                    new vscode.CancellationTokenSource().token
                );
            } catch (err) {
                rejection = err as Error;
            }
            assert.ok(rejection, 'saveCustomDocument should have rejected on saveError');
            assert.match(
                rejection!.message,
                /Paintbox: simulated encoder failure/,
                `expected Paintbox-prefixed error; got: ${rejection!.message}`
            );
        } finally {
            await h.cleanup();
        }
    });

    // ---------- Test 5d — MIME mismatch rejects WITHOUT touching disk -----

    test('5d — MIME mismatch rejects without modifying disk', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'mismatch.png');
        try {
            const sha256Before = sha256(await fs.promises.readFile(h.document.uri.fsPath));

            h.interceptNextRequestSave((requestId) => {
                Promise.resolve(h.messageHandler({
                    type: 'saveResult',
                    requestId,
                    mime: 'image/tiff',
                    bytes: [0x4d, 0x4d, 0x00, 0x2a],
                    format: 'TIFF',
                    filename: 'mismatch.tiff',
                })).catch(() => undefined);
            });

            let rejection: Error | null = null;
            try {
                await h.provider.saveCustomDocument(
                    h.document,
                    new vscode.CancellationTokenSource().token
                );
            } catch (err) { rejection = err as Error; }
            assert.ok(rejection, 'saveCustomDocument should reject on MIME mismatch');
            assert.match(
                rejection!.message,
                /expected image\/png but webview produced image\/tiff/,
                `expected MIME-mismatch error; got: ${rejection!.message}`
            );

            const sha256After = sha256(await fs.promises.readFile(h.document.uri.fsPath));
            assert.strictEqual(
                sha256Before, sha256After,
                'disk file must not be modified when format/MIME mismatches'
            );
        } finally {
            await h.cleanup();
        }
    });

    // ---------- Test 5e — revertCustomDocument re-posts disk bytes --------

    test('5e — revertCustomDocument re-posts fresh disk bytes (SHA-256 match)', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'revert.png');
        try {
            // Externally overwrite the file with the 2x2 fixture (simulating
            // an out-of-band change on disk).
            await fs.promises.copyFile(FIXTURE_2x2_PNG, h.document.uri.fsPath);
            const expectedBytes = await fs.promises.readFile(h.document.uri.fsPath);
            const expectedSha = sha256(expectedBytes);

            // Capture the next 'load' the host posts in response to revert.
            const loadCapture = h.captureNextLoad();

            await h.provider.revertCustomDocument(
                h.document,
                new vscode.CancellationTokenSource().token
            );

            // We need the load message that was posted AFTER revert was
            // called. The harness's captureNextLoad returns a load already
            // queued before revert (resolveCustomEditor's webviewReady path
            // doesn't fire here because we never sent webviewReady — so the
            // first load IS the revert one). Defensive check:
            const loadMsg = await loadCapture;
            assert.strictEqual(loadMsg.type, 'load');
            const dataUrl = String(loadMsg.dataUrl || '');
            assert.ok(
                dataUrl.startsWith('data:image/png;base64,'),
                `expected png data-URL; got: ${dataUrl.slice(0, 40)}`
            );
            const decoded = Buffer.from(dataUrl.split(',')[1], 'base64');
            assert.strictEqual(
                sha256(decoded),
                expectedSha,
                'revert must re-post bytes that hash-match the disk file'
            );
        } finally {
            await h.cleanup();
        }
    });

});

// ---------- Phase 6 tests (cross-format Save As + lossy warning UX) -------

/**
 * Phase 6 tests (see .orchestrator/phase6-design.md §7 + orchestrator override).
 *
 *   6a (MANDATORY) — Cross-format Save As round-trip with real disk write.
 *                    Stub showWarningMessage → 'Save Anyway'; assert JPEG magic
 *                    bytes on disk; assert source PNG unchanged (SHA-256).
 *   6b — Lossy-warning Cancel aborts the save; destination must NOT exist.
 *   6c — Same-format Save As still works AND does NOT call showWarningMessage.
 *   6d — JSON Save As throws Gate 1 unsupported-extension error.
 *   6e — GIF cross-format Save As throws BEFORE the warning fires (override).
 *
 * Phase 5's Test 5f was deleted; tests 6a + 6c together replace its coverage.
 */

/**
 * Monkey-patch helper for `vscode.window.showWarningMessage`. Tests use
 * `try { … } finally { stub.restore(); }` to guarantee restoration even on
 * assertion failure. No Sinon dependency.
 */
function installWarnStub(response: 'Save Anyway' | undefined) {
    const original = vscode.window.showWarningMessage;
    let callCount = 0;
    let lastMessage = '';
    (vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Thenable<string | undefined> })
        .showWarningMessage = (...args: unknown[]) => {
            callCount++;
            lastMessage = String(args[0] || '');
            return Promise.resolve(response);
        };
    return {
        get callCount() { return callCount; },
        get lastMessage() { return lastMessage; },
        restore() {
            (vscode.window as unknown as { showWarningMessage: typeof original }).showWarningMessage = original;
        },
    };
}

suite('Paintbox Phase 6 — Save As + Format Conversion', () => {
    interface PostedMessage { type: string; [k: string]: unknown }

    interface Harness {
        provider: {
            openCustomDocument: (
                uri: vscode.Uri,
                openCtx: vscode.CustomDocumentOpenContext,
                tok: vscode.CancellationToken
            ) => Promise<unknown>;
            resolveCustomEditor: (
                doc: unknown,
                panel: vscode.WebviewPanel,
                tok: vscode.CancellationToken
            ) => Promise<void>;
            saveCustomDocument: (doc: unknown, tok: vscode.CancellationToken) => Promise<void>;
            saveCustomDocumentAs: (
                doc: unknown,
                dest: vscode.Uri,
                tok: vscode.CancellationToken
            ) => Promise<void>;
        };
        document: { uri: vscode.Uri; mime: string };
        messageHandler: (m: PostedMessage) => void | Promise<void>;
        posted: PostedMessage[];
        cleanup: () => Promise<void>;
        interceptNextRequestSave: (cb: (requestId: string) => void) => void;
    }

    async function makeHarness(fixturePath: string, fixtureBaseName: string): Promise<Harness> {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const providerModule = require('../../editorProvider');
        const Provider = providerModule.PaintboxEditorProvider;

        const ext = vscode.extensions.getExtension('NateDogDotNet.paintbox');
        await ext!.activate();

        const extensionUri = vscode.Uri.file(REPO_ROOT);
        const fakeContext = {
            extensionUri,
            extensionPath: REPO_ROOT,
            subscriptions: [] as vscode.Disposable[],
        } as unknown as vscode.ExtensionContext;
        const provider = new Provider(fakeContext);

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paintbox-6-'));
        const tmpFile = path.join(tmpDir, fixtureBaseName);
        await fs.promises.copyFile(fixturePath, tmpFile);
        const tmpUri = vscode.Uri.file(tmpFile);

        const document = await provider.openCustomDocument(
            tmpUri,
            { backupId: undefined } as unknown as vscode.CustomDocumentOpenContext,
            new vscode.CancellationTokenSource().token
        );

        const posted: PostedMessage[] = [];
        let messageHandler: ((msg: PostedMessage) => void | Promise<void>) | undefined;
        const requestSaveInterceptors: Array<(requestId: string) => void> = [];

        const fakeWebview = {
            cspSource: 'vscode-webview://fake',
            options: {} as vscode.WebviewOptions,
            html: '',
            asWebviewUri: (uri: vscode.Uri) =>
                vscode.Uri.parse(`https://fake-webview.test${uri.path}`),
            onDidReceiveMessage: (cb: (msg: PostedMessage) => void | Promise<void>) => {
                messageHandler = cb;
                return new vscode.Disposable(() => { messageHandler = undefined; });
            },
            postMessage: async (msg: PostedMessage) => {
                posted.push(msg);
                if (msg.type === 'requestSave' && requestSaveInterceptors.length > 0) {
                    const cb = requestSaveInterceptors.shift()!;
                    setTimeout(() => cb(String(msg.requestId)), 0);
                }
                return true;
            },
        };
        const fakePanel = {
            webview: fakeWebview,
            onDidDispose: (_cb: () => void) => new vscode.Disposable(() => undefined),
        } as unknown as vscode.WebviewPanel;

        await provider.resolveCustomEditor(
            document,
            fakePanel,
            new vscode.CancellationTokenSource().token
        );
        assert.ok(messageHandler, 'host did not register onDidReceiveMessage');

        return {
            provider: provider as Harness['provider'],
            document: document as Harness['document'],
            messageHandler: messageHandler!,
            posted,
            cleanup: async () => {
                try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); }
                catch { /* best-effort */ }
            },
            interceptNextRequestSave: (cb) => { requestSaveInterceptors.push(cb); },
        };
    }

    function sha256(buf: Uint8Array | Buffer): string {
        return crypto.createHash('sha256').update(buf).digest('hex');
    }

    // ---------- Test 6a — MANDATORY: cross-format Save As round-trip ---------

    test('6a — saveCustomDocumentAs (PNG → JPG) writes JPEG to disk; source PNG unchanged', async function () {
        this.timeout(15_000);
        const h = await makeHarness(FIXTURE_2x2_PNG, 'src.png');
        const stub = installWarnStub('Save Anyway');
        try {
            // Pre: capture source SHA-256 to prove non-mutation post-save.
            const sourceBytesBefore = await fs.promises.readFile(h.document.uri.fsPath);
            const sourceShaBefore = sha256(sourceBytesBefore);

            // Destination .jpg in the same tmp dir.
            const tmpDir = path.dirname(h.document.uri.fsPath);
            const destPath = path.join(tmpDir, 'out.jpg');
            const destUri = vscode.Uri.file(destPath);

            // Synthetic JPEG bytes the "webview" will return. JFIF magic
            // (0xff 0xd8 0xff 0xe0) + minimal payload — content does not need
            // to be a fully decodable JPEG; we only assert magic bytes + that
            // the bytes-on-disk match what the webview emitted.
            const fakeJpegBytes = new Uint8Array([
                0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
                0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
                // ... arbitrary trailing payload ...
                0xff, 0xd9, // EOI marker
            ]);

            h.interceptNextRequestSave((requestId) => {
                Promise.resolve(h.messageHandler({
                    type: 'saveResult',
                    requestId,
                    bytes: Array.from(fakeJpegBytes),
                    format: 'JPG',
                    filename: 'out.jpg',
                    mime: 'image/jpeg',
                })).catch(() => undefined);
            });

            await h.provider.saveCustomDocumentAs(
                h.document,
                destUri,
                new vscode.CancellationTokenSource().token
            );

            // ── load-bearing assertion (Test 6a) ──
            // 1. Destination file exists with JPEG magic bytes.
            const onDisk = await fs.promises.readFile(destPath);
            assert.ok(onDisk.length >= 4, 'destination file must have at least 4 bytes');
            const isJfif = onDisk[0] === 0xff && onDisk[1] === 0xd8 &&
                           onDisk[2] === 0xff && onDisk[3] === 0xe0;
            const isExif = onDisk[0] === 0xff && onDisk[1] === 0xd8 &&
                           onDisk[2] === 0xff && onDisk[3] === 0xe1;
            assert.ok(
                isJfif || isExif,
                `destination must start with JPEG magic (ff d8 ff e0 OR ff d8 ff e1); ` +
                `got: ${onDisk[0].toString(16)} ${onDisk[1].toString(16)} ${onDisk[2].toString(16)} ${onDisk[3].toString(16)}`
            );

            // 2. On-disk bytes are NOT byte-identical to the source PNG.
            assert.notStrictEqual(
                sha256(onDisk),
                sourceShaBefore,
                'on-disk JPEG must differ from source PNG'
            );

            // 3. Source PNG file at document.uri is unchanged (SHA-256 pre vs post).
            const sourceBytesAfter = await fs.promises.readFile(h.document.uri.fsPath);
            assert.strictEqual(
                sha256(sourceBytesAfter),
                sourceShaBefore,
                'source PNG SHA-256 must be unchanged after Save As'
            );

            // 4. Warning was shown exactly once (cross-format triggers it).
            assert.strictEqual(stub.callCount, 1,
                `expected exactly 1 showWarningMessage call; saw ${stub.callCount}`);
            assert.match(stub.lastMessage, /\.png/, 'warning should mention .png');
            assert.match(stub.lastMessage, /\.jpg/, 'warning should mention .jpg');
        } finally {
            stub.restore();
            await h.cleanup();
        }
    });

    // ---------- Test 6b — Cancel aborts the save ----------------------------

    test('6b — lossy-warning Cancel aborts saveCustomDocumentAs (no dest file)', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_2x2_PNG, 'src.png');
        const stub = installWarnStub(undefined); // 'Cancel' / dismiss
        try {
            const tmpDir = path.dirname(h.document.uri.fsPath);
            const destPath = path.join(tmpDir, 'cancelled.jpg');
            const destUri = vscode.Uri.file(destPath);

            let rejection: Error | null = null;
            try {
                await h.provider.saveCustomDocumentAs(
                    h.document,
                    destUri,
                    new vscode.CancellationTokenSource().token
                );
            } catch (err) { rejection = err as Error; }
            assert.ok(rejection, 'saveCustomDocumentAs should reject when user cancels');
            assert.match(
                rejection!.message,
                /Save As cancelled/,
                `expected cancellation message; got: ${rejection!.message}`
            );

            // Destination must not exist.
            let destExists = true;
            try { await fs.promises.stat(destPath); } catch { destExists = false; }
            assert.strictEqual(destExists, false,
                'destination file must NOT exist when user cancelled the warning');

            // Warning was shown exactly once with both extensions.
            assert.strictEqual(stub.callCount, 1,
                `expected exactly 1 showWarningMessage call; saw ${stub.callCount}`);
            assert.match(stub.lastMessage, /\.png/, 'warning should mention .png');
            assert.match(stub.lastMessage, /\.jpg/, 'warning should mention .jpg');
        } finally {
            stub.restore();
            await h.cleanup();
        }
    });

    // ---------- Test 6c — Same-format Save As skips the warning -------------

    test('6c — same-format Save As succeeds without firing the warning', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_2x2_PNG, 'src.png');
        // Spy on showWarningMessage; if it fires, count goes up and we fail.
        const stub = installWarnStub('Save Anyway');
        try {
            const tmpDir = path.dirname(h.document.uri.fsPath);
            const destPath = path.join(tmpDir, 'copy.png');
            const destUri = vscode.Uri.file(destPath);

            const synthBytes = new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                // ... minimal junk payload, host doesn't decode ...
                0x00, 0x00, 0x00, 0x00,
            ]);

            h.interceptNextRequestSave((requestId) => {
                Promise.resolve(h.messageHandler({
                    type: 'saveResult',
                    requestId,
                    bytes: Array.from(synthBytes),
                    format: 'PNG',
                    filename: 'copy.png',
                    mime: 'image/png',
                })).catch(() => undefined);
            });

            await h.provider.saveCustomDocumentAs(
                h.document,
                destUri,
                new vscode.CancellationTokenSource().token
            );

            // Bytes at the new path begin with PNG magic.
            const onDisk = await fs.promises.readFile(destPath);
            assert.ok(
                onDisk[0] === 0x89 && onDisk[1] === 0x50 &&
                onDisk[2] === 0x4e && onDisk[3] === 0x47,
                `destination must start with PNG magic; got: ${onDisk[0].toString(16)} ${onDisk[1].toString(16)} ${onDisk[2].toString(16)} ${onDisk[3].toString(16)}`
            );

            // Warning was NOT shown (same-format path).
            assert.strictEqual(stub.callCount, 0,
                `same-format Save As must NOT fire the warning; got ${stub.callCount} calls`);
        } finally {
            stub.restore();
            await h.cleanup();
        }
    });

    // ---------- Test 6d — JSON Save As throws Gate 1 ------------------------

    test('6d — Save As to .json throws unsupported-extension error', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_2x2_PNG, 'src.png');
        // Stub Save Anyway so the warning resolves; we want to test that
        // Gate 1 rejects unsupported .json AFTER the warning click-through.
        const stub = installWarnStub('Save Anyway');
        try {
            const sourceShaBefore = sha256(await fs.promises.readFile(h.document.uri.fsPath));

            const tmpDir = path.dirname(h.document.uri.fsPath);
            const destPath = path.join(tmpDir, 'layers.json');
            const destUri = vscode.Uri.file(destPath);

            let rejection: Error | null = null;
            try {
                await h.provider.saveCustomDocumentAs(
                    h.document,
                    destUri,
                    new vscode.CancellationTokenSource().token
                );
            } catch (err) { rejection = err as Error; }
            assert.ok(rejection, 'saveCustomDocumentAs should reject .json destination');
            assert.match(
                rejection!.message,
                /extension "\.json" is not supported/,
                `expected Gate 1 unsupported-extension error; got: ${rejection!.message}`
            );

            // Source PNG is unchanged.
            const sourceShaAfter = sha256(await fs.promises.readFile(h.document.uri.fsPath));
            assert.strictEqual(
                sourceShaBefore, sourceShaAfter,
                'source PNG must be unchanged after rejected JSON Save As'
            );
        } finally {
            stub.restore();
            await h.cleanup();
        }
    });

    // ---------- Test 6e — GIF cross-format throws BEFORE warning (override) -

    test('6e — GIF cross-format Save As throws fast (does NOT show the warning)', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_2x2_PNG, 'src.png');
        // Per orchestrator override: GIF check fires BEFORE the lossy warning.
        // We do NOT install a Save-Anyway stub; if the warning DID fire, the
        // unstubbed showWarningMessage in test mode would either hang or
        // resolve undefined, neither of which we want to depend on.
        // Use a stub that ASSERTS-FALSE if called: any call indicates the
        // override was implemented incorrectly.
        let warnCalled = false;
        const original = vscode.window.showWarningMessage;
        (vscode.window as unknown as { showWarningMessage: (...a: unknown[]) => Thenable<string | undefined> })
            .showWarningMessage = (..._args: unknown[]) => {
                warnCalled = true;
                return Promise.resolve(undefined);
            };
        try {
            const tmpDir = path.dirname(h.document.uri.fsPath);
            const destPath = path.join(tmpDir, 'out.gif');
            const destUri = vscode.Uri.file(destPath);

            let rejection: Error | null = null;
            try {
                await h.provider.saveCustomDocumentAs(
                    h.document,
                    destUri,
                    new vscode.CancellationTokenSource().token
                );
            } catch (err) { rejection = err as Error; }
            assert.ok(rejection, 'GIF cross-format Save As must reject');
            assert.match(
                rejection!.message,
                /Save As to GIF across formats is not supported/,
                `expected GIF-deferral error; got: ${rejection!.message}`
            );

            // Override assertion: warning must NOT have been shown.
            assert.strictEqual(warnCalled, false,
                'GIF check must fire BEFORE the lossy-conversion warning (orchestrator override)');

            // Destination must not exist.
            let destExists = true;
            try { await fs.promises.stat(destPath); } catch { destExists = false; }
            assert.strictEqual(destExists, false,
                'GIF destination must NOT exist after rejection');
        } finally {
            (vscode.window as unknown as { showWarningMessage: typeof original })
                .showWarningMessage = original;
            await h.cleanup();
        }
    });
});

// ---------- Phase 6.6 tests (unsolicited saveResult + Print sentinel) -----

/**
 * Phase 6.6 tests (see .orchestrator/phase6.6-design.md §Tests).
 *
 *   6.6b — Unsolicited saveResult (no matching requestId, not __print__) →
 *          showSaveDialog returns a tmp Uri → file written; SHA-256 match;
 *          info toast asserted.
 *   6.6c — Cancelled showSaveDialog → no file written, no error toast.
 *   6.6d — saveResult with requestId='__print__' → tmp PNG written;
 *          openExternal called with vscode.Uri.file(tmpPath); info toast.
 */
suite('Paintbox Phase 6.6 — Unsolicited saveResult + Print sentinel', () => {
    interface PostedMessage { type: string; [k: string]: unknown }

    interface Harness {
        provider: { __pbTestIsDirty: (uri: vscode.Uri) => boolean };
        document: { uri: vscode.Uri; mime: string };
        messageHandler: (m: PostedMessage) => void | Promise<void>;
        cleanup: () => Promise<void>;
    }

    async function makeHarness(fixturePath: string, fixtureBaseName: string): Promise<Harness> {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const providerModule = require('../../editorProvider');
        const Provider = providerModule.PaintboxEditorProvider;

        const ext = vscode.extensions.getExtension('NateDogDotNet.paintbox');
        await ext!.activate();

        const extensionUri = vscode.Uri.file(REPO_ROOT);
        const fakeContext = {
            extensionUri,
            extensionPath: REPO_ROOT,
            subscriptions: [] as vscode.Disposable[],
        } as unknown as vscode.ExtensionContext;
        const provider = new Provider(fakeContext);

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paintbox-66-'));
        const tmpFile = path.join(tmpDir, fixtureBaseName);
        await fs.promises.copyFile(fixturePath, tmpFile);
        const tmpUri = vscode.Uri.file(tmpFile);

        const document = await provider.openCustomDocument(
            tmpUri,
            { backupId: undefined } as unknown as vscode.CustomDocumentOpenContext,
            new vscode.CancellationTokenSource().token
        );

        let messageHandler: ((msg: PostedMessage) => void | Promise<void>) | undefined;

        const fakeWebview = {
            cspSource: 'vscode-webview://fake',
            options: {} as vscode.WebviewOptions,
            html: '',
            asWebviewUri: (uri: vscode.Uri) =>
                vscode.Uri.parse(`https://fake-webview.test${uri.path}`),
            onDidReceiveMessage: (cb: (msg: PostedMessage) => void | Promise<void>) => {
                messageHandler = cb;
                return new vscode.Disposable(() => { messageHandler = undefined; });
            },
            postMessage: async (_msg: PostedMessage) => true,
        };
        const fakePanel = {
            webview: fakeWebview,
            onDidDispose: (_cb: () => void) => new vscode.Disposable(() => undefined),
        } as unknown as vscode.WebviewPanel;

        await provider.resolveCustomEditor(
            document,
            fakePanel,
            new vscode.CancellationTokenSource().token
        );
        assert.ok(messageHandler, 'host did not register onDidReceiveMessage');

        return {
            provider: provider as Harness['provider'],
            document: document as Harness['document'],
            messageHandler: messageHandler!,
            cleanup: async () => {
                try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); }
                catch { /* best-effort */ }
            },
        };
    }

    function sha256(buf: Uint8Array | Buffer): string {
        return crypto.createHash('sha256').update(buf).digest('hex');
    }

    /**
     * Monkey-patch helper for `vscode.window.showSaveDialog` /
     * showInformationMessage / showErrorMessage. Restored via the returned
     * `restore()` regardless of pass/fail.
     */
    function installDialogStubs(saveDialogResponse: vscode.Uri | undefined) {
        const origShowSaveDialog = vscode.window.showSaveDialog;
        const origShowInfo = vscode.window.showInformationMessage;
        const origShowError = vscode.window.showErrorMessage;
        let saveDialogCalls = 0;
        let lastDefaultUri: vscode.Uri | undefined;
        const infoMessages: string[] = [];
        const errorMessages: string[] = [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showSaveDialog = async (opts?: vscode.SaveDialogOptions) => {
            saveDialogCalls++;
            lastDefaultUri = opts?.defaultUri;
            return saveDialogResponse;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = async (msg: string) => {
            infoMessages.push(msg);
            return undefined;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showErrorMessage = async (msg: string) => {
            errorMessages.push(msg);
            return undefined;
        };
        return {
            get saveDialogCalls() { return saveDialogCalls; },
            get lastDefaultUri() { return lastDefaultUri; },
            get infoMessages() { return infoMessages; },
            get errorMessages() { return errorMessages; },
            restore() {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (vscode.window as any).showSaveDialog = origShowSaveDialog;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (vscode.window as any).showInformationMessage = origShowInfo;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (vscode.window as any).showErrorMessage = origShowError;
            },
        };
    }

    // ---------- Test 6.6b — unsolicited saveResult writes user-chosen path -

    test('6.6b — unsolicited saveResult writes user-chosen path (SHA-256 match)', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'open.png');
        const tmpDestDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paintbox-66b-'));
        const destPath = path.join(tmpDestDir, 'export.png');
        const destUri = vscode.Uri.file(destPath);
        const stubs = installDialogStubs(destUri);
        try {
            // The bytes the "webview" emitted (use the 2x2 fixture so the
            // file is non-trivial and SHA-256 is auditable).
            const webviewBytes = await fs.promises.readFile(FIXTURE_2x2_PNG);
            const webviewSha = sha256(webviewBytes);

            await Promise.resolve(h.messageHandler({
                type: 'saveResult',
                // No requestId — unsolicited path.
                bytes: Array.from(webviewBytes),
                format: 'PNG',
                filename: 'export.png',
                mime: 'image/png',
            }));

            // Allow the host's awaited writeFile to settle.
            await new Promise<void>((resolve) => setTimeout(resolve, 50));

            // showSaveDialog was called exactly once.
            assert.strictEqual(stubs.saveDialogCalls, 1,
                `expected 1 showSaveDialog call; saw ${stubs.saveDialogCalls}`);
            // defaultUri uses the open document's parent dir + msg.filename.
            assert.ok(stubs.lastDefaultUri, 'showSaveDialog should be passed defaultUri');
            assert.strictEqual(
                path.basename(stubs.lastDefaultUri!.fsPath),
                'export.png',
                `defaultUri filename should be export.png; got: ${stubs.lastDefaultUri!.fsPath}`
            );

            // File written, SHA-256 match.
            const onDisk = await fs.promises.readFile(destPath);
            assert.strictEqual(
                sha256(onDisk),
                webviewSha,
                'on-disk bytes must hash-match the webview-emitted bytes'
            );

            // Info toast asserted.
            const savedToast = stubs.infoMessages.find((m) => /Paintbox: saved/.test(m));
            assert.ok(savedToast,
                `expected a 'Paintbox: saved …' info toast; saw: ${JSON.stringify(stubs.infoMessages)}`);
            assert.match(savedToast!, /export\.png/,
                `toast should mention the saved basename; got: ${savedToast}`);
            // No error toast.
            assert.strictEqual(stubs.errorMessages.length, 0,
                `unexpected error toast(s): ${JSON.stringify(stubs.errorMessages)}`);
        } finally {
            stubs.restore();
            await fs.promises.rm(tmpDestDir, { recursive: true, force: true }).catch(() => undefined);
            await h.cleanup();
        }
    });

    // ---------- Test 6.6c — cancelled showSaveDialog → no write -----------

    test('6.6c — cancelled showSaveDialog → no file written, no error toast', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'open.png');
        const tmpDestDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paintbox-66c-'));
        const destPath = path.join(tmpDestDir, 'cancelled.png');
        const stubs = installDialogStubs(undefined); // user cancels
        try {
            const webviewBytes = await fs.promises.readFile(FIXTURE_2x2_PNG);

            await Promise.resolve(h.messageHandler({
                type: 'saveResult',
                bytes: Array.from(webviewBytes),
                format: 'PNG',
                filename: 'cancelled.png',
                mime: 'image/png',
            }));

            // Allow async path to settle.
            await new Promise<void>((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(stubs.saveDialogCalls, 1,
                `expected 1 showSaveDialog call; saw ${stubs.saveDialogCalls}`);

            // Destination file must NOT exist.
            let destExists = true;
            try { await fs.promises.stat(destPath); } catch { destExists = false; }
            assert.strictEqual(destExists, false,
                'no file should be written when user cancels showSaveDialog');

            // No info toast (silent no-op).
            assert.strictEqual(stubs.infoMessages.length, 0,
                `unexpected info toast on cancellation: ${JSON.stringify(stubs.infoMessages)}`);
            // No error toast.
            assert.strictEqual(stubs.errorMessages.length, 0,
                `unexpected error toast on cancellation: ${JSON.stringify(stubs.errorMessages)}`);
        } finally {
            stubs.restore();
            await fs.promises.rm(tmpDestDir, { recursive: true, force: true }).catch(() => undefined);
            await h.cleanup();
        }
    });

    // ---------- Test 6.6d — __print__ sentinel writes tmp PNG + actionable toast

    test('6.6d — __print__ requestId writes tmp PNG and surfaces actionable toast', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'open.png');

        // Phase 6.7: openExternal is no longer called from the print path. We
        // stub showInformationMessage to capture the toast (text + button
        // label) AND simulate the user clicking the "Reveal in Explorer"
        // action. The print path then runs `vscode.commands.executeCommand
        // ('revealFileInOS', tmpUri)`, which we stub to capture the call.
        const origShowInfo = vscode.window.showInformationMessage;
        const infoMessages: string[] = [];
        const infoButtons: string[][] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = async (msg: string, ...items: string[]) => {
            infoMessages.push(msg);
            infoButtons.push(items);
            // Simulate the user clicking "Reveal in Explorer" if it was
            // offered, so we can assert the executeCommand follow-up.
            if (items.includes('Reveal in Explorer')) {
                return 'Reveal in Explorer';
            }
            return undefined;
        };
        const origShowError = vscode.window.showErrorMessage;
        const errorMessages: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showErrorMessage = async (msg: string) => {
            errorMessages.push(msg);
            return undefined;
        };
        const origExecuteCommand = vscode.commands.executeCommand;
        const executeCommandCalls: Array<{ command: string; args: unknown[] }> = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
            executeCommandCalls.push({ command, args });
            return undefined;
        };

        try {
            const webviewBytes = await fs.promises.readFile(FIXTURE_2x2_PNG);

            await Promise.resolve(h.messageHandler({
                type: 'saveResult',
                requestId: '__print__',
                bytes: Array.from(webviewBytes),
                format: 'PNG',
                filename: 'print.png',
                mime: 'image/png',
            }));

            // Allow the awaited writeFile + showInformationMessage to settle.
            await new Promise<void>((resolve) => setTimeout(resolve, 50));

            // Info toast asserted: text mentions tmp path, button label was
            // passed as a second argument.
            assert.strictEqual(infoMessages.length, 1,
                `expected 1 showInformationMessage call; saw ${infoMessages.length}`);
            const printToast = infoMessages[0];
            assert.match(printToast, /print artifact saved at/,
                `expected toast text to match /print artifact saved at/; got: ${printToast}`);
            // Extract the tmp path from the toast text and verify it's under
            // os.tmpdir() with the expected paintbox-print-*.png basename.
            const tmpPath = printToast.replace(/^Paintbox: print artifact saved at /, '');
            assert.ok(tmpPath.startsWith(os.tmpdir()),
                `tmp path should be under os.tmpdir(); got: ${tmpPath}`);
            assert.match(path.basename(tmpPath), /^paintbox-print-.*\.png$/,
                `tmp filename should match paintbox-print-*.png; got: ${path.basename(tmpPath)}`);

            // Button label asserted: 'Reveal in Explorer' must have been
            // passed as a positional arg to showInformationMessage.
            assert.deepStrictEqual(infoButtons[0], ['Reveal in Explorer'],
                `expected ['Reveal in Explorer'] button label; got: ${JSON.stringify(infoButtons[0])}`);

            // The tmp PNG was actually written; bytes match the webview emit.
            const onDisk = await fs.promises.readFile(tmpPath);
            assert.strictEqual(
                sha256(onDisk),
                sha256(webviewBytes),
                'tmp PNG bytes must hash-match the webview-emitted bytes'
            );

            // Simulated button click: revealFileInOS was invoked with the tmp Uri.
            assert.strictEqual(executeCommandCalls.length, 1,
                `expected 1 executeCommand call; saw ${executeCommandCalls.length}`);
            assert.strictEqual(executeCommandCalls[0].command, 'revealFileInOS',
                `expected revealFileInOS command; got: ${executeCommandCalls[0].command}`);
            const revealUri = executeCommandCalls[0].args[0] as vscode.Uri;
            assert.strictEqual(revealUri.fsPath, tmpPath,
                `revealFileInOS Uri must equal the tmp path; got: ${revealUri.fsPath}`);

            assert.strictEqual(errorMessages.length, 0,
                `unexpected error toast: ${JSON.stringify(errorMessages)}`);

            // Cleanup the tmp artifact (best-effort).
            await fs.promises.unlink(tmpPath).catch(() => undefined);
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInformationMessage = origShowInfo;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showErrorMessage = origShowError;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.commands as any).executeCommand = origExecuteCommand;
            await h.cleanup();
        }
    });
});
