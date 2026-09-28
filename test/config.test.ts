import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadLabConfig, parseLabConfigFile } from '../src/config';

const dir = () => mkdtempSync(join(tmpdir(), 'fintechlab-config-'));

describe('loadLabConfig', () => {
    it('with no file and no env: the lab on this machine, no stand_ins', () => {
        const c = loadLabConfig({ dir: dir(), env: {} });
        assert.deepEqual(c, { consoleUrl: 'http://127.0.0.1:8090', clockUrl: 'http://127.0.0.1:8096/clock' });
    });

    it('reads the file, and the env wins over it', () => {
        const d = dir();
        writeFileSync(
            join(d, 'fintechlab.json'),
            JSON.stringify({
                _comment: 'ignored',
                console_url: 'http://lab:8090/',
                clock_url: 'http://lab:8096/clock',
                advertised_url: 'http://tunnel.example',
                stand_ins: { receiver: { connected: false, shown: false } },
            })
        );
        const c = loadLabConfig({
            dir: d,
            env: { FINTECH_SIM_LAB_CLOCK_URL: 'http://other:8096/clock/', RUNNER_BROWSE_URL: 'http://127.0.0.1:1' },
            defaults: { advertisedUrl: 'http://default', browseUrl: 'http://default-browse' },
        });
        assert.equal(c.consoleUrl, 'http://lab:8090');
        assert.equal(c.clockUrl, 'http://other:8096/clock');
        assert.equal(c.advertisedUrl, 'http://tunnel.example');
        assert.equal(c.browseUrl, 'http://127.0.0.1:1');
        assert.deepEqual(c.standIns, { receiver: { connected: false, shown: false } });
        assert.equal(c.file, join(d, 'fintechlab.json'));
    });

    it('uses defaults for what neither sets', () => {
        const c = loadLabConfig({ dir: dir(), env: {}, defaults: { advertisedUrl: 'http://a', browseUrl: 'http://b' } });
        assert.equal(c.advertisedUrl, 'http://a');
        assert.equal(c.browseUrl, 'http://b');
    });

    it('FINTECHLAB_CONFIG names the file, and a named file that is missing is an error', () => {
        const d = dir();
        writeFileSync(join(d, 'elsewhere.json'), JSON.stringify({ stand_ins: { notifier: { shown: false } } }));
        const c = loadLabConfig({ dir: d, env: { FINTECHLAB_CONFIG: join(d, 'elsewhere.json') } });
        assert.deepEqual(c.standIns, { notifier: { shown: false } });
        assert.throws(() => loadLabConfig({ dir: d, env: { FINTECHLAB_CONFIG: 'nope.json' } }), /does not exist/);
    });

    it('refuses a malformed file rather than running on defaults', () => {
        const d = dir();
        const file = join(d, 'fintechlab.json');
        writeFileSync(file, '{ not json');
        assert.throws(() => loadLabConfig({ dir: d, env: {} }), /is not JSON/);
        writeFileSync(file, JSON.stringify({ consol_url: 'x' }));
        assert.throws(() => loadLabConfig({ dir: d, env: {} }), /unknown field "consol_url"/);
        writeFileSync(file, JSON.stringify({ stand_ins: { receiver: { connected: 'false' } } }));
        assert.throws(() => loadLabConfig({ dir: d, env: {} }), /must be true or false/);
    });

    it('accepts the example file it ships', () => {
        // build-test/test/ → the package root
        const example = join(__dirname, '..', '..', 'fintechlab.example.json');
        const parsed = parseLabConfigFile(readFileSync(example, 'utf8'), example);
        assert.deepEqual(parsed.stand_ins?.receiver, { connected: false, shown: false });
    });
});
