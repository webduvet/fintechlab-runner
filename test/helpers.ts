import type { Fetch, Logger } from '../src/util';

export interface Call {
    url: string;
    method: string;
    body?: unknown;
}

/** A fetch that answers from a function and remembers every call. */
export function fakeFetch(answer: (call: Call) => Response | Promise<Response> | Error): Fetch & { calls: Call[] } {
    const calls: Call[] = [];
    const f = async (input: string, init?: RequestInit) => {
        const call: Call = {
            url: input,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const got = await answer(call);
        if (got instanceof Error) throw got;
        return got;
    };
    return Object.assign(f, { calls });
}

export function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A logger that keeps what it was told. */
export function memoryLogger(): Logger & { lines: string[]; warnings: string[] } {
    const lines: string[] = [];
    const warnings: string[] = [];
    return {
        lines,
        warnings,
        log: (...a: unknown[]) => void lines.push(a.join(' ')),
        warn: (...a: unknown[]) => void warnings.push(a.join(' ')),
    };
}

/** Let pending promise callbacks run. */
export const flush = () => new Promise<void>((r) => setImmediate(r));
