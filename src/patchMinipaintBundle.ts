// Build-time helper: read vendor/minipaint/dist/bundle.js, replace the 8
// `p().saveAs(` call sites with `(window.__pbBridge||p()).saveAs(`, and write
// the result to out/webview/minipaint-bundle.patched.js.
//
// Per .orchestrator/phase4-design.md §2b plus orchestrator override Q1:
//   - Build-time only. `npm run compile` runs this. The VSIX ships pre-patched.
//   - Activation only verifies the artifact (verifyPatchedBundle below).
//   - Integrity check: exactly 8 occurrences of `p().saveAs(` in the source
//     bundle. Anything else throws so an upstream bump fails loud.
//
// Per orchestrator override Q9 file location: this helper lives in src/ (built
// by the host tsconfig.json) because it uses Node `fs`/`path`. It must NOT live
// in src/webview/ — that build is browser-only (lib: ES2020+DOM, types: []).

import * as fs from 'fs';
import * as path from 'path';

const SAVE_AS_PATTERN = /p\(\)\.saveAs\(/g;
const PATCHED_REPLACEMENT = '((typeof window!=="undefined"&&window.__pbBridge)||p()).saveAs(';
export const EXPECTED_SITES = 8;
export const PAINTBOX_HEADER =
    '/* PAINTBOX-BUNDLE-PATCH v1: ' +
    'p\\(\\)\\.saveAs\\( replaced ' + EXPECTED_SITES + 'x */\n';

function bundleSrc(extensionRoot: string): string {
    return path.join(extensionRoot, 'vendor', 'minipaint', 'dist', 'bundle.js');
}

function bundleOut(extensionRoot: string): string {
    return path.join(extensionRoot, 'out', 'webview', 'minipaint-bundle.patched.js');
}

/**
 * Read the upstream bundle, run the integrity check, and write the patched
 * bundle to `out/webview/minipaint-bundle.patched.js`. Idempotent — if the
 * output already matches the desired contents, no write happens.
 *
 * Throws if the source bundle's `p().saveAs(` count is not exactly
 * EXPECTED_SITES, so an upstream bump that silently changes the surface fails
 * at build time rather than at runtime.
 */
export function patchMinipaintBundle(extensionRoot: string): string {
    const src = bundleSrc(extensionRoot);
    const out = bundleOut(extensionRoot);
    const original = fs.readFileSync(src, 'utf8');

    const matches = original.match(SAVE_AS_PATTERN);
    if (!matches || matches.length !== EXPECTED_SITES) {
        throw new Error(
            'Paintbox: miniPaint bundle integrity check failed. ' +
            'Expected ' + EXPECTED_SITES + ' "p().saveAs(" call sites, found ' +
            (matches ? matches.length : 0) + '. ' +
            'The vendored bundle may have been updated upstream — ' +
            're-run the audit in .orchestrator/phase4-design.md §1 ' +
            'before proceeding.'
        );
    }

    const patched = PAINTBOX_HEADER + original.replace(
        SAVE_AS_PATTERN,
        PATCHED_REPLACEMENT
    );

    // Idempotent fast path: don't rewrite if the file already matches.
    if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === patched) {
        return out;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, patched, 'utf8');

    // Source map: copy alongside (the patched bundle's offsets shift, so the
    // source map will be slightly off — acceptable for Phase 4. Phase 7 may
    // revisit if mismatched offsets become an issue.)
    const srcMap = path.join(extensionRoot, 'vendor', 'minipaint', 'dist', 'bundle.js.map');
    const outMap = out + '.map';
    if (fs.existsSync(srcMap) && !fs.existsSync(outMap)) {
        fs.copyFileSync(srcMap, outMap);
    }
    return out;
}

/**
 * Activation-time verifier (no filesystem writes).
 *
 * Confirms `out/webview/minipaint-bundle.patched.js` exists and contains
 * exactly EXPECTED_SITES patched call sites with zero remaining bare
 * `p().saveAs(` matches. Throws a user-readable error if any check fails;
 * `activate()` lets the throw bubble so VS Code surfaces "Activating
 * extension 'paintbox' failed: <reason>" — exactly what we want when the
 * VSIX or local checkout is missing the build artifact.
 */
export function verifyPatchedBundle(extensionRoot: string): void {
    const out = bundleOut(extensionRoot);
    const fail = (reason: string): never => {
        throw new Error(
            'Paintbox: patched miniPaint bundle missing or corrupt (' + reason + '). ' +
            'Run `npm run compile` to regenerate.'
        );
    };

    let stat: fs.Stats;
    try {
        stat = fs.statSync(out);
    } catch {
        return fail('artifact not found at ' + out);
    }
    if (!stat.isFile() || stat.size === 0) {
        return fail('artifact is not a non-empty file');
    }

    const contents = fs.readFileSync(out, 'utf8');
    if (!contents.startsWith(PAINTBOX_HEADER)) {
        return fail('PAINTBOX-BUNDLE-PATCH header missing or stale');
    }

    const patchedMatches = contents.match(
        /\(\(typeof window!=="undefined"&&window\.__pbBridge\)\|\|p\(\)\)\.saveAs\(/g
    );
    if (!patchedMatches || patchedMatches.length !== EXPECTED_SITES) {
        return fail(
            'expected ' + EXPECTED_SITES + ' patched call sites, found ' +
            (patchedMatches ? patchedMatches.length : 0)
        );
    }

    // After the header strip, the remaining body must contain ZERO bare
    // `p().saveAs(` strings — every site must have been rewritten.
    const body = contents.slice(PAINTBOX_HEADER.length);
    const bareMatches = body.match(SAVE_AS_PATTERN);
    if (bareMatches && bareMatches.length > 0) {
        return fail(
            'found ' + bareMatches.length + ' un-rewritten "p().saveAs(" call sites'
        );
    }
}
