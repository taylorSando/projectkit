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

  // --- detail ------------------------------------------------------------
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

  // --- routing / attribution --------------------------------------------
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

  // --- governance --------------------------------------------------------
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
  producer: { name: string; version?: string };
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

type AckBody = Partial<Ack> & Record<string, unknown>;

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

  // --- result detail -----------------------------------------------------
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

const CALLBACK_STATUSES: readonly CallbackStatus[] = [
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
export function validateConcern(o: unknown): string[] {
  const problems: string[] = [];
  if (typeof o !== 'object' || o === null) return ['concern is not an object'];
  const c = o as Record<string, unknown>;
  const reqString = (k: string) => {
    if (typeof c[k] !== 'string' || (c[k] as string).trim().length === 0) {
      problems.push(`missing/invalid required string field: ${k}`);
    }
  };
  reqString('schema_version');
  reqString('project_key');
  reqString('dispatched_at');
  reqString('concern_ref');
  reqString('kind');
  reqString('title');
  if (typeof c['dispatched_at'] === 'string' && Number.isNaN(Date.parse(c['dispatched_at'] as string))) {
    problems.push('dispatched_at is not a parseable ISO-8601 timestamp');
  }
  if (c['inputs'] !== undefined && (typeof c['inputs'] !== 'object' || c['inputs'] === null)) {
    problems.push('inputs, when present, must be an object');
  }
  for (const k of ['audience', 'assignee'] as const) {
    if (c[k] !== undefined && (typeof c[k] !== 'string' || (c[k] as string).trim().length === 0)) {
      problems.push(`${k}, when present, must be a non-empty string`);
    }
  }
  if (
    c['source_event_ref'] !== undefined &&
    (typeof c['source_event_ref'] !== 'string' || (c['source_event_ref'] as string).trim().length === 0)
  ) {
    problems.push('source_event_ref, when present, must be a non-empty string');
  }
  if (c['acceptance'] !== undefined) {
    if (!Array.isArray(c['acceptance']) || (c['acceptance'] as unknown[]).some((a) => typeof a !== 'string')) {
      problems.push('acceptance, when present, must be an array of strings');
    }
  }
  if (c['callback'] !== undefined) {
    if (typeof c['callback'] !== 'object' || c['callback'] === null) {
      problems.push('callback, when present, must be an object');
    } else {
      const cb = c['callback'] as Record<string, unknown>;
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
export function validateCallback(o: unknown): string[] {
  const problems: string[] = [];
  if (typeof o !== 'object' || o === null) return ['callback is not an object'];
  const cb = o as Record<string, unknown>;
  const reqString = (k: string) => {
    if (typeof cb[k] !== 'string' || (cb[k] as string).trim().length === 0) {
      problems.push(`missing/invalid required string field: ${k}`);
    }
  };
  reqString('schema_version');
  reqString('concern_ref');
  reqString('status');
  if (typeof cb['status'] === 'string' && !CALLBACK_STATUSES.includes(cb['status'] as CallbackStatus)) {
    problems.push(`status must be one of: ${CALLBACK_STATUSES.join(', ')}`);
  }
  if (cb['outputs'] !== undefined && (typeof cb['outputs'] !== 'object' || cb['outputs'] === null)) {
    problems.push('outputs, when present, must be an object');
  }
  if (cb['error_code'] !== undefined && (typeof cb['error_code'] !== 'string' || (cb['error_code'] as string).trim().length === 0)) {
    problems.push('error_code, when present, must be a non-empty string');
  }
  if (cb['artifacts'] !== undefined) {
    const a = cb['artifacts'];
    if (
      !Array.isArray(a) ||
      a.some(
        (x) =>
          typeof x !== 'object' ||
          x === null ||
          typeof (x as Record<string, unknown>)['kind'] !== 'string' ||
          typeof (x as Record<string, unknown>)['ref'] !== 'string',
      )
    ) {
      problems.push('artifacts, when present, must be an array of {kind, ref} objects');
    } else {
      for (const x of a as Record<string, unknown>[]) {
        if (x['content_type'] !== undefined && typeof x['content_type'] !== 'string') {
          problems.push('artifacts[].content_type, when present, must be a string');
        }
        for (const k of ['byte_size', 'duration_ms'] as const) {
          if (x[k] !== undefined && (typeof x[k] !== 'number' || !Number.isFinite(x[k] as number) || (x[k] as number) < 0)) {
            problems.push(`artifacts[].${k}, when present, must be a non-negative number`);
          }
        }
      }
    }
  }
  return problems;
}

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

/**
 * The single concern_ref to echo on an Ack when an envelope carries exactly
 * one concern (the common dispatch shape); undefined for an empty/multi batch.
 */
function singleConcernRef(envelope: DispatchEnvelope): string | undefined {
  return envelope.concerns.length === 1 ? envelope.concerns[0]?.concern_ref : undefined;
}

/** Accepts and DROPS everything, reporting success. Default for "dispatch is off". */
export class NullDispatchAdapter implements DispatchAdapter {
  readonly name = 'null';
  async dispatch(envelope: DispatchEnvelope): Promise<Ack> {
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
export class MemoryDispatchAdapter implements DispatchAdapter {
  readonly name = 'memory';
  readonly envelopes: DispatchEnvelope[] = [];
  async dispatch(envelope: DispatchEnvelope): Promise<Ack> {
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
export class HttpDispatchAdapter implements DispatchAdapter {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: HttpDispatchAdapterOptions) {
    if (!opts.url) throw new Error('HttpDispatchAdapter requires a url');
    const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new Error('HttpDispatchAdapter: no fetch available; pass opts.fetchImpl');
    // Bind to the global scope: calling `this.fetchImpl(...)` would otherwise
    // invoke the browser's native `fetch` with `this === HttpDispatchAdapter`,
    // which throws "Illegal invocation" (Node's fetch tolerates any `this`, so
    // this only bit in the browser). Mirrors HttpSink.
    this.fetchImpl = f.bind(globalThis);
    this.name = opts.name ?? `http(${safeHost(opts.url)})`;
  }

  async dispatch(envelope: DispatchEnvelope): Promise<Ack> {
    const body = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.opts.headers ?? {}),
    };
    try {
      if (this.opts.sign) Object.assign(headers, await this.opts.sign(body));
    } catch (err) {
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
      return await readHttpAck(res, {
        adapter: this.name,
        httpOk: res.ok,
        httpStatus: res.status,
        fallbackAccepted: envelope.concerns.length,
        concernRef: single,
      });
    } catch (err) {
      return { ok: false, adapter: this.name, error: errMsg(err) };
    } finally {
      clearTimeout(timer);
    }
  }
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
export async function readHttpAck(res: { ok: boolean; status: number; json?: () => Promise<unknown> }, ctx: HttpAckContext): Promise<Ack> {
  const body = await readAckBody(res);
  const accepted = acceptedFromBody(body, ctx.httpOk ? ctx.fallbackAccepted : 0);
  const bodyOk = typeof body?.ok === 'boolean' ? body.ok : undefined;
  const ok = ctx.httpOk && (bodyOk ?? true);
  const ack: Ack = {
    ok,
    adapter: stringField(body, 'adapter') ?? ctx.adapter,
    status: numberField(body, 'status') ?? ctx.httpStatus,
    accepted,
    ...(stringField(body, 'concern_ref') ?? ctx.concernRef
      ? { concern_ref: stringField(body, 'concern_ref') ?? ctx.concernRef }
      : {}),
    ...(stringField(body, 'poll_ref') ? { poll_ref: stringField(body, 'poll_ref') } : {}),
  };
  const error = stringField(body, 'error');
  if (error) ack.error = error;
  if (!ack.ok && !ack.error) ack.error = `HTTP ${ctx.httpStatus}`;
  return ack;
}

async function readAckBody(res: { json?: () => Promise<unknown> }): Promise<AckBody | null> {
  if (typeof res.json !== 'function') return null;
  try {
    const data = await res.json();
    return typeof data === 'object' && data !== null ? (data as AckBody) : null;
  } catch {
    return null;
  }
}

function acceptedFromBody(body: AckBody | null, fallback: number): number {
  const accepted = body?.accepted;
  if (typeof accepted === 'number' && Number.isFinite(accepted) && accepted >= 0) {
    return Math.floor(accepted);
  }
  if (typeof accepted === 'boolean') return accepted ? fallback : 0;
  return fallback;
}

function stringField(body: AckBody | null, key: keyof Ack): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(body: AckBody | null, key: keyof Ack): number | undefined {
  const value = body?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
