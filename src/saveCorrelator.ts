/**
 * SaveCorrelator — a pure transport layer that maps `requestId` strings to
 * pending save Promises. Extracted from `editorProvider.ts` to keep Test 5a
 * a true unit test (no `vscode` dependency).
 *
 * Lifecycle:
 *   register(requestId, timeoutMs, meta?) → Promise<Uint8Array>
 *      Adds an entry; arms a timer that rejects with the standard timeout
 *      error if no result arrives within `timeoutMs`. The optional `meta`
 *      blob is opaque to the correlator and used by `cancelByPredicate`.
 *
 *   handleSaveResult(requestId, bytes) → boolean
 *      Resolves the matching entry with the bytes. Returns true on match.
 *      Returns false (silent) on no-match — the provider's onMessage handler
 *      is expected to log and ignore in that case (default 4 from
 *      .orchestrator/phase5-design.md §10).
 *
 *   handleSaveError(requestId, errorMsg) → boolean
 *      Rejects the matching entry with `Error('Paintbox: <errorMsg>')`.
 *      Returns true on match, false on no-match (silent).
 *
 *   cancel(requestId, error) → boolean
 *      Removes the entry and rejects with the supplied Error. Used for
 *      cancellation tokens.
 *
 *   cancelByPredicate(pred, error) → number
 *      Iterates pending entries; for each whose `meta` matches the predicate,
 *      removes and rejects with the supplied Error. Returns the count.
 *
 *   dispose() → void
 *      Rejects all pending with `Paintbox: provider disposed`.
 *
 *   size() → number — for tests.
 *
 * The correlator does NOT validate MIME or formats — that's the provider's
 * job (§8 gates 1+2). Keeping this module pure transport makes Test 5a a
 * true unit test with no Web/VS Code dependencies.
 */

interface PendingEntry<M> {
    resolve: (bytes: Uint8Array) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    meta: M | undefined;
}

export class SaveCorrelator<M = unknown> {
    private readonly _pending = new Map<string, PendingEntry<M>>();

    register(requestId: string, timeoutMs: number, meta?: M): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve, reject) => {
            const timer = setTimeout(() => {
                const entry = this._pending.get(requestId);
                if (!entry) return;
                this._pending.delete(requestId);
                entry.reject(new Error(
                    'Paintbox: save timed out after 30s — the editor may be unresponsive. ' +
                    'Try closing and reopening the file.'
                ));
            }, timeoutMs);
            this._pending.set(requestId, { resolve, reject, timer, meta });
        });
    }

    handleSaveResult(requestId: string, bytes: Uint8Array): boolean {
        const entry = this._pending.get(requestId);
        if (!entry) return false;
        this._pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.resolve(bytes);
        return true;
    }

    handleSaveError(requestId: string, errorMsg: string): boolean {
        const entry = this._pending.get(requestId);
        if (!entry) return false;
        this._pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(new Error(`Paintbox: ${errorMsg}`));
        return true;
    }

    cancel(requestId: string, error: Error): boolean {
        const entry = this._pending.get(requestId);
        if (!entry) return false;
        this._pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(error);
        return true;
    }

    cancelByPredicate(pred: (meta: M | undefined) => boolean, error: Error): number {
        let count = 0;
        for (const [requestId, entry] of Array.from(this._pending.entries())) {
            if (pred(entry.meta)) {
                this._pending.delete(requestId);
                clearTimeout(entry.timer);
                entry.reject(error);
                count++;
            }
        }
        return count;
    }

    dispose(): void {
        const entries = Array.from(this._pending.entries());
        this._pending.clear();
        for (const [, entry] of entries) {
            clearTimeout(entry.timer);
            entry.reject(new Error('Paintbox: provider disposed'));
        }
    }

    size(): number {
        return this._pending.size;
    }

    /** Test-only: returns the meta object associated with a pending entry. */
    __pbTestGetMeta(requestId: string): M | undefined {
        const entry = this._pending.get(requestId);
        return entry ? entry.meta : undefined;
    }
}
