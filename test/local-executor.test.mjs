import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { CONTRACT_VERSION, HttpDispatchAdapter, validateCallback, validateConcern } from '../dist/index.js';
import { meshHmacSigner } from '../dist/mesh-hmac.js';
import { createLocalExecutor, concernPollRef } from '../bin/local-executor.mjs';

/**
 * local-executor — the SECOND REAL (non-mesh) dispatch backend.
 *
 * These tests prove, executably, the One-Line Boundary Test against an actual
 * backend: the same Concern dispatched through HttpDispatchAdapter at
 * local-executor and at a mock mesh door produces identical Concern / Ack /
 * Callback SHAPES — only the adapter URL changes. Plus contract-shape checks
 * against the vendored JSON schemas, real process execution (spawn + async
 * completion), idempotency, and the optional HMAC gate.
 */

const fixedNow = '2026-06-09T20:00:00.000Z';

const concernSchema = JSON.parse(readFileSync(new URL('../schemas/concern.schema.json', import.meta.url), 'utf8'));
const callbackSchema = JSON.parse(readFileSync(new URL('../schemas/callback.schema.json', import.meta.url), 'utf8'));

// --- minimal vendored-schema validators (zero deps, like the rest of the repo) --

/** Assert `cb` satisfies schemas/callback.schema.json (required + enum + types). */
function assertMatchesCallbackSchema(cb, label) {
  for (const req of callbackSchema.required) {
    assert.ok(req in cb, `${label}: callback missing schema-required field: ${req}`);
  }
  assert.ok(
    callbackSchema.properties.status.enum.includes(cb.status),
    `${label}: callback status ${JSON.stringify(cb.status)} not in schema enum`,
  );
  assert.equal(typeof cb.schema_version, 'string', `${label}: schema_version must be a string`);
  assert.ok(cb.concern_ref.length >= 1, `${label}: concern_ref minLength 1`);
  if ('outputs' in cb) assert.equal(typeof cb.outputs, 'object', `${label}: outputs must be an object`);
  if ('artifacts' in cb) {
    assert.ok(Array.isArray(cb.artifacts), `${label}: artifacts must be an array`);
    for (const a of cb.artifacts) {
      for (const req of callbackSchema.properties.artifacts.items.required) {
        assert.ok(typeof a[req] === 'string' && a[req].length >= 1, `${label}: artifact.${req} required`);
      }
    }
  }
  if ('completed_at' in cb) {
    assert.ok(!Number.isNaN(Date.parse(cb.completed_at)), `${label}: completed_at must be a date-time`);
  }
  // belt-and-suspenders: the TS validator agrees with the JSON schema
  assert.deepEqual(validateCallback(cb), [], `${label}: validateCallback rejects it`);
}

/** Assert `env` satisfies schemas/concern.schema.json (envelope + every Concern). */
function assertMatchesConcernSchema(env, label) {
  for (const req of concernSchema.required) {
    assert.ok(req in env, `${label}: envelope missing schema-required field: ${req}`);
  }
  // envelope is additionalProperties:false — no key outside the schema may appear
  for (const key of Object.keys(env)) {
    assert.ok(key in concernSchema.properties, `${label}: envelope key ${key} not allowed by schema`);
  }
  assert.ok(
    concernSchema.properties.contract_version.enum.includes(env.contract_version),
    `${label}: contract_version not in schema enum`,
  );
  for (const c of env.concerns) {
    for (const req of concernSchema.$defs.Concern.required) {
      assert.ok(req in c, `${label}: concern missing schema-required field: ${req}`);
    }
    assert.deepEqual(validateConcern(c), [], `${label}: validateConcern rejects it`);
  }
}

// --- fixtures ---------------------------------------------------------------

function fixtureConcern(overrides = {}) {
  return {
    schema_version: CONTRACT_VERSION,
    project_key: 'winwar',
    dispatched_at: fixedNow,
    concern_ref: overrides.concern_ref ?? 'wi-boundary-0001',
    kind: 'execute',
    title: 'Fix the report threshold drift',
    summary: 'reportThresholds returns stale bands after the engine update',
    inputs: { route_path: '/reports', severity: 'high' },
    priority: 'high',
    sensitivity: 'internal',
    source_event_ref: 'evt-capture-77',
    ...overrides,
  };
}

