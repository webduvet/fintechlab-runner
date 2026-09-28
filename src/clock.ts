/**
 * Following the lab's clock.
 *
 * The lab owns one business clock (its `clock` service, :8096) and every
 * vendor follows its offset from the real time. A platform that follows it
 * too books a payout "on Monday" on the same Monday as the bank. Only the
 * offset changes hands, polled once a second, so a follower anywhere is
 * right to within its poll — and it is outbound, so it works wherever the
 * lab is.
 *
 * The follower writes what it reads to one small file; every process of the
 * platform preloads the clock shim (`@fintechlab/runner/clock-shim`), which
 * watches that file and shifts `Date` by its offset. One writer, many
 * readers, so the whole platform moves together.
 *
 * A platform with work in flight that must not have the clock moved under
 * it (a settlement run) holds the clock; moves are refused until it lets go
 * or the hold lapses, so a platform killed mid-run cannot freeze the lab.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { errorMessage, trimSlash, type Fetch, type Logger } from './util';

/** A calendar the lab judges business days by. */
export interface LabCalendar {
    code: string;
    zone: string;
    date: string;
    weekday: string;
    business_day: boolean;
}

export interface LabClockHold {
    holder: string;
    reason: string;
    [field: string]: unknown;
}

/** What `GET /clock` answers. */
export interface LabClock {
    offset_ms: number;
    offset_hours?: number;
    now?: string;
    /** "real", "pinned", "auto-business-day". */
    mode: string;
    reason?: string;
    business_day?: boolean;
    calendars?: LabCalendar[];
    holds?: LabClockHold[];
    [field: string]: unknown;
}

/** What the clock file carries; the shim reads `offset_ms` (and `mode`, `reason`). */
export interface ClockFileContent {
    offset_ms: number;
    mode: string;
    reason?: string;
}

/** The clock file the shim watches unless told otherwise: RUNNER_CLOCK_FILE, else `.runs/clock.json` under the working directory. */
export function defaultClockFile(env: NodeJS.ProcessEnv = process.env): string {
    return env.RUNNER_CLOCK_FILE || resolve(process.cwd(), '.runs', 'clock.json');
}

