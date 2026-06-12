import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION,
  createProjectSignal,
  MemorySink,
  NullSink,
  HttpSink,
  validateWorkRequest,
} from '../dist/index.js';

const fixedNow = () => '2026-06-03T20:00:00.000Z';

test('validateWorkRequest passes a complete request', () => {
  const req = {
    schema_version: CONTRACT_VERSION,
    project_key: 'sitelayer',
    requested_at: fixedNow(),
    request_ref: 'cap-9f3a',
    intent: 'fix',
    title: 'Takeoff scale overlay resets on reload',
    acceptance: ['scale persists across reload'],
    audience: 'steve',
    assignee: 'steve',
    links: ['https://sitelayer/x'],
  };
  assert.deepEqual(validateWorkRequest(req), []);
});

test('validateWorkRequest flags every missing required field', () => {
  const problems = validateWorkRequest({});
  for (const k of ['schema_version', 'project_key', 'requested_at', 'request_ref', 'intent', 'title']) {
    assert.ok(
      problems.some((p) => p.includes(k)),
      `expected a problem mentioning ${k}; got: ${problems.join(' | ')}`,
    );
  }
});

test('validateWorkRequest rejects non-object, bad timestamp, and bad array fields', () => {
  assert.deepEqual(validateWorkRequest(null), ['work request is not an object']);
  const base = {
    schema_version: CONTRACT_VERSION,
    project_key: 'x',
    request_ref: 'r1',
    intent: 'fix',
    title: 't',
  };
  assert.ok(validateWorkRequest({ ...base, requested_at: 'not-a-date' }).some((p) => /ISO-8601/.test(p)));
  assert.ok(
    validateWorkRequest({ ...base, requested_at: fixedNow(), acceptance: [1, 2] }).some((p) =>
      /acceptance/.test(p),
    ),
  );
  assert.ok(
    validateWorkRequest({ ...base, requested_at: fixedNow(), links: 'nope' }).some((p) => /links/.test(p)),
  );
  // v1.4.0 fields fail closed on bad shapes
  assert.ok(
    validateWorkRequest({ ...base, requested_at: fixedNow(), audience: '' }).some((p) => /audience/.test(p)),
  );
  assert.ok(
    validateWorkRequest({ ...base, requested_at: fixedNow(), assignee: 7 }).some((p) => /assignee/.test(p)),
  );
});

test('validateWorkRequest rejects blank idempotency and source refs', () => {
  const base = {
    schema_version: CONTRACT_VERSION,
    project_key: 'x',
    requested_at: fixedNow(),
    request_ref: 'r1',
    intent: 'fix',
    title: 't',
  };
  assert.ok(validateWorkRequest({ ...base, request_ref: '   ' }).some((p) => /request_ref/.test(p)));
  assert.ok(
    validateWorkRequest({ ...base, source_event_ref: '   ' }).some((p) => /source_event_ref/.test(p)),
  );
});

test('requestWork routes a typed request through the SAME EventSink as a *.work.requested event', async () => {
  const sink = new MemorySink();
  const signal = createProjectSignal({ projectKey: 'chess', sink, now: fixedNow, strict: true });
  const res = await signal.requestWork({
    request_ref: 'evt-123',
    intent: 'capture-followup',
    title: 'Investigate puzzle-set 500',
    summary: 'Daily puzzle set returns 500 on load',
    source_event_ref: 'delivery-abc',
    route_path: '/train/puzzles',
    sensitivity: 'internal',
  });
  assert.equal(res.ok, true);
  assert.equal(sink.events.length, 1);
  const ev = sink.events[0];
  assert.equal(ev.event_type, 'chess.work.requested');
  assert.equal(ev.domain, 'workflow_event');
  assert.equal(ev.outcome, 'requested');
  assert.equal(ev.action, 'capture-followup');
  assert.equal(ev.reason, 'delivery-abc');
  assert.equal(ev.route_path, '/train/puzzles');
  // the typed WorkRequest rides in the payload, validated and SDK-stamped
  const wr = ev.payload.work_request;
  assert.equal(wr.schema_version, CONTRACT_VERSION);
  assert.equal(wr.project_key, 'chess');
  assert.equal(wr.requested_at, fixedNow());
  assert.equal(wr.intent, 'capture-followup');
  assert.equal(wr.source_event_ref, 'delivery-abc');
  assert.deepEqual(validateWorkRequest(wr), []);
});

test('requestWork in strict mode throws on an invalid request', async () => {
  const signal = createProjectSignal({ projectKey: 'x', sink: new NullSink(), now: fixedNow, strict: true });
  await assert.rejects(
    () => signal.requestWork({ request_ref: '', intent: '', title: '' }),
    /invalid work request/,
  );
});

test('buildWorkEnvelope produces the standalone WorkRequestEnvelope wire shape', () => {
  const signal = createProjectSignal({ projectKey: 'nhl', sink: new NullSink(), now: fixedNow });
  const env = signal.buildWorkEnvelope([
    { request_ref: 'r1', intent: 'review', title: 'Review lineup optimizer change' },
  ]);
  assert.equal(env.contract_version, CONTRACT_VERSION);
  assert.equal(env.project_key, 'nhl');
  assert.equal(env.emitted_at, fixedNow());
  assert.equal(env.requests.length, 1);
  const r = env.requests[0];
  assert.equal(r.schema_version, CONTRACT_VERSION);
  assert.equal(r.project_key, 'nhl');
  assert.equal(r.requested_at, fixedNow());
  assert.equal(r.intent, 'review');
  assert.deepEqual(validateWorkRequest(r), []);
});

test('requestWork sends to mesh as just-a-URL via HttpSink (the WorkRequest in the body payload)', async () => {
  let captured = null;
  const sink = new HttpSink({
    url: 'https://mesh.example/api/product-trace/ingest',
    sign: (body) => ({ 'x-signature': `sig:${body.length}` }),
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 202 };
    },
  });
  const signal = createProjectSignal({ projectKey: 'learn', sink, now: fixedNow });
  const res = await signal.requestWork({ request_ref: 'r1', intent: 'research', title: 'Spaced-repetition cadence' });
  assert.equal(res.ok, true);
  assert.equal(captured.url, 'https://mesh.example/api/product-trace/ingest');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.contract_version, CONTRACT_VERSION);
  assert.equal(body.events[0].event_type, 'learn.work.requested');
  assert.equal(body.events[0].payload.work_request.intent, 'research');
});

test('the new work surface keeps the schema mirror in sync (work-request.schema.json exists)', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = JSON.parse(
    readFileSync(new URL('../schemas/work-request.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(schema.title, 'WorkRequestEnvelope');
  assert.ok(schema.$defs.WorkRequest.required.includes('request_ref'));
  assert.ok(schema.$defs.WorkRequest.required.includes('intent'));
});