function fixtureEnvelope(concern) {
  return {
    contract_version: CONTRACT_VERSION,
    project_key: concern.project_key,
    dispatched_at: fixedNow,
    producer: { name: 'winwar', version: 'test' },
    concerns: [concern],
    delivery_id: concern.concern_ref,
  };
}

async function pollUntilTerminal(baseUrl, pollRef, { headers = {}, attempts = 100 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${baseUrl}/api/projectkit/concerns/${pollRef}`, { headers });
    assert.equal(res.status, 200, `poll HTTP ${res.status}`);
    const cb = await res.json();
    if (['succeeded', 'failed', 'cancelled'].includes(cb.status)) return cb;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`concern ${pollRef} never reached a terminal Callback`);
}

async function withExecutor(opts, fn) {
  const executor = createLocalExecutor({ quiet: true, env: {}, ...opts });
  const addr = await executor.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl, executor);
  } finally {
    await executor.close();
  }
}

/**
 * A mock of MESH'S dispatch door, mirroring mesh/core/server_projectkit_dispatch.go
 * shapes exactly: Ack {ok, adapter:"mesh", accepted, status:202, concern_ref,
 * poll_ref} on POST (HTTP 202, same deterministic poll_ref derivation) and the
 * Callback shape on GET — a completed task with outputs lifted from output_data.
 * This stands in for the real mesh in the swap test so the test runs hermetic.
 */
function startMockMeshDoor() {
  const tasks = new Map(); // poll_ref -> { concern }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mesh.mock');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && url.pathname === '/api/projectkit/concerns') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const env = JSON.parse(body);
        const c = env.concerns[0];
        const pollRef = concernPollRef(env.project_key, c.concern_ref);
        tasks.set(pollRef, { concern: c });
        send(202, {
          ok: true,
          adapter: 'mesh',
          accepted: env.concerns.length,
          status: 202,
          ...(env.concerns.length === 1 ? { concern_ref: c.concern_ref } : {}),
          ...(env.concerns.length === 1 ? { poll_ref: pollRef } : {}),
        });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/projectkit/concerns/')) {
      const pollRef = url.pathname.slice('/api/projectkit/concerns/'.length);
      const task = tasks.get(pollRef);
      if (!task) return send(404, { error: 'no concern for that poll_ref' });
      // a COMPLETED mesh task: buildProjectkitCallbackForTask shape
      return send(200, {
        schema_version: CONTRACT_VERSION,
        concern_ref: task.concern.concern_ref,
        status: 'succeeded',
        outputs: { stdout: 'mesh task output', exit_code: 0, command: 'mesh-task' },
        completed_at: new Date().toISOString(),
      });
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// --- contract-shape: Concern in -> Callback out, against the vendored schemas --

test('local-executor: Concern in -> Ack + terminal Callback out, all schema-valid', async () => {
  await withExecutor({}, async (baseUrl) => {
    const concern = fixtureConcern();
    const envelope = fixtureEnvelope(concern);
    assertMatchesConcernSchema(envelope, 'dispatched envelope');

    const adapter = new HttpDispatchAdapter({ url: `${baseUrl}/api/projectkit/concerns` });
    const ack = await adapter.dispatch(envelope);
    assert.equal(ack.ok, true);
    assert.equal(ack.status, 202);
    assert.equal(ack.accepted, 1);
    assert.equal(ack.concern_ref, concern.concern_ref);
    assert.equal(ack.poll_ref, concernPollRef(concern.project_key, concern.concern_ref));

    const cb = await pollUntilTerminal(baseUrl, ack.poll_ref);
    assertMatchesCallbackSchema(cb, 'local-executor callback');
    assert.equal(cb.status, 'succeeded');
    assert.equal(cb.concern_ref, concern.concern_ref);
    // the default stub REALLY ran: its echo wrapped the concern title
    assert.match(cb.outputs.stdout, /local-executor stub: Fix the report threshold drift/);
    assert.equal(cb.outputs.exit_code, 0);
  });
});

test('local-executor REALLY executes: custom command sees the concern, async completion', async () => {
  await withExecutor(
    { cmd: 'printf "ran %s kind=%s\\n::artifact::report::file://out-%s.txt\\n" "$CONCERN_REF" "$CONCERN_KIND" "$CONCERN_REF"' },
    async (baseUrl, executor) => {
      const concern = fixtureConcern({ concern_ref: 'wi-exec-42' });
      const adapter = new HttpDispatchAdapter({ url: `${baseUrl}/api/projectkit/concerns` });
      const ack = await adapter.dispatch(fixtureEnvelope(concern));
      assert.equal(ack.ok, true);

      const cb = await pollUntilTerminal(baseUrl, ack.poll_ref);
      assertMatchesCallbackSchema(cb, 'exec callback');
      assert.equal(cb.status, 'succeeded');
      assert.match(cb.outputs.stdout, /ran wi-exec-42 kind=execute/);
      assert.deepEqual(cb.artifacts, [{ kind: 'report', ref: 'file://out-wi-exec-42.txt' }]);
      // a real process was spawned exactly once
      assert.equal(executor.records.get(ack.poll_ref).spawnCount, 1);
    },
  );
});

test('local-executor: failing command -> Callback failed with exit code + stderr', async () => {
  await withExecutor({ cmd: 'echo "partial work"; echo "boom: disk on fire" >&2; exit 3' }, async (baseUrl) => {
    const adapter = new HttpDispatchAdapter({ url: `${baseUrl}/api/projectkit/concerns` });
    const concern = fixtureConcern({ concern_ref: 'wi-fails-1' });
    const ack = await adapter.dispatch(fixtureEnvelope(concern));
    const cb = await pollUntilTerminal(baseUrl, ack.poll_ref);
    assertMatchesCallbackSchema(cb, 'failed callback');
    assert.equal(cb.status, 'failed');
    assert.equal(cb.outputs.exit_code, 3);
    assert.match(cb.error, /command exited 3/);
    assert.match(cb.error, /disk on fire/);
  });
});

test('local-executor dedupes retries on concern_ref: same Concern never runs twice', async () => {
  await withExecutor({ cmd: 'echo once' }, async (baseUrl, executor) => {
    const adapter = new HttpDispatchAdapter({ url: `${baseUrl}/api/projectkit/concerns` });
    const concern = fixtureConcern({ concern_ref: 'wi-idem-1' });
    const ack1 = await adapter.dispatch(fixtureEnvelope(concern));
    const ack2 = await adapter.dispatch(fixtureEnvelope(concern)); // retry
    assert.equal(ack1.poll_ref, ack2.poll_ref);
    await pollUntilTerminal(baseUrl, ack1.poll_ref);
    assert.equal(executor.records.get(ack1.poll_ref).spawnCount, 1, 'retry must not respawn');
  });
});

test('local-executor rejects malformed input with mesh-door Ack shapes', async () => {
  await withExecutor({}, async (baseUrl) => {
    const url = `${baseUrl}/api/projectkit/concerns`;
    const post = (body) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

    let res = await post('{nope');
    assert.equal(res.status, 400);
    res = await post(JSON.stringify({ contract_version: '9.0.0', project_key: 'x', concerns: [fixtureConcern()] }));
    assert.equal(res.status, 422);
    res = await post(JSON.stringify({ contract_version: CONTRACT_VERSION, project_key: 'x', concerns: [] }));
    assert.equal(res.status, 400);
    // an invalid concern in a batch is SKIPPED, not a batch failure (mesh parity)
    res = await post(
      JSON.stringify({
        contract_version: CONTRACT_VERSION,
        project_key: 'winwar',
        dispatched_at: fixedNow,
        producer: { name: 'winwar' },
        concerns: [{ bogus: true }, fixtureConcern({ concern_ref: 'wi-batch-ok' })],
      }),
    );
    assert.equal(res.status, 202);
    const ack = await res.json();
    assert.equal(ack.accepted, 1);
  });
});

test('local-executor HMAC gate (opt-in): unsigned 401, meshHmacSigner-signed 202', async () => {
  const secretHex = 'aa'.repeat(32);
  await withExecutor({ hmacSecretHex: secretHex, hmacComponent: 'winwar-relay' }, async (baseUrl) => {
    const url = `${baseUrl}/api/projectkit/concerns`;
    const concern = fixtureConcern({ concern_ref: 'wi-hmac-1' });
    const envelope = fixtureEnvelope(concern);

    // unsigned -> 401 (the same fail-closed wording the mesh door uses)
    const unsigned = new HttpDispatchAdapter({ url });
    const nack = await unsigned.dispatch(envelope);
    assert.equal(nack.ok, false);
    assert.equal(nack.status, 401);

    // signed with the published meshHmacSigner -> accepted: HMAC is INJECTED,
    // never baked in; the same signer works against mesh and the local executor.
    const signed = new HttpDispatchAdapter({
      url,
      sign: meshHmacSigner({ component: 'winwar-relay', secretHex, path: '/api/projectkit/concerns' }),
    });
    const ack = await signed.dispatch(envelope);
    assert.equal(ack.ok, true);
    assert.equal(ack.status, 202);

    // the poll GET is gated too; sign it the way nhl's mesh-dispatch.sh does
    const bare = await fetch(`${baseUrl}/api/projectkit/concerns/${ack.poll_ref}`);
    assert.equal(bare.status, 401);
    const signGet = meshHmacSigner({
      component: 'winwar-relay',
      secretHex,
      path: `/api/projectkit/concerns/${ack.poll_ref}`,
      method: 'GET',
    });
    const cb = await pollUntilTerminal(baseUrl, ack.poll_ref, { headers: await signGet('') });
    assertMatchesCallbackSchema(cb, 'hmac-gated callback');
  });
});

// --- THE ONE-LINE BOUNDARY TEST against a REAL second backend -----------------

test('ONE-LINE BOUNDARY TEST: swap mesh for local-executor — only the adapter URL changes; Concern/Ack/Callback shapes identical', async () => {
  const mesh = await startMockMeshDoor();
  try {
    await withExecutor({ cmd: 'echo "mesh task output"' }, async (localBase) => {
      const concern = fixtureConcern({ concern_ref: 'wi-swap-0001' });
      const envelope = fixtureEnvelope(concern);

      // THE SWAP: two HttpDispatchAdapters, identical construction, ONE line differs.
      const viaLocal = new HttpDispatchAdapter({ url: `${localBase}/api/projectkit/concerns`, name: 'x' });
      const viaMesh = new HttpDispatchAdapter({ url: `${mesh.baseUrl}/api/projectkit/concerns`, name: 'x' });

      const ackLocal = await viaLocal.dispatch(envelope);
      const ackMesh = await viaMesh.dispatch(envelope);

      // the dispatched Concern/envelope satisfied the SAME vendored schema both times
      assertMatchesConcernSchema(envelope, 'swap envelope');

      // Ack: identical key SET and identical values on every contract field.
      assert.deepEqual(Object.keys(ackLocal).sort(), Object.keys(ackMesh).sort(), 'Ack key sets differ');
      assert.equal(ackLocal.ok, ackMesh.ok);
      assert.equal(ackLocal.status, ackMesh.status);
      assert.equal(ackLocal.accepted, ackMesh.accepted);
      assert.equal(ackLocal.concern_ref, ackMesh.concern_ref);
      // even the opaque poll handle is the same deterministic derivation
      assert.equal(ackLocal.poll_ref, ackMesh.poll_ref);

      // Callback: poll BOTH backends to a terminal Callback; same shape, same keys.
      const cbLocal = await pollUntilTerminal(localBase, ackLocal.poll_ref);
      const cbMeshRes = await fetch(`${mesh.baseUrl}/api/projectkit/concerns/${ackMesh.poll_ref}`);
      const cbMesh = await cbMeshRes.json();
      assertMatchesCallbackSchema(cbLocal, 'swap local callback');
      assertMatchesCallbackSchema(cbMesh, 'swap mesh callback');
      assert.deepEqual(Object.keys(cbLocal).sort(), Object.keys(cbMesh).sort(), 'Callback key sets differ');
      assert.equal(cbLocal.schema_version, cbMesh.schema_version);
      assert.equal(cbLocal.concern_ref, cbMesh.concern_ref);
      assert.equal(cbLocal.status, cbMesh.status);
      assert.deepEqual(Object.keys(cbLocal.outputs).sort(), Object.keys(cbMesh.outputs).sort());
      assert.equal(cbLocal.outputs.stdout.trim(), cbMesh.outputs.stdout.trim());
    });
  } finally {
    await mesh.close();
  }
});

// --- poll handle parity with mesh ---------------------------------------------

test('concernPollRef mirrors mesh: deterministic, opaque, pkc_-prefixed, url-safe', () => {
  const a = concernPollRef('winwar', 'wi-1');
  const b = concernPollRef('winwar', 'wi-1');
  const c = concernPollRef('winwar', 'wi-2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^pkc_[A-Za-z0-9_-]+$/);
  assert.ok(!a.includes('winwar') && !a.includes('wi-1'), 'poll_ref must stay opaque');
});
