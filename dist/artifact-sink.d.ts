/**
 * projectkit — artifact sinks. Where capture-dock MEDIA goes (audio, video,
 * screenshots), as opposed to {@link EventSink} (where structured EVENTS go).
 *
 * WHY THIS EXISTS. The capture dock can already return an inline artifact ref
 * (`inline:<kind>:<sessionId>`) — a pointer that says "the media exists, addressed
 * by kind+session" without actually persisting bytes anywhere. There was no way to
 * STORE the bytes. `ArtifactSink` is the missing seam: a dock hands an artifact to
 * a sink, the sink persists it and returns a ref. Mesh/control-plane is merely ONE
 * possible artifact sink (an `HttpArtifactSink` pointed at its blob ingest URL,
 * optionally signed) — exactly as it is merely one `EventSink`. Nothing here imports
 * control-plane or mesh, and (like the event sinks) HMAC/auth is INJECTED via a
 * `sign` fn, never baked into the SDK.
 *
 * `NullArtifactSink` formalizes today's default: it persists nothing and returns
 * the inline ref, so it is capture-off-safe — the dock keeps working with no blob
 * store wired. `HttpArtifactSink` is the canonical "to a blob store / to mesh"
 * transport. Both mirror `SinkResult` conventions from {@link ./sink.js}.
 *
 * BROWSER-SAFE: uses only `fetch`, `AbortController`, and `Uint8Array` (universal
 * across Node 18+ and the browser), so it IS re-exported from the package root
 * barrel (`index.ts`), unlike the node-only `git-ref-sink` / `mesh-hmac` subpaths.
 */
import type { SignFn } from './sink.js';
/**
 * One piece of dock media handed to an {@link ArtifactSink}. Either `bytes` (the
 * raw media to persist) or `ref` (an already-addressable pointer the sink can
 * record without re-uploading) is present; a sink that needs bytes but is handed
 * only a ref should fail closed.
 */
export interface Artifact {
    /** What kind of media, e.g. "audio", "video", "screenshot". Opaque to the contract. */
    kind: string;
    /** Capture session this media belongs to. Forms the default inline ref. */
    sessionId: string;
    /** MIME type of the bytes, e.g. "audio/webm", "image/png". */
    contentType: string;
    /** The raw media to persist. Mutually-exclusive-ish with `ref` (prefer `bytes`). */
    bytes?: Uint8Array;
    /** An already-addressable pointer, when the bytes live elsewhere already. */
    ref?: string;
    /** Free-form, small, flat metadata to carry alongside the media. */
    metadata?: Record<string, unknown>;
}
/**
 * Where the sink left the artifact. `inline` is intentionally not durable: it
 * says "the dock produced a ref" but no bytes were stored.
 */
export type ArtifactPersistence = 'durable' | 'inline' | 'memory' | 'missing' | 'unknown';
/**
 * Result of persisting one {@link Artifact}. Mirrors `SinkResult` conventions in
 * {@link ./sink.js}: `ok` + `sink` always; `ref` on success (where the media now
 * lives); `persistence` says whether that ref can be fetched later; `status` /
 * `error` are diagnostics.
 */
export interface ArtifactSinkResult {
    ok: boolean;
    sink: string;
    /** Whether the artifact bytes were durably stored, kept in memory, or not stored. */
    persistence: ArtifactPersistence;
    /** Pointer to the stored media on success — a URL, path, ref, or the inline ref. */
    ref?: string;
    status?: number;
    error?: string;
}
export interface ArtifactSink {
    readonly name: string;
    put(artifact: Artifact): Promise<ArtifactSinkResult>;
}
/** The inline ref the dock returns by default: `inline:<kind>:<sessionId>`. */
export declare function inlineArtifactRef(artifact: Pick<Artifact, 'kind' | 'sessionId'>): string;
/**
 * Persists nothing; returns the inline ref. Formalizes today's default and is the
 * "no blob store wired" / capture-off-safe sink — the dock keeps working unchanged.
 */
export declare class NullArtifactSink implements ArtifactSink {
    readonly name = "null-artifact";
    put(artifact: Artifact): Promise<ArtifactSinkResult>;
}
/** Collects artifacts in memory; returns the inline ref. For tests and introspection. */
export declare class MemoryArtifactSink implements ArtifactSink {
    readonly name = "memory-artifact";
    readonly artifacts: Artifact[];
    put(artifact: Artifact): Promise<ArtifactSinkResult>;
    clear(): void;
}
export interface HttpArtifactSinkOptions {
    /** Full blob-ingest URL. mesh is just this string; the sink does not know mesh. */
    url: string;
    /** HTTP method for the upload. Default 'PUT'. */
    method?: 'PUT' | 'POST';
    /** Static headers (content-type is set from the artifact automatically). */
    headers?: Record<string, string>;
    /**
     * Optional signer. HMAC/auth is INJECTED, never baked in — a testbed never needs
     * to hold a mesh secret in the SDK; the host wires the signer (e.g. meshHmacSigner).
     * The signer receives the raw upload body as a UTF-8-ish string view of the bytes.
     */
    sign?: SignFn;
    /** Defaults to global fetch (Node 18+/browser). Inject for tests. */
    fetchImpl?: typeof fetch;
    /** Abort after this many ms. Default 8000 (matches HttpSink). */
    timeoutMs?: number;
    /** Sink name for diagnostics. Default derived from the URL host. */
    name?: string;
    /**
     * Derive the stored ref from the HTTP response. Default: a `Location` response
     * header if present, else the request URL. Lets a host map the store's own id back.
     */
    refFromResponse?: (res: Response, artifact: Artifact) => string;
}
/**
 * Uploads artifact bytes to a configurable URL via PUT (default) or POST. The
 * canonical "to a blob store / to mesh" artifact sink. Content-type comes from the
 * artifact; HMAC/auth is injected via `sign`, never baked in.
 */
export declare class HttpArtifactSink implements ArtifactSink {
    private readonly opts;
    readonly name: string;
    private readonly fetchImpl;
    constructor(opts: HttpArtifactSinkOptions);
    put(artifact: Artifact): Promise<ArtifactSinkResult>;
    private deriveRef;
}
/** Puts to several artifact sinks; ok only if ALL succeed. Returns the first ref. */
export declare class FanoutArtifactSink implements ArtifactSink {
    private readonly sinks;
    readonly name: string;
    constructor(sinks: ArtifactSink[]);
    put(artifact: Artifact): Promise<ArtifactSinkResult>;
}
//# sourceMappingURL=artifact-sink.d.ts.map