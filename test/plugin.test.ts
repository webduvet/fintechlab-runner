import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type { Plugin } from '../src/descriptor';
import { LabPlugin } from '../src/plugin';
import { fakeFetch, flush, jsonResponse, memoryLogger } from './helpers';

const descriptor = (): Plugin => ({
    id: 'my-platform',
    name: 'My platform',
    base_url: 'http://127.0.0.1:3109',
    health_path: '/status',
    clock: 'follows',
});

const accepted = (renew = 10) =>
    jsonResponse(200, { id: 'my-platform', state: 'live', ttl_seconds: 30, renew_seconds: renew, clock: 'follows' });

describe('LabPlugin', () => {
    it('registers the descriptor and renews at the interval the console gives', async () => {
        const fetch = fakeFetch(() => accepted(7));
        const logger = memoryLogger();
        const p = new LabPlugin({ consoleUrl: 'http://lab:8090/', descriptor, fetch, logger });
        assert.equal(await p.register(), true);
        assert.deepEqual(fetch.calls[0], { url: 'http://lab:8090/api/plugins', method: 'POST', body: descriptor() });
        assert.equal(p.state.live, true);
        assert.equal(p.state.renewMs, 7000);
        await p.register();
        assert.equal(logger.lines.length, 1, 'registered is said once');
    });

    it('logs a failure once, again only when the reason changes, and recovers', async () => {
        let answer: () => Response | Error = () => new Error('ECONNREFUSED');
        const fetch = fakeFetch(() => answer());
        const logger = memoryLogger();
        const p = new LabPlugin({ consoleUrl: 'http://lab:8090', descriptor, fetch, logger });
        await p.register();
        await p.register();
        assert.equal(logger.warnings.length, 1);
        answer = () => jsonResponse(400, { error: 'bad plugin descriptor: name is required' });
        await p.register();
        assert.equal(logger.warnings.length, 2);
        assert.match(logger.warnings[1] ?? '', /name is required/);
        assert.equal(p.state.error, 'bad plugin descriptor: name is required');
        answer = () => accepted();
        await p.register();
        assert.equal(p.state.live, true);
        assert.equal(p.state.error, undefined);
        assert.equal(logger.lines.length, 1);
    });

    it('refuses to start with a descriptor the console would refuse', () => {
        const fetch = fakeFetch(() => accepted());
        const p = new LabPlugin({
            consoleUrl: 'http://lab:8090',
            descriptor: { ...descriptor(), health_path: 'status' },
            fetch,
            logger: memoryLogger(),
        });
        assert.throws(() => p.start(), /health_path "status"/);
        assert.equal(fetch.calls.length, 0);
    });

    it('renews on a timer, sends the current descriptor, and stops on stop()', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            let name = 'First';
            const fetch = fakeFetch((call) => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : accepted(5)));
            const p = new LabPlugin({
                consoleUrl: 'http://lab:8090',
                descriptor: () => ({ ...descriptor(), name }),
                fetch,
                logger: memoryLogger(),
            });
            p.start();
            await flush();
            assert.equal(fetch.calls.length, 1);
            name = 'Second';
            mock.timers.tick(4999);
            await flush();
            assert.equal(fetch.calls.length, 1, 'not before renew_seconds');
            mock.timers.tick(1);
            await flush();
            assert.equal(fetch.calls.length, 2);
            assert.equal((fetch.calls[1]?.body as Plugin).name, 'Second');

            assert.equal(await p.stop(), true);
            assert.deepEqual(fetch.calls.at(-1), {
                url: 'http://lab:8090/api/plugins/my-platform',
                method: 'DELETE',
                body: undefined,
            });
            const after = fetch.calls.length;
            mock.timers.tick(60_000);
            await flush();
            assert.equal(fetch.calls.length, after, 'no renewal after stop');
            assert.equal(p.state.live, false);
        } finally {
            mock.timers.reset();
        }
    });

    it('keeps retrying at the renew interval while the console is away', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            let up = false;
            const fetch = fakeFetch(() => (up ? accepted(10) : new Error('ECONNREFUSED')));
            const p = new LabPlugin({ consoleUrl: 'http://lab:8090', descriptor, fetch, logger: memoryLogger(), renewMs: 3000 });
            p.start();
            await flush();
            mock.timers.tick(3000);
            await flush();
            assert.equal(fetch.calls.length, 2);
            up = true;
            mock.timers.tick(3000);
            await flush();
            assert.equal(p.state.live, true);
            assert.equal(p.state.renewMs, 10_000);
            await p.stop();
        } finally {
            mock.timers.reset();
        }
    });
});
