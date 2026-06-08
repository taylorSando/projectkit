#!/usr/bin/env node
/**
 * echo-dispatch-adapter — a SECOND, NON-MESH dispatch executor for the
 * @operator/projectkit contract. This is the executable proof of the One-Line
 * Boundary Test: a testbed (chess) can swap mesh for THIS adapter by changing a
 * single URL (MESH_CONCERN_DISPATCH_URL) and the Concern / Ack / Callback shapes
 * it produces and consumes do not change. mesh is just one implementation behind
 * a URL; this file is another, and it imports NOTHING from mesh/control-plane —
 * only the published contract (validateConcern / validateCallback).
 *
 * It speaks the same two routes mesh's dispatch backend speaks:
 *
 *   POST /api/projectkit/concerns          accept a DispatchEnvelope, validate
 *                                          every Concern with the contract's
 *                                          validateConcern, store it, and return
 *                                          the projectkit `Ack` shape (with a
 *                                          poll_ref for poll-mode callers).
 *   GET  /api/projectkit/concerns/:pollRef serve the poll/Callback shape — a
 *                                          projectkit `Callback` keyed by the
 *                                          dispatched concern_ref.
 *   GET  /healthz                          liveness.
 *   GET  /__captured                       introspection: every envelope + ack
 *                                          this process has seen (for the
 *                                          boundary-test evidence capture).
 *
 * Run:  node server.mjs            (PORT defaults to 8799, HOST to 127.0.0.1)
 *       PORT=8799 HOST=0.0.0.0 node server.mjs
 *
 * Resolve the contract from the published git-ref so this stays a faithful,
 * dependency-light reference adapter:
 *   npm i github:taylorSando/projectkit#v0.7.0   (see package.json here)
 */
import http from 'node:http';
import { validateConcern, validateCallback } from '@operator/projectkit';

const PORT = Number(process.env.PORT || 8799);
const HOST = process.env.HOST || '127.0.0.1';
const ADAPTER = process.env.ADAPTER_NAME || 'echo-dispatch-adapter';

// In-memory ledger: every dispatched envelope + the ack we returned, and the
// synthesized Callback for each accepted concern (served on the poll route).
const captured = []; // { receivedAt, envelope, ack }
const callbacks = new Map(); // poll_ref -> Callback

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, adapter: ADAPTER });
  }

  if (req.method === 'GET' && url.pathname === '/__captured') {
    return json(res, 200, { adapter: ADAPTER, count: captured.length, captured });
  }

  // POLL / CALLBACK shape: serve the Callback for a previously dispatched concern.
  if (req.method === 'GET' && url.pathname.startsWith('/api/projectkit/concerns/')) {
    const pollRef = decodeURIComponent(url.pathname.split('/').pop() || '');
    const cb = callbacks.get(pollRef);
    if (!cb) return json(res, 404, { error: `no callback for poll_ref ${pollRef}` });
    // Fail closed even on the way out: never serve a Callback the contract rejects.
    const problems = validateCallback(cb);
    if (problems.length) return json(res, 500, { error: `internal: invalid callback: ${problems.join('; ')}` });
    return json(res, 200, cb);
  }

  // DISPATCH: accept a DispatchEnvelope, validate, store, return an Ack.
  if (req.method === 'POST' && url.pathname === '/api/projectkit/concerns') {
    let envelope;
    try {
      envelope = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { ok: false, adapter: ADAPTER, error: 'body is not valid JSON' });
    }
    const concerns = Array.isArray(envelope?.concerns) ? envelope.concerns : [];
    if (!concerns.length) {
      return json(res, 400, { ok: false, adapter: ADAPTER, error: 'envelope has no concerns' });
    }
    // Fail closed: every concern must satisfy the published contract.
    for (const c of concerns) {
      const problems = validateConcern(c);
      if (problems.length) {
        return json(res, 422, {
          ok: false,
          adapter: ADAPTER,
          concern_ref: c?.concern_ref,
          error: `invalid concern: ${problems.join('; ')}`,
        });
      }
    }

    const single = concerns.length === 1 ? concerns[0].concern_ref : undefined;
    const pollRef = single ?? `${ADAPTER}:${envelope.delivery_id ?? Date.now()}`;

    // Synthesize an `accepted` Callback so the poll route has something contract-
    // shaped to return. A real executor would run the work and flip this to
    // running/succeeded; the shape is what the boundary test cares about.
    if (single) {
      callbacks.set(pollRef, {
        schema_version: concerns[0].schema_version,
        concern_ref: single,
        status: 'accepted',
        outputs: { adapter: ADAPTER, note: 'accepted by non-mesh echo adapter' },
      });
    }

    // The projectkit `Ack` shape — byte-identical to what mesh returns.
    const ack = {
      ok: true,
      adapter: ADAPTER,
      accepted: concerns.length,
      ...(single ? { concern_ref: single } : {}),
      poll_ref: pollRef,
      status: 200,
    };

    captured.push({ receivedAt: new Date().toISOString(), envelope, ack });

    // Log the Concern we received — this is the boundary-test evidence.
    console.log(
      `[${ADAPTER}] accepted ${concerns.length} concern(s):`,
      JSON.stringify(concerns.map((c) => ({
        schema_version: c.schema_version,
        kind: c.kind,
        concern_ref: c.concern_ref,
        source_event_ref: c.source_event_ref,
        project_key: c.project_key,
        title: c.title,
      })), null, 2),
    );

    return json(res, 200, ack);
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[${ADAPTER}] listening on http://${HOST}:${PORT}`);
  console.log(`[${ADAPTER}] POST /api/projectkit/concerns  GET /api/projectkit/concerns/:pollRef  GET /__captured  GET /healthz`);
});
