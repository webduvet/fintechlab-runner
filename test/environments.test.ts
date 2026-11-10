import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadLabConfig } from '../src/config';
import type { Plugin } from '../src/descriptor';
import { LabClient } from '../src/lab';
import { LabPlugin } from '../src/plugin';
import { fakeFetch, jsonResponse, memoryLogger } from './helpers';

const dir = () => mkdtempSync(join(tmpdir(), 'fintechlab-env-'));

describe('environments', () => {
    it('reads the environment from FINTECH_SIM_LAB_ENVIRONMENT, then lab_environment', () => {
        const d = dir();
        writeFileSync(join(d, 'fintechlab.json'), JSON.stringify({ lab_environment: 'from-file' }));
        assert.equal(loadLabConfig({ dir: d, env: {} }).environment, 'from-file');
        assert.equal(loadLabConfig({ dir: d, env: { FINTECH_SIM_LAB_ENVIRONMENT: 'sbx' } }).environment, 'sbx');
        assert.equal(loadLabConfig({ dir: dir(), env: {} }).environment, undefined);
    });

    it('names the environment on every lab call, and only when there is one', async () => {
        const fetch = fakeFetch(() => jsonResponse(200, { ok: true }));
        await new LabClient({ token: 'lenv_x', environment: 'sbx', fetch }).reset();
        assert.equal(fetch.calls[0]?.environment, 'sbx');
        assert.equal(fetch.calls[0]?.authorization, 'Bearer lenv_x');
        await new LabClient({ fetch }).reset();
        assert.equal(fetch.calls[1]?.environment, undefined);
    });

    it('registers the card in its environment', async () => {
        const fetch = fakeFetch(() => jsonResponse(200, { id: 'p', state: 'live', ttl_seconds: 30, renew_seconds: 10, clock: 'wall' }));
        const descriptor = (): Plugin => ({
            id: 'p', name: 'P', summary: '', base_url: 'http://p:1', health_path: '/health', clock: 'wall',
        });
        const p = new LabPlugin({ labUrl: 'http://lab:8097', environment: 'sbx', descriptor, fetch, logger: memoryLogger() });
        assert.equal(await p.register(), true);
        assert.equal(fetch.calls[0]?.environment, 'sbx');
    });

    it('creates, reads and deletes environments, and fetches a kit as text', async () => {
        const fetch = fakeFetch((call) => {
            if (call.url.endsWith('/v1/connect/env?host=lab.example')) return new Response('FINTECH_SIM_LAB_TOKEN=lenv_1\n', { status: 200 });
            if (call.method === 'POST') return jsonResponse(201, { environment: { id: 'sbx' }, token: 'lenv_1' });
            if (call.method === 'DELETE') return jsonResponse(200, { deleted: 'sbx' });
            return jsonResponse(200, { id: 'sbx' });
        });
        const lab = new LabClient({ url: 'http://lab:8097', token: 'admin', fetch });
        const made = await lab.createEnvironment({ name: 'sbx', config: { settlement_identifier: 'Infinite_Payment' } });
        assert.equal(made.status, 201);
        assert.equal(made.body.token, 'lenv_1');
        assert.deepEqual(fetch.calls[0]?.body, { name: 'sbx', config: { settlement_identifier: 'Infinite_Payment' } });
        assert.equal((await lab.environment()).body.id, 'sbx');
        assert.equal(fetch.calls[1]?.url, 'http://lab:8097/v1/environment');
        const kit = await lab.kit('lab.example');
        assert.equal(kit.body, 'FINTECH_SIM_LAB_TOKEN=lenv_1\n');
        assert.equal((await lab.deleteEnvironment('sbx')).status, 200);
        assert.equal(fetch.calls.at(-1)?.url, 'http://lab:8097/v1/environments/sbx');
    });
});
