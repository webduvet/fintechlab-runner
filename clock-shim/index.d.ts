/**
 * @fintechlab/runner/clock-shim — preload with `node -r`; see index.cjs.
 * Requiring it installs the shim in this process.
 */

/** The live offset from the real clock, in ms. */
export declare const offsetMs: number;
/** Whether the clock file has taken control of the offset. */
export declare const pinned: boolean;
/** Now on the real clock, in ms. */
export declare function realNow(): number;
/** Whether `at` is a business day in both Europe/London and Europe/Stockholm. */
export declare function isBusinessDayEverywhere(at: Date): boolean;
/** The most recent business-day instant at or before `from`, or null within six days. */
export declare function mostRecentBusinessDay(from: Date): Date | null;
/** The file this process watches. */
export declare const CLOCK_FILE: string;