/** Written whole and renamed, so a reader mid-write never parses half a file. */
export function writeClockFile(file: string, content: ClockFileContent): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.partial`;
    writeFileSync(tmp, JSON.stringify(content, null, 2));
    renameSync(tmp, file);
}

export interface LabClockFollowerOptions {
    /** The clock service's `GET /clock`, e.g. http://127.0.0.1:8096/clock. */
    url: string;
    /** Who holds the clock: the plugin id is the natural choice. */
    holder: string;
    /** The file the platform's clock shims watch. Default: defaultClockFile(). */
    clockFile?: string;
    /**
     * Why the clock must not move right now, or null/undefined when it may.
     * Called by syncHold(): a platform calls that whenever its work starts
     * or finishes — "is a run in flight?".
     */
    holdReason?: () => string | null | undefined;
    /** How long a hold stands unless renewed or released. Default 900 (the lab caps it at an hour). */
    holdTtlSeconds?: number;
    /** Default 1000. */
    intervalMs?: number;
    /** Per request. Default 2000. */
    timeoutMs?: number;
    /** What processes start on when there is no lab clock yet, for the log line. */
    fallback?: string;
    fetch?: Fetch;
    logger?: Logger;
}

export interface LabClockFollowerState {
    reachable: boolean;
    /** The lab's last answer. */
    last?: LabClock;
    error?: string;
    /** When the current reachable stretch began. */
    since?: string;
    /** The offset last written to the clock file. */
    written?: number;
    /** A hold this follower asked for and has not released. */
    holding?: string;
}

/** The follower's side of GET /sim/clock-style endpoints. */
export interface LabClockView {
    file: string;
    follows: string;
    lab_reachable: boolean;
    lab?: LabClock;
    lab_error?: string;
    holding?: string;
}

export class LabClockFollower {
    readonly url: string;
    readonly holder: string;
    readonly clockFile: string;
    private readonly options: LabClockFollowerOptions;
    private readonly fetch: Fetch;
    private readonly logger: Logger;
    private timer?: ReturnType<typeof setInterval>;
    private readonly current: LabClockFollowerState = { reachable: false };

    constructor(options: LabClockFollowerOptions) {
        this.options = options;
        this.url = trimSlash(options.url);
        this.holder = options.holder;
        this.clockFile = options.clockFile ?? defaultClockFile();
        this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.logger = options.logger ?? console;
    }

    get state(): Readonly<LabClockFollowerState> {
        return this.current;
    }

    private get timeoutMs(): number {
        return this.options.timeoutMs ?? 2000;
    }

    /** One read of the lab clock. Throws on anything but a usable answer. */
    async read(): Promise<LabClock> {
        const res = await this.fetch(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as LabClock;
        if (typeof body?.offset_ms !== 'number') throw new Error('no offset_ms in the answer');
        return body;
    }

    /**
     * One poll: read the lab, and rewrite the clock file only when the
     * offset changed — every shim re-reads the file whenever its bytes do.
     * Never throws; an unreachable lab keeps the last offset (the lab
     * restarting is not the lab going back to the real clock).
     */
    async poll(): Promise<LabClock | undefined> {
        try {
            const lab = await this.read();
            if (!this.current.reachable) {
                this.logger.log(`⏰ following the lab clock at ${this.url}`);
                this.current.since = new Date().toISOString();
            }
            this.current.reachable = true;
            this.current.last = lab;
            this.current.error = undefined;
            if (this.current.written !== lab.offset_ms) {
                // mode "lab", not the lab's own mode: the lab has already
                // done the arithmetic (auto-business-day included), and a
                // shim told "auto-business-day" would redo it against its
                // own calendars.
                writeClockFile(this.clockFile, {
                    offset_ms: lab.offset_ms,
                    mode: 'lab',
                    reason: `lab clock: ${lab.mode}${lab.reason ? ` — ${lab.reason}` : ''}`,
                });
                this.current.written = lab.offset_ms;
            }
            return lab;
        } catch (err) {
            const msg = errorMessage(err);
            if (this.current.reachable || this.current.error === undefined) {
                // Said once, not every second.
                this.logger.warn(`⏰ cannot read the lab clock at ${this.url} (${msg}); keeping the last offset`);
            }
            this.current.reachable = false;
            this.current.error = msg;
            this.current.since = undefined;
            return undefined;
        }
    }

    /**
     * Before the platform's processes start: take the lab's clock, or — with
     * no lab to ask — remove a clock file left from another session, so the
     * processes start on their own setting (RUNNER_NOW) rather than a day
     * nobody remembers choosing. Then poll every second until stop().
     */
    async start(): Promise<void> {
        await this.poll();
        if (!this.current.reachable && existsSync(this.clockFile)) {
            rmSync(this.clockFile, { force: true });
            const fallback =
                this.options.fallback ?? `RUNNER_NOW (${process.env.RUNNER_NOW || 'the real clock'})`;
            this.logger.warn(`⏰ no lab clock yet; removed ${this.clockFile}, starting on ${fallback}`);
        }
        if (this.timer) return;
        this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 1000);
        this.timer.unref?.();
    }

    /** Stop polling, and release any hold this follower took. */
    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (this.current.holding !== undefined) await this.release();
    }

    private get holdsUrl(): string {
        // The holds live under the clock: POST /clock/holds, DELETE /clock/holds/{holder}.
        return `${this.url}/holds`;
    }

    /** Hold the lab clock: moves are refused with 409 and this reason until release() or the TTL. */
    async hold(reason: string, ttlSeconds = this.options.holdTtlSeconds ?? 900): Promise<boolean> {
        this.current.holding = reason;
        try {
            const res = await this.fetch(this.holdsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ holder: this.holder, reason, ttl_seconds: ttlSeconds }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (!res.ok) this.logger.warn(`⏰ could not hold the lab clock: HTTP ${res.status}`);
            return res.ok;
        } catch (err) {
            // No lab clock, no hold to take: the work goes ahead regardless.
            this.logger.warn(`⏰ could not reach the lab clock to hold it: ${errorMessage(err)}`);
            return false;
        }
    }

    async release(): Promise<boolean> {
        this.current.holding = undefined;
        try {
            const res = await this.fetch(`${this.holdsUrl}/${encodeURIComponent(this.holder)}`, {
                method: 'DELETE',
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            return res.ok || res.status === 404;
        } catch (err) {
            this.logger.warn(`⏰ could not reach the lab clock to release it: ${errorMessage(err)}`);
            return false;
        }
    }

    /**
     * Hold while holdReason() gives a reason, release when it gives none.
     * Call it whenever the platform's work starts or finishes.
     */
    async syncHold(): Promise<boolean> {
        const reason = this.options.holdReason?.();
        return reason ? this.hold(reason) : this.release();
    }

    view(): LabClockView {
        const s = this.current;
        return {
            file: this.clockFile,
            follows: this.url,
            lab_reachable: s.reachable,
            ...(s.last ? { lab: s.last } : {}),
            ...(s.error ? { lab_error: s.error } : {}),
            ...(s.holding ? { holding: s.holding } : {}),
        };
    }
}
