/**
 * Settlement files from anywhere: a store the platform keeps them in, and
 * the two routes the console's files table calls (docs/plugins.md,
 * Settlement — upload_path and preview_path).
 *
 * A file can be big — a real acquirer's day can run to a million lines —
 * so nothing here reads a whole file into memory: an upload is streamed to
 * disk, and a preview reads lines until it has enough and stops.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { json, type RouteHandler } from './http';
import { errorMessage } from './util';

export interface StoredFile {
    name: string;
    path: string;
    bytes: number;
    /** ISO time the file was last written. */
    modified: string;
}

/** A refusal with the HTTP status it should be answered with. */
export class FileRefused extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

/**
 * The name a file is kept under: its base name, with anything but letters,
 * digits, dot, dash and underscore made a dash. A name is a label from a
 * browser, never a path — "../../etc/passwd" is kept as "etc-passwd".
 */
export function safeFileName(raw: string): string | undefined {
    const base = basename(String(raw).replace(/\\/g, '/'))
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[.-]+/, '')
        .slice(0, 120);
    return base && base !== '.' && base !== '..' ? base : undefined;
}

export interface FileStoreOptions {
    /** The largest file taken, in bytes. Default 512 MB. */
    maxBytes?: number;
    /** Names already in use elsewhere (the platform's own fixtures): an
        upload with one of them is kept under the next free name instead. */
    reserved?: () => Iterable<string>;
}

/** A directory of files the platform was handed. */
export class FileStore {
    readonly dir: string;
    private readonly maxBytes: number;
    private readonly reserved: () => Iterable<string>;

    constructor(dir: string, options: FileStoreOptions = {}) {
        this.dir = resolve(dir);
        this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
        this.reserved = options.reserved ?? (() => []);
    }

    /** Every file kept, newest first. */
    list(): StoredFile[] {
        let names: string[];
        try {
            names = readdirSync(this.dir);
        } catch {
            return [];
        }
        const out: StoredFile[] = [];
        for (const name of names) {
            if (name.startsWith('.')) continue; // partial uploads, sidecars
            const f = this.find(name);
            if (f) out.push(f);
        }
        return out.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
    }

    find(name: string): StoredFile | undefined {
        const safe = safeFileName(name);
        if (!safe || safe !== name) return undefined;
        const path = resolve(this.dir, safe);
        try {
            const st = statSync(path);
            if (!st.isFile()) return undefined;
            return { name: safe, path, bytes: st.size, modified: st.mtime.toISOString() };
        } catch {
            return undefined;
        }
    }

    /** A free name for raw: raw itself, or raw-2, raw-3 … before the extension. */
    private freeName(raw: string): string {
        const safe = safeFileName(raw);
        if (!safe) throw new FileRefused(`"${raw}" is not a file name`, 400);
        const taken = new Set(this.reserved());
        const ext = extname(safe);
        const stem = safe.slice(0, safe.length - ext.length);
        for (let i = 1; ; i++) {
            const candidate = i === 1 ? safe : `${stem}-${i}${ext}`;
            if (!taken.has(candidate) && !existsSync(resolve(this.dir, candidate))) return candidate;
        }
    }

    /**
     * Keep what source streams under a name derived from rawName. Written
     * to a hidden partial file first and renamed when complete, so a list
     * never shows half a file.
     */
    async save(source: Readable, rawName: string): Promise<StoredFile> {
        mkdirSync(this.dir, { recursive: true });
        const name = this.freeName(rawName);
        const partial = resolve(this.dir, `.${name}.partial`);
        const out = createWriteStream(partial);
        let bytes = 0;
        try {
            await new Promise<void>((done, fail) => {
                source.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > this.maxBytes) {
                        source.destroy();
                        fail(new FileRefused(`over the ${Math.round(this.maxBytes / 1048576)} MB this platform takes`, 413));
                        return;
                    }
                    if (!out.write(chunk)) {
                        source.pause();
                        out.once('drain', () => source.resume());
                    }
                });
                source.on('end', () => out.end(done));
                source.on('error', fail);
                out.on('error', fail);
            });
        } catch (err) {
            out.destroy();
            rmSync(partial, { force: true });
            throw err;
        }
        if (bytes === 0) {
            rmSync(partial, { force: true });
            throw new FileRefused('the file is empty', 400);
        }
        const path = resolve(this.dir, name);
        renameSync(partial, path);
        return this.find(name) ?? { name, path, bytes, modified: new Date().toISOString() };
    }

    /** Remove a kept file. False when there is no such file. */
    remove(name: string): boolean {
        const f = this.find(name);
        if (!f) return false;
        rmSync(f.path, { force: true });
        return true;
    }
}

