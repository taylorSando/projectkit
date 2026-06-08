import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  createProjectSignal,
  NullSink,
  MemorySink,
  NullDispatchAdapter,
  MemoryDispatchAdapter,
  HttpDispatchAdapter,
  validateConcern,
  validateCallback,
} from '../dist/index.js';

const fixedNow = () => '2026-06-03T20:00:00.000Z';

// --- validateConcern -----------------------------------------------------

test('validateConcern passes a complete concern', () => {
  const concern = {
    schema_version: CONTRACT_VERSION,
    project_key: 'nhl',
    dispatched_at: fixedNow(),
    concern_ref: 'lineup-opt-9f3a',
    kind: 'execute',
    title: "Optimize tonight's lineup",
    summary: 'run the optimizer over the slate',
    inputs: { slate: '2026-06-03' },
    callback: { url: 'https://nhl/cb', mode: 'webhook' },
    priority: 'high',
    sensitivity: 'internal',
  };
  assert.deepEqual(validateConcern(concern), []);
});

test('validateConcern flags every missing required field', () => {
  const problems = validateConcern({});
  for (const k of ['schema_version', 'project_key', 'dispatched_at', 'concern_ref', 'kind', 'title']) {
    assert.ok(
      problems.some((p) => p.includes(k)),
      `expected a problem mentioning ${k}; got: ${problems.join(' | ')}`,
    );
  }
});

test('validateConcern rejects non-object, bad timestamp, bad inputs, and bad callback', () => {
  assert.deepEqual(validateConcern(null), ['concern is not an object']);
  const base = {
    schema_version: CONTRACT_VERSION,
    project_key: 'x',
    concern_ref: 'c1',
    kind: 'execute',
    title: 't',
  };
  assert.ok(validateConcern({ ...base, dispatched_at: 'not-a-date' }).some((p) => /ISO-8601/.test(p)));
  assert.ok(
    validateConcern({ ...base, dispatched_at: fixedNow(), inputs: 'nope' }).some((p) => /inputs/.test(p)),
  );
  assert.ok(
    validateConcern({ ...base, dispatched_at: fixedNow(), callback: 'nope' }).some((p) => /callback/.test(p)),
  );
  assert.ok(
    validateConcern({ ...base, dispatched_at: fixedNow(), callback: { url: 5 } }).some((p) =>
      /callback\.url/.test(p),
    ),
  );
});

// --- validateCallback ----------------------------------------------------

test('validateCallback passes a complete callback', () => {
  const cb = {
    schema_version: CONTRACT_VERSION,
    concern_ref: 'lineup-opt-9f3a',
    status: 'succeeded',
    outputs: { lineup_id: 42 },
    artifacts: [{ kind: 'report', ref: 'path://r.json' }],
    completed_at: fixedNow(),
  };
  assert.deepEqual(validateCallback(cb), []);
});

test('validateCallback flags missing fields, bad status, and bad artifacts', () => {
  const problems = validateCallback({});
  for (const k of ['schema_version', 'concern_ref', 'status']) {
    assert.ok(problems.some((p) => p.includes(k)), `expected a problem mentioning ${k}`);
  }
  assert.deepEqual(validateCallback(null), ['callback is not an object']);
  assert.ok(
    validateCallback({ schema_version: CONTRACT_VERSION, concern_ref: 'c1', status: 'bogus' }).some((p) =>
      /status must be one of/.test(p),
    ),
  );
  assert.ok(
    validateCallback({
      schema_version: CONTRACT_VERSION,
      concern_ref: 'c1',
      status: 'succeeded',
      artifacts: [{ kind: 'pr' }],
    }).some((p) => /artifacts/.test(p)),
  );
});

// --- dispatch through adapters -------------------------------------------

test('dispatch through the default NullDispatchAdapter accepts and drops', async () => {
  // No dispatchAdapter wired → default NullDispatchAdapter → dispatch is OFF but app works.
  const signal = createProjectSignal({ projectKey: 'nhl', sink: new NullSink(), now: fixedNow, strict: true });
  const ack = await signal.dispatch({ concern_ref: 'c1', kind: 'execute', title: 'run' });
  assert.equal(ack.ok, true);
  assert.equal(ack.adapter, 'null');
  assert.equal(ack.accepted, 1);
  assert.equal(ack.concern_ref, 'c1');
});

