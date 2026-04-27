import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

/**
 * Mocha entry point invoked by @vscode/test-electron via runTest.ts.
 *
 * Picks up every compiled `*.test.js` in the suite directory and runs it
 * against a real VS Code instance. Synchronous file walk — keeps things
 * KISS for Phase 2's single test file.
 */
export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 60_000,
    });

    const testsRoot = __dirname;

    return new Promise((resolve, reject) => {
        try {
            const files = walk(testsRoot).filter((f) => f.endsWith('.test.js'));
            files.forEach((f) => mocha.addFile(f));

            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} test(s) failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(full));
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
    return out;
}
