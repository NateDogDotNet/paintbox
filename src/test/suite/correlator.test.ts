import * as assert from 'assert';

/**
 * Test 5a — UNIT — pure SaveCorrelator correlation logic.
 *
 * Per .orchestrator/phase5-design.md §10 Test 5a, the correlation Map +
 * register/handleSaveResult/handleSaveError logic is extracted into a separate
 * module (`src/saveCorrelator.ts`) so this test can run without any vscode
 * dependency. The provider then composes a SaveCorrelator instance.
 *
 * The behavioural contract under test:
 *   1. registerPending(requestId) returns a Promise<Uint8Array> that resolves
 *      when handleSaveResult is called with a matching requestId.
 *   2. Out-of-order saveResults still match the right promise (each one keyed
 *      by its own requestId — no shared cursor).
 *   3. handleSaveError(requestId, msg) rejects the matching promise with a
 *      `Paintbox: <msg>` Error.
 *   4. A timer fires after timeoutMs and rejects with the timeout error.
 *   5. cancel(requestId, reason) rejects with the given reason and clears the
 *      timer. cancelByPredicate(pred, reason) rejects all matching entries.
 *   6. handleSaveResult/handleSaveError without a matching requestId are
 *      silent (return false) so the provider can implement default-4 (log
 *      and ignore) without leaking state.
 *   7. MIME mismatch is reported by the consumer; SaveCorrelator does NOT
 *      enforce MIME — it only delivers raw bytes. The provider checks MIME
 *      before calling resolveBytes. (Keeps the correlator a pure transport
 *      layer.)
 *   8. dispose() clears all pending entries with `provider disposed`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SaveCorrelator } = require('../../saveCorrelator');

suite('Phase 5 Test 5a — SaveCorrelator (pure unit)', () => {
    test('register + handleSaveResult resolves with bytes', async () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const p = c.register('uuid-1', 30_000);
        const ok = c.handleSaveResult('uuid-1', new Uint8Array([1, 2, 3]));
        assert.strictEqual(ok, true);
        const bytes = await p;
        assert.deepStrictEqual(Array.from(bytes), [1, 2, 3]);
    });

    test('out-of-order saveResults resolve their own promises', async () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const p1 = c.register('uuid-1', 30_000);
        const p2 = c.register('uuid-2', 30_000);
        const p3 = c.register('uuid-3', 30_000);

        // Arrive in reverse order.
        c.handleSaveResult('uuid-3', new Uint8Array([3, 3, 3]));
        c.handleSaveResult('uuid-1', new Uint8Array([1, 1, 1]));
        c.handleSaveResult('uuid-2', new Uint8Array([2, 2, 2]));

        assert.deepStrictEqual(Array.from(await p1), [1, 1, 1]);
        assert.deepStrictEqual(Array.from(await p2), [2, 2, 2]);
        assert.deepStrictEqual(Array.from(await p3), [3, 3, 3]);
    });

    test('handleSaveError rejects with Paintbox-prefixed Error', async () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const p = c.register('uuid-err', 30_000);
        const matched = c.handleSaveError('uuid-err', 'simulated encoder failure');
        assert.strictEqual(matched, true);

        let caught: Error | null = null;
        try { await p; } catch (err) { caught = err as Error; }
        assert.ok(caught, 'expected rejection');
        assert.match(caught!.message, /Paintbox: simulated encoder failure/);
    });

    test('handleSaveResult without matching requestId returns false (no leak)', () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const matched = c.handleSaveResult('uuid-nope', new Uint8Array([0]));
        assert.strictEqual(matched, false);
    });

    test('handleSaveError without matching requestId returns false', () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const matched = c.handleSaveError('uuid-nope', 'whatever');
        assert.strictEqual(matched, false);
    });

    test('timeout rejects after timeoutMs with the standard message', async () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const p = c.register('uuid-slow', 30); // 30ms for fast test
        let caught: Error | null = null;
        try { await p; } catch (err) { caught = err as Error; }
        assert.ok(caught, 'expected timeout rejection');
        assert.match(caught!.message, /Paintbox: save timed out after 30s/);
    });

    test('cancel(requestId, reason) rejects with the given reason and clears timer', async () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const p = c.register('uuid-cancel', 30_000);
        const matched = c.cancel('uuid-cancel', new Error('Paintbox: save cancelled.'));
        assert.strictEqual(matched, true);

        let caught: Error | null = null;
        try { await p; } catch (err) { caught = err as Error; }
        assert.ok(caught);
        assert.match(caught!.message, /Paintbox: save cancelled\./);
    });

    test('cancelByPredicate rejects only matching pending entries', async () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const p1 = c.register('uuid-A', 30_000, { tag: 'docA' });
        const p2 = c.register('uuid-B', 30_000, { tag: 'docB' });
        const p3 = c.register('uuid-A2', 30_000, { tag: 'docA' });

        c.cancelByPredicate(
            (meta: unknown) => (meta as { tag?: string }).tag === 'docA',
            new Error('Paintbox: editor closed before save completed.')
        );

        let caughtA: Error | null = null;
        let caughtA2: Error | null = null;
        try { await p1; } catch (e) { caughtA = e as Error; }
        try { await p3; } catch (e) { caughtA2 = e as Error; }
        assert.ok(caughtA);
        assert.ok(caughtA2);
        assert.match(caughtA!.message, /editor closed before save completed/);

        // p2 (docB) is still pending.
        c.handleSaveResult('uuid-B', new Uint8Array([42]));
        assert.deepStrictEqual(Array.from(await p2), [42]);
    });

    test('dispose() rejects all pending with "provider disposed"', async () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        const p = c.register('uuid-x', 30_000);
        c.dispose();
        let caught: Error | null = null;
        try { await p; } catch (err) { caught = err as Error; }
        assert.ok(caught);
        assert.match(caught!.message, /Paintbox: provider disposed/);
    });

    test('size() reports outstanding pending entries', () => {
        const c = new (SaveCorrelator as new () => import('../../saveCorrelator').SaveCorrelator)();
        assert.strictEqual(c.size(), 0);
        c.register('a', 30_000);
        c.register('b', 30_000);
        assert.strictEqual(c.size(), 2);
        c.handleSaveResult('a', new Uint8Array([0]));
        assert.strictEqual(c.size(), 1);
    });
});
