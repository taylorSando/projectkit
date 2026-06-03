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

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('meshHmacSigner: secretHex has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('meshHmacSigner: secretHex is not valid hex');
    out[i] = byte;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Copy into a fresh ArrayBuffer so the value is an unambiguous BufferSource for Web Crypto. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/** Lowercase sha256 hex of the body (empty body => the well-known e3b0c4… constant). */
export async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(body || '')));
  return bytesToHex(new Uint8Array(digest));
}

/** The four-tuple both sides hash, in mesh's canonical order. */
export async function meshCanonicalString(o: {
  timestamp: string | number;
  method: string;
  path: string;
  body: string;
}): Promise<string> {
  return `${o.timestamp}.${o.method}.${o.path}.${await sha256Hex(o.body || '')}`;
}

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
export function meshHmacSigner(opts: MeshHmacSignerOptions): SignFn {
  if (!opts.component) throw new Error('meshHmacSigner: component is required');
  if (!opts.secretHex) throw new Error('meshHmacSigner: secretHex is required');
  const secret = hexToBytes(opts.secretHex);
  if (secret.length < 32) {
    throw new Error(`meshHmacSigner: secretHex decodes to ${secret.length} bytes; expected >= 32`);
  }
  const method = (opts.method ?? 'POST').toUpperCase();
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000));

  return async (body: string): Promise<Record<string, string>> => {
    const timestamp = String(clock());
    const canonical = await meshCanonicalString({ timestamp, method, path: opts.path, body });
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, toArrayBuffer(new TextEncoder().encode(canonical)));
    return {
      'X-Mesh-Component': opts.component,
      'X-Mesh-Signature': `sha256=${bytesToHex(new Uint8Array(sigBuf))}`,
      'X-Mesh-Timestamp': timestamp,
    };
  };
}