test('explicit NullDispatchAdapter on batch reports the accepted count', async () => {
  const signal = createProjectSignal({
    projectKey: 'nhl',
    sink: new NullSink(),
    dispatchAdapter: new NullDispatchAdapter(),
    now: fixedNow,
  });
  const ack = await signal.dispatchBatch([
    { concern_ref: 'c1', kind: 'execute', title: 'a' },
    { concern_ref: 'c2', kind: 'research', title: 'b' },
  ]);
  assert.equal(ack.ok, true);
  assert.equal(ack.accepted, 2);
});

test('dispatch routes a typed Concern through an in-memory adapter, SDK-stamped + validated', async () => {
  const adapter = new MemoryDispatchAdapter();
  const signal = createProjectSignal({
    projectKey: 'sitelayer',
    sink: new MemorySink(),
    dispatchAdapter: adapter,
    now: fixedNow,
    strict: true,
  });
  const ack = await signal.dispatch({
    concern_ref: 'takeoff-9f3a',
    kind: 'execute',
    title: 'Run takeoff assembly',
    inputs: { sheet: 3 },
    callback: { mode: 'poll' },
    source_event_ref: 'delivery-abc',
    sensitivity: 'internal',
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.adapter, 'memory');
  assert.equal(adapter.concerns.length, 1);
  const c = adapter.concerns[0];
  assert.equal(c.schema_version, CONTRACT_VERSION);
  assert.equal(c.project_key, 'sitelayer');
  assert.equal(c.dispatched_at, fixedNow());
  assert.equal(c.concern_ref, 'takeoff-9f3a');
  assert.equal(c.kind, 'execute');
  assert.equal(c.source_event_ref, 'delivery-abc');
  assert.deepEqual(validateConcern(c), []);
  // the dispatched envelope carries the contract version + producer.
  const env = adapter.envelopes[0];
  assert.equal(env.contract_version, CONTRACT_VERSION);
  assert.equal(env.project_key, 'sitelayer');
  assert.equal(env.dispatched_at, fixedNow());
  assert.equal(env.concerns.length, 1);
});

test('dispatch in strict mode throws on an invalid concern', async () => {
  const signal = createProjectSignal({
    projectKey: 'x',
    sink: new NullSink(),
    dispatchAdapter: new NullDispatchAdapter(),
    now: fixedNow,
    strict: true,
  });
  await assert.rejects(() => signal.dispatch({ concern_ref: '', kind: '', title: '' }), /invalid concern/);
});

test('emit/log/requestWork still flow through the EventSink unchanged when a dispatchAdapter is wired', async () => {
  const sink = new MemorySink();
  const signal = createProjectSignal({
    projectKey: 'nhl',
    sink,
    dispatchAdapter: new MemoryDispatchAdapter(),
    now: fixedNow,
  });
  await signal.emit({ event_type: 'nhl.lineup.saved', outcome: 'succeeded' });
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].event_type, 'nhl.lineup.saved');
});

// --- HttpDispatchAdapter against an injected fetch stub ------------------

test('HttpDispatchAdapter POSTs the envelope as JSON with injected signer; mesh is just a url', async () => {
  let captured = null;
  const adapter = new HttpDispatchAdapter({
    url: 'https://mesh.example/api/dispatch',
    sign: (body) => ({ 'x-signature': `sig:${body.length}` }),
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 202, json: async () => ({ poll_ref: 'run-123' }) };
    },
  });
  const signal = createProjectSignal({
    projectKey: 'nhl',
    sink: new NullSink(),
    dispatchAdapter: adapter,
    now: fixedNow,
  });
  const ack = await signal.dispatch({ concern_ref: 'c1', kind: 'execute', title: 'run' });
  assert.equal(ack.ok, true);
  assert.equal(ack.status, 202);
  assert.equal(ack.concern_ref, 'c1');
  assert.equal(ack.poll_ref, 'run-123'); // poll handle surfaced from the response body
  assert.equal(captured.url, 'https://mesh.example/api/dispatch');
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.init.headers['x-signature'], /^sig:\d+$/);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.contract_version, CONTRACT_VERSION);
  assert.equal(body.concerns[0].concern_ref, 'c1');
  assert.equal(body.concerns[0].kind, 'execute');
});

