/**
 * The platform's card in the lab's console.
 *
 * A platform is a plugin of the console: it registers a descriptor, renews
 * it every `renew_seconds` for as long as it runs, and unregisters on a
 * clean shutdown so the card goes grey at once instead of lapsing. The
 * console keeps registrations in memory, so after a console restart the
 * card is back within one renewal — which is why a failed renewal is simply
 * tried again next time rather than given up on.
 *
 * All of it is outbound from the platform: it works against a lab on
 * another machine with no tunnel. Only the card's live parts (health, logs,
 * buttons) need the console to reach the platform, at `base_url`.
 */

import { validateDescriptor, type Plugin, type RegisterResponse } from './descriptor';
import { errorMessage, sleep, trimSlash, type Fetch, type Logger } from './util';

export interface LabPluginOptions {
    /** Where the platform reaches the console, e.g. http://127.0.0.1:8090. */
    consoleUrl: string;
    /**
     * The descriptor, or a function building it. A function is called on
     * every renewal, so a changed descriptor reaches the console within one
     * renewal — registering is renewing.
     */
    descriptor: Plugin | (() => Plugin);
    /** Until the console says otherwise (it answers renew_seconds). Default 10s. */
    renewMs?: number;
    /** Per registration request. Default 3s. */
    timeoutMs?: number;
    /** The goodbye on shutdown: short, because the process is on its way out. Default 400ms. */
    unregisterTimeoutMs?: number;
    fetch?: Fetch;
    logger?: Logger;
}

export interface LabPluginState {
    /** The last registration was accepted. */
    live: boolean;
    /** Why the last one was not. */
    error?: string;
    /** When the next renewal is due, from the console's renew_seconds. */
    renewMs: number;
    /** The console's last answer. */
    response?: RegisterResponse;
    /** When the current live stretch began. */
    since?: string;
}

export class LabPlugin {
    readonly consoleUrl: string;
    private readonly build: () => Plugin;
    private readonly fetch: Fetch;
    private readonly logger: Logger;
    private readonly timeoutMs: number;
    private readonly unregisterTimeoutMs: number;
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
    private pending?: Promise<boolean>;
    private readonly current: LabPluginState;

    constructor(options: LabPluginOptions) {
        this.consoleUrl = trimSlash(options.consoleUrl);
        const d = options.descriptor;
        this.build = typeof d === 'function' ? d : () => d;
        this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.logger = options.logger ?? console;
        this.timeoutMs = options.timeoutMs ?? 3000;
        this.unregisterTimeoutMs = options.unregisterTimeoutMs ?? 400;
        this.current = { live: false, renewMs: options.renewMs ?? 10_000 };
    }

    /** The descriptor as it would be sent now, checked against the console's rules. */
    descriptor(): Plugin {
        return validateDescriptor(this.build());
    }

    get id(): string {
        return this.build().id;
    }

    get state(): Readonly<LabPluginState> {
        return this.current;
    }

    /**
     * Register, or renew: the same call. Never throws; says once when it
     * starts working and once when it stops, not every renewal.
     */
    register(): Promise<boolean> {
        const attempt = this.attempt();
        this.pending = attempt;
        return attempt;
    }

    private async attempt(): Promise<boolean> {
        try {
            const descriptor = this.descriptor();
            const res = await this.fetch(`${this.consoleUrl}/api/plugins`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(descriptor),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            const body = (await res.json().catch(() => ({}))) as Partial<RegisterResponse> & { error?: string };
            if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
            if (typeof body.renew_seconds === 'number' && body.renew_seconds > 0) {
                this.current.renewMs = body.renew_seconds * 1000;
            }
            if (!this.current.live) {
                this.logger.log(`🧩 registered with the lab console at ${this.consoleUrl}`);
                this.current.since = new Date().toISOString();
            }
            this.current.live = true;
            this.current.error = undefined;
            this.current.response = body as RegisterResponse;
            return true;
        } catch (err) {
            const msg = errorMessage(err);
            // Once when it breaks, and again only if the reason changes: a
            // console that is down reads the same every ten seconds.
            if (this.current.live || this.current.error !== msg) {
                this.logger.warn(`🧩 cannot register with the lab console at ${this.consoleUrl} (${msg}); retrying`);
            }
            this.current.live = false;
            this.current.error = msg;
            this.current.since = undefined;
            return false;
        }
    }

    /**
     * Register now and keep renewing until stop(). Throws at once on a
     * descriptor the console would refuse, rather than logging a 400 every
     * renewal for a card that never appears. The timer never holds the
     * process open.
     */
    start(): void {
        this.descriptor();
        if (this.running) return;
        this.running = true;
        const tick = async () => {
            await this.register();
            if (!this.running) return;
            this.timer = setTimeout(() => void tick(), this.current.renewMs);
            this.timer.unref?.();
        };
        void tick();
    }

    /** Stop renewing and say goodbye, so the card goes grey (stopped) at once. */
    async stop(): Promise<boolean> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        // A renewal still in flight would land after the goodbye and bring
        // the card back to live; let it finish first, within the same budget.
        if (this.pending) {
            await Promise.race([this.pending, sleep(this.unregisterTimeoutMs)]);
        }
        this.current.live = false;
        try {
            const res = await this.fetch(`${this.consoleUrl}/api/plugins/${encodeURIComponent(this.id)}`, {
                method: 'DELETE',
                signal: AbortSignal.timeout(this.unregisterTimeoutMs),
            });
            return res.ok;
        } catch {
            return false;
        }
    }
}
