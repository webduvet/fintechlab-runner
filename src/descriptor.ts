/**
 * The plugin descriptor: what a platform registers with the lab's console.
 *
 * These types mirror the lab's docs/plugins.md (and cmd/console, which
 * enforces it) field for field, in the lab's own snake_case, so a
 * descriptor built here is posted as-is — there is no mapping layer to
 * drift from the contract.
 */

/** Whether a platform moves with the lab clock. */
export type ClockPolicy = 'follows' | 'wall';

/** A row of the endpoints table at the foot of the card. */
export interface Endpoint {
    method: string;
    path: string;
    note?: string;
}

/** One button: a label and the one call it makes on the plugin's base_url. */
export interface PluginAction {
    /** Unique; lower-case letters, digits and dashes. */
    id: string;
    label: string;
    /** An action changes something: POST (the console's default), PUT or DELETE. */
    method?: 'POST' | 'PUT' | 'DELETE';
    /** A path on base_url. */
    path: string;
    /** The card's one filled button. */
    primary?: boolean;
    /** Asked first, in these words. */
    confirm?: string;
    /** The toast when the platform's answer carries no `note` of its own. */
    note?: string;
    /**
     * Inputs asked for before the call. With any, the button opens a form in
     * a modal and the call's JSON body is `{"<field id>": value}` — numbers
     * as numbers, empty fields left out. At most six.
     */
    fields?: ActionField[];
}

/** One input of an action's form. */
export interface ActionField {
    /** Unique within the action; the key in the JSON body. Lower-case letters, digits, underscores. */
    id: string;
    label: string;
    type: 'number' | 'text' | 'select';
    /** What the field starts with: a number for `number`, a string otherwise. */
    default?: number | string;
    /** `number` only. */
    min?: number;
    max?: number;
    /** `text` only: shown while it is empty. */
    placeholder?: string;
    /** `select` only: one to twenty choices. */
    options?: Array<{ value: string; label: string }>;
    /** A sentence under the form: what the field changes. */
    hint?: string;
}

/** The two platform-internal arrows of the System in test diagram. */
export type SettlementStageArrow = 'ingest' | 'reports';

/** A platform that settles Worldline files. */
export interface PluginSettlement {
    /** GET: the files table. */
    files_path: string;
    /** POST {"files": [...]}: start runs. */
    run_path: string;
    /** GET: what is running and how the last run went. */
    status_path?: string;
    /**
     * POST ?name=<file name> with the raw bytes: take a file from anywhere
     * and list it with the rest; DELETE ?name= removes one it took.
     * FileStore and uploadHandler() implement it.
     */
    upload_path?: string;
    /** GET ?name=&lines=: the head of a file. previewHandler(). */
    preview_path?: string;
    /** The activity log whose total is the diagram's "runs". */
    runs_log?: string;
    /** The diagram's arrows mapped to the platform's own stage names. */
    stages?: Partial<Record<SettlementStageArrow, string[]>>;
}

/**
 * The lab's stand-in services: what played the platform's role before a
 * real platform plugged in. `string & {}` keeps the known ids in editor
 * completion without refusing one the lab adds later.
 */
export type StandInId = 'receiver' | 'settlement' | 'payment-api' | 'notifier' | (string & {});

/**
 * What the platform wants of one stand-in. Both fields are optional: an
 * absent field (or an absent id) leaves it as the lab has it.
 */
export interface StandIn {
    /** Whether the stand-in's vendor wiring is live. */
    connected?: boolean;
    /** Whether its card is visible in the console. */
    shown?: boolean;
}

export type StandIns = Partial<Record<StandInId, StandIn>>;

/** Everything a platform registers with `POST /api/plugins`. */
export interface Plugin {
    /** Lower-case letters, digits, dashes; not one of the lab's own service ids. */
    id: string;
    /** The card title. */
    name: string;
    /** One paragraph: what this platform is. */
    summary?: string;
    /** Where the console reaches the platform (http/https). */
    base_url: string;
    /** Where a person's browser does: the card's Open link. */
    browse_url?: string;
    /** A 2xx here is "up". */
    health_path: string;
    /** Logs in the lab's activity shape; one panel per log. */
    activity_path?: string;
    ports?: string[];
    transport?: string;
    auth?: string;
    swap_for?: string;
    docs?: string;
    endpoints?: Endpoint[];
    clock: ClockPolicy;
    /** Shown when it is not running: how to start it. */
    start_hint?: string;
    /** At most eight. */
    actions?: PluginAction[];
    settlement?: PluginSettlement;
    /** `{"<log name>": "what would put something here"}` */
    empty_hints?: Record<string, string>;
    /**
     * Which of the lab's stand-ins stay connected and shown while this
     * platform is registered. Applied when the plugin first registers and
     * whenever this value changes, not on every renewal. Omit it to leave
     * them all as the lab has them.
     */
    stand_ins?: StandIns;
}

