import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Driver that downloads (and caches) a VS Code build, launches it, and runs
 * the Mocha suite at out/test/suite/index.js inside that VS Code instance.
 *
 * Headless environments need a display. If running in a container without
 * one, wrap this with `xvfb-run -a npm test`.
 */
async function main(): Promise<void> {
    try {
        // Repo root: this file compiles to out/test/runTest.js, so two dirs up.
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: ['--disable-extensions'],
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
