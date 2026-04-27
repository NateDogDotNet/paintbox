import * as vscode from 'vscode';
import { PaintboxEditorProvider } from './editorProvider';
import { verifyPatchedBundle } from './patchMinipaintBundle';

/**
 * Extension entry point.
 *
 * Phase map (see docs/integration-plan.md):
 *   Phase 1 — vendor miniPaint (submodule or copy into vendor/minipaint/)
 *   Phase 2 — this file: register the CustomEditorProvider (done as stub below)
 *   Phase 3 — editorProvider.ts: open-file → webview postMessage
 *   Phase 4 — miniPaint save hook: postMessage back to host
 *   Phase 5 — editorProvider.ts: host-side writeFile
 *   Phase 6 — save-as, format conversion
 *   Phase 7 — package + publish to Open VSX
 */
export function activate(context: vscode.ExtensionContext): void {
    // Phase 4 (per .orchestrator/phase4-design.md §2c + override Q1):
    // verify the patched miniPaint bundle artifact exists and is intact.
    // The patch runs at build time only (scripts/patch-bundle.js), so any
    // failure here means the VSIX shipped without the artifact OR a local
    // checkout never ran `npm run compile`. Throw before registering the
    // provider — the user sees "Activating extension 'paintbox' failed:
    // Paintbox: patched miniPaint bundle missing or corrupt …".
    verifyPatchedBundle(context.extensionPath);

    const provider = PaintboxEditorProvider.register(context);
    context.subscriptions.push(provider);

    console.log('paintbox: activated');
}

export function deactivate(): void {
    // Nothing to clean up at this stage.
}
