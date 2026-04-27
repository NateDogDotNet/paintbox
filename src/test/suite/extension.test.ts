import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Phase 3 tests (see docs/integration-plan.md and .orchestrator/phase3-design.md):
 *
 *   1. Extension activates without throwing.
 *   2. paintbox.imageEditor opens a .png via vscode.openWith without throwing
 *      (Phase 2 carry-over; subsumes the old smoke test).
 *   3a. (UNIT) buildWebviewHtml emits the required markers (base href, CSP,
 *       miniPaint bundle script tag, shim script tag, pb_chrome overlay,
 *       data-state attribute set up).
 *   3b. (INTEGRATION) host responds to a `webviewReady` message with a `load`
 *       message carrying a data-URL and basename filename.
 *   3c. (INTEGRATION, demotable per Q5) opening the pixel.png fixture results
 *       in the webview posting `ready`.
 *
 * Phase 2's third test (`_getPlaceholderHtml` direct call) is replaced — the
 * placeholder helper has been deleted.
 */

const EXTENSION_ID = 'NateDogDotNet.paintbox';
// __dirname is out/test/suite at runtime; fixtures live in src/test/suite/fixtures.
// Compute the repo root and reach into src/. tsc doesn't copy .png assets, and a
// pretest hook is overkill for a single 67-byte file.
const FIXTURE_PNG = path.resolve(__dirname, '../../../src/test/suite/fixtures/pixel.png');

