import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Driver that downloads (and caches) a VS Code build, launches it, and runs
 * the Mocha suite at out/test/suite/index.js inside that VS Code instance.
 *
 * Headless environments need a display. In a container without one:
 *
 *     xvfb-run -a npm test
 *
 * That needs BOTH packages — `xvfb` and `xauth`. `xvfb-run` shells out to
 * `xauth` to write the cookie for the display it creates, so with `xvfb`
 * alone it exits 3 with `xvfb-run: error: xauth command not found`, which
 * reads like a missing display rather than a missing package. On Debian:
 *
 *     sudo apt-get install -y xvfb xauth
 *
 * If you cannot install packages, run a display yourself instead:
 *
 *     Xvfb :99 -screen 0 1280x1024x24 &
 *     DISPLAY=:99 npm test
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
