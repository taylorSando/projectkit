/**
 * projectkit — sinks. A sink is where emitted events GO. The contract is
 * sink-agnostic: a testbed emits to an `EventSink`, and mesh/control-plane is
 * merely ONE possible sink (an HttpSink pointed at its ingest URL, optionally
 * signed). Nothing here imports control-plane or mesh.
 */
import type { ProjectEventEnvelope } from './contract.js';
export interface SinkResult {
    ok: boolean;
    sink: string;
    status?: number;
    error?: string;
    /** Number of events the sink accepted from the envelope. */
    accepted?: number;
}
export interface EventSink {
    readonly name: string;
    deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
}
/** Drops everything and reports success. Default for "capture is off". */
export declare class NullSink implements EventSink {
    readonly name = "null";
    deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
}
/** Collects envelopes in memory. For tests and local introspection. */
export declare class MemorySink implements EventSink {
    readonly name = "memory";
    readonly envelopes: ProjectEventEnvelope[];
    deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
    /** Flattened view of every event delivered so far. */
    get events(): import("./contract.js").ProjectEvent[];
    clear(): void;
}
/** Writes a one-line JSON summary per envelope to a logger (default console). */
export declare class ConsoleSink implements EventSink {
    private readonly log;
    readonly name = "console";
    constructor(log?: (line: string) => void);
    deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
}
/** A function that, given the request body, returns headers to attach (e.g. HMAC). */
export type SignFn = (body: string) => Record<string, string> | Promise<Record<string, string>>;
export interface HttpSinkOptions {
    /** Full ingest URL. mesh is just this string; the sink does not know mesh. */
    url: string;
    /** Static headers (content-type is added automatically). */
    headers?: Record<string, string>;
    /**
     * Optional signer. HMAC/auth is INJECTED, never baked in — a testbed never
     * needs to hold a mesh secret in the SDK; the host wires the signer.
     */
    sign?: SignFn;
    /** Defaults to global fetch (Node 18+/browser). Inject for tests. */
    fetchImpl?: typeof fetch;
    /** Abort after this many ms. Default 8000. */
    timeoutMs?: number;
    /** Sink name for diagnostics. Default derived from the URL host. */
    name?: string;
}
/** POSTs the envelope as JSON to a configurable URL. The canonical "to mesh" sink. */
export declare class HttpSink implements EventSink {
    private readonly opts;
    readonly name: string;
    private readonly fetchImpl;
    constructor(opts: HttpSinkOptions);
    deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
}
/** Delivers to several sinks; ok only if ALL succeed. Useful for tee'ing. */
export declare class FanoutSink implements EventSink {
    private readonly sinks;
    readonly name: string;
    constructor(sinks: EventSink[]);
    deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
}
//# sourceMappingURL=sink.d.ts.map