suite('Paintbox Phase 3 — Open File: Read Bytes → Webview', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paintbox-test-'));
    const tmpFixturePng = path.join(tmpDir, 'fixture.png');
    let tmpFixtureUri: vscode.Uri;
    let realFixtureUri: vscode.Uri;

    suiteSetup(() => {
        // Copy the checked-in 1x1 PNG (src/test/suite/fixtures/pixel.png, 67
        // bytes) to a tmp file so tests don't pollute the source tree. Source
        // bytes auditable from the fixture file itself; matches the byte
        // sequence used in Phase 2's smoke test.
        const fixtureBytes = fs.readFileSync(FIXTURE_PNG);
        assert.strictEqual(fixtureBytes.length, 67, 'fixtures/pixel.png unexpected size');
        fs.writeFileSync(tmpFixturePng, fixtureBytes);
        tmpFixtureUri = vscode.Uri.file(tmpFixturePng);
        realFixtureUri = vscode.Uri.file(FIXTURE_PNG);
    });

    suiteTeardown(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    });

    test('extension is present and activates without throwing', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} not found in installed extensions`);
        await ext!.activate();
        assert.strictEqual(ext!.isActive, true, 'extension failed to activate');
    });

    test('paintbox.imageEditor opens a .png via vscode.openWith without throwing', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        await ext!.activate();

        // If the view type is not registered, this command rejects.
        await vscode.commands.executeCommand(
            'vscode.openWith',
            tmpFixtureUri,
            'paintbox.imageEditor'
        );

        // Close the editor to keep the harness clean.
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    // ---------- Test 3a: HTML builder unit test ---------------------------

    test('3a — buildWebviewHtml emits required markers', () => {
        // Pure-function unit test: stub a Webview and call buildWebviewHtml directly.
        // No real webview needed — the HTML string is the contract under test.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { buildWebviewHtml } = require('../../webviewHtml');
        assert.ok(typeof buildWebviewHtml === 'function', 'buildWebviewHtml not exported');

        // Determine the extensionUri the same way the test harness's extension does:
        // two dirs up from out/test/suite (i.e. the repo root).
        const extensionPath = path.resolve(__dirname, '../../..');
        const extensionUri = vscode.Uri.file(extensionPath);

        const fakeCspSource = 'vscode-webview://fake-cspsource';
        const fakeWebview: Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'> = {
            cspSource: fakeCspSource,
            asWebviewUri: (uri: vscode.Uri) =>
                vscode.Uri.parse(`https://fake-webview.test${uri.path}`),
        };

        const html: string = buildWebviewHtml(
            fakeWebview,
            extensionUri,
            { filename: 'test.png' }
        );

        // <base href="..."> injected, points at vendor/minipaint/ (with trailing slash).
        assert.match(
            html,
            /<base href="https:\/\/fake-webview\.test[^"]*\/vendor\/minipaint\/"/,
            'expected <base href> pointing at vendor/minipaint/'
        );

        // CSP meta with the webview cspSource somewhere in script-src.
        assert.match(
            html,
            /<meta http-equiv="Content-Security-Policy"[^>]*content="[^"]*script-src[^"]*vscode-webview:\/\/fake-cspsource/,
            'expected CSP meta with cspSource in script-src'
        );

        // Phase 4: the upstream `<script src="dist/bundle.js">` is rewritten
        // to point at the paintbox-patched bundle (out/webview/...).
        assert.match(
            html,
            /<script src="https:\/\/fake-webview\.test[^"]*\/out\/webview\/minipaint-bundle\.patched\.js"/,
            'expected patched bundle <script src> via asWebviewUri'
        );
        assert.doesNotMatch(
            html,
            /<script src="dist\/bundle\.js"/,
            'upstream `<script src="dist/bundle.js">` should be rewritten in Phase 4'
        );

        // Shim script tag (rewritten via asWebviewUri to a fake-webview URL).
        assert.match(
            html,
            /<script src="https:\/\/fake-webview\.test[^"]*\/out\/webview\/shim\.js"/,
            'expected shim <script src> pointing at out/webview/shim.js via asWebviewUri'
        );

        // pb_chrome overlay div present.
        assert.match(html, /id="pb_chrome"/, 'expected #pb_chrome overlay container');

        // pb_caption element present so shim can write the basename into it.
        assert.match(html, /id="pb_caption"/, 'expected #pb_caption element');

        // Initial data-state="loading" set on body.
        assert.match(
            html,
            /<body[^>]*data-state="loading"/,
            'expected <body data-state="loading"> initial state'
        );
    });

    // ---------- Test 3b: host posts load after webviewReady ----------------

    test('3b — host posts load message after webviewReady', async () => {
        // Build a fake WebviewPanel-shaped object that exposes the bits
        // resolveCustomEditor uses. We invoke resolveCustomEditor directly
        // with the fake panel and drive the webviewReady → load round-trip
        // without spinning up a real webview.

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const providerModule = require('../../editorProvider');
        const Provider = providerModule.PaintboxEditorProvider;
        assert.ok(Provider, 'PaintboxEditorProvider not exported');

        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        await ext!.activate();

        const extensionPath = path.resolve(__dirname, '../../..');
        const extensionUri = vscode.Uri.file(extensionPath);
        const fakeContext = {
            extensionUri,
            subscriptions: [] as vscode.Disposable[],
        } as unknown as vscode.ExtensionContext;

        const provider = new Provider(fakeContext);

        const document = await provider.openCustomDocument(
            tmpFixtureUri,
            { backupId: undefined } as unknown as vscode.CustomDocumentOpenContext,
            new vscode.CancellationTokenSource().token
        );
        assert.ok(document, 'openCustomDocument returned undefined');

        type PostedMessage = { type: string; [k: string]: unknown };
        const posted: PostedMessage[] = [];
        let messageHandler: ((msg: PostedMessage) => void) | undefined;

        const fakeWebview = {
            cspSource: 'vscode-webview://fake',
            options: {} as vscode.WebviewOptions,
            html: '',
            asWebviewUri: (uri: vscode.Uri) =>
                vscode.Uri.parse(`https://fake-webview.test${uri.path}`),
            onDidReceiveMessage: (cb: (msg: PostedMessage) => void) => {
                messageHandler = cb;
                return new vscode.Disposable(() => { messageHandler = undefined; });
            },
            postMessage: async (msg: PostedMessage) => {
                posted.push(msg);
                return true;
            },
        };

        const onDisposeListeners: Array<() => void> = [];
        const fakePanel = {
            webview: fakeWebview,
            onDidDispose: (cb: () => void) => {
                onDisposeListeners.push(cb);
                return new vscode.Disposable(() => {
                    const i = onDisposeListeners.indexOf(cb);
                    if (i >= 0) onDisposeListeners.splice(i, 1);
                });
            },
        } as unknown as vscode.WebviewPanel;

        await provider.resolveCustomEditor(
            document,
            fakePanel,
            new vscode.CancellationTokenSource().token
        );

        // After resolveCustomEditor, the webview HTML must be set, and
        // onDidReceiveMessage must have registered a handler.
        assert.ok(fakeWebview.html.length > 0, 'webview.html was not set');
        assert.ok(messageHandler, 'host did not register an onDidReceiveMessage handler');

        // Simulate the shim signalling readiness.
        await Promise.resolve(messageHandler!({ type: 'webviewReady' }));

        // Allow microtasks to drain (postLoad is async — readFile + base64).
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        const loadMsg = posted.find((m) => m.type === 'load');
        assert.ok(loadMsg, `expected a 'load' postMessage; saw: ${JSON.stringify(posted)}`);
        assert.strictEqual(loadMsg!.filename, 'fixture.png', 'filename should be basename');
        assert.strictEqual(loadMsg!.mime, 'image/png', 'mime should be image/png');
        const dataUrl = String(loadMsg!.dataUrl);
        assert.ok(
            dataUrl.startsWith('data:image/png;base64,'),
            `dataUrl should be a base64 PNG data-URL; got: ${dataUrl.slice(0, 40)}…`
        );

        // Cleanup: invoke any onDispose listeners.
        for (const cb of onDisposeListeners) cb();
    });

    // ---------- Test 3c: real round-trip (demotable per Q5) ---------------

    // ---------- Test 4c: activation-time bundle integrity check ----------

    test('4c — activation verifies the patched miniPaint bundle artifact', async () => {
        // Phase 4 contract (.orchestrator/phase4-design.md §8 + override Q1):
        // activate() calls verifyPatchedBundle(extensionPath); it MUST throw
        // if the artifact is missing or corrupt. The artifact is generated
        // by `npm run compile` (chained via scripts/patch-bundle.js).
        //
        // pretest runs `npm run compile`, so by the time this test runs the
        // artifact is present and the extension activated cleanly. We assert
        // the file system invariants directly.

        const repoRoot = path.resolve(__dirname, '../../..');
        const patchedPath = path.join(repoRoot, 'out', 'webview', 'minipaint-bundle.patched.js');

        assert.ok(
            fs.existsSync(patchedPath),
            `expected patched bundle artifact at ${patchedPath}`
        );
        const stat = fs.statSync(patchedPath);
        assert.ok(stat.size > 0, 'patched bundle artifact is empty');

        const contents = fs.readFileSync(patchedPath, 'utf8');
        const firstLine = contents.split('\n', 1)[0];
        assert.strictEqual(
            firstLine,
            '/* PAINTBOX-BUNDLE-PATCH v1: p\\(\\)\\.saveAs\\( replaced 8x */',
            `unexpected first line of patched bundle: ${firstLine}`
        );

        // Exactly 8 patched call sites.
        const patchedRe = /\(\(typeof window!=="undefined"&&window\.__pbBridge\)\|\|p\(\)\)\.saveAs\(/g;
        const patchedMatches = contents.match(patchedRe);
        assert.ok(patchedMatches, 'expected patched call-site pattern in bundle');
        assert.strictEqual(
            patchedMatches.length,
            8,
            `expected 8 patched call sites, found ${patchedMatches.length}`
        );

        // Zero remaining bare `p().saveAs(` (after stripping the header).
        const header = '/* PAINTBOX-BUNDLE-PATCH v1: p\\(\\)\\.saveAs\\( replaced 8x */\n';
        const body = contents.startsWith(header) ? contents.slice(header.length) : contents;
        const bareRe = /(?:^|[^)])p\(\)\.saveAs\(/g;
        const bareMatches = body.match(bareRe);
        assert.strictEqual(
            bareMatches ? bareMatches.length : 0,
            0,
            `expected 0 bare p().saveAs( call sites in patched bundle; found ${bareMatches ? bareMatches.length : 0}`
        );

        // Activation should have run cleanly (the EDH would have failed loud
        // in beforeAll otherwise). Just sanity-check the extension is active.
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        await ext!.activate();
        assert.strictEqual(ext!.isActive, true, 'extension should be active');
    });

    test('3c — real round-trip with pixel.png shows ready (slow)', async function () {
        // This test drives the real provider via vscode.openWith. The webview
        // boots miniPaint for real, runs the shim, posts webviewReady, the
        // host posts load, the shim hands the data-URL to miniPaint, and the
        // shim eventually posts ready. We can't directly observe the webview's
        // outbound messages because vscode.openWith returns no panel handle,
        // so we just assert that the open call resolves cleanly and that no
        // error notification was raised. Per Q5 this is the "automatable
        // smoke" tier — demotion to manual is acceptable if it flakes.
        this.timeout(15000);

        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        await ext!.activate();

        let errorShown: string | undefined;
        const origShowError = vscode.window.showErrorMessage;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showErrorMessage = async (msg: string, ..._items: unknown[]) => {
            errorShown = msg;
            return undefined;
        };

        try {
            await vscode.commands.executeCommand(
                'vscode.openWith',
                realFixtureUri,
                'paintbox.imageEditor'
            );
            // Give miniPaint time to boot inside the webview and the shim's
            // double-rAF heuristic time to fire ready.
            await new Promise<void>((resolve) => setTimeout(resolve, 4000));
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showErrorMessage = origShowError;
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        assert.strictEqual(
            errorShown,
            undefined,
            `unexpected error shown by extension: ${errorShown}`
        );
    });
});
