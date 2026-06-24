/**
 * projectkit — the DISPATCH-DIRECTION surface (v1.3.0, extended in v1.4.0).
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
import { type ProjectKey, type Sensitivity } from './contract.js';
/**
 * How a dispatcher should return the `Callback` result. Open `string`
 * fallback so an adapter can name a delivery mode the contract does not know.
 *
 * - `webhook` — the adapter POSTs a `Callback` to `callback.url` when done.
 * - `poll`    — the testbed polls the adapter (using the `Ack.poll_ref`).
 */
export type CallbackMode = 'webhook' | 'poll' | string;
/**
 * Where/how a dispatched `Concern` wants its result delivered. Both fields are
 * optional: an adapter may default to poll, or the host may wire a webhook.
 */
export interface ConcernCallback {
    /** Webhook URL the adapter POSTs the `Callback` to. Adapter-agnostic. */
    url?: string;
    /** How the result comes back. Defaults to the adapter's own convention. */
    mode?: CallbackMode;
}
export type ConcernPriority = 'low' | 'normal' | 'high' | 'urgent' | string;
/**
 * `Concern` — one unit of work a testbed DISPATCHES for execution. It is the
 * dispatch-direction analogue of `WorkRequest`: a `WorkRequest` is emitted
 * fire-and-forget and a subscriber MAY mint a task; a `Concern` is dispatched
 * to an executor that WILL run it and return a `Callback`.
 */
export interface Concern {
    /** Equals CONTRACT_VERSION at dispatch time. An adapter narrows on this. */
    schema_version: string;
    /** Dispatching project. Open string — no closed roster. */
    project_key: ProjectKey;
    /** ISO-8601 timestamp the concern was dispatched. */
    dispatched_at: string;
    /**
     * Producer-stable idempotency key. An adapter dedupes retries on this so the
     * same concern never runs twice; it also keys the `Callback` back.
     */
    concern_ref: string;
    /**
     * What kind of execution this is. Open string — well-known values include
     * `execute`, `research`, `review` — so an adapter narrows on the known ones
     * and routes the rest to a default lane without a contract bump.
     */
    kind: string;
    /** Short human-readable title for the unit of work. */
    title: string;
    summary?: string;
    /** Free-form input map the executor consumes. Keep it small + flat. */
    inputs?: Record<string, unknown>;
    /** Where/how the result should come back. */
    callback?: ConcernCallback;
    priority?: ConcernPriority;
    /**
     * Explicit success criteria the executor should verify before reporting
     * `succeeded`. Mirrors `WorkRequest.acceptance` — before v1.4.0 a dispatched
     * Concern could not carry the criteria, so an executor had to guess. (v1.4.0)
     */
    acceptance?: string[];
    /**
     * Which executor pool / feed lane should pick this up — e.g. `mesh`,
     * `capture-analyzer`, `steve`. Open string; an adapter or pull-feed filters
     * on it. Before v1.4.0 routing could only be inferred from kind/priority,
     * so a Concern could not be addressed TO a specific executor. (v1.4.0)
     */
    audience?: string;
    /**
     * Person/agent identity accountable for the result (attribution), distinct
     * from `audience` (routing). Open string, e.g. `steve`, `operator`. (v1.4.0)
     */
    assignee?: string;
    /** Pointer back to an originating ProjectEvent/WorkRequest/capture. */
    source_event_ref?: string;
    sensitivity?: Sensitivity;
}
/**
 * `DispatchEnvelope` — the transport wrapper for one or more concerns. Mirrors
 * `ProjectEventEnvelope` / `WorkRequestEnvelope` / `LogEnvelope`: an adapter
 * accepts it and returns an `Ack`. `contract_version` is what adapters pin to.
 */
export interface DispatchEnvelope {
    contract_version: string;
    project_key: ProjectKey;
    /** ISO-8601 when the batch was dispatched by the producer. */
    dispatched_at: string;
    producer: {
        name: string;
        version?: string;
    };
    concerns: Concern[];
    /** Optional idempotency key so an adapter can dedupe retries. */
    delivery_id?: string;
}
/**
 * `Ack` — the synchronous result of DISPATCHING an envelope. Mirrors
 * `SinkResult` in sink.ts (the emit-direction result): `ok` + `adapter` +
 * diagnostics, plus dispatch-specific fields for accept-count and the poll
 * handle a testbed uses when `callback.mode === 'poll'`. This is NOT the work
 * RESULT — that comes later as a `Callback`.
 */
export interface Ack {
    ok: boolean;
    /** Which dispatch adapter handled it (mesh is just one). */
    adapter: string;
    /** Echo of the concern_ref for a single-concern dispatch, if applicable. */
    concern_ref?: string;
    /** Number of concerns the adapter accepted from the envelope. */
    accepted?: number;
    /** Opaque handle the testbed polls with when mode is `poll`. */
    poll_ref?: string;
    /** Adapter-side status (e.g. an HTTP status). */
    status?: number;
    error?: string;
}
/** Terminal + transitional states a dispatched `Concern` moves through. */
export type CallbackStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** A produced artifact pointer carried back on a `Callback`. */
export interface CallbackArtifact {
    /** What kind of artifact, e.g. "pr", "report", "screenshot", "diff". */
    kind: string;
    /** Pointer to it — a URL, path, ref, or id. Opaque to the contract. */
    ref: string;
    /** MIME type of the artifact, e.g. "video/webm", "image/png". (v1.4.0) */
    content_type?: string;
    /** Size of the artifact in bytes. Matches capture-overlay's chunk-manifest
     * `byte_size` naming. (v1.4.0) */
    byte_size?: number;
    /** Duration for time-based media (audio/video/replay), in ms. (v1.4.0) */
    duration_ms?: number;
}
/**
 * Machine-readable failure category on a `Callback`. Before v1.4.0 `error` was
 * the only failure signal — a free-form string a consumer could not branch on.
 * Open string with well-known literals so an executor can add a category
 * without a contract bump:
 *
 * - `timeout`    — the executor killed the work after its time budget.
 * - `permission` — the executor could not access a required resource.
 * - `validation` — the Concern's inputs were malformed/unusable.
 * - `execution`  — the work ran and failed on its own terms.
 * - `cancelled`  — the work was cancelled before completing.
 */
