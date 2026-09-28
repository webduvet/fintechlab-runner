import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createControlServer, isInvalidBody, json, readBody } from '../src/http';

describe('control server helpers', () => {
    const server = createControlServer({
        'GET /status': (_req, res) => json(res, 200, { status: 'ok' }),
        'POST /echo': async (req, res) => {
            const body = await readBody(req);
            json(res, isInvalidBody(body) ? 400 : 200, body);
        },
        'POST /boom': async () => {
            throw new Error('it broke');
        },
    });
    let base = '';
    before(async () => {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    it('routes by method and path', async () => {
        const res = await fetch(`${base}/status?x=1`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: 'ok' });
        const missing = await fetch(`${base}/status`, { method: 'POST' });
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: 'no route POST /status' });
    });

    it('reads JSON bodies, empty as {}, and marks what is not JSON', async () => {
        const post = (body: string) => fetch(`${base}/echo`, { method: 'POST', body });
        assert.deepEqual(await (await post('{"a":1}')).json(), { a: 1 });
        assert.deepEqual(await (await post('')).json(), {});
        const bad = await post('nope');
        assert.equal(bad.status, 400);
        assert.deepEqual(await bad.json(), { __invalid: 'nope' });
        assert.equal((await post('[1]')).status, 400);
    });

    it('answers 500 with the message when a handler throws', async () => {
        const res = await fetch(`${base}/boom`, { method: 'POST' });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: 'it broke' });
    });
});
