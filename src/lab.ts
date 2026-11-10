/**
 * A client of the lab API, for what a platform's local runner or its tests
 * do to the lab rather than to a vendor: land a wire on a safeguarding
 * account, seed a vendor, run a cycle now, arm a trap, reset.
 *
 * One address and one token, as for registration and the clock
 * (LabConfig.labUrl, LabConfig.token). A vendor's own surface is not called
 * through it: the platform reaches a vendor as it would the real one.
 *
 *   const lab = new LabClient({ url: config.labUrl, token: config.token, environment: config.environment });
 *   await lab.sim('banking-circle', 'incoming-payments', { body: { currency: 'EUR', amount: '1000.00' } });
 *   await lab.reset({ scope: 'flow' });
 *
 * GET {url}/v1 lists every route; docs/api/lab-api.md in the lab describes them.
 *
 * Every call is in one environment (the lab's docs/lab-api/environments.md):
 * the token's own, or the one `environment` names for the admin token.
 */

import { DEFAULT_LAB_URL } from './config';
import { trimSlash, type Fetch } from './util';

export interface LabClientOptions {
    /** The lab API. Default http://127.0.0.1:8097. */
    url?: string;
    /** Sent as `Authorization: Bearer …` when the lab asks for one. */
    token?: string;
    /** Sent as `Lab-Environment`: the environment the calls act in (LabConfig.environment). */
    environment?: string;
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
        this.headers = labHeaders(options.token, options.environment);
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

    /**
     * Reset the lab, producers first and the clock last: POST /v1/lab/reset.
     * Only this client's environment's records: another platform's are not
     * this one's to clear.
     */
    reset(options: LabResetOptions = {}): Promise<LabAnswer> {
        return this.post('/v1/lab/reset', options);
    }

    /** The environment this client acts in: GET /v1/environment. */
    environment(): Promise<LabAnswer<LabEnvironment>> {
        return this.get<LabEnvironment>('/v1/environment');
    }

    /** Every environment (the admin token), or this one: GET /v1/environments. */
    environments(): Promise<LabAnswer<{ environments: LabEnvironment[] }>> {
        return this.get('/v1/environments');
    }

    /**
     * Create an environment (the admin token): POST /v1/environments. The
     * answer carries its token, which reaches only it.
     */
    createEnvironment(body: { name: string; id?: string; config?: LabEnvironmentConfig }): Promise<LabAnswer<{ environment: LabEnvironment; token: string }>> {
        return this.request('POST', '/v1/environments', body);
    }

    /** Delete an environment and everything it made (the admin token). */
    deleteEnvironment(id: string): Promise<LabAnswer> {
        return this.request('DELETE', `/v1/environments/${encodeURIComponent(id)}`);
    }

    /**
     * This environment's kit: the `.env` its platform runs with — its own
     * logins at every vendor, its safeguarding accounts, its lab token.
     * GET /v1/connect/env; the body is the file's text.
     */
    kit(host?: string): Promise<LabAnswer<string>> {
        return this.get<string>(`/v1/connect/env${host ? `?host=${encodeURIComponent(host)}` : ''}`);
    }
}

/** An environment's settings (all optional). */
export interface LabEnvironmentConfig {
    settlement_identifier?: string;
    webhook_hosts?: string[];
    aci_webhook_url?: string;
    b4b_callback_url?: string;
    clock?: 'follows' | 'wall';
}

/** An environment as the lab API shows it. */
export interface LabEnvironment {
    id: string;
    name: string;
    default?: boolean;
    config: LabEnvironmentConfig;
    created_at?: string;
    /** never-seen until a vendor has seen its platform, then seen. */
    state: 'never-seen' | 'seen';
    last_seen: string | null;
    seen_by: Record<string, string | null>;
    token?: string;
    kit: string;
    /** Vendors that do not keep environments apart yet. */
    shared: string[];
}

/** The headers every lab API call carries: the token, and the environment when one is named. */
export function labHeaders(token?: string, environment?: string): Record<string, string> {
    return {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(environment ? { 'Lab-Environment': environment } : {}),
    };
}