test('HttpDispatchAdapter reports failure on non-ok response without throwing', async () => {
  const adapter = new HttpDispatchAdapter({
    url: 'https://x/y',
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  const signal = createProjectSignal({ projectKey: 'x', sink: new NullSink(), dispatchAdapter: adapter, now: fixedNow });
  const ack = await signal.dispatch({ concern_ref: 'c1', kind: 'execute', title: 'run' });
  assert.equal(ack.ok, false);
  assert.equal(ack.status, 500);
  assert.equal(ack.accepted, 0);
});

test('HttpDispatchAdapter requires a url', () => {
  assert.throws(() => new HttpDispatchAdapter({ url: '' }), /requires a url/);
});

// --- buildDispatchEnvelope wire shape ------------------------------------

test('buildDispatchEnvelope produces the standalone DispatchEnvelope wire shape', () => {
  const signal = createProjectSignal({ projectKey: 'nhl', sink: new NullSink(), now: fixedNow });
  const env = signal.buildDispatchEnvelope([
    { concern_ref: 'r1', kind: 'review', title: 'Review lineup optimizer change' },
  ]);
  assert.equal(env.contract_version, CONTRACT_VERSION);
  assert.equal(env.project_key, 'nhl');
  assert.equal(env.dispatched_at, fixedNow());
  assert.equal(env.concerns.length, 1);
  const c = env.concerns[0];
  assert.equal(c.schema_version, CONTRACT_VERSION);
  assert.equal(c.project_key, 'nhl');
  assert.equal(c.dispatched_at, fixedNow());
  assert.equal(c.kind, 'review');
  assert.deepEqual(validateConcern(c), []);
});

// --- schema-mirror-sync check --------------------------------------------

test('the dispatch surface keeps its schema mirrors in sync (concern + callback)', () => {
  const concernSchema = JSON.parse(
    readFileSync(new URL('../schemas/concern.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(concernSchema.title, 'DispatchEnvelope');
  assert.equal(concernSchema.$id, 'https://operator.dev/schemas/concern-1.3.0.json');
  assert.ok(concernSchema.properties.contract_version.enum.includes('1.3.0'));
  for (const req of ['schema_version', 'project_key', 'dispatched_at', 'concern_ref', 'kind', 'title']) {
    assert.ok(concernSchema.$defs.Concern.required.includes(req), `concern schema missing required: ${req}`);
  }

  const callbackSchema = JSON.parse(
    readFileSync(new URL('../schemas/callback.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(callbackSchema.title, 'Callback');
  assert.equal(callbackSchema.$id, 'https://operator.dev/schemas/callback-1.3.0.json');
  for (const req of ['schema_version', 'concern_ref', 'status']) {
    assert.ok(callbackSchema.required.includes(req), `callback schema missing required: ${req}`);
  }
  assert.deepEqual(callbackSchema.properties.status.enum, [
    'accepted',
    'running',
    'succeeded',
    'failed',
    'cancelled',
  ]);
});

test('a Concern built via buildDispatchEnvelope satisfies the concern schema required fields', () => {
  const concernSchema = JSON.parse(
    readFileSync(new URL('../schemas/concern.schema.json', import.meta.url), 'utf8'),
  );
  const signal = createProjectSignal({ projectKey: 'nhl', sink: new NullSink(), now: fixedNow });
  const env = signal.buildDispatchEnvelope([{ concern_ref: 'c1', kind: 'execute', title: 't' }]);
  const c = env.concerns[0];
  for (const req of concernSchema.$defs.Concern.required) {
    assert.ok(req in c, `built concern missing required field: ${req}`);
  }
});

// Regression: the browser's native fetch throws "Illegal invocation" when called
// with a non-global `this`. HttpDispatchAdapter calls `this.fetchImpl(...)`, so it
// MUST bind fetch to the global. strictFetch simulates the browser.
test('HttpDispatchAdapter binds fetch to globalThis (no "Illegal invocation" in the browser)', async () => {
  function strictFetch() {
    if (this !== globalThis) throw new TypeError('Failed to execute \'fetch\': Illegal invocation');
    return new Response(JSON.stringify({ accepted: true, concern_ref: 'cb-bound' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const adapter = new HttpDispatchAdapter({ url: 'https://nhl/dispatch', fetchImpl: strictFetch });
  const ack = await adapter.dispatch({
    schema_version: CONTRACT_VERSION,
    dispatched_at: fixedNow(),
    concerns: [
      {
        schema_version: CONTRACT_VERSION,
        project_key: 'nhl',
        dispatched_at: fixedNow(),
        concern_ref: 'cb-bound',
        kind: 'execute',
        title: 'bind check',
        summary: 'ensure fetch is bound',
        inputs: {},
        callback: { url: 'https://nhl/cb', mode: 'webhook' },
        priority: 'normal',
        sensitivity: 'internal',
      },
    ],
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.accepted, 1);
  assert.equal(ack.concern_ref, 'cb-bound');
});
