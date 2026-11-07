import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LabClient } from '../src/lab';
import { fakeFetch, jsonResponse } from './helpers';

describe('LabClient', () => {
    it('reaches a lab hook through the passthrough, query and token included', async () => {
        const fetch = fakeFetch(() => jsonResponse(200, { published: ['f.pgp'] }));
        const lab = new LabClient({ url: 'http://lab:8097/', token: 's3cret', fetch });
        const got = await lab.sim('worldline', 'settlement-cycle/run?slot=morning&date=2026-11-06', { method: 'POST' });
        assert.deepEqual(got, { status: 200, ok: true, body: { published: ['f.pgp'] } });
        assert.deepEqual(fetch.calls[0], {
            url: 'http://lab:8097/v1/services/worldline/sim/settlement-cycle/run?slot=morning&date=2026-11-06',
            method: 'POST',
            body: undefined,
            authorization: 'Bearer s3cret',
        });
    });

    it('posts with a body, gets without, and hands back any status for the caller to judge', async () => {
        const fetch = fakeFetch((call) =>
            call.method === 'POST' ? jsonResponse(202, { id: 'bcp_1' }) : new Response('not json', { status: 503 })
        );
        const lab = new LabClient({ fetch });
        const wire = await lab.sim('banking-circle', 'incoming-payments', { body: { currency: 'EUR', amount: '1.00' } });
        assert.equal(wire.status, 202);
        assert.deepEqual(fetch.calls[0], {
            url: 'http://127.0.0.1:8097/v1/services/banking-circle/sim/incoming-payments',
            method: 'POST',
            body: { currency: 'EUR', amount: '1.00' },
        });
        const down = await lab.sim('banking-circle', 'accounts');
        assert.deepEqual(down, { status: 503, ok: false, body: 'not json' });
    });

    it('resets the lab', async () => {
        const fetch = fakeFetch(() => jsonResponse(200, { ok: true }));
        await new LabClient({ fetch }).reset({ scope: 'all', services: ['banking-circle'] });
        assert.deepEqual(fetch.calls[0], {
            url: 'http://127.0.0.1:8097/v1/lab/reset',
            method: 'POST',
            body: { scope: 'all', services: ['banking-circle'] },
        });
    });
});
