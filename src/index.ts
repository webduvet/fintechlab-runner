/**
 * @fintechlab/runner — what a platform needs to plug into the fintech sim lab.
 *
 *   descriptor  the plugin descriptor types (docs/plugins.md), and the console's rules
 *   plugin      LabPlugin: register the card at the lab API, renew it, unregister on shutdown
 *   clock       LabClockFollower: follow the lab clock into the shim's file; hold the clock
 *   lab         LabClient: the lab API for what the platform does to the lab (a wire, a seed, a reset)
 *   activity    ActivityLog: logs in the lab's activity shape
 *   config      loadLabConfig(): fintechlab.json + env — the lab's one address and its token
 *   files       FileStore, uploadHandler, previewHandler: settlement files from anywhere
 *   http        readBody, json, a route table for the control server
 *   supervise   Supervisor: child processes with prefixed output; port checks
 *   wait        waitFor, pollFor
 *
 * The clock shim is its own entry point, `@fintechlab/runner/clock-shim`,
 * preloaded with `node -r`; nothing here loads it.
 */

export * from './activity';
export * from './clock';
export * from './config';
export * from './descriptor';
export * from './files';
export * from './http';
export * from './lab';
export * from './plugin';
export * from './supervise';
export * from './util';
export * from './wait';
