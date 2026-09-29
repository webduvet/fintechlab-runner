import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { FileRefused, FileStore, headLines, previewHandler, safeFileName, uploadHandler } from '../src/files';
import { routeRequests } from '../src/http';

const dirs: string[] = [];
function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'fintechlab-files-'));
    dirs.push(d);
    return d;
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('safeFileName', () => {
    it('keeps a base name and nothing that could be a path', () => {
        assert.equal(safeFileName('worldline day 1.csv'), 'worldline-day-1.csv');
        assert.equal(safeFileName('../../etc/passwd'), 'passwd');
        assert.equal(safeFileName('C:\\Users\\me\\file.csv'), 'file.csv');
        assert.equal(safeFileName('.hidden'), 'hidden');
        assert.equal(safeFileName('..'), undefined);
        assert.equal(safeFileName(''), undefined);
    });
});

describe('FileStore', () => {
    it('keeps a stream under a free name, never over a reserved one', async () => {
        const store = new FileStore(join(tmp(), 'uploads'), { reserved: () => ['sample.csv'] });
        const a = await store.save(Readable.from(['a,b\n', '1,2\n']), 'sample.csv');
        assert.equal(a.name, 'sample-2.csv');
        const b = await store.save(Readable.from(['x']), 'sample.csv');
        assert.equal(b.name, 'sample-3.csv');
        assert.equal(readFileSync(a.path, 'utf8'), 'a,b\n1,2\n');
        assert.deepEqual(store.list().map((f) => f.name).sort(), ['sample-2.csv', 'sample-3.csv']);
        assert.equal(store.remove('sample-2.csv'), true);
        assert.equal(store.remove('../sample-3.csv'), false);
        assert.equal(store.list().length, 1);
    });

    it('refuses a file over its limit and leaves nothing behind', async () => {
        const dir = tmp();
        const store = new FileStore(dir, { maxBytes: 10 });
        await assert.rejects(store.save(Readable.from(['0123456789', 'more']), 'big.csv'), (err: unknown) => err instanceof FileRefused && err.status === 413);
        assert.deepEqual(store.list(), []);
        await assert.rejects(store.save(Readable.from([]), 'empty.csv'), (err: unknown) => err instanceof FileRefused && err.status === 400);
    });
});

describe('headLines', () => {
    it('reads the head of a long file and says there is more', async () => {
        const path = join(tmp(), 'long.csv');
        writeFileSync(path, '\uFEFF' + Array.from({ length: 5000 }, (_, i) => `row,${i}`).join('\n'));
        const head = await headLines(path, 100);
        assert.equal(head.lines.length, 100);
        assert.equal(head.lines[0], 'row,0');
        assert.equal(head.truncated, true);
        const all = await headLines(path, 10000);
        assert.equal(all.lines.length, 5000);
        assert.equal(all.truncated, false);
    });

    it('cuts a very long line rather than returning it whole', async () => {
        const path = join(tmp(), 'wide.csv');
        writeFileSync(path, 'x'.repeat(10000) + '\nshort');
        const head = await headLines(path, 10, 100);
        assert.equal(head.lines[0]?.length, 100);
        assert.equal(head.long_lines, 1);
    });
});

describe('uploadHandler and previewHandler', () => {
    it('take a file over HTTP, preview it and remove it', async () => {
        const store = new FileStore(tmp());
        const saved: string[] = [];
        const server = createServer(
            routeRequests({
                'POST /upload': uploadHandler(store, { saved: (f) => (saved.push(f.name), { note: `kept ${f.name}` }) }),
                'DELETE /upload': uploadHandler(store),
                'GET /preview': previewHandler((name) => store.find(name)?.path),
            })
        );
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const up = await fetch(`${base}/upload?name=day%201.csv`, { method: 'POST', body: 'h\n1\n2\n3\n' });
            assert.equal(up.status, 201);
            const upBody = (await up.json()) as { name: string; bytes: number; note: string };
            assert.equal(upBody.name, 'day-1.csv');
            assert.equal(upBody.note, 'kept day-1.csv');
            assert.deepEqual(saved, ['day-1.csv']);

            const pv = await fetch(`${base}/preview?name=day-1.csv&lines=2`);
            const head = (await pv.json()) as { lines: string[]; truncated: boolean };
            assert.deepEqual(head.lines, ['h', '1']);
            assert.equal(head.truncated, true);

            assert.equal((await fetch(`${base}/preview?name=nope.csv`)).status, 404);
            assert.equal((await fetch(`${base}/upload`, { method: 'POST', body: 'x' })).status, 400);
            assert.equal((await fetch(`${base}/upload?name=day-1.csv`, { method: 'DELETE' })).status, 204);
            assert.equal(store.list().length, 0);
        } finally {
            server.close();
        }
    });
});
