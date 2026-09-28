/**
 * @fintechlab/runner — what a platform needs to plug into the fintech sim lab.
 *
 *   descriptor  the plugin descriptor types (docs/plugins.md), and the console's rules
 *   plugin      LabPlugin: register the card, renew it, unregister on shutdown
 *   clock       LabClockFollower: follow GET /clock into the shim's file; hold the clock
 *   activity    ActivityLog: logs in the lab's activity shape
 *   config      loadLabConfig(): fintechlab.json + env
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
export * from './http';
export * from './plugin';
export * from './supervise';
export * from './util';
export * from './wait';
