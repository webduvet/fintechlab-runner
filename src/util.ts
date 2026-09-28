/** Where the library says things. `console` fits; so does any logger with these two. */
export interface Logger {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}

/** The fetch this library calls; injectable so tests can answer for the lab. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** A base URL without its trailing slashes, so paths can be appended with one. */
export function trimSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

/* ── the wall clock ───────────────────────────────────────────────────────
   A platform following the lab clock has a shifted `Date` (the clock shim),
   but some things must stay on the real time: an activity log's `at`, like
   every vendor's, so an event does not read "1d ago" the moment it happens.
   The shim publishes itself under a global symbol so this can undo its
   offset without loading it — importing the library must never install a
   shifted clock in a process that did not ask for one. */

const SHIM_KEY = Symbol.for('@fintechlab/runner/clock-shim');

/** The clock shim's current offset in ms, or 0 when no shim is loaded. */
export function shimOffsetMs(): number {
    const shim = (globalThis as Record<symbol, { offsetMs?: number } | undefined>)[SHIM_KEY];
    return typeof shim?.offsetMs === 'number' ? shim.offsetMs : 0;
}

/** Now on the wall clock, as an ISO string, whatever the shim has done to `Date`. */
export function wallClock(): string {
    return new Date(Date.now() - shimOffsetMs()).toISOString();
}
