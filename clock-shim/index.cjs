/**
 * @fintechlab/runner/clock-shim — a platform's processes on the lab's clock
 *
 *   node -r @fintechlab/runner/clock-shim your-entry.js
 *
 * Preloaded with `node -r`, it applies an offset to Date — constant, not
 * frozen, so timeouts, long-polling and elapsed-time logging all still
 * behave — and it watches one small file for that offset. The fintech sim
 * lab's clock service decides the offset; the platform's runner copies what
 * the lab says into the file (LabClockFollower, mode "lab"), and every
 * process preloading this shim picks it up within a second. One write moves
 * the whole platform, which is the point: a settlement whose stages
 * disagreed with the bank about what day it is would be a worse lie than
 * the wall clock.
 *
 * Zero dependencies and plain CommonJS on purpose: it loads before any
 * TypeScript loader, in processes (built bundles, shell-started servers)
 * that have nothing else in common.
 *
 * Environment:
 *
 *   RUNNER_CLOCK_FILE   the file to watch; default .runs/clock.json under the
 *                       working directory the process started in. Set it
 *                       once for the whole platform so every process watches
 *                       the same file whatever its cwd.
 *   RUNNER_NOW          the starting point until the file says otherwise — or
 *                       the whole story with no lab running. Off when unset.
 *                       auto-business-day       the most recent instant that is
 *                                               a business day on both calendars
 *                                               below
 *                       2026-09-16T10:00:00Z    pinned to that instant
 *   SETTLE_BANK_HOLIDAYS_GB, SETTLE_BANK_HOLIDAYS_SE
 *                       extra non-business dates (YYYY-MM-DD, comma or newline
 *                       separated) for RUNNER_NOW=auto-business-day, which
 *                       judges business days against Europe/London and
 *                       Europe/Stockholm. With a lab running the lab does that
 *                       arithmetic and these do not matter.
 *
 * Why auto-business-day exists at all: a settlement platform (buddy's
 * BusinessDayService) rightly refuses to settle on a weekend or bank
 * holiday of the file's currency calendar, which makes a local run
 * impossible for a third of the week — including any weekday evening after
 * 22:00 UTC, when Stockholm has already rolled into Saturday. Rather than
 * weaken the product rule, the shim moves the platform's clock.
 */

const RealDate = Date;

/** Local ISO date (YYYY-MM-DD) and weekday of `at` in `timeZone`. */
function localParts(at, timeZone) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(at);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
    return { date, weekday };
}

function holidays(envVar) {
    return new Set(
        (process.env[envVar] ?? '')
            .split(/[,\n]/)
            .map((entry) => entry.trim())
            .filter(Boolean)
    );
}

/**
 * Whether `at` is a business day on both settlement calendars. Deliberately
 * stricter than any single currency's rule: one shifted clock serves a run that
 * may carry GBP and EUR files, and a day that satisfies both is always safe.
 */
function isBusinessDayEverywhere(at) {
    const calendars = [
        { timeZone: 'Europe/London', envVar: 'SETTLE_BANK_HOLIDAYS_GB' },
        { timeZone: 'Europe/Stockholm', envVar: 'SETTLE_BANK_HOLIDAYS_SE' },
    ];
    return calendars.every(({ timeZone, envVar }) => {
        const { date, weekday } = localParts(at, timeZone);
        return weekday !== 'Sat' && weekday !== 'Sun' && !holidays(envVar).has(date);
    });
}

/** The most recent business-day instant at or before `from`, stepping back an hour at a time. */
function mostRecentBusinessDay(from) {
    const hour = 3600 * 1000;
    let at = new RealDate(from.getTime());
    // Four days of hours is enough to clear any weekend plus a bank holiday.
    for (let step = 0; step < 24 * 6; step += 1) {
        if (isBusinessDayEverywhere(at)) {
            return at;
        }
        at = new RealDate(at.getTime() - hour);
    }
    return null;
}

function resolveOffset() {
    const setting = (process.env.RUNNER_NOW ?? '').trim();
    if (!setting) {
        return 0;
    }

    const realNow = new RealDate();

    if (setting === 'auto-business-day') {
        if (isBusinessDayEverywhere(realNow)) {
            return 0;
        }
        const target = mostRecentBusinessDay(realNow);
        if (!target) {
            console.warn(
                '⏰ clock-shim: no business day found within the last six days — leaving the clock alone'
            );
            return 0;
        }
        return target.getTime() - realNow.getTime();
    }

    const parsed = RealDate.parse(setting);
    if (Number.isNaN(parsed)) {
        // Refusing is safer than guessing: a typo that silently ran on the real
        // clock would look like the shim working and fail deep in a stage.
        throw new Error(
            `clock-shim: RUNNER_NOW="${setting}" is neither "auto-business-day" nor a parsable timestamp`
        );
    }
    return parsed - realNow.getTime();
}

let offset = resolveOffset();
/** Whether the shared file has taken control of the offset. */
let pinned = false;

const CLOCK_FILE =
    process.env.RUNNER_CLOCK_FILE || require('node:path').resolve(process.cwd(), '.runs', 'clock.json');

/**
 * Follow the shared clock file.
 *
 * One writer (the runner's clock follower), many readers: every supervised
 * process runs this shim, so a single write moves them all together.
 *
 * Polled rather than watched with fs.watch: a poll is four stat calls a
 * second across the whole stack, and fs.watch's behaviour on a file replaced
 * by rename (which is how the follower writes it) differs between
 * platforms in ways not worth discovering at 2am.
 */
