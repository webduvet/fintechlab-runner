import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pollFor } from '../src/wait';

describe('pollFor', () => {
    it('returns the first truthy answer, treating throws as not yet', async () => {
        let n = 0;
        const got = await pollFor(
            async () => {
                n += 1;
                if (n === 1) throw new Error('not yet');
                return n >= 3 ? 'done' : undefined;
            },
            5,
            { intervalMs: 1 }
        );
        assert.equal(got, 'done');
    });

    it('survives a check that never answers', async () => {
        const started = performance.now();
        const got = await pollFor(() => new Promise<string>(() => {}), 0.2, { checkTimeoutMs: 50, intervalMs: 10 });
        assert.equal(got, undefined);
        assert.ok(performance.now() - started < 2000);
    });
});
