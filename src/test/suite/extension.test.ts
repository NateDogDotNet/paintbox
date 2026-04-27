import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Phase 2 smoke test (see docs/integration-plan.md):
 *   - Extension activates without throwing.
 *   - The custom editor `paintbox.imageEditor` is wired up such that
 *     `vscode.openWith` resolves a webview without throwing.
 *   - The placeholder HTML contains the expected marker text and the file URI.
 *
 * The third assertion reaches into the compiled provider directly via require()
 * to call `_getPlaceholderHtml`. That is intentional for Phase 2: the placeholder
 * is the contract being tested, and reading it back from a webview after open
 * is racy in the test harness. When Phase 3 replaces the placeholder with the
 * miniPaint HTML, this direct call should be removed and replaced with a check
 * for the loaded miniPaint markup.
 */

const EXTENSION_ID = 'NateDogDotNet.paintbox';

suite('Paintbox Phase 2 — Extension Shell', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paintbox-test-'));
    const fixturePng = path.join(tmpDir, 'fixture.png');
    let fixtureUri: vscode.Uri;

    suiteSetup(() => {
        // 1x1 transparent PNG (smallest valid PNG, 67 bytes).
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
            0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
            0x42, 0x60, 0x82,
        ]);
        fs.writeFileSync(fixturePng, pngBytes);
        fixtureUri = vscode.Uri.file(fixturePng);
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
            fixtureUri,
            'paintbox.imageEditor'
        );

        // Close the editor to keep the harness clean.
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    test('placeholder HTML contains the marker text and the file URI', async () => {
        // Import the compiled provider and call the placeholder method directly.
        // The method is private at the TS level, so reach in via bracket access on
        // an instance. We build a minimal fake ExtensionContext — the placeholder
        // method does not consult it.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const providerModule = require('../../editorProvider');
        const Provider = providerModule.PaintboxEditorProvider;
        assert.ok(Provider, 'PaintboxEditorProvider not exported');

        const fakeContext = {} as vscode.ExtensionContext;
        const instance = new Provider(fakeContext);
        const html: string = instance['_getPlaceholderHtml'](fixtureUri);

        assert.ok(
            html.includes('Paintbox — Image Editor'),
            'placeholder HTML missing "Paintbox — Image Editor" marker'
        );
        assert.ok(
            html.includes(fixtureUri.fsPath),
            `placeholder HTML missing file URI ${fixtureUri.fsPath}`
        );
    });
});