export interface Head {
    lines: string[];
    /** More lines follow the ones returned. */
    truncated: boolean;
    /** How many returned lines were cut at maxLineChars. */
    long_lines: number;
    bytes: number;
}

/**
 * The first `max` lines of a file, reading no further than it has to —
 * a preview of a million-line file costs the same as one of a hundred.
 */
export async function headLines(path: string, max: number, maxLineChars = 4000): Promise<Head> {
    const bytes = statSync(path).size;
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    let truncated = false;
    let long = 0;
    try {
        for await (const raw of rl) {
            if (lines.length >= max) {
                truncated = true;
                break;
            }
            const line = lines.length === 0 ? raw.replace(/^﻿/, '') : raw;
            if (line.length > maxLineChars) long++;
            lines.push(line.length > maxLineChars ? line.slice(0, maxLineChars) : line);
        }
    } finally {
        rl.close();
        stream.destroy();
    }
    return { lines, truncated, long_lines: long, bytes };
}

/** Call onLine for every line of a file, streamed. */
export async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) onLine(line);
    } finally {
        rl.close();
        stream.destroy();
    }
}

export interface UploadHooks {
    /** After a file is kept: e.g. parse it. What it returns is merged into
        the answer (a `note` there is the console's toast). */
    saved?: (file: StoredFile) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
    /** After a file is removed. */
    removed?: (name: string) => void;
}

/**
 * The upload_path route: POST ?name= keeps the body (201 with the name it
 * was kept under — which may differ), DELETE ?name= removes one (204).
 */
export function uploadHandler(store: FileStore, hooks: UploadHooks = {}): RouteHandler {
    return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
        const name = url.searchParams.get('name') ?? '';
        if (req.method === 'DELETE') {
            if (!store.remove(name)) {
                json(res, 404, { error: `no uploaded file ${name} in ${store.dir}` });
                return;
            }
            hooks.removed?.(name);
            res.writeHead(204).end();
            return;
        }
        if (!name) {
            json(res, 400, { error: 'name the file: ?name=<file name>' });
            return;
        }
        try {
            const file = await store.save(req, name);
            const extra = (await hooks.saved?.(file)) ?? {};
            json(res, 201, { name: file.name, bytes: file.bytes, dir: store.dir, ...extra });
        } catch (err) {
            json(res, err instanceof FileRefused ? err.status : 500, { error: errorMessage(err) });
        }
    };
}

/**
 * The preview_path route: GET ?name=&lines= answers the head of a file
 * `find` knows — {name, lines, truncated, long_lines, bytes}. lines is
 * clamped to 1..1000.
 */
export function previewHandler(find: (name: string) => string | undefined): RouteHandler {
    return async (_req: IncomingMessage, res: ServerResponse, url: URL) => {
        const name = url.searchParams.get('name') ?? '';
        const path = find(name);
        if (!path) {
            json(res, 404, { error: `no settlement file ${name}` });
            return;
        }
        const asked = Number(url.searchParams.get('lines') ?? 100);
        const max = Math.min(1000, Math.max(1, Number.isFinite(asked) ? Math.floor(asked) : 100));
        try {
            json(res, 200, { name, ...(await headLines(path, max)) });
        } catch (err) {
            json(res, 500, { error: errorMessage(err) });
        }
    };
}