export type CallbackErrorCode = 'timeout' | 'permission' | 'validation' | 'execution' | 'cancelled' | string;
/**
 * `Callback` — the RESULT of executing a dispatched `Concern`, returned by the
 * adapter (webhook POST) or fetched by the testbed (poll). Keyed by
 * `concern_ref` back to the originating `Concern`. This is the return leg that
 * makes dispatch a two-way seam, not just another emit.
 */
export interface Callback {
    /** Equals CONTRACT_VERSION at callback time. The testbed narrows on this. */
    schema_version: string;
    /** The concern_ref of the Concern this is the result for. */
    concern_ref: string;
    /** Where the unit of work ended up. */
    status: CallbackStatus;
    /** Free-form output map the executor produced. Keep it small + flat. */
    outputs?: Record<string, unknown>;
    /** Pointers to produced artifacts (PRs, reports, screenshots, …). */
    artifacts?: CallbackArtifact[];
    /** Human-readable failure detail when status is `failed`/`cancelled`. */
    error?: string;
    /** Machine-readable failure category when status is `failed`/`cancelled`. (v1.4.0) */
    error_code?: CallbackErrorCode;
    /** ISO-8601 when execution finished (terminal states). */
    completed_at?: string;
}
/**
 * `DispatchAdapter` — the sink-agnostic dispatch sender. Exactly like
 * `EventSink` is for the emit direction: a testbed dispatches to a
 * `DispatchAdapter`, and mesh is merely ONE possible adapter (an
 * `HttpDispatchAdapter` pointed at its dispatch URL, optionally signed).
 * Nothing here imports control-plane or mesh.
 */
export interface DispatchAdapter {
    readonly name: string;
    dispatch(envelope: DispatchEnvelope): Promise<Ack>;
}
/**
 * Validate a Concern against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or an adapter gate. Mirrors `validateWorkRequest`.
 */
export declare function validateConcern(o: unknown): string[];
/**
 * Validate a Callback against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable on the return leg so
 * a testbed fails closed on a malformed result. Mirrors `validateConcern`.
 */
export declare function validateCallback(o: unknown): string[];
/** A function that, given the request body, returns headers to attach (e.g. HMAC). */
export type DispatchSignFn = (body: string) => Record<string, string> | Promise<Record<string, string>>;
export interface HttpDispatchAdapterOptions {
    /** Full dispatch URL. mesh is just this string; the adapter does not know mesh. */
    url: string;
    /** Static headers (content-type is added automatically). */
    headers?: Record<string, string>;
    /**
     * Optional signer. HMAC/auth is INJECTED, never baked in — a testbed never
     * needs to hold a mesh secret in the SDK; the host wires the signer.
     */
    sign?: DispatchSignFn;
    /** Defaults to global fetch (Node 18+/browser). Inject for tests. */
    fetchImpl?: typeof fetch;
    /** Abort after this many ms. Default 8000. */
    timeoutMs?: number;
    /** Adapter name for diagnostics. Default derived from the URL host. */
    name?: string;
}
/** Accepts and DROPS everything, reporting success. Default for "dispatch is off". */
export declare class NullDispatchAdapter implements DispatchAdapter {
    readonly name = "null";
    dispatch(envelope: DispatchEnvelope): Promise<Ack>;
}
/** Collects dispatched envelopes in memory. For tests and local introspection. */
export declare class MemoryDispatchAdapter implements DispatchAdapter {
    readonly name = "memory";
    readonly envelopes: DispatchEnvelope[];
    dispatch(envelope: DispatchEnvelope): Promise<Ack>;
    /** Flattened view of every concern dispatched so far. */
    get concerns(): Concern[];
    clear(): void;
}
/**
 * POSTs the DispatchEnvelope as JSON to a configurable URL — the canonical
 * "to mesh" dispatch adapter, the dispatch-direction analogue of `HttpSink`.
 * mesh is just the URL; HMAC is injected, never baked in.
 */
export declare class HttpDispatchAdapter implements DispatchAdapter {
    private readonly opts;
    readonly name: string;
    private readonly fetchImpl;
    constructor(opts: HttpDispatchAdapterOptions);
    dispatch(envelope: DispatchEnvelope): Promise<Ack>;
}
export interface HttpAckContext {
    adapter: string;
    httpOk: boolean;
    httpStatus: number;
    fallbackAccepted: number;
    concernRef?: string;
}
/**
 * Parse an adapter Ack from an HTTP response without assuming that HTTP 2xx
 * means every concern was accepted. Mesh and local-executor return the real
 * accepted count in the body; older adapters may omit it, so OK responses keep
 * the historical fallback.
 */
export declare function readHttpAck(res: {
    ok: boolean;
    status: number;
    json?: () => Promise<unknown>;
}, ctx: HttpAckContext): Promise<Ack>;
//# sourceMappingURL=dispatch.d.ts.map