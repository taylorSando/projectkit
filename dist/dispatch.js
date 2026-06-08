/**
 * projectkit — the DISPATCH-DIRECTION surface (v1.3.0).
 *
 * Every surface before this one is EMIT-direction: a testbed says "this
 * happened" (`ProjectEvent`), "do this" (`WorkRequest`), or "log this"
 * (`LogRecord`) and FORGETS — fire-and-forget through an `EventSink`. The
 * DISPATCH direction is the OTHER half of the One-Line Boundary Test: a
 * testbed DISPATCHES a unit of work for execution and receives a CALLBACK
 * result. Before v1.3.0 this lived ENTIRELY inside each testbed's own
 * mesh-shaped routes — nhl's `/api/nhl/dispatch` + `/api/workflows` polling,
 * sitelayer's mesh-dispatcher — so mesh was the BAKED-IN owner of dispatch and
 * poll. With `Concern` / `DispatchEnvelope` / `Callback` a testbed dispatches
 * through a sink-agnostic `DispatchAdapter` and mesh becomes ONE swappable
 * implementation behind a URL, exactly like `EventSink` made mesh one sink.
 *
 * The boundary test: a testbed can swap mesh for ANOTHER `DispatchAdapter`
 * (a local executor, a different fleet, a NullDispatchAdapter) without
 * changing the `Concern` / `DispatchEnvelope` / `Callback` shapes it produces
 * and consumes. mesh is never in the testbed's dependency graph.
 *
 * Same invariants as the rest of projectkit: imports ONLY from ./contract.js
 * (so the fail-closed invariant and zero-runtime-deps hold); pure +
 * dependency-free. mesh is ONE possible dispatch adapter — never the owner.
 *
 * Wire stability rule: once a status literal or field has shipped, do NOT
 * change its meaning. Add a new optional field / new literal and bump
 * CONTRACT_VERSION per semver. The companion JSON Schemas
 * (schemas/concern.schema.json, schemas/callback.schema.json) are the Go-side
 * mirrors so a non-JS adapter (mesh) validates against the same shapes.
 */
const CALLBACK_STATUSES = [
    'accepted',
    'running',
    'succeeded',
    'failed',
    'cancelled',
];
/**
 * Validate a Concern against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or an adapter gate. Mirrors `validateWorkRequest`.
 */
export function validateConcern(o) {
    const problems = [];
    if (typeof o !== 'object' || o === null)
        return ['concern is not an object'];
    const c = o;
    const reqString = (k) => {
        if (typeof c[k] !== 'string' || c[k].length === 0) {
            problems.push(`missing/invalid required string field: ${k}`);
        }
    };
    reqString('schema_version');
    reqString('project_key');
    reqString('dispatched_at');
    reqString('concern_ref');
    reqString('kind');
    reqString('title');
    if (typeof c['dispatched_at'] === 'string' && Number.isNaN(Date.parse(c['dispatched_at']))) {
        problems.push('dispatched_at is not a parseable ISO-8601 timestamp');
    }
    if (c['inputs'] !== undefined && (typeof c['inputs'] !== 'object' || c['inputs'] === null)) {
        problems.push('inputs, when present, must be an object');
    }
    if (c['callback'] !== undefined) {
        if (typeof c['callback'] !== 'object' || c['callback'] === null) {
            problems.push('callback, when present, must be an object');
        }
        else {
            const cb = c['callback'];
            if (cb['url'] !== undefined && typeof cb['url'] !== 'string') {
                problems.push('callback.url, when present, must be a string');
            }
            if (cb['mode'] !== undefined && typeof cb['mode'] !== 'string') {
                problems.push('callback.mode, when present, must be a string');
            }
        }
    }
    return problems;
}
/**
 * Validate a Callback against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable on the return leg so
 * a testbed fails closed on a malformed result. Mirrors `validateConcern`.
 */