/** What `POST /api/plugins` answers. */
export interface RegisterResponse {
    id: string;
    state: 'live' | 'lapsed' | 'stopped';
    ttl_seconds: number;
    renew_seconds: number;
    clock: ClockPolicy;
}

/* ── validation ───────────────────────────────────────────────────────────
   The console is the authority: it answers 400 with the reason. Checking
   the same rules here turns a card that silently never appears (a renewal
   loop logging one 400 every ten seconds) into an error at start-up that
   names the field. */

/**
 * The lab's own service ids, which a plugin may not take. The console's
 * catalogue is the authority; this list is a courtesy and may lag it.
 */
export const LAB_SERVICE_IDS: readonly string[] = [
    'worldline',
    'b4b',
    'banking-circle',
    'aci',
    'verify',
    'verification',
    'clock',
    'settlement',
    'receiver',
    'payment-api',
    'bank',
    'notifier',
];

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LOG_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MAX_ACTIONS = 8;
const FIELD_ID = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_FIELDS = 6;
const MAX_OPTIONS = 20;

/** Shape problems in one action's fields, in the console's words. */
function fieldProblems(actionId: string, fields: ActionField[] | undefined): string[] {
    if (fields === undefined) return [];
    const where = `action ${actionId}`;
    if (!Array.isArray(fields)) return [`${where}: fields must be a list`];
    const problems: string[] = [];
    if (fields.length > MAX_FIELDS) problems.push(`${where}: at most ${MAX_FIELDS} fields`);
    const seen = new Set<string>();
    for (const f of fields) {
        if (!FIELD_ID.test(f.id ?? '') || seen.has(f.id)) {
            problems.push(`${where}: field id "${f.id}" must be unique, lower-case letters, digits and underscores`);
        }
        seen.add(f.id);
        const at = `${where} field ${f.id}`;
        if (!f.label?.trim()) problems.push(`${at} needs a label`);
        switch (f.type) {
            case 'number':
                for (const k of ['default', 'min', 'max'] as const) {
                    const v = f[k];
                    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
                        problems.push(`${at}: ${k} must be a number`);
                    }
                }
                if (typeof f.min === 'number' && typeof f.max === 'number' && f.min > f.max) {
                    problems.push(`${at}: min is above max`);
                }
                break;
            case 'text':
                if (f.default !== undefined && typeof f.default !== 'string') {
                    problems.push(`${at}: default must be text`);
                }
                break;
            case 'select': {
                const options = f.options ?? [];
                if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS) {
                    problems.push(`${at}: a select needs 1 to ${MAX_OPTIONS} options`);
                    break;
                }
                if (options.some((o) => typeof o?.value !== 'string' || !o.label?.trim())) {
                    problems.push(`${at}: every option needs a value and a label`);
                }
                if (f.default !== undefined && !options.some((o) => o.value === f.default)) {
                    problems.push(`${at}: default "${String(f.default)}" is not one of its options`);
                }
                break;
            }
            default:
                problems.push(`${at}: type "${String(f.type)}" — number, text or select`);
        }
    }
    return problems;
}

function pathProblem(field: string, p: string | undefined, required: boolean): string | undefined {
    if (p === undefined || p === '') return required ? `${field} is required` : undefined;
    if (!p.startsWith('/') || p.startsWith('//') || p.includes('..') || /[\s\\]/.test(p)) {
        return `${field} "${p}" must be an absolute path on the plugin's own base_url`;
    }
    return undefined;
}

function urlProblem(field: string, raw: string | undefined, required: boolean): string | undefined {
    if (!raw) return required ? `${field} is required` : undefined;
    try {
        const u = new URL(raw);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host) return undefined;
    } catch {
        // fall through
    }
    return `${field} "${raw}" must be an http(s) URL`;
}

/**
 * The reasons the console would refuse this descriptor, in the console's
 * words; empty when it would accept it.
 */
