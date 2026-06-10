#!/usr/bin/env node
/**
 * local-executor — a SECOND, REAL (non-mesh) dispatch backend for the
 * @operator/projectkit DISPATCH-direction contract.
 *
 * This is the executable proof of the One-Line Boundary Test against an actual
 * backend: a testbed swaps mesh for THIS executor by changing ONE URL (e.g.
 * MESH_CONCERN_DISPATCH_URL) and the Concern / Ack / Callback shapes it
 * produces and consumes do not change. Unlike examples/echo-dispatch-adapter
 * (which only echoes an `accepted` Callback), this executor REALLY RUNS each
 * Concern: it spawns a local one-shot process per accepted Concern and drives
 * the Callback through accepted -> running -> succeeded|failed with the
 * process's real output and exit code.
 *
 * It speaks the same two routes mesh's dispatch door speaks, byte-compatible
 * with the vendored schemas (schemas/concern.schema.json,
 * schemas/callback.schema.json):
 *
 *   POST /api/projectkit/concerns          accept a DispatchEnvelope, validate
 *                                          every Concern (validateConcern),
 *                                          execute it, return the `Ack` shape
 *                                          (HTTP 202, with poll_ref).
 *   GET  /api/projectkit/concerns/:pollRef serve the `Callback` shape for the
 *                                          Concern's CURRENT execution state.
 *   GET  /healthz                          liveness.
 *
 * EXECUTION (the point is the SHAPE — real process spawn, real async
 * completion, NOT a mesh call):
 *   LOCAL_EXECUTOR_CMD   shell command run once per accepted Concern (via
 *                        `sh -c`). Default is a safe echo stub. The Concern is
 *                        delivered to the process as:
 *                          - env: CONCERN_REF, CONCERN_KIND, CONCERN_TITLE,
 *                                 CONCERN_SUMMARY, CONCERN_PROJECT_KEY,
 *                                 CONCERN_INPUTS_JSON
 *                          - stdin: the full Concern JSON
 *                        exit 0  -> Callback status `succeeded` (stdout in
 *                                   outputs.stdout)
 *                        exit !0 -> `failed` (stderr tail in error)
 *                        A stdout line `::artifact::<kind>::<ref>` becomes a
 *                        CallbackArtifact.
 *   Point it at a real agent later, e.g.:
 *     LOCAL_EXECUTOR_CMD='claude -p "$CONCERN_TITLE — $CONCERN_SUMMARY"'
 *     LOCAL_EXECUTOR_CMD='agentcell up myrepo "$CONCERN_REF"'
 *   LOCAL_EXECUTOR_TIMEOUT_MS  kill the process after this many ms (default
 *                              120000) -> Callback `failed`.
 *
 * IDEMPOTENCY: keyed on (project_key, concern_ref) exactly like mesh — a
 * retried dispatch of the same Concern never runs twice; the poll_ref is the
 * SAME deterministic opaque handle mesh mints (sha256-derived, `pkc_` prefix),
 * so a poll-mode caller cannot tell the backends apart by shape.
 *
 * AUTH (optional, default OFF for local use): set
 *   LOCAL_EXECUTOR_HMAC_SECRET_HEX  hex shared secret (>= 32 bytes decoded)
 * and every request must carry mesh's canonical component-HMAC headers
 * (X-Mesh-Component / X-Mesh-Signature / X-Mesh-Timestamp over
 * `${ts}.${METHOD}.${path}.${sha256hex(body)}` — exactly what
 * @operator/projectkit/mesh-hmac's meshHmacSigner produces). Optionally pin
 * the caller with LOCAL_EXECUTOR_HMAC_COMPONENT.
 *
 * Zero runtime deps: node built-ins + this package's own dist (run
 * `npm run build` first). Imports NOTHING from mesh or control-plane.
 *
 * Run:  local-executor                     (PORT 8790, HOST 127.0.0.1)
 *       PORT=8790 LOCAL_EXECUTOR_CMD='...' local-executor
 */
import http from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateConcern, validateCallback } from '../dist/dispatch.js';
import { runConcernProcess, DEFAULT_TIMEOUT_MS } from './executor-core.mjs';

