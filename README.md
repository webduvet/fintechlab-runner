# @fintechlab/runner

What a platform needs to plug into the **fintech sim lab**
([fintechlab-simple](https://github.com/webduvet/fintechlab-simple)): put
its own card in the lab's console, follow the lab's business clock, and
serve its logs in the lab's shape.

The lab simulates vendors — Worldline, B4B, Banking Circle, ACI — and knows
no platform by name. A platform under test **registers itself** with the
console (`POST /api/plugins`) and **follows the lab clock** (`GET /clock`).
Both calls are outbound from the platform, so they work against a lab on
another machine. The contract is the lab's `docs/plugins.md`; this library
is that contract as typed code, plus the pieces every platform's local
runner ends up writing anyway.

It was extracted from buddy's `infinite-local-runner`, which is still the
reference user. Nothing in it knows buddy: no settlement files, no
databases, no stage names.

TypeScript, CommonJS, Node ≥ 20, **no runtime dependencies**.

## Modules

| Module | What it is |
| --- | --- |
| `descriptor` | `Plugin`, `PluginAction` (and its form's `ActionField`s), `PluginSettlement`, `Endpoint`, `ClockPolicy`, `StandIns` — the descriptor, field for field as `docs/plugins.md` has it, in the lab's snake_case. `descriptorProblems()` / `validateDescriptor()` check the console's rules (id format, paths on `base_url`, at most eight actions, …) so a bad card fails at start-up, not as a 400 every ten seconds |
| `plugin` | `LabPlugin`: register, renew every `renew_seconds` the console answers, retry quietly while the console is away (one line when it breaks, one when it is back), unregister on shutdown so the card goes grey at once |
| `clock` | `LabClockFollower`: poll `GET /clock` every second, write the offset to the file the clock shim watches (only when it changes), remove a stale file when there is no lab at start, and **hold** the clock (`POST /clock/holds`) while `holdReason()` says there is work in flight |
| `clock-shim` | `@fintechlab/runner/clock-shim`, a `node -r` preload that shifts `Date` by the offset in that file. Zero-dependency CommonJS — see [The clock shim](#the-clock-shim) |
| `activity` | `ActivityLog`: a fixed-size ring in the lab's activity shape (`{"logs": [{name, title, note, labels, total, kept, last, events}]}`), stamped on the wall clock even under the shim; `activityBody()` serves several |
| `files` | `FileStore` (a directory of uploaded files: streamed to disk under a safe name that never shadows a reserved one, capped, never half-written), `headLines` (the first N lines of any file, reading no further), `eachLine`, and the two routes the console's files table calls — `uploadHandler` (`upload_path`: POST keeps, DELETE forgets) and `previewHandler` (`preview_path`) |
| `config` | `loadLabConfig()`: the optional `fintechlab.json` merged with the environment, env winning |
| `http` | `readBody`, `json`, and a `"METHOD /path"` route table (`createControlServer`) — the plumbing of a control API |
| `supervise` | `Supervisor`: child processes with name-prefixed output, a port check on both address families before starting, one retry for a death on the way up, and nothing after that but a report. `portFree`, `bindable`, `runCommand`, `captureCommand` |
| `wait` | `waitFor` (once a second, then carry on), `pollFor` (deadline-based, every check bounded, monotonic clock) |

Everything is exported from `@fintechlab/runner`; the shim is its own
entry point so that importing the library never shifts a process's clock.

## A minimal platform

```ts
import { createServer } from 'node:http';
import {
    ActivityLog, activityBody, json, LabClockFollower, LabPlugin, loadLabConfig,
    routeRequests, type Plugin,
} from '@fintechlab/runner';

const PORT = 4000;
const lab = loadLabConfig({
    defaults: { advertisedUrl: `http://host.containers.internal:${PORT}`, browseUrl: `http://127.0.0.1:${PORT}` },
});
const events = new ActivityLog('events', 'Events', 'What this platform did.');

const descriptor = (): Plugin => ({
    id: 'my-platform',
    name: 'My platform',
    summary: 'What it is, in a paragraph.',
    base_url: lab.advertisedUrl!, // where the console, in a container, reaches us
    browse_url: lab.browseUrl,
    health_path: '/health',
    activity_path: '/activity',
    clock: 'follows',
    actions: [{ id: 'poke', label: 'Poke it', path: '/poke', primary: true }],
    ...(lab.standIns ? { stand_ins: lab.standIns } : {}),
});

const server = createServer(
    routeRequests({
        'GET /health': (_req, res) => json(res, 200, { status: 'ok' }),
        'GET /activity': (_req, res, url) => json(res, 200, activityBody([events], url.searchParams.get('limit'))),
        'POST /poke': (_req, res) => {
            events.record({ op: 'poke', summary: 'poked from the console' });
            json(res, 202, { note: 'Poked.' });
        },
    })
);

const clock = new LabClockFollower({ url: lab.clockUrl, holder: 'my-platform' });
const plugin = new LabPlugin({ consoleUrl: lab.consoleUrl, descriptor });

void (async () => {
    await clock.start(); // before starting anything that reads the clock
    server.listen(PORT, () => plugin.start());
})();

process.on('SIGINT', () => {
    server.close();
    void Promise.allSettled([plugin.stop(), clock.stop()]).then(() => process.exit(0));
});
```

Run it with the shim preloaded, so its own `Date` follows the lab too:

```bash
node -r @fintechlab/runner/clock-shim my-platform.js
```

and the console shows **My platform** with a working **Poke it** button and
an *Events* panel. `clock: 'follows'` promises the lab that this platform
moves with its clock; a platform that cannot (a deployed stack) says
`'wall'`, and the console then refuses to move the lab clock while it is
live.

Holding the clock while work is in flight:

```ts
const clock = new LabClockFollower({
    url: lab.clockUrl,
    holder: 'my-platform',
    holdReason: () => (running.size ? `settlement in flight: ${[...running].join(', ')}` : null),
});
// whenever work starts or finishes:
void clock.syncHold();
```

Moves are then refused with `409` and that reason. A hold lapses after
`holdTtlSeconds` (default 900), so a platform killed mid-run cannot freeze
the lab; `clock.stop()` releases it on a clean exit.

## The clock shim

`@fintechlab/runner/clock-shim` (`clock-shim/index.cjs`) is preloaded with
`node -r` into every process of the platform. It replaces `globalThis.Date`
with a subclass whose `now()` and `new Date()` are offset by a constant —
constant, not frozen, so timers, long-polling and elapsed-time logging
behave — and re-reads one small JSON file every second. `LabClockFollower`
is the one writer; every shim is a reader, so one write moves the whole
platform together.

| Variable | |
| --- | --- |
| `RUNNER_CLOCK_FILE` | the file to watch. Default `.runs/clock.json` under the process's working directory — set it for the whole platform when its processes start in different directories |
| `RUNNER_NOW` | the starting point until the file says otherwise, or the whole story with no lab: `auto-business-day` (the most recent instant that is a business day in Europe/London and Europe/Stockholm) or an instant such as `2026-09-16T10:00:00Z`. Unset: the real clock |
| `SETTLE_BANK_HOLIDAYS_GB`, `SETTLE_BANK_HOLIDAYS_SE` | extra non-business dates for `auto-business-day` |

The names are the ones buddy's runner has always used, so existing `.env`
files keep working. With a lab running, the lab decides the offset (the
follower writes mode `lab`) and the calendar logic stands aside.

`setTimeout`, `performance.now()` and `process.hrtime` are untouched, and so
is everything this library times itself with. The shim publishes itself
under `Symbol.for('@fintechlab/runner/clock-shim')`, which is how
`ActivityLog` stamps events on the wall clock without loading it.

## The config file

`loadLabConfig({ dir })` reads `fintechlab.json` in `dir` (default the
working directory; `FINTECHLAB_CONFIG` names another file) and the
environment. **Env wins** for the addresses, so a `.env` that already sets
them keeps working:

| File field | Environment | Default | Who dials it |
| --- | --- | --- | --- |
| `console_url` | `FINTECH_SIM_LAB_CONSOLE_URL` | `http://127.0.0.1:8090` | the platform → the console |
| `clock_url` | `FINTECH_SIM_LAB_CLOCK_URL` | `http://127.0.0.1:8096/clock` | the platform → the clock |
| `advertised_url` | `RUNNER_ADVERTISED_URL` | `defaults.advertisedUrl` | the console → the platform (`base_url`) |
| `browse_url` | `RUNNER_BROWSE_URL` | `defaults.browseUrl` | a browser → the platform (`browse_url`) |
| `stand_ins` | — | none | see below |

See [fintechlab.example.json](fintechlab.example.json). A file that exists
but is malformed — not JSON, an unknown field, `"connected": "false"` —
throws with the path and the reason: a typo that silently left the lab's
stand-ins running would look like the lab ignoring the setting. Keys
starting with `_` are comments. `LabConfig.file` says which file was read,
or is absent when there was none.

## Stand-ins

The lab ships services that played the platform's part before a real
platform plugged in:

| Id | What it does |
| --- | --- |
| `receiver` | the webhook listener Banking Circle's seeded subscription and ACI's webhooks point at |
| `settlement` | pulls Worldline's files over SFTP and pays outlets through B4B |
| `payment-api` | a generic payment facade with Idempotency-Key — scaffolding, not vendor-shaped |
| `notifier` | a signed-webhook worker with retries and an allowlist |

Once a real platform is plugged in, some of them are noise: payouts nobody
made, deliveries to a listener that is not the platform's. The descriptor's
`stand_ins` says, per stand-in, whether it stays **connected** (its vendor
wiring live) and **shown** (its card visible):

```json
"stand_ins": {
  "receiver":   {"connected": false, "shown": false},
  "settlement": {"connected": false, "shown": true}
}
```

Both fields are optional; an absent id or field leaves it as the lab has
it. The console applies it when the plugin first registers and whenever the
value changes — not on every renewal, so a stand-in switched back on from
the console stays on. It refuses (400) a `stand_ins` naming a service that
is not a stand-in; a plugin cannot hide a vendor.

Where the value comes from is the platform's choice. The usual pattern is a
platform default laid under the config file, and only when there is a file,
so the lab changes only for developers who opted in:

```ts
const standIns = lab.file
    ? mergeStandIns({ receiver: { connected: false, shown: false } }, lab.standIns)
    : undefined;
```

## Linking it into a platform

The library is consumed **built**: `dist/` is CommonJS with `.d.ts`, and the
shim is plain CommonJS. That way it works from plain `node` — which is how
`node -r …/clock-shim` has to load, before any TypeScript loader and inside
bundles that have none — from ts-node, tsx or `@swc-node/register`, and
under a consumer's strict tsconfig, which then checks only the `.d.ts`.

Any of these puts it in a platform's `node_modules`:

```bash
# a symlink — what buddy's runner does (init/link-lab-runner.sh), no package.json needed
mkdir -p node_modules/@fintechlab && ln -sfn ~/gh/fintechlab-runner node_modules/@fintechlab/runner

# or, with a package.json of your own
npm install ~/gh/fintechlab-runner        # "prepare" builds dist/
```

With a symlink, build it first (`npm install && npm run build` here) and
again after changing it. Node follows the link to the real path, which is
fine: the library resolves nothing at runtime but Node's built-ins. For
types it needs `@types/node` in the consumer, which a Node platform has.

## Developing it

```bash
npm install
npm run build       # dist/
npm run typecheck   # src and tests
npm test            # compiles to build-test/ and runs node:test
```

The tests cover the pure parts with fakes: descriptor validation and
stand-in merging, the config merge, the activity ring, the clock follower
and the plugin's renewal with a fake `fetch`, the route table, the waits,
and the shim in a child process.

When the lab's contract changes, `docs/plugins.md` there changes first;
then the types in `src/descriptor.ts`, and the checks beside them.
