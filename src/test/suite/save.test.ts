import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vm from 'vm';
import * as vscode from 'vscode';

/**
 * Phase 4 tests (see .orchestrator/phase4-design.md §8):
 *
 *   4a — UNIT: window.__pbBridge.saveAs(blob, fname) serializes to a
 *        `saveResult` postMessage with the expected fields. Runs the shim
 *        IIFE in a sandboxed VM with a minimal browser stub.
 *   4b — INTEGRATION: bypass-popup. resolveCustomEditor receives a
 *        `saveResult` message synthesized as if the bridge had posted it,
 *        and editorProvider's logging branch fires without throwing.
 *   (4c lives in extension.test.ts — activation integrity check.)
 *
 * Why VM-driven 4a instead of @vscode/test-electron-driven: the shim is
 * compiled to out/webview/shim.js and runs as an IIFE. Loading it inside the
 * Extension Development Host requires a real webview, which the
 * @vscode/test-electron harness doesn't surface. A VM context with a Blob
 * polyfill exercises the same load-bearing IIFE code path with full
 * assertion coverage and zero flake risk.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SHIM_PATH = path.join(REPO_ROOT, 'out', 'webview', 'shim.js');

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
            console: { log: () => undefined, error: () => undefined },
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

    test('4b — host onDidReceiveMessage logs saveResult without throwing', async () => {
        // Drive the Phase 4 host log path WITHOUT spinning up a real webview.
        // Per §8 Test 4b "bypass-popup" — synthesize the saveResult message
        // as if the bridge had posted it, and verify editorProvider's switch
        // case fires (logs only in Phase 4).

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

        // Fixture URI (existence is fine; postLoad reads bytes but we don't
        // care about that path here).
        const fixturePng = path.join(REPO_ROOT, 'src', 'test', 'suite', 'fixtures', 'pixel.png');
        const fixtureUri = vscode.Uri.file(fixturePng);

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

        // VS Code's extension host wires console output through an IPC
        // channel that bypasses both `process.stdout.write` and direct
        // `console.log` reassignment in ways that vary across VS Code
        // versions. Rather than fight the host, we use TWO observable
        // checkpoints: (a) the messageHandler must not throw on `saveResult`
        // or `saveError`; (b) the editorProvider source must contain the
        // `saveResult received` log statement (smoke that the case branch
        // wasn't accidentally removed).

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

        // Source-level smoke: editorProvider has the saveResult log statement.
        // (Phase 5 turns this into a writeFile assertion.)
        const epSrc = fs.readFileSync(
            path.join(REPO_ROOT, 'out', 'editorProvider.js'),
            'utf8'
        );
        assert.ok(
            epSrc.includes('saveResult received'),
            'expected editorProvider to log "[paintbox] saveResult received"'
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