const ADAPTER_NAME_DEFAULT = 'local-executor';
const MAX_BODY_BYTES = 256 * 1024; // mirror mesh's maxProjectkitDispatchBytes
const POLL_REF_PREFIX = 'pkc_';
const DEFAULT_HMAC_SKEW_S = 300;
// Tolerated contract versions — the same subscriber posture as mesh's door
// (a producer pins its version; the executor tolerates the supported range).
const SUPPORTED_CONTRACT_VERSIONS = new Set(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0']);
const LATEST_CONTRACT_VERSION = '1.4.0';

/**
 * Deterministic opaque poll handle for a Concern — the SAME derivation mesh
 * uses (mesh/core mints sha256("projectkit.concern.poll.v1\0<project>\0<ref>")
 * -> base64url(first 18 bytes) with the pkc_ prefix), so swapping backends
 * does not even change the poll_ref a testbed holds for the same Concern.
 */
export function concernPollRef(projectKey, concernRef) {
  const sum = createHash('sha256')
    .update(`projectkit.concern.poll.v1\x00${String(projectKey).trim()}\x00${String(concernRef).trim()}`)
    .digest();
  return POLL_REF_PREFIX + sum.subarray(0, 18).toString('base64url');
}

function validPollRef(pollRef) {
  if (typeof pollRef !== 'string' || !pollRef.startsWith(POLL_REF_PREFIX)) return false;
  const suffix = pollRef.slice(POLL_REF_PREFIX.length);
  return suffix.length > 0 && /^[A-Za-z0-9_-]+$/.test(suffix);
}

function sha256HexSync(body) {
  return createHash('sha256').update(body || '', 'utf8').digest('hex');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('local-executor: LOCAL_EXECUTOR_HMAC_SECRET_HEX is not valid hex');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Verify mesh's canonical component-HMAC over this request. Returns null when
 * valid, else a human-readable problem. `body` is the raw request body string
 * ('' for GET). Mirrors mesh/core/hmac_auth_middleware.go semantics.
 */
function verifyMeshHmac({ secret, component, skewS, headers, method, path, body, nowS }) {
  const gotComponent = String(headers['x-mesh-component'] || '');
  const gotSignature = String(headers['x-mesh-signature'] || '');
  const gotTimestamp = String(headers['x-mesh-timestamp'] || '');
  if (!gotComponent || !gotSignature || !gotTimestamp) return 'hmac component identity required';
  if (component && gotComponent !== component) return 'unknown component';
  const ts = Number(gotTimestamp);
  if (!Number.isFinite(ts)) return 'invalid timestamp';
  if (Math.abs(nowS - ts) > skewS) return 'timestamp outside accepted skew';
  if (!gotSignature.startsWith('sha256=')) return 'invalid signature format';
  const canonical = `${gotTimestamp}.${method.toUpperCase()}.${path}.${sha256HexSync(body)}`;
  const expect = createHmac('sha256', secret).update(canonical, 'utf8').digest();
  let got;
  try {
    got = Buffer.from(gotSignature.slice('sha256='.length), 'hex');
  } catch {
    return 'invalid signature format';
  }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return 'signature mismatch';
  return null;
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

/**
 * Create the executor. Options (all optional; env is the fallback):
 *   cmd        shell command per Concern   (LOCAL_EXECUTOR_CMD)
 *   timeoutMs  per-process kill timer      (LOCAL_EXECUTOR_TIMEOUT_MS)
 *   adapterName                            (LOCAL_EXECUTOR_ADAPTER_NAME)
 *   hmacSecretHex  enable HMAC verification (LOCAL_EXECUTOR_HMAC_SECRET_HEX)
 *   hmacComponent  pin the caller identity  (LOCAL_EXECUTOR_HMAC_COMPONENT)
 *   hmacSkewS      timestamp tolerance      (LOCAL_EXECUTOR_HMAC_SKEW_S)
 *   onExecuted(record)  test/introspection hook fired at terminal state
 *
 * Returns { server, listen(port, host), close(), records } where `records` is
 * the in-memory ledger: poll_ref -> { concern, callback, spawnCount }.
 */
export function createLocalExecutor(opts = {}) {
  const env = opts.env ?? process.env;
  const cmd =
    opts.cmd ??
    env.LOCAL_EXECUTOR_CMD ??
    // Safe default stub: wraps the concern summary; replace with a real agent
    // (e.g. `claude -p "$CONCERN_TITLE — $CONCERN_SUMMARY"`) via LOCAL_EXECUTOR_CMD.
    'echo "local-executor stub: $CONCERN_TITLE ($CONCERN_REF) — ${CONCERN_SUMMARY:-no summary}"';
  const timeoutMs = Number(opts.timeoutMs ?? env.LOCAL_EXECUTOR_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const adapter = opts.adapterName ?? env.LOCAL_EXECUTOR_ADAPTER_NAME ?? ADAPTER_NAME_DEFAULT;
  const hmacSecretHex = opts.hmacSecretHex ?? env.LOCAL_EXECUTOR_HMAC_SECRET_HEX ?? '';
  const hmacComponent = opts.hmacComponent ?? env.LOCAL_EXECUTOR_HMAC_COMPONENT ?? '';
  const hmacSkewS = Number(opts.hmacSkewS ?? env.LOCAL_EXECUTOR_HMAC_SKEW_S ?? DEFAULT_HMAC_SKEW_S);
  const hmacSecret = hmacSecretHex ? hexToBytes(hmacSecretHex) : null;
  if (hmacSecret && hmacSecret.length < 32) {
    throw new Error('local-executor: LOCAL_EXECUTOR_HMAC_SECRET_HEX decodes to < 32 bytes');
  }
  const onExecuted = opts.onExecuted ?? (() => {});
  const log = opts.quiet ? () => {} : (...a) => console.log(`[${adapter}]`, ...a);

  /** poll_ref -> { concern, callback, spawnCount } */
  const records = new Map();
  /** idempotency: `${project_key}\x00${concern_ref}` -> poll_ref */
  const idem = new Map();

  function setCallback(record, patch) {
    record.callback = { ...record.callback, ...patch };
  }

  /** POST the terminal Callback to concern.callback.url (webhook mode), best-effort. */
  async function pushWebhook(record) {
    const url = record.concern.callback?.url;
    if (!url) return;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record.callback),
        signal: controller.signal,
      }).finally(() => clearTimeout(t));
    } catch (err) {
      log(`webhook push to ${url} failed (best-effort):`, err instanceof Error ? err.message : err);
    }
  }

  /** REALLY run the Concern: one local one-shot process, async completion.
   * The process leg lives in executor-core.mjs, SHARED with pull-executor so
   * the two backends cannot drift on the execution contract. */
  function execute(record) {
    const concern = record.concern;
    record.spawnCount += 1;
    setCallback(record, { status: 'running' });
    log(`running concern ${concern.concern_ref}: ${cmd}`);
    void runConcernProcess(concern, { cmd, env, timeoutMs }).then((patch) => {
      setCallback(record, patch);
      log(`concern ${concern.concern_ref} -> ${record.callback.status} (exit ${patch.outputs?.exit_code ?? 'n/a'})`);
      onExecuted(record);
      void pushWebhook(record);
    });
  }

  /** Accept one validated Concern: dedupe, mint the record, start execution. */
  function accept(concern) {
    const key = `${concern.project_key}\x00${concern.concern_ref}`;
    const existing = idem.get(key);
    if (existing) return existing; // retried dispatch: never run twice
    const pollRef = concernPollRef(concern.project_key, concern.concern_ref);
    const record = {
      concern,
      spawnCount: 0,
      callback: {
        schema_version: concern.schema_version,
        concern_ref: concern.concern_ref,
        status: 'accepted',
      },
    };
    records.set(pollRef, record);
    idem.set(key, pollRef);
    execute(record);
    return pollRef;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, adapter });
    }

    // POLL leg — serve the Callback shape for the Concern's CURRENT state.
    if (req.method === 'GET' && url.pathname.startsWith('/api/projectkit/concerns/')) {
      if (hmacSecret) {
        const problem = verifyMeshHmac({
          secret: hmacSecret,
          component: hmacComponent,
          skewS: hmacSkewS,
          headers: req.headers,
          method: 'GET',
          path: url.pathname,
          body: '',
          nowS: Math.floor(Date.now() / 1000),
        });
        if (problem) return json(res, 401, { error: problem });
      }
      const pollRef = decodeURIComponent(url.pathname.slice('/api/projectkit/concerns/'.length)).replace(/\/+$/, '');
      if (!validPollRef(pollRef)) return json(res, 400, { error: 'invalid poll_ref' });
      const record = records.get(pollRef);
      if (!record) return json(res, 404, { error: 'no concern for that poll_ref' });
      // Fail closed on the way out: never serve a Callback the contract rejects.
      const problems = validateCallback(record.callback);
      if (problems.length) return json(res, 500, { error: `internal: invalid callback: ${problems.join('; ')}` });
      return json(res, 200, record.callback);
    }

    // DISPATCH leg — accept a DispatchEnvelope, validate, EXECUTE, return the Ack.
    if (req.method === 'POST' && url.pathname === '/api/projectkit/concerns') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { ok: false, adapter, status: 400, error: 'body too large or read error' });
      }
      if (hmacSecret) {
        const problem = verifyMeshHmac({
          secret: hmacSecret,
          component: hmacComponent,
          skewS: hmacSkewS,
          headers: req.headers,
          method: 'POST',
          path: url.pathname,
          body,
          nowS: Math.floor(Date.now() / 1000),
        });
        if (problem) return json(res, 401, { ok: false, adapter, status: 401, error: problem });
      }

      let envelope;
      try {
        envelope = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, adapter, status: 400, error: 'invalid dispatch envelope json' });
      }
      const contractVersion = String(envelope?.contract_version ?? '');
      if (!SUPPORTED_CONTRACT_VERSIONS.has(contractVersion)) {
        return json(res, 422, {
          ok: false, adapter, status: 422,
          error: `contract_version ${JSON.stringify(contractVersion)} not supported (executor accepts 1.0.0..${LATEST_CONTRACT_VERSION})`,
        });
      }
      if (typeof envelope.project_key !== 'string' || !envelope.project_key.trim()) {
        return json(res, 400, { ok: false, adapter, status: 400, error: 'project_key required' });
      }
      const concerns = Array.isArray(envelope.concerns) ? envelope.concerns : [];
      if (!concerns.length) {
        return json(res, 400, { ok: false, adapter, status: 400, error: 'concerns required (non-empty)' });
      }

      // Best-effort per-concern, mirroring mesh's door: a malformed Concern is
      // skipped (not a batch failure); `accepted` is the count that landed.
      let accepted = 0;
      let lastPollRef = '';
      for (const concern of concerns) {
        if (validateConcern(concern).length > 0) continue;
        lastPollRef = accept(concern);
        accepted++;
      }

      // The projectkit Ack — byte-compatible with mesh's writeProjectkitAck.
      const ack = { ok: true, adapter, accepted, status: 202 };
      if (concerns.length === 1 && typeof concerns[0]?.concern_ref === 'string') {
        ack.concern_ref = concerns[0].concern_ref.trim();
      }
      if (accepted === 1 && lastPollRef) ack.poll_ref = lastPollRef;
      return json(res, 202, ack);
    }

    return json(res, 404, { error: 'not found' });
  });

  return {
    server,
    records,
    listen(port = Number(env.LOCAL_EXECUTOR_PORT ?? env.PORT ?? 8790), host = env.HOST ?? '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// CLI entrypoint: `local-executor` / `node bin/local-executor.mjs`.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const executor = createLocalExecutor();
  executor.listen().then((addr) => {
    const where = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : String(addr);
    console.log(`[local-executor] listening on http://${where}`);
    console.log('[local-executor] POST /api/projectkit/concerns  GET /api/projectkit/concerns/:pollRef  GET /healthz');
    console.log(`[local-executor] cmd: ${process.env.LOCAL_EXECUTOR_CMD ?? '(default echo stub — set LOCAL_EXECUTOR_CMD)'}`);
    console.log(`[local-executor] hmac: ${process.env.LOCAL_EXECUTOR_HMAC_SECRET_HEX ? 'REQUIRED' : 'off (set LOCAL_EXECUTOR_HMAC_SECRET_HEX to require)'}`);
  });
}
