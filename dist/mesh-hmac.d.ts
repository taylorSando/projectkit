/**
 * projectkit — mesh-hmac: the canonical mesh component-HMAC signer.
 *
 * A SUBPATH module, NOT re-exported from the package root — import it explicitly
 * from the "@operator/projectkit/mesh-hmac" subpath (server-only).
 *
 * It produces the EXACT scheme mesh's verifier accepts (mesh/core/hmac_auth_middleware.go,
 * mirrored by console/gateway/lib/mesh-hmac.js), so a testbed can sign for mesh without
 * hand-rolling the canonical string in app code:
 *
 *   canonical = `${timestamp}.${METHOD}.${path}.${sha256hex(body)}`
 *   signature = "sha256=" + hex(HMAC-SHA256(hexDecode(secret), canonical))
 *   headers   = X-Mesh-Component, X-Mesh-Signature, X-Mesh-Timestamp
 *
 * Mesh stays just a URL: this returns a `SignFn` you inject into an HttpSink /
 * HttpDispatchAdapter, and the SECRET is supplied by the host at call time, never baked
 * into the SDK. Uses Web Crypto only (universal across Node 18+ and the browser, zero
 * runtime deps). Pinned byte-for-byte against the cross-implementation fixture in
 * test/mesh-hmac.test.mjs (which matches the Go verifier).
 */
import type { SignFn } from './sink.js';
export interface MeshHmacSignerOptions {
    /** Caller identity — the mesh component name that holds an active capture_grant. */
    component: string;
    /** Hex-encoded shared secret (must decode to >= 32 bytes). Injected by the host. */
    secretHex: string;
    /** The ingest pathname mesh verifies, e.g. '/api/product-trace/ingest'. */
    path: string;
    /** HTTP method; default 'POST'. */
    method?: string;
    /** Unix-seconds clock; injectable for tests. */
    now?: () => number;
}
/** Lowercase sha256 hex of the body (empty body => the well-known e3b0c4… constant). */
export declare function sha256Hex(body: string): Promise<string>;
/** The four-tuple both sides hash, in mesh's canonical order. */
export declare function meshCanonicalString(o: {
    timestamp: string | number;
    method: string;
    path: string;
    body: string;
}): Promise<string>;
/**
 * Build a `SignFn` that emits mesh's three component-HMAC headers for a fixed
 * (component, path, method). Wire it into a sink/adapter:
 *
 *   const url = process.env.SIGNAL_SINK_URL!;
 *   new HttpSink({ url, sign: meshHmacSigner({
 *     component: process.env.MESH_HMAC_COMPONENT!,
 *     secretHex: process.env.MESH_HMAC_SECRET_HEX!,
 *     path: new URL(url).pathname,
 *   }) });
 *
 * Throws on a missing/undersized secret so a misconfig surfaces here, not as a mesh 401.
 */
export declare function meshHmacSigner(opts: MeshHmacSignerOptions): SignFn;
//# sourceMappingURL=mesh-hmac.d.ts.map