/**
 * Where the lab is, and what the platform wants of it.
 *
 * Two sources, env winning:
 *   - an optional JSON file, `fintechlab.json` in the platform's directory
 *     (FINTECHLAB_CONFIG names another) — the place for things that are a
 *     choice about this checkout, like which stand-ins to switch off;
 *   - the environment — the place for addresses, which differ per machine
 *     and are what a .env already carries.
 *
 *   {
 *     "console_url":    "http://127.0.0.1:8090",
 *     "clock_url":      "http://127.0.0.1:8096/clock",
 *     "advertised_url": "http://host.containers.internal:3109",
 *     "browse_url":     "http://127.0.0.1:3109",
 *     "stand_ins": {"receiver": {"connected": false, "shown": false}}
 *   }
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRecord, standInProblems, type StandIns } from './descriptor';
import { trimSlash } from './util';

export const DEFAULT_CONSOLE_URL = 'http://127.0.0.1:8090';
export const DEFAULT_CLOCK_URL = 'http://127.0.0.1:8096/clock';
export const CONFIG_FILE_NAME = 'fintechlab.json';

/** The environment variables read, and the file field each overrides. */
export const CONFIG_ENV = {
    file: 'FINTECHLAB_CONFIG',
    consoleUrl: 'FINTECH_SIM_LAB_CONSOLE_URL',
    clockUrl: 'FINTECH_SIM_LAB_CLOCK_URL',
    advertisedUrl: 'RUNNER_ADVERTISED_URL',
    browseUrl: 'RUNNER_BROWSE_URL',
} as const;

/** The config file, as written. */
export interface LabConfigFile {
    console_url?: string;
    clock_url?: string;
    advertised_url?: string;
    browse_url?: string;
    stand_ins?: StandIns;
}

export interface LabConfig {
    /** Where the platform reaches the console. */
    consoleUrl: string;
    /** The clock service's GET /clock. */
    clockUrl: string;
    /** Where the console reaches the platform: the descriptor's base_url. */
    advertisedUrl?: string;
    /** Where a browser reaches it: the descriptor's browse_url. */
    browseUrl?: string;
    /** From the file only; undefined when the file does not say. */
    standIns?: StandIns;
    /** The config file that was read, or undefined when there was none. */
    file?: string;
}

export interface LoadLabConfigOptions {
    /** Where `fintechlab.json` is looked for. Default: the working directory. */
    dir?: string;
    /** The file itself, overriding `dir`. FINTECHLAB_CONFIG overrides both. */
    file?: string;
    /** Default: process.env. */
    env?: NodeJS.ProcessEnv;
    /** Used for whatever neither the env nor the file sets. */
    defaults?: Partial<Pick<LabConfig, 'consoleUrl' | 'clockUrl' | 'advertisedUrl' | 'browseUrl'>>;
}

const FILE_FIELDS: Record<string, true> = {
    console_url: true,
    clock_url: true,
    advertised_url: true,
    browse_url: true,
    stand_ins: true,
};

/** Parse and check a config file's text; throws naming `where`. */
export function parseLabConfigFile(text: string, where: string): LabConfigFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`${where} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isRecord(parsed)) throw new Error(`${where} must hold a JSON object`);
    const problems: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
        // A key starting with "_" or "$" is a comment ("_comment", "$schema").
        if (key.startsWith('_') || key.startsWith('$')) continue;
        if (!FILE_FIELDS[key]) {
            problems.push(`unknown field "${key}" (known: ${Object.keys(FILE_FIELDS).join(', ')})`);
        } else if (key !== 'stand_ins' && typeof value !== 'string') {
            problems.push(`${key} must be a string`);
        }
    }
    problems.push(...standInProblems(parsed.stand_ins, 'stand_ins'));
    if (problems.length) throw new Error(`${where}: ${problems.join('; ')}`);
    return parsed as LabConfigFile;
}

/**
 * Read the config file (if there is one) and the environment. A file that
 * exists but is malformed throws: a typo that silently left the stand-ins
 * connected would look like the lab ignoring the setting.
 */
export function loadLabConfig(options: LoadLabConfigOptions = {}): LabConfig {
    const env = options.env ?? process.env;
    const fromEnv = (name: string) => {
        const v = env[name]?.trim();
        return v ? v : undefined;
    };
    const explicit = fromEnv(CONFIG_ENV.file) ?? options.file;
    const path = resolve(options.dir ?? process.cwd(), explicit ?? CONFIG_FILE_NAME);
    let file: LabConfigFile = {};
    let found: string | undefined;
    if (existsSync(path)) {
        file = parseLabConfigFile(readFileSync(path, 'utf8'), path);
        found = path;
    } else if (explicit) {
        // Named on purpose and not there: say so rather than run on defaults.
        const by = fromEnv(CONFIG_ENV.file) ? CONFIG_ENV.file : 'the file option';
        throw new Error(`lab config ${path}, named by ${by}, does not exist`);
    }
    const d = options.defaults ?? {};
    const pick = (envName: string, fileValue: string | undefined, dflt: string | undefined) =>
        fromEnv(envName) ?? fileValue ?? dflt;
    const advertisedUrl = pick(CONFIG_ENV.advertisedUrl, file.advertised_url, d.advertisedUrl);
    const browseUrl = pick(CONFIG_ENV.browseUrl, file.browse_url, d.browseUrl);
    return {
        consoleUrl: trimSlash(pick(CONFIG_ENV.consoleUrl, file.console_url, d.consoleUrl) ?? DEFAULT_CONSOLE_URL),
        clockUrl: trimSlash(pick(CONFIG_ENV.clockUrl, file.clock_url, d.clockUrl) ?? DEFAULT_CLOCK_URL),
        ...(advertisedUrl ? { advertisedUrl } : {}),
        ...(browseUrl ? { browseUrl } : {}),
        ...(file.stand_ins ? { standIns: file.stand_ins } : {}),
        ...(found ? { file: found } : {}),
    };
}
