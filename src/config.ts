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
 *     "lab_url":        "http://127.0.0.1:8097",
 *     "lab_token":      "…",
 *     "advertised_url": "http://host.containers.internal:3109",
 *     "browse_url":     "http://127.0.0.1:3109",
 *     "stand_ins": {"receiver": {"connected": false, "shown": false}}
 *   }
 *
 * The lab is one address: its lab API. The platform registers there
 * (/v1/plugins), follows the clock there (/v1/clock), and sends the token
 * there when the lab asks for one. console_url and clock_url are for a lab
 * without the lab API; clock_url, when set, still names the clock to follow.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRecord, standInProblems, type StandIns } from './descriptor';
import { trimSlash } from './util';

export const DEFAULT_LAB_URL = 'http://127.0.0.1:8097';
export const DEFAULT_CONSOLE_URL = 'http://127.0.0.1:8090';
/** The clock service itself, for a lab without the lab API. */
export const DEFAULT_CLOCK_URL = 'http://127.0.0.1:8096/clock';
export const CONFIG_FILE_NAME = 'fintechlab.json';

/** The environment variables read, and the file field each overrides. */
export const CONFIG_ENV = {
    file: 'FINTECHLAB_CONFIG',
    labUrl: 'FINTECH_SIM_LAB_URL',
    labToken: 'FINTECH_SIM_LAB_TOKEN',
    consoleUrl: 'FINTECH_SIM_LAB_CONSOLE_URL',
    clockUrl: 'FINTECH_SIM_LAB_CLOCK_URL',
    advertisedUrl: 'RUNNER_ADVERTISED_URL',
    browseUrl: 'RUNNER_BROWSE_URL',
} as const;

/**
 * The lab's own name for its token (what `make up` and the e2e suite read),
 * used when FINTECH_SIM_LAB_TOKEN is not set: a shell that started the lab
 * with a token can start the platform too.
 */
export const LAB_TOKEN_FALLBACK_ENV = 'LAB_API_TOKEN';

/** The config file, as written. */
export interface LabConfigFile {
    lab_url?: string;
    lab_token?: string;
    console_url?: string;
    clock_url?: string;
    advertised_url?: string;
    browse_url?: string;
    stand_ins?: StandIns;
}

export interface LabConfig {
    /** The lab API: where the platform registers, follows the clock, and calls the lab. */
    labUrl: string;
    /** Sent as `Authorization: Bearer …` to the lab API, when the lab asks for one. */
    token?: string;
    /**
     * The clock to follow: the lab API's /v1/clock, unless clock_url names
     * the clock service itself (a lab without the lab API).
     */
    clockUrl: string;
    /** The console, for a lab without the lab API (LabPlugin's consoleUrl). */
    consoleUrl: string;
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
    defaults?: Partial<Pick<LabConfig, 'labUrl' | 'consoleUrl' | 'clockUrl' | 'advertisedUrl' | 'browseUrl'>>;
}

const FILE_FIELDS: Record<string, true> = {
    lab_url: true,
    lab_token: true,
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
    const labUrl = trimSlash(pick(CONFIG_ENV.labUrl, file.lab_url, d.labUrl) ?? DEFAULT_LAB_URL);
    const token = fromEnv(CONFIG_ENV.labToken) ?? fromEnv(LAB_TOKEN_FALLBACK_ENV) ?? (file.lab_token || undefined);
    return {
        labUrl,
        ...(token ? { token } : {}),
        clockUrl: trimSlash(pick(CONFIG_ENV.clockUrl, file.clock_url, d.clockUrl) ?? `${labUrl}/v1/clock`),
        consoleUrl: trimSlash(pick(CONFIG_ENV.consoleUrl, file.console_url, d.consoleUrl) ?? DEFAULT_CONSOLE_URL),
        ...(advertisedUrl ? { advertisedUrl } : {}),
        ...(browseUrl ? { browseUrl } : {}),
        ...(file.stand_ins ? { standIns: file.stand_ins } : {}),
        ...(found ? { file: found } : {}),
    };
}
