import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { LabClockFollower } from '../src/clock';
import { fakeFetch, jsonResponse, memoryLogger } from './helpers';

const URL_ = 'http://lab:8096/clock';
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fintechlab-clock-')), '.runs', 'clock.json');

describe('LabClockFollower', () => {
    it('writes the offset to the clock file, and only when it changes', async () => {
        let offset = 3_600_000;
        const fetch = fakeFetch(() => jsonResponse(200, { offset_ms: offset, mode: 'pinned', reason: 'advanced 1h' }));
        const logger = memoryLogger();
        const file = tmpFile();
        const f = new LabClockFollower({ url: URL_, holder: 'p', clockFile: file, fetch, logger });

        await f.poll();
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
            offset_ms: 3_600_000,
            mode: 'lab',
            reason: 'lab clock: pinned — advanced 1h',
        });
        assert.equal(logger.lines.filter((l) => l.includes('following the lab clock')).length, 1);

        writeFileSync(file, 'sentinel');
        await f.poll();
        assert.equal(readFileSync(file, 'utf8'), 'sentinel', 'unchanged offset must not rewrite the file');

        offset = -86_400_000;
        await f.poll();
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).offset_ms, -86_400_000);
        assert.equal(logger.lines.length, 1, 'said once, not per poll');
        assert.equal(f.view().lab?.offset_ms, -86_400_000);
        assert.equal(f.view().lab_reachable, true);
    });

    it('keeps the last offset when the lab goes away, and says so once', async () => {
        let up = true;
        const fetch = fakeFetch(() => (up ? jsonResponse(200, { offset_ms: 5, mode: 'pinned' }) : new Error('ECONNREFUSED')));
        const logger = memoryLogger();
        const file = tmpFile();
        const f = new LabClockFollower({ url: URL_, holder: 'p', clockFile: file, fetch, logger });
        await f.poll();
        up = false;
        await f.poll();
        await f.poll();
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).offset_ms, 5);
        assert.equal(logger.warnings.length, 1);
        assert.equal(f.view().lab_reachable, false);
        assert.equal(f.view().lab_error, 'ECONNREFUSED');
        up = true;
        await f.poll();
        assert.equal(logger.lines.length, 2, 'following again is said again');
    });

    it('refuses an answer without offset_ms', async () => {
        const fetch = fakeFetch(() => jsonResponse(200, { mode: 'real' }));
        const f = new LabClockFollower({ url: URL_, holder: 'p', clockFile: tmpFile(), fetch, logger: memoryLogger() });
        assert.equal(await f.poll(), undefined);
        assert.match(f.state.error ?? '', /no offset_ms/);
    });

    it('with no lab at start, removes a stale clock file', async () => {
        const file = tmpFile();
        const seed = new LabClockFollower({
            url: URL_,
            holder: 'p',
            clockFile: file,
            fetch: fakeFetch(() => jsonResponse(200, { offset_ms: 1, mode: 'pinned' })),
            logger: memoryLogger(),
        });
        await seed.poll();
        assert.ok(existsSync(file));
        const logger = memoryLogger();
        const f = new LabClockFollower({
            url: URL_,
            holder: 'p',
            clockFile: file,
            fetch: fakeFetch(() => new Error('down')),
            logger,
            fallback: 'the real clock',
            intervalMs: 60_000,
        });
        await f.start();
        await f.stop();
        assert.equal(existsSync(file), false);
        assert.ok(logger.warnings.some((w) => w.includes('starting on the real clock')));
    });

    it('holds while there is a reason, releases when there is none', async () => {
        let reason: string | null = 'settlement in flight: EUR run-1';
        const fetch = fakeFetch(() => new Response(null, { status: 204 }));
        const f = new LabClockFollower({
            url: URL_ + '/',
            holder: 'my platform',
            clockFile: tmpFile(),
            holdReason: () => reason,
            holdTtlSeconds: 60,
            fetch,
            logger: memoryLogger(),
        });
        await f.syncHold();
        assert.deepEqual(fetch.calls.at(-1), {
            url: 'http://lab:8096/clock/holds',
            method: 'POST',
            body: { holder: 'my platform', reason: 'settlement in flight: EUR run-1', ttl_seconds: 60 },
        });
        assert.equal(f.view().holding, 'settlement in flight: EUR run-1');
        reason = null;
        await f.syncHold();
        assert.deepEqual(fetch.calls.at(-1), {
            url: 'http://lab:8096/clock/holds/my%20platform',
            method: 'DELETE',
            body: undefined,
        });
        assert.equal(f.view().holding, undefined);
    });

    it('releases its hold on stop', async () => {
        const fetch = fakeFetch(() => new Response(null, { status: 204 }));
        const f = new LabClockFollower({ url: URL_, holder: 'p', clockFile: tmpFile(), fetch, logger: memoryLogger() });
        await f.hold('busy');
        await f.stop();
        assert.equal(fetch.calls.at(-1)?.method, 'DELETE');
        const before = fetch.calls.length;
        await f.stop();
        assert.equal(fetch.calls.length, before, 'nothing held, nothing to release');
    });
});
