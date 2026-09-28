import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { activityBody, ActivityLog } from '../src/activity';
import { shimOffsetMs, wallClock } from '../src/util';

const KEY = Symbol.for('@fintechlab/runner/clock-shim');

describe('ActivityLog', () => {
    afterEach(() => {
        delete (globalThis as Record<symbol, unknown>)[KEY];
    });

    it('keeps the newest events up to its capacity, counting everything', () => {
        const log = new ActivityLog('runs', 'Runs', 'note', { capacity: 3, labels: { warn: 'slow' }, now: () => 'T' });
        for (let i = 1; i <= 5; i++) log.record({ op: 'run', summary: `run ${i}` });
        const snap = log.snapshot(10);
        assert.equal(snap.total, 5);
        assert.equal(snap.kept, 3);
        assert.deepEqual(
            snap.events.map((e) => e.seq),
            [5, 4, 3]
        );
        assert.equal(snap.last?.summary, 'run 5');
        assert.equal(snap.events[0]?.status, 'ok');
        assert.equal(snap.events[0]?.at, 'T');
        assert.deepEqual(snap.labels, { warn: 'slow' });
    });

    it('rewrites an event in place', () => {
        const log = new ActivityLog('runs', 'Runs', '');
        const ev = log.record({ op: 'run', summary: 'started' });
        assert.equal(log.update(ev.seq, { summary: 'done', status: 'warn', detail: { root: 'r' } }), true);
        assert.equal(log.update(999, { summary: 'x' }), false);
        const [only] = log.recent();
        assert.equal(only?.summary, 'done');
        assert.equal(only?.status, 'warn');
        assert.equal(log.snapshot().total, 1);
    });

    it('serves {"logs": [...]} with the limit, in order', () => {
        const a = new ActivityLog('a', 'A', '');
        const b = new ActivityLog('b', 'B', '');
        for (let i = 0; i < 5; i++) a.record({ op: 'x', summary: String(i) });
        const body = activityBody([a, b], '2');
        assert.deepEqual(
            body.logs.map((l) => [l.name, l.events.length]),
            [
                ['a', 2],
                ['b', 0],
            ]
        );
        assert.equal(activityBody([a], 'junk').logs[0]?.events.length, 5);
        assert.deepEqual(b.snapshot().events, []);
    });

    it("stamps the wall clock, undoing the shim's offset", () => {
        assert.equal(shimOffsetMs(), 0);
        (globalThis as Record<symbol, unknown>)[KEY] = { offsetMs: 86_400_000 };
        const shifted = Date.now();
        const wall = Date.parse(wallClock());
        assert.ok(Math.abs(shifted - 86_400_000 - wall) < 1000);
    });
});
