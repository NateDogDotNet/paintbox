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
        // Synthesize a `saveResult` and a `saveError` message — neither has
        // a matching pending requestId, so under Phase 5 default-4 the
        // handler logs and ignores. Either way it must NOT throw.

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

    // ---------- Test 5f — saveCustomDocumentAs cross-format rejection -----

    test('5f — saveCustomDocumentAs rejects cross-format with Phase-6 deferral', async function () {
        this.timeout(10_000);
        const h = await makeHarness(FIXTURE_1x1_PNG, 'crossfmt.png');
        try {
            // Different extension from the document URI.
            const tmpDir = path.dirname(h.document.uri.fsPath);
            const destUri = vscode.Uri.file(path.join(tmpDir, 'crossfmt.jpg'));

            let rejection: Error | null = null;
            try {
                await h.provider.saveCustomDocumentAs(
                    h.document,
                    destUri,
                    new vscode.CancellationTokenSource().token
                );
            } catch (err) { rejection = err as Error; }
            assert.ok(rejection, 'saveCustomDocumentAs should reject cross-format');
            assert.match(
                rejection!.message,
                /Save As across formats is implemented in Phase 6/,
                `expected Phase 6 deferral message; got: ${rejection!.message}`
            );
        } finally {
            await h.cleanup();
        }
    });
});
