// Build-time helper: read vendor/minipaint/dist/bundle.js, replace the 8
// `p().saveAs(` call sites with `(window.__pbBridge||p()).saveAs(`, remove the
// GIF + BMP entries from miniPaint's SAVE_TYPES dict, and write the result to
// out/webview/minipaint-bundle.patched.js.
//
// Per docs/architecture.md DC-2:
//   - Build-time only. `npm run compile` runs this. The VSIX ships pre-patched.
//   - Activation only verifies the artifact (verifyPatchedBundle below).
//   - Integrity check: exactly 8 occurrences of `p().saveAs(` in the source
//     bundle. Anything else throws so an upstream bump fails loud.
//
// Phase 6.8 adds a SECOND text-replace patch: strip the GIF + BMP entries
// from miniPaint's SAVE_TYPES dict so they vanish from the Save / Export
// dropdowns. miniPaint's GIF encoder uses a Web Worker that the webview's
// CSP blocks, and miniPaint's BMP encoder defers to canvas.toBlob('image/bmp')
// which most browsers don't ship. Hide them rather than leave a footgun.
// Same fail-loud convention: assert exactly 1 occurrence before patching.
//
// Phase 6.9 adds a THIRD text-replace patch: remove the File → Print menu
// entry (and the Ctrl+P shortcut binding it carries). VS Code webviews
// silently block `window.print()`, so the entry was a dead-end UX. Same
// fail-loud convention; same regression guard via the adjacent "Quick Save"
// menu item surviving.
//
// Per orchestrator override Q9 file location: this helper lives in src/ (built
// by the host tsconfig.json) because it uses Node `fs`/`path`. It must NOT live
// in src/webview/ — that build is browser-only (lib: ES2020+DOM, types: []).

import * as fs from 'fs';
import * as path from 'path';