function followClockFile() {
    const fs = require('node:fs');
    let lastSeen = '';
    const read = () => {
        let raw;
        try {
            raw = fs.readFileSync(CLOCK_FILE, 'utf8');
        } catch {
            return; // no file is the normal case: the env setting stands
        }
        if (raw === lastSeen) {
            return;
        }
        lastSeen = raw;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            console.warn(`⏰ clock-shim: ${CLOCK_FILE} is not JSON — ignoring it`);
            return;
        }
        let next;
        if (parsed.mode === 'auto-business-day') {
            // A stored offset cannot mean "the most recent business day": the
            // real clock keeps moving, so an offset written last night lands
            // this process an hour inside a Saturday — and MERCHANT_SETTLEMENT
            // skips with NON_BUSINESS_DAY for a reason nothing connects to a
            // file. The file carries the *intent*; each reader does its own
            // arithmetic against its own real clock.
            const target = mostRecentBusinessDay(new RealDate());
            next = target ? target.getTime() - RealDate.now() : 0;
        } else {
            next = Number(parsed.offset_ms);
        }
        if (!Number.isFinite(next) || next === offset) {
            return;
        }
        offset = next;
        pinned = parsed.mode !== 'auto-business-day';
        installShiftedDate();
        const now = new RealDate(RealDate.now() + offset);
        console.log(
            `⏰ clock-shim: now ${now.toISOString()} (${(offset / 3600000).toFixed(1)}h from real)` +
                `${parsed.reason ? ' — ' + parsed.reason : ''}`
        );
    };
    read();
    const timer = setInterval(read, 1000);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
}

/**
 * Keep the shifted clock inside a business day.
 *
 * The offset is a constant, so a process started at 23:00 on a Friday walks
 * out of Friday an hour later exactly as the real clock does — and the next
 * settlement run fails on a non-business day with the operator none the
 * wiser, because nothing about the failure mentions a clock. Re-deriving it
 * on a slow timer costs nothing and removes the whole class of "it worked an
 * hour ago".
 *
 * Node's timers are monotonic, so moving Date backwards does not disturb
 * anything already scheduled.
 */
function keepInsideBusinessDay() {
    if ((process.env.RUNNER_NOW ?? '').trim() !== 'auto-business-day') {
        return;
    }
    const timer = setInterval(() => {
        // A deliberate Sunday is a test, not a drift. Once something has
        // pinned the clock through the file, this stops second-guessing it —
        // otherwise "run this on a non-business day" would quietly become
        // "run this on Friday" five minutes later, which is the kind of help
        // nobody can debug.
        if (pinned) {
            return;
        }
        const shiftedNow = new RealDate(RealDate.now() + offset);
        if (isBusinessDayEverywhere(shiftedNow)) {
            return;
        }
        const target = mostRecentBusinessDay(new RealDate());
        if (!target) {
            return;
        }
        const next = target.getTime() - RealDate.now();
        const moved = (next - offset) / 3600000;
        offset = next;
        console.log(
            `⏰ clock-shim: the shifted clock left the business day; moved a further ` +
                `${moved.toFixed(1)}h back to ${new RealDate(RealDate.now() + offset).toISOString()}`
        );
    }, 5 * 60 * 1000);
    // Never a reason to hold the process open.
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
}

/* The shifted Date reads `offset` through a closure rather than capturing
   it, so the class is installed once and every later change to the offset —
   from the file, or from the business-day timer — is picked up by code that
   already holds a reference to Date. */
let installed = false;

function installShiftedDate() {
    if (installed) {
        return;
    }
    installed = true;

    class ShiftedDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                super(RealDate.now() + offset);
                return;
            }
            super(...args);
        }

        static now() {
            return RealDate.now() + offset;
        }
    }

    globalThis.Date = ShiftedDate;
}

if (offset !== 0) {
    installShiftedDate();

    const shiftedNow = new RealDate(RealDate.now() + offset);
    const hours = (offset / 3600000).toFixed(1);
    console.log(
        `⏰ clock-shim: ${shiftedNow.toISOString()} (${hours}h from the real clock) — ` +
            `London ${localParts(shiftedNow, 'Europe/London').weekday}, ` +
            `Stockholm ${localParts(shiftedNow, 'Europe/Stockholm').weekday}`
    );
}

// Watched whether or not an offset was set at start: the lab can put a
// process on a different day at any point, including one that booted on the
// real clock.
followClockFile();

// Started unconditionally, for the same reason: a process that booted at 22:30
// on a Friday needs this more than one that booted at noon, and it is exactly
// the one whose offset was zero.
keepInsideBusinessDay();

const shim = {
    /** The live offset from the real clock in ms, for anything that wants to report it. */
    get offsetMs() {
        return offset;
    },
    /** Whether the clock file has taken control of the offset. */
    get pinned() {
        return pinned;
    },
    /** Now on the real clock, in ms — what Date.now() would say without the shim. */
    realNow() {
        return RealDate.now();
    },
    isBusinessDayEverywhere,
    mostRecentBusinessDay,
    CLOCK_FILE,
};

/* Published under a global symbol, so @fintechlab/runner can tell the wall
   clock from the shifted one (an activity log's `at`) without loading the
   shim into a process that did not ask for it. */
globalThis[Symbol.for('@fintechlab/runner/clock-shim')] = shim;

module.exports = shim;
