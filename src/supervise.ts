/**
 * Supervising a platform's processes as children of one command.
 *
 * Deliberately small: start each one, prefix its output with its name,
 * refuse to start one whose port is taken (and say why), retry once a
 * process that dies on the way up, and report — not loop on — anything
 * that fails twice or fails later. A restart loop hides exactly the
 * failures a developer needs to see: a port in use, a schema behind the
 * branch, a missing bundle.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import type { ActivityLog } from './activity';
import { sleep, wallClock } from './util';

/** What to run. Extend it with whatever else the platform wants to know about a process. */
export interface ProcessSpec {
    name: string;
    cmd: string;
    args: string[];
    /** Checked free before starting; shown in status. */
    port?: number;
    /** Default: the supervisor's cwd. */
    cwd?: string;
    /** Default: the supervisor's env. */
    env?: NodeJS.ProcessEnv;
}

/** What the supervisor knows about a process while it runs. */
export interface ProcessState {
    child?: ChildProcess;
    /** performance.now() at the last start — monotonic, so the clock shim cannot skew uptime. */
    startedAt?: number;
    exit?: { code: number | null; signal: string | null; at: string };
    /** Why it was not started at all, when that is the answer. */
    blocked?: string;
    retried?: boolean;
}

export type Supervised<T extends ProcessSpec = ProcessSpec> = T & ProcessState;

/** One process, as a status endpoint shows it. */
export interface ProcessView {
    name: string;
    state: 'up' | 'down';
    pid?: number;
    port?: number;
    uptime_seconds?: number;
    exit?: ProcessState['exit'];
    blocked?: string;
}

export interface SupervisorOptions {
    cwd: string;
    /** Default: process.env. */
    env?: NodeJS.ProcessEnv;
    /** Starts, retries, exits and blocked starts are recorded here. */
    log?: ActivityLog;
    /** Where a child's output lines go. Default: prefixLine to stdout. */
    output?: (name: string, line: string) => void;
    /** A death this soon after starting is retried, once. Default 15s. */
    retryWindowMs?: number;
    /** Default 2s. */
    retryDelayMs?: number;
    /** How long a busy port is given to come free. Default 4s. */
    portWaitMs?: number;
}

/** `name         │ line`, the way every supervised line is printed. */
export function prefixLine(name: string, line: string, width = 13): void {
    process.stdout.write(`${name.padEnd(width)}│ ${line}\n`);
}

/** Whether one address family is free to bind. */
export function bindable(port: number, host: string): Promise<boolean> {
    return new Promise((done) => {
        const probe = createServer();
        probe.once('error', () => done(false));
        probe.once('listening', () => probe.close(() => done(true)));
        probe.listen(port, host);
    });
}

/**
 * Whether a port is free, on both address families.
 *
 * Probing only 0.0.0.0 misses a server on :::port — it binds IPv6-any and
 * the IPv4 probe succeeds anyway. Sequentially, because a dual-stack [::]
 * probe and a 0.0.0.0 probe on the same port conflict with each other.
 * It waits a moment rather than answering at once: a process just killed
 * holds its listener for a beat, and "restart the stack" is the most common
 * thing anyone does.
 */
export async function portFree(port: number, waitMs = 4000): Promise<boolean> {
    const deadline = performance.now() + waitMs;
    for (;;) {
        const v6 = await bindable(port, '::');
        const v4 = v6 ? await bindable(port, '0.0.0.0') : false;
        if (v4 && v6) return true;
        if (performance.now() >= deadline) return false;
        await sleep(400);
    }
}

export class Supervisor<T extends ProcessSpec = ProcessSpec> {
    readonly processes: Supervised<T>[];
    private stopping = false;
    private readonly out: (name: string, line: string) => void;

    constructor(
        specs: readonly T[],
        private readonly options: SupervisorOptions
    ) {
        this.processes = specs.map((s) => ({ ...s }) as Supervised<T>);
        this.out = options.output ?? prefixLine;
    }

    get shuttingDown(): boolean {
        return this.stopping;
    }

    /** Every process is running. */
    allUp(): boolean {
        return this.processes.every((p) => p.child);
    }

    /** The processes not running. */
    down(): Supervised<T>[] {
        return this.processes.filter((p) => !p.child);
    }

    /** "orchestrator (port 3108 is already in use …), workers" — for a 503 that says why. */
    downReason(): string {
        return this.down()
            .map((p) => (p.blocked ? `${p.name} (${p.blocked})` : p.name))
            .join(', ');
    }