const SAVE_AS_PATTERN = /p\(\)\.saveAs\(/g;
const PATCHED_REPLACEMENT = '((typeof window!=="undefined"&&window.__pbBridge)||p()).saveAs(';
export const EXPECTED_SITES = 8;

// Phase 6.8: literal substring (not a regex) — match the GIF + BMP keys
// exactly as they appear in the bundle's SAVE_TYPES dict object literal.
// Removing this substring cleanly elides both entries; the surviving dict is
// `…WEBP:"Weppy File Format",TIFF:"Tag Image File Format"…`.
const SAVE_TYPES_GIF_BMP =
    'GIF:"Graphics Interchange Format",BMP:"Windows Bitmap",';
export const SAVE_TYPES_GIF_BMP_EXPECTED_SITES = 1;

// Phase 6.9: literal substring — match the File menu's Print entry exactly.
// Adjacent context (verified at byte ~63868):
//   …target:"file/save.save_data_url"},<THIS>{divider:!0},{name:"Quick Save"…
// Removing this substring cleanly elides the Print menu entry and its
// Ctrl+P keyboard binding. The language-file occurrences of "Print" elsewhere
// in the bundle (translations) are unaffected — they don't match this exact
// menu-entry literal.
const FILE_MENU_PRINT_ENTRY =
    '{name:"Print",ellipsis:!0,shortcut:"Ctrl+P",target:"file/print.print"},';
export const FILE_MENU_PRINT_ENTRY_EXPECTED_SITES = 1;

export const PAINTBOX_HEADER =
    '/* PAINTBOX-BUNDLE-PATCH v3: ' +
    'p\\(\\)\\.saveAs\\( replaced ' + EXPECTED_SITES + 'x; ' +
    'SAVE_TYPES GIF+BMP entries removed; ' +
    'File menu Print entry removed */\n';

function bundleSrc(extensionRoot: string): string {
    return path.join(extensionRoot, 'vendor', 'minipaint', 'dist', 'bundle.js');
}

function bundleOut(extensionRoot: string): string {
    return path.join(extensionRoot, 'out', 'webview', 'minipaint-bundle.patched.js');
}

/**
 * Count non-overlapping occurrences of a literal substring `needle` in `hay`.
 * Avoids regex-escape gotchas for substrings containing metachars.
 */
function countOccurrences(hay: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let from = 0;
    while (true) {
        const i = hay.indexOf(needle, from);
        if (i < 0) return count;
        count += 1;
        from = i + needle.length;
    }
}

/**
 * Read the upstream bundle, run the integrity checks, apply both patches, and
 * write the patched bundle to `out/webview/minipaint-bundle.patched.js`.
 * Idempotent — if the output already matches the desired contents, no write
 * happens.
 *
 * Throws if either patch's expected occurrence count doesn't match, so an
 * upstream bump that silently changes the surface fails at build time rather
 * than at runtime.
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
            're-run the audit in docs/architecture.md DC-1 ' +
            'before proceeding.'
        );
    }

    // Phase 6.8: SAVE_TYPES GIF+BMP integrity check. Same fail-loud contract
    // as the saveAs check — exactly 1 occurrence expected; anything else
    // means upstream rearranged the dict and we need to re-audit.
    const saveTypesCount = countOccurrences(original, SAVE_TYPES_GIF_BMP);
    if (saveTypesCount !== SAVE_TYPES_GIF_BMP_EXPECTED_SITES) {
        throw new Error(
            'Paintbox: miniPaint bundle SAVE_TYPES integrity check failed. ' +
            'Expected ' + SAVE_TYPES_GIF_BMP_EXPECTED_SITES +
            ' occurrence of the GIF+BMP SAVE_TYPES entries, found ' +
            saveTypesCount + '. ' +
            'The vendored bundle may have been updated upstream — ' +
            're-audit before proceeding.'
        );
    }

    // Phase 6.9: File-menu Print-entry integrity check. Same fail-loud
    // contract: exactly 1 occurrence; anything else means upstream
    // rearranged the menu definition and we need to re-audit.
    const printEntryCount = countOccurrences(original, FILE_MENU_PRINT_ENTRY);
    if (printEntryCount !== FILE_MENU_PRINT_ENTRY_EXPECTED_SITES) {
        throw new Error(
            'Paintbox: miniPaint bundle File-menu Print-entry integrity check failed. ' +
            'Expected ' + FILE_MENU_PRINT_ENTRY_EXPECTED_SITES +
            ' occurrence of the Print menu entry, found ' +
            printEntryCount + '. ' +
            'The vendored bundle may have been updated upstream — ' +
            're-audit before proceeding.'
        );
    }

    const patched = PAINTBOX_HEADER + original
        .replace(SAVE_AS_PATTERN, PATCHED_REPLACEMENT)
        // Plain-string .replace (no regex) — the literal substrings are
        // unambiguous and contain no regex metachars worth defending against.
        .replace(SAVE_TYPES_GIF_BMP, '')
        .replace(FILE_MENU_PRINT_ENTRY, '');

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
 * `p().saveAs(` matches. Phase 6.8 also asserts the SAVE_TYPES GIF+BMP
 * entries are gone AND that the adjacent TIFF entry survives (regression
 * guard against the substring patch chewing past its boundaries). Throws a
 * user-readable error if any check fails; `activate()` lets the throw bubble
 * so VS Code surfaces "Activating extension 'paintbox' failed: <reason>" —
 * exactly what we want when the VSIX or local checkout is missing the build
 * artifact.
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

    // Phase 6.8: SAVE_TYPES patch verification.
    if (countOccurrences(contents, 'GIF:"Graphics Interchange Format"') !== 0) {
        return fail('expected 0 occurrences of GIF SAVE_TYPES entry');
    }
    if (countOccurrences(contents, 'BMP:"Windows Bitmap"') !== 0) {
        return fail('expected 0 occurrences of BMP SAVE_TYPES entry');
    }
    // Regression guard: TIFF was the entry immediately following BMP in the
    // upstream dict. A miss-bounded substring patch would eat it too. Assert
    // it's still present so that failure mode fails the build, not a user.
    if (countOccurrences(contents, 'TIFF:"Tag Image File Format"') !== 1) {
        return fail('expected adjacent TIFF SAVE_TYPES entry to survive');
    }

    // Phase 6.9: File-menu Print-entry patch verification.
    if (countOccurrences(contents, 'name:"Print"') !== 0) {
        return fail('expected 0 occurrences of File-menu Print entry');
    }
    // Regression guard: Quick Save was the entry immediately following the
    // Print entry's divider. A miss-bounded substring patch would chew
    // through Quick Save too. Assert it's still present so that failure
    // mode fails the build, not a user.
    if (countOccurrences(contents, 'name:"Quick Save"') !== 1) {
        return fail('expected adjacent Quick Save menu entry to survive');
    }
}
