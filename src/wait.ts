import { sleep, type Logger } from './util';

/**
 * Wait until `check` answers true, once a second, for up to `seconds`.
 * Says so and carries on when it never does: what it waited for may yet
 * come up, and the caller's next step will say more than a throw here.
 */
export async function waitFor(
    what: string,
    check: () => Promise<boolean>,
    seconds = 60,
    logger: Logger = console
): Promise<boolean> {
    for (let i = 0; i < seconds; i++) {
        if (await check().catch(() => false)) return true;
        await sleep(1000);
    }
    logger.log(`   ⚠ ${what} did not come up within ${seconds}s — carrying on`);
    return false;
}

export interface PollOptions {
    /** A single check that has not answered by then counts as "not yet". Default 5000. */
    checkTimeoutMs?: number;
    /** Between checks. Default 1000. */
    intervalMs?: number;
}

/**
 * Poll `check` until it gives a truthy value or `seconds` pass.
 *
 * Deadline-based, not iteration-based, and every check is itself bounded:
 * counting iterations assumes each one returns, and the one that does not
 * (a database connect that neither resolves nor rejects) is exactly the
 * failure this has to survive. A check that throws is "not yet".
 */
export async function pollFor<T>(
    check: () => Promise<T | undefined>,
    seconds: number,
    options: PollOptions = {}
): Promise<T | undefined> {
    const checkTimeoutMs = options.checkTimeoutMs ?? 5000;
    const intervalMs = options.intervalMs ?? 1000;
    // performance.now(), not Date.now(): it is monotonic, and the clock
    // shim moving Date an hour must not end (or extend) a wait.
    const deadline = performance.now() + seconds * 1000;
    while (performance.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const got = await Promise.race([
            check().catch(() => undefined),
            new Promise<undefined>((r) => {
                timer = setTimeout(() => r(undefined), checkTimeoutMs);
            }),
        ]);
        clearTimeout(timer);
        if (got) return got;
        await sleep(intervalMs);
    }
    return undefined;
}