    async start(p: Supervised<T>): Promise<void> {
        const log = this.options.log;
        // A process left over from a previous run holding the port is the
        // most common way a start goes wrong, and its symptom — one
        // EADDRINUSE among a hundred lines of boot output — is easy to miss.
        if (p.port && !(await portFree(p.port, this.options.portWaitMs))) {
            p.blocked = `port ${p.port} is already in use — something else is still running (lsof -i :${p.port})`;
            this.out(p.name, `✗ not started: ${p.blocked}`);
            log?.record({
                op: 'process.blocked',
                summary: `${p.name} not started — port ${p.port} already in use`,
                status: 'bad',
            });
            return;
        }
        p.blocked = undefined;
        const child = spawn(p.cmd, p.args, {
            cwd: p.cwd ?? this.options.cwd,
            env: p.env ?? this.options.env ?? process.env,
        });
        p.child = child;
        p.startedAt = performance.now();
        p.exit = undefined;
        this.pipe(p.name, child);
        log?.record({
            op: 'process.start',
            summary: `${p.name} started${p.port ? ` on :${p.port}` : ''}`,
            status: 'ok',
            detail: { pid: String(child.pid ?? '') },
        });
        child.on('error', (err) => {
            // A command that cannot be spawned at all (ENOENT): unhandled,
            // this event would take the supervisor down with it.
            if (p.child !== child) return;
            p.child = undefined;
            p.exit = { code: null, signal: null, at: wallClock() };
            this.out(p.name, `✗ could not start: ${err.message}`);
            log?.record({ op: 'process.exit', summary: `${p.name} could not start — ${err.message}`, status: 'bad' });
        });
        child.on('exit', (code, signal) => {
            if (p.child !== child) return;
            p.exit = { code, signal, at: wallClock() };
            p.child = undefined;
            if (this.stopping) return;
            const how = String(code ?? signal);
            const startupDeath =
                p.startedAt !== undefined && performance.now() - p.startedAt < (this.options.retryWindowMs ?? 15_000);
            if (startupDeath && !p.retried) {
                p.retried = true;
                this.out(p.name, `restarting once — it exited ${how} moments after starting`);
                log?.record({
                    op: 'process.retry',
                    summary: `${p.name} exited ${how} on startup; restarting once`,
                    status: 'warn',
                });
                setTimeout(() => {
                    if (!this.stopping) void this.start(p);
                }, this.options.retryDelayMs ?? 2000);
                return;
            }
            log?.record({ op: 'process.exit', summary: `${p.name} exited with code ${how}`, status: 'bad' });
            this.out(p.name, `✗ exited (${how})`);
        });
    }

    /** Start each in order, `staggerMs` apart. */
    async startAll(staggerMs = 0): Promise<void> {
        for (const p of this.processes) {
            await this.start(p);
            if (staggerMs) await sleep(staggerMs);
        }
    }

    stopAll(signal: NodeJS.Signals = 'SIGTERM'): void {
        this.stopping = true;
        for (const p of this.processes) p.child?.kill(signal);
    }

    view(): ProcessView[] {
        return this.processes.map((p) => ({
            name: p.name,
            state: p.child ? 'up' : 'down',
            pid: p.child?.pid,
            port: p.port,
            uptime_seconds:
                p.child && p.startedAt !== undefined ? Math.round((performance.now() - p.startedAt) / 1000) : undefined,
            exit: p.exit,
            blocked: p.blocked,
        }));
    }

    private pipe(name: string, child: ChildProcess): void {
        const emit = (buf: Buffer) => {
            for (const line of buf.toString().split('\n')) {
                if (line.trim()) this.out(name, line);
            }
        };
        child.stdout?.on('data', emit);
        child.stderr?.on('data', emit);
    }
}

export interface CommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

/** Run a command with its output on this terminal; resolves with its exit code. */
export function runCommand(cmd: string, args: string[], options: CommandOptions = {}): Promise<number> {
    return new Promise((done) => {
        const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'inherit' });
        child.on('error', () => done(127));
        child.on('exit', (code) => done(code ?? 1));
    });
}

/** Run a command and collect its stdout and stderr together. */
export function captureCommand(
    cmd: string,
    args: string[],
    options: CommandOptions = {}
): Promise<{ code: number; out: string }> {
    return new Promise((done) => {
        const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env });
        let out = '';
        child.stdout?.on('data', (b) => (out += b.toString()));
        child.stderr?.on('data', (b) => (out += b.toString()));
        child.on('error', (err) => done({ code: 127, out: out + String(err) }));
        child.on('exit', (code) => done({ code: code ?? 1, out }));
    });
}
