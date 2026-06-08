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
/** The inline ref the dock returns by default: `inline:<kind>:<sessionId>`. */
export function inlineArtifactRef(artifact) {
    return `inline:${artifact.kind}:${artifact.sessionId}`;
}
/**
 * Persists nothing; returns the inline ref. Formalizes today's default and is the
 * "no blob store wired" / capture-off-safe sink — the dock keeps working unchanged.
 */
export class NullArtifactSink {
    name = 'null-artifact';
    async put(artifact) {
        return { ok: true, sink: this.name, ref: inlineArtifactRef(artifact) };
    }
}
/** Collects artifacts in memory; returns the inline ref. For tests and introspection. */
export class MemoryArtifactSink {
    name = 'memory-artifact';
    artifacts = [];
    async put(artifact) {
        this.artifacts.push(artifact);
        return { ok: true, sink: this.name, ref: inlineArtifactRef(artifact) };
    }
    clear() {
        this.artifacts.length = 0;
    }
}
/**
 * Uploads artifact bytes to a configurable URL via PUT (default) or POST. The
 * canonical "to a blob store / to mesh" artifact sink. Content-type comes from the
 * artifact; HMAC/auth is injected via `sign`, never baked in.
 */
export class HttpArtifactSink {
    opts;
    name;
    fetchImpl;
    constructor(opts) {
        this.opts = opts;
        if (!opts.url)
            throw new Error('HttpArtifactSink requires a url');
        const f = opts.fetchImpl ?? globalThis.fetch;
        if (!f)
            throw new Error('HttpArtifactSink: no fetch available; pass opts.fetchImpl');
        this.fetchImpl = f;
        this.name = opts.name ?? `http-artifact(${safeHost(opts.url)})`;
    }
    async put(artifact) {
        if (!artifact.bytes) {
            // No bytes to upload — nothing to persist over HTTP. Fail closed rather than
            // silently dropping; a NullArtifactSink is the right sink for ref-only media.
            return {
                ok: false,
                sink: this.name,
                error: 'HttpArtifactSink: artifact has no bytes to upload (got a ref-only artifact)',
            };
        }
        const headers = {
            'content-type': artifact.contentType,
            ...(this.opts.headers ?? {}),
        };
        if (this.opts.sign) {
            try {
                // The signer canonicalizes over the body; give it a deterministic string
                // view of the same bytes we send (mirrors HttpSink signing the JSON body).
                Object.assign(headers, await this.opts.sign(bytesToBinaryString(artifact.bytes)));
            }
            catch (err) {
                return { ok: false, sink: this.name, error: `sign failed: ${errMsg(err)}` };
            }
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
        try {
            const res = await this.fetchImpl(this.opts.url, {
                method: this.opts.method ?? 'PUT',
                headers,
                // Copy into a fresh ArrayBuffer so the body is an unambiguous BufferSource
                // (a bare Uint8Array over ArrayBufferLike is not assignable to BodyInit).
                body: toArrayBuffer(artifact.bytes),
                signal: controller.signal,
            });
            if (!res.ok) {
                return { ok: false, sink: this.name, status: res.status, error: `HTTP ${res.status}` };
            }
            return {
                ok: true,
                sink: this.name,
                status: res.status,
                ref: this.deriveRef(res, artifact),
            };
        }
        catch (err) {
            return { ok: false, sink: this.name, error: errMsg(err) };
        }
        finally {
            clearTimeout(timer);
        }
    }
    deriveRef(res, artifact) {
        if (this.opts.refFromResponse)
            return this.opts.refFromResponse(res, artifact);
        const loc = res.headers.get('location');
        return loc ?? this.opts.url;
    }
}
/** Puts to several artifact sinks; ok only if ALL succeed. Returns the first ref. */
export class FanoutArtifactSink {
    sinks;
    name;
    constructor(sinks) {
        this.sinks = sinks;
        this.name = `fanout-artifact(${sinks.map((s) => s.name).join(',')})`;
    }
    async put(artifact) {
        const results = await Promise.all(this.sinks.map((s) => s.put(artifact)));
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
            return {
                ok: false,
                sink: this.name,
                error: failed.map((f) => `${f.sink}:${f.error}`).join('; '),
            };
        }
        const firstRef = results.find((r) => r.ref)?.ref ?? inlineArtifactRef(artifact);
        return { ok: true, sink: this.name, ref: firstRef };
    }
}
/** Copy into a fresh ArrayBuffer so the value is an unambiguous BodyInit/BufferSource. */
function toArrayBuffer(bytes) {
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);
    return ab;
}
/** A stable string view of arbitrary bytes (latin1/binary), for signing only. */
function bytesToBinaryString(bytes) {
    let s = '';
    for (const b of bytes)
        s += String.fromCharCode(b);
    return s;
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
//# sourceMappingURL=artifact-sink.js.map