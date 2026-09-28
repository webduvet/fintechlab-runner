/**
 * Activity logs in the lab's shape (the lab's internal/activity; its
 * docs/plugins.md, "Activity logs"), so the console renders a platform's
 * logs with the panel it already draws every vendor's with.
 *
 * Two additions over a vendor's log, both about saying what is true:
 * - `at` is the wall clock, like every vendor's, not the platform's shifted
 *   clock — see wallClock().
 * - `labels` names what amber and red mean in this log. A vendor's amber is
 *   a request it refused; a platform's may be "finished with failed stages".
 */

import { wallClock } from './util';

export type EventStatus = 'ok' | 'warn' | 'bad';

export type StatusLabels = Partial<Record<Exclude<EventStatus, 'ok'>, string>>;

export interface ActivityEvent {
    seq: number;
    /** Wall-clock time, ISO 8601. */
    at: string;
    op: string;
    peer?: string;
    summary: string;
    status: EventStatus;
    detail?: Record<string, string>;
}

export interface ActivitySnapshot {
    name: string;
    title: string;
    note?: string;
    labels: StatusLabels;
    /** Everything ever recorded. */
    total: number;
    /** What is still in the ring. */
    kept: number;
    last?: ActivityEvent;
    events: ActivityEvent[];
}

export interface ActivityLogOptions {
    /** What amber and red mean in this log. */
    labels?: StatusLabels;
    /** How many events it keeps; the oldest goes first. The lab's default is 256. */
    capacity?: number;
    /** Where `at` comes from. Default: the wall clock. */
    now?: () => string;
}

/** How many events a request returns when it does not ask; the lab's default. */
export const DEFAULT_ACTIVITY_LIMIT = 100;

/** A fixed-size ring of events, newest first. */
export class ActivityLog {
    readonly labels: StatusLabels;
    private events: ActivityEvent[] = [];
    private seq = 0;
    private total = 0;
    private readonly capacity: number;
    private readonly now: () => string;

    /**
     * @param name  the stable key the console renders under (a log name:
     *              lower-case letters, digits, `-`, `_`)
     * @param title shown to the operator
     * @param note  what this log is for
     */
    constructor(
        readonly name: string,
        readonly title: string,
        readonly note: string,
        options: ActivityLogOptions = {}
    ) {
        this.labels = options.labels ?? {};
        this.capacity = Math.max(1, options.capacity ?? 256);
        this.now = options.now ?? wallClock;
    }

    /** Add an event; `seq` and `at` are filled in here. */
    record(e: Omit<ActivityEvent, 'seq' | 'at' | 'status'> & { at?: string; status?: EventStatus }): ActivityEvent {
        const full: ActivityEvent = {
            ...e,
            status: e.status ?? 'ok',
            seq: ++this.seq,
            at: e.at ?? this.now(),
        };
        this.total += 1;
        this.events.unshift(full);
        if (this.events.length > this.capacity) this.events.length = this.capacity;
        return full;
    }

    /** Rewrite an event in place, so one long-running thing stays one row.
     *  False when it has already left the ring. */
    update(seq: number, patch: Partial<Omit<ActivityEvent, 'seq'>>): boolean {
        const found = this.events.find((e) => e.seq === seq);
        if (found) Object.assign(found, patch);
        return Boolean(found);
    }

    /** Up to `limit` events, newest first. */
    recent(limit = DEFAULT_ACTIVITY_LIMIT): ActivityEvent[] {
        return this.events.slice(0, Math.max(0, limit));
    }

    snapshot(limit = DEFAULT_ACTIVITY_LIMIT): ActivitySnapshot {
        const events = this.recent(limit);
        return {
            name: this.name,
            title: this.title,
            note: this.note,
            labels: this.labels,
            total: this.total,
            kept: this.events.length,
            last: events[0],
            // Always an array: the console renders its empty state from a
            // list it can count.
            events,
        };
    }
}

/**
 * The body of an activity_path: `{"logs": [...]}`, in the order given.
 * `limit` is the request's `?limit=`, as a string or number; anything that
 * is not a positive number means the default.
 */
export function activityBody(
    logs: readonly ActivityLog[],
    limit?: string | number | null
): { logs: ActivitySnapshot[] } {
    const n = Number(limit);
    const effective = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ACTIVITY_LIMIT;
    return { logs: logs.map((l) => l.snapshot(effective)) };
}