export function descriptorProblems(p: Plugin, reservedIds: readonly string[] = LAB_SERVICE_IDS): string[] {
    const problems: string[] = [];
    const add = (problem: string | undefined) => {
        if (problem) problems.push(problem);
    };
    if (!ID.test(p.id ?? '')) add(`id "${p.id}" must be lower-case letters, digits and dashes`);
    else if (reservedIds.includes(p.id)) add(`id "${p.id}" is one of the lab's own services`);
    if (!p.name?.trim()) add('name is required');
    add(urlProblem('base_url', p.base_url, true));
    add(urlProblem('browse_url', p.browse_url, false));
    add(pathProblem('health_path', p.health_path, true));
    add(pathProblem('activity_path', p.activity_path, false));
    if (p.clock !== 'follows' && p.clock !== 'wall') {
        add(`clock must be "follows" or "wall", got "${String(p.clock)}"`);
    }
    const actions = p.actions ?? [];
    if (actions.length > MAX_ACTIONS) add(`at most ${MAX_ACTIONS} actions`);
    const seen = new Set<string>();
    for (const a of actions) {
        if (!ID.test(a.id ?? '') || seen.has(a.id)) {
            add(`action id "${a.id}" must be unique, lower-case letters, digits and dashes`);
        }
        seen.add(a.id);
        if (!a.label?.trim()) add(`action ${a.id} needs a label`);
        if (a.method !== undefined && !['POST', 'PUT', 'DELETE'].includes(a.method)) {
            add(`action ${a.id}: method "${a.method}" — actions change something, so POST, PUT or DELETE`);
        }
        add(pathProblem(`action ${a.id} path`, a.path, true));
        for (const problem of fieldProblems(a.id, a.fields)) add(problem);
    }
    const s = p.settlement;
    if (s) {
        add(pathProblem('settlement.files_path', s.files_path, true));
        add(pathProblem('settlement.run_path', s.run_path, true));
        add(pathProblem('settlement.status_path', s.status_path, false));
        add(pathProblem('settlement.upload_path', s.upload_path, false));
        add(pathProblem('settlement.preview_path', s.preview_path, false));
        if (s.runs_log !== undefined && s.runs_log !== '' && !LOG_NAME.test(s.runs_log)) {
            add(`settlement.runs_log "${s.runs_log}" is not a log name`);
        }
    }
    for (const name of Object.keys(p.empty_hints ?? {})) {
        if (!LOG_NAME.test(name)) add(`empty_hints key "${name}" is not a log name`);
    }
    for (const problem of standInProblems(p.stand_ins, 'stand_ins')) add(problem);
    return problems;
}

/** Throws with every problem at once, or returns the descriptor. */
export function validateDescriptor<P extends Plugin>(p: P, reservedIds?: readonly string[]): P {
    const problems = descriptorProblems(p, reservedIds);
    if (problems.length) {
        throw new Error(`plugin descriptor ${p.id ?? '(no id)'}: ${problems.join('; ')}`);
    }
    return p;
}

/** Shape problems in a stand_ins value, wherever it came from. */
export function standInProblems(value: unknown, where: string): string[] {
    if (value === undefined) return [];
    if (!isRecord(value)) return [`${where} must be an object of {"<id>": {"connected", "shown"}}`];
    const problems: string[] = [];
    for (const [id, entry] of Object.entries(value)) {
        if (!ID.test(id)) problems.push(`${where}: "${id}" is not a service id`);
        if (!isRecord(entry)) {
            problems.push(`${where}.${id} must be an object like {"connected": false, "shown": true}`);
            continue;
        }
        for (const [field, v] of Object.entries(entry)) {
            if (field !== 'connected' && field !== 'shown') {
                problems.push(`${where}.${id}.${field} is not a stand-in field (connected, shown)`);
            } else if (typeof v !== 'boolean') {
                problems.push(`${where}.${id}.${field} must be true or false`);
            }
        }
    }
    return problems;
}

/**
 * Lay `over` on top of `base`, field by field: an id or field absent from
 * `over` keeps `base`'s. Undefined when both are.
 */
export function mergeStandIns(base: StandIns | undefined, over: StandIns | undefined): StandIns | undefined {
    if (!base && !over) return undefined;
    const out: StandIns = {};
    for (const source of [base ?? {}, over ?? {}]) {
        for (const [id, entry] of Object.entries(source)) {
            if (!entry) continue;
            const merged: StandIn = { ...out[id] };
            if (entry.connected !== undefined) merged.connected = entry.connected;
            if (entry.shown !== undefined) merged.shown = entry.shown;
            out[id] = merged;
        }
    }
    return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
