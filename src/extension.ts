import * as vscode from 'vscode';
import { PaintboxEditorProvider } from './editorProvider';

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
    // TODO (Phase 2): Wire through the ExtensionContext so editorProvider
    // can resolve the miniPaint HTML path and set up the webview.
    const provider = PaintboxEditorProvider.register(context);
    context.subscriptions.push(provider);

    console.log('paintbox: activated');
}

export function deactivate(): void {
    // Nothing to clean up at this stage.
}
