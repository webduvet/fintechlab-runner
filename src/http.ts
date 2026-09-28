/**
 * The few pieces of a control server every plugin writes: read a JSON
 * body, answer JSON, and route "METHOD /path" to a handler. Node's http
 * module and nothing else — a platform's control plane is a handful of
 * routes, and the console calls exactly the paths the descriptor declares.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { errorMessage } from './util';

/**
 * A parsed request body: unknown values, not `any`, so every field is
 * checked before it is used.
 */
export type JSONBody = Record<string, unknown>;

/** The key readBody() puts the raw text under when the body is not JSON. */
export const INVALID_BODY = '__invalid';

/**
 * The request's JSON body. Empty is `{}`; text that is not JSON is
 * `{"__invalid": "<first 200 characters>"}` (isInvalidBody()), so the
 * handler can refuse it in its own words. Capped at `maxBytes`.
 */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<JSONBody> {
    return new Promise((done) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > maxBytes) raw = raw.slice(0, maxBytes);
        });
        req.on('end', () => {
            if (!raw.trim()) return done({});
            try {
                const parsed: unknown = JSON.parse(raw);
                done(
                    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                        ? (parsed as JSONBody)
                        : { [INVALID_BODY]: raw.slice(0, 200) }
                );
            } catch {
                done({ [INVALID_BODY]: raw.slice(0, 200) });
            }
        });
        req.on('error', () => done({}));
    });
}

export function isInvalidBody(body: JSONBody): boolean {
    return INVALID_BODY in body;
}

/** Answer with JSON. */
export function json(res: ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

/** `{"GET /status": handler, "POST /sim/run": handler}` */
export type Routes = Record<string, RouteHandler>;

/**
 * A request listener for a route table keyed "METHOD /path". Unknown
 * routes are a JSON 404 naming the route; a handler that throws (or
 * rejects) is a JSON 500 with its message, unless it already answered.
 */
export function routeRequests(routes: Routes): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = `${req.method} ${url.pathname}`;
        const handler = routes[route];
        if (!handler) {
            json(res, 404, { error: `no route ${route}` });
            return;
        }
        const fail = (err: unknown) => {
            if (!res.headersSent) json(res, 500, { error: errorMessage(err) });
        };
        try {
            const pending = handler(req, res, url);
            if (pending) pending.catch(fail);
        } catch (err) {
            fail(err);
        }
    };
}

/** An http.Server serving a route table; listen() is the caller's. */
export function createControlServer(routes: Routes): Server {
    return createServer(routeRequests(routes));
}
