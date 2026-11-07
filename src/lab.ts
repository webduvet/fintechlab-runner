/**
 * A client of the lab API, for what a platform's local runner or its tests
 * do to the lab rather than to a vendor: land a wire on a safeguarding
 * account, seed a vendor, run a cycle now, arm a trap, reset.
 *
 * One address and one token, as for registration and the clock
 * (LabConfig.labUrl, LabConfig.token). A vendor's own surface is not called
 * through it: the platform reaches a vendor as it would the real one.
 *
 *   const lab = new LabClient({ url: config.labUrl, token: config.token });
 *   await lab.sim('banking-circle', 'incoming-payments', { body: { currency: 'EUR', amount: '1000.00' } });
 *   await lab.reset({ scope: 'flow' });
 *
 * GET {url}/v1 lists every route; docs/api/lab-api.md in the lab describes them.
 */

import { DEFAULT_LAB_URL } from './config';
import { trimSlash, type Fetch } from './util';

export interface LabClientOptions {
    /** The lab API. Default http://127.0.0.1:8097. */
    url?: string;
    /** Sent as `Authorization: Bearer …` when the lab asks for one. */
    token?: string;
    /** Per request. Default 10s. */
    timeoutMs?: number;
    fetch?: Fetch;
}

/** The lab's answer: its status as given, and its JSON body (or its text, when it is not JSON). */
export interface LabAnswer<T = unknown> {
    status: number;
    ok: boolean;
    body: T;
}

export interface LabResetOptions {
    /** "flow" (the default) clears what a run made; "all" is as on first start. */
    scope?: 'flow' | 'all';
    /** Only these services. */
    services?: string[];
    /** Reset even while someone holds the clock. */
    force?: boolean;
}

export class LabClient {
    readonly url: string;
    private readonly headers: Record<string, string>;
    private readonly timeoutMs: number;
    private readonly fetch: Fetch;

    constructor(options: LabClientOptions = {}) {
        this.url = trimSlash(options.url ?? DEFAULT_LAB_URL);
        this.headers = options.token ? { Authorization: `Bearer ${options.token}` } : {};
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    }

    /**
     * One call: `path` from the root, e.g. "/v1/services". Throws only when
     * the lab cannot be reached; any answer, 4xx and 5xx included, comes
     * back for the caller to judge.
     */
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<LabAnswer<T>> {
        const res = await this.fetch(`${this.url}${path.startsWith('/') ? '' : '/'}${path}`, {
            method,
            headers: body === undefined ? this.headers : { 'Content-Type': 'application/json', ...this.headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            // not JSON: the text, as it came
        }
        return { status: res.status, ok: res.ok, body: parsed as T };
    }

    get<T = unknown>(path: string): Promise<LabAnswer<T>> {
        return this.request<T>('GET', path);
    }

    post<T = unknown>(path: string, body?: unknown): Promise<LabAnswer<T>> {
        return this.request<T>('POST', path, body ?? {});
    }

    /**
     * One of a service's lab hooks, `/sim/{rest}` on its control port,
     * through the lab API's passthrough. `rest` may carry a query:
     * sim('worldline', 'settlement-cycle/run?slot=morning&date=2026-11-06', { method: 'POST' }).
     * The method defaults to POST with a body, GET without.
     */
    sim<T = unknown>(service: string, rest: string, init: { method?: string; body?: unknown } = {}): Promise<LabAnswer<T>> {
        const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
        return this.request<T>(method, `/v1/services/${encodeURIComponent(service)}/sim/${rest.replace(/^\//, '')}`, init.body);
    }

    /** Reset the lab, producers first and the clock last: POST /v1/lab/reset. */
    reset(options: LabResetOptions = {}): Promise<LabAnswer> {
        return this.post('/v1/lab/reset', options);
    }
}