export function validateCallback(o) {
    const problems = [];
    if (typeof o !== 'object' || o === null)
        return ['callback is not an object'];
    const cb = o;
    const reqString = (k) => {
        if (typeof cb[k] !== 'string' || cb[k].length === 0) {
            problems.push(`missing/invalid required string field: ${k}`);
        }
    };
    reqString('schema_version');
    reqString('concern_ref');
    reqString('status');
    if (typeof cb['status'] === 'string' && !CALLBACK_STATUSES.includes(cb['status'])) {
        problems.push(`status must be one of: ${CALLBACK_STATUSES.join(', ')}`);
    }
    if (cb['outputs'] !== undefined && (typeof cb['outputs'] !== 'object' || cb['outputs'] === null)) {
        problems.push('outputs, when present, must be an object');
    }
    if (cb['artifacts'] !== undefined) {
        const a = cb['artifacts'];
        if (!Array.isArray(a) ||
            a.some((x) => typeof x !== 'object' ||
                x === null ||
                typeof x['kind'] !== 'string' ||
                typeof x['ref'] !== 'string')) {
            problems.push('artifacts, when present, must be an array of {kind, ref} objects');
        }
    }
    return problems;
}
/**
 * The single concern_ref to echo on an Ack when an envelope carries exactly
 * one concern (the common dispatch shape); undefined for an empty/multi batch.
 */
function singleConcernRef(envelope) {
    return envelope.concerns.length === 1 ? envelope.concerns[0]?.concern_ref : undefined;
}
/** Accepts and DROPS everything, reporting success. Default for "dispatch is off". */
export class NullDispatchAdapter {
    name = 'null';
    async dispatch(envelope) {
        const single = singleConcernRef(envelope);
        return {
            ok: true,
            adapter: this.name,
            accepted: envelope.concerns.length,
            ...(single ? { concern_ref: single } : {}),
        };
    }
}
/** Collects dispatched envelopes in memory. For tests and local introspection. */
export class MemoryDispatchAdapter {
    name = 'memory';
    envelopes = [];
    async dispatch(envelope) {
        this.envelopes.push(envelope);
        const single = singleConcernRef(envelope);
        return {
            ok: true,
            adapter: this.name,
            accepted: envelope.concerns.length,
            ...(single ? { concern_ref: single } : {}),
        };
    }
    /** Flattened view of every concern dispatched so far. */
    get concerns() {
        return this.envelopes.flatMap((e) => e.concerns);
    }
    clear() {
        this.envelopes.length = 0;
    }
}
/**
 * POSTs the DispatchEnvelope as JSON to a configurable URL — the canonical
 * "to mesh" dispatch adapter, the dispatch-direction analogue of `HttpSink`.
 * mesh is just the URL; HMAC is injected, never baked in.
 */
export class HttpDispatchAdapter {
    opts;
    name;
    fetchImpl;
    constructor(opts) {
        this.opts = opts;
        if (!opts.url)
            throw new Error('HttpDispatchAdapter requires a url');
        const f = opts.fetchImpl ?? globalThis.fetch;
        if (!f)
            throw new Error('HttpDispatchAdapter: no fetch available; pass opts.fetchImpl');
        // Bind to the global scope: calling `this.fetchImpl(...)` would otherwise
        // invoke the browser's native `fetch` with `this === HttpDispatchAdapter`,
        // which throws "Illegal invocation" (Node's fetch tolerates any `this`, so
        // this only bit in the browser). Mirrors HttpSink.
        this.fetchImpl = f.bind(globalThis);
        this.name = opts.name ?? `http(${safeHost(opts.url)})`;
    }
    async dispatch(envelope) {
        const body = JSON.stringify(envelope);
        const headers = {
            'content-type': 'application/json',
            ...(this.opts.headers ?? {}),
        };
        try {
            if (this.opts.sign)
                Object.assign(headers, await this.opts.sign(body));
        }
        catch (err) {
            return { ok: false, adapter: this.name, error: `sign failed: ${errMsg(err)}` };
        }
        const single = singleConcernRef(envelope);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
        try {
            const res = await this.fetchImpl(this.opts.url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            });
            const ack = {
                ok: res.ok,
                adapter: this.name,
                status: res.status,
                accepted: res.ok ? envelope.concerns.length : 0,
                ...(single ? { concern_ref: single } : {}),
                ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
            };
            // If the adapter returned a poll handle, surface it for poll-mode callers.
            const pollRef = await readPollRef(res);
            if (pollRef)
                ack.poll_ref = pollRef;
            return ack;
        }
        catch (err) {
            return { ok: false, adapter: this.name, error: errMsg(err) };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
/** Best-effort extraction of a poll handle from the dispatch response body. */
async function readPollRef(res) {
    if (!res.ok || typeof res.json !== 'function')
        return undefined;
    try {
        const data = (await res.json());
        const ref = data?.['poll_ref'];
        return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
    }
    catch {
        return undefined;
    }
}
function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return 'invalid-url';
    }
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=dispatch.js.map