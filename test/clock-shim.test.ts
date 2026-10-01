import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// build-test/test/ → the package root
const SHIM = resolve(__dirname, '..', '..', 'clock-shim', 'index.cjs');

/** Run a snippet in a fresh node preloading the shim; its stdout's last line, parsed. */
function withShim(env: Record<string, string>, code: string): Record<string, unknown> {
    const out = execFileSync(process.execPath, ['-r', SHIM, '-e', code], {
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
}

const report = `
const shim = globalThis[Symbol.for('@fintechlab/runner/clock-shim')];
console.log(JSON.stringify({ skew: Date.now() - shim.realNow(), offset: shim.offsetMs, pinned: shim.pinned, file: shim.CLOCK_FILE }));
`;

describe('clock shim', () => {
    it('leaves the clock alone with no setting and no file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fintechlab-shim-'));
        const got = withShim({ RUNNER_CLOCK_FILE: join(dir, 'clock.json') }, report);
        assert.equal(got.offset, 0);
        assert.ok(Math.abs(Number(got.skew)) < 50);
    });

    it('applies the offset in RUNNER_CLOCK_FILE at start', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fintechlab-shim-'));
        const file = join(dir, 'clock.json');
        writeFileSync(file, JSON.stringify({ offset_ms: 7_200_000, mode: 'lab', reason: 'test' }));
        const got = withShim({ RUNNER_CLOCK_FILE: file }, report);
        assert.equal(got.offset, 7_200_000);
        assert.equal(got.pinned, true);
        assert.equal(got.file, file);
        assert.ok(Math.abs(Number(got.skew) - 7_200_000) < 50);
    });

    it('keeps Date.now() a whole number when the lab sends a fractional offset', () => {
        // The lab clock once published offsets worked out from nanoseconds;
        // a fractional Date.now() made PostHog's uuidv7 throw and killed a process.
        const dir = mkdtempSync(join(tmpdir(), 'fintechlab-shim-'));
        const file = join(dir, 'clock.json');
        writeFileSync(file, JSON.stringify({ offset_ms: 29643060.766812, mode: 'lab', reason: 'test' }));
        const got = withShim(
            { RUNNER_CLOCK_FILE: file },
            `const shim = globalThis[Symbol.for('@fintechlab/runner/clock-shim')];
             console.log(JSON.stringify({ now: Date.now(), offset: shim.offsetMs, time: new Date().getTime() }))`
        );
        assert.ok(Number.isInteger(got.now), `Date.now() = ${got.now}`);
        assert.ok(Number.isInteger(got.time), `getTime() = ${got.time}`);
        assert.equal(got.offset, 29643061);
    });

    it('pins to RUNNER_NOW', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fintechlab-shim-'));
        const got = withShim(
            { RUNNER_CLOCK_FILE: join(dir, 'none.json'), RUNNER_NOW: '2026-09-16T10:00:00Z' },
            `console.log(JSON.stringify({ now: new Date().toISOString().slice(0, 13) }))`
        );
        assert.equal(got.now, '2026-09-16T10');
    });

    it('defaults the file to .runs/clock.json under the working directory', () => {
        const got = withShim({}, report);
        assert.equal(got.file, resolve(process.cwd(), '.runs', 'clock.json'));
    });
});
