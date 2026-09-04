#!/usr/bin/env node
// Build-time wrapper. Invoked from package.json's `compile` script after
// the host TypeScript build emits out/patchMinipaintBundle.js.
//
// Per docs/architecture.md DC-2: the patch
// runs at build time only. The VSIX ships pre-patched. Activation just
// verifies the artifact (verifyPatchedBundle in src/patchMinipaintBundle.ts).

'use strict';

const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const compiled = path.join(repoRoot, 'out', 'patchMinipaintBundle.js');

let mod;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(compiled);
} catch (err) {
    console.error(
        '[paintbox] scripts/patch-bundle.js: could not load ' + compiled + '\n' +
        'Did `tsc -p ./` run first? Check the `compile` script in package.json.\n' +
        'Underlying error: ' + (err && err.message ? err.message : String(err))
    );
    process.exit(1);
}

if (typeof mod.patchMinipaintBundle !== 'function') {
    console.error(
        '[paintbox] scripts/patch-bundle.js: ' + compiled +
        ' did not export patchMinipaintBundle()'
    );
    process.exit(1);
}

try {
    const out = mod.patchMinipaintBundle(repoRoot);
    console.log('[paintbox] patched miniPaint bundle written to ' + out);
} catch (err) {
    console.error(
        '[paintbox] patchMinipaintBundle failed: ' +
        (err && err.message ? err.message : String(err))
    );
    process.exit(1);
}
