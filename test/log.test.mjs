import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  createProjectSignal,
  MemorySink,
  NullSink,
  HttpSink,
  validateLogRecord,
} from '../dist/index.js';

const fixedNow = () => '2026-06-03T20:00:00.000Z';

test('validateLogRecord passes a complete record', () => {
  const rec = {
    schema_version: CONTRACT_VERSION,
    project_key: 'sitelayer',
    occurred_at: fixedNow(),
    level: 'error',
    message: 'QBO sync failed',
    logger: 'worker.qbo',
    error_code: 'E_TIMEOUT',
    fields: { company: 'la-operations' },
  };
  assert.deepEqual(validateLogRecord(rec), []);
});

test('validateLogRecord flags every missing required field', () => {
  const problems = validateLogRecord({});
  for (const k of ['schema_version', 'project_key', 'occurred_at', 'level', 'message']) {
    assert.ok(
      problems.some((p) => p.includes(k)),
      `expected a problem mentioning ${k}; got: ${problems.join(' | ')}`,
    );
  }
});

test('validateLogRecord rejects non-object, bad level, bad timestamp, and bad fields', () => {
  assert.deepEqual(validateLogRecord(null), ['log record is not an object']);
  const base = {
    schema_version: CONTRACT_VERSION,
    project_key: 'x',
    occurred_at: fixedNow(),
    message: 'm',
  };
  assert.ok(validateLogRecord({ ...base, level: 'verbose' }).some((p) => /level must be one of/.test(p)));
  assert.ok(
    validateLogRecord({ ...base, level: 'info', occurred_at: 'not-a-date' }).some((p) =>
      /ISO-8601/.test(p),
    ),
  );
  assert.ok(
    validateLogRecord({ ...base, level: 'info', fields: 'nope' }).some((p) => /fields/.test(p)),
  );
});

test('log() routes a typed record through the SAME EventSink as a *.log event', async () => {
  const sink = new MemorySink();
  const signal = createProjectSignal({ projectKey: 'chess', sink, now: fixedNow, strict: true });
  const res = await signal.log('info', 'puzzle set loaded', { set: 500 });
  assert.equal(res.ok, true);
  assert.equal(sink.events.length, 1);
  const ev = sink.events[0];
  assert.equal(ev.event_type, 'chess.log');
  assert.equal(ev.domain, 'diagnostic');
  assert.equal(ev.action, 'info');
  assert.equal(ev.summary, 'puzzle set loaded');
  // the typed LogRecord rides in the payload, validated and SDK-stamped
  const lr = ev.payload.log_record;
  assert.equal(lr.schema_version, CONTRACT_VERSION);
  assert.equal(lr.project_key, 'chess');
  assert.equal(lr.occurred_at, fixedNow());
  assert.equal(lr.level, 'info');
  assert.deepEqual(lr.fields, { set: 500 });
  assert.deepEqual(validateLogRecord(lr), []);
});

test('log() at error/fatal classifies the event as runtime_error/failed', async () => {
  const sink = new MemorySink();
  const signal = createProjectSignal({ projectKey: 'sitelayer', sink, now: fixedNow });
  await signal.log('error', 'sync failed');
  await signal.log('fatal', 'process exiting');
  for (const ev of sink.events) {
    assert.equal(ev.domain, 'runtime_error');
    assert.equal(ev.outcome, 'failed');
  }
});

test('log() is inert under NullSink (logging off, app keeps working)', async () => {
  const signal = createProjectSignal({ projectKey: 'x', sink: new NullSink(), now: fixedNow });
  const res = await signal.log('debug', 'noop');
  assert.equal(res.ok, true);
  assert.equal(res.sink, 'null');
});

test('log() in strict mode throws on an invalid level', async () => {
  const signal = createProjectSignal({ projectKey: 'x', sink: new NullSink(), now: fixedNow, strict: true });
  await assert.rejects(() => signal.log('verbose', 'm'), /invalid log record/);
});

test('buildLogEnvelope produces the standalone LogEnvelope wire shape', () => {
  const signal = createProjectSignal({ projectKey: 'nhl', sink: new NullSink(), now: fixedNow });
  const env = signal.buildLogEnvelope([{ level: 'warn', message: 'lineup optimizer slow' }]);
  assert.equal(env.contract_version, CONTRACT_VERSION);
  assert.equal(env.project_key, 'nhl');
  assert.equal(env.emitted_at, fixedNow());
  assert.equal(env.records.length, 1);
  const r = env.records[0];
  assert.equal(r.schema_version, CONTRACT_VERSION);
  assert.equal(r.project_key, 'nhl');
  assert.equal(r.occurred_at, fixedNow());
  assert.equal(r.level, 'warn');
  assert.deepEqual(validateLogRecord(r), []);
});

test('log() ships to mesh as just-a-URL via HttpSink (the LogRecord in the body payload)', async () => {
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
  const res = await signal.log('info', 'reel viewed', { reel: 7 });
  assert.equal(res.ok, true);
  assert.equal(captured.url, 'https://mesh.example/api/product-trace/ingest');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.contract_version, CONTRACT_VERSION);
  assert.equal(body.events[0].event_type, 'learn.log');
  assert.equal(body.events[0].payload.log_record.level, 'info');
});

test('the new log surface keeps the schema mirror in sync (log-record.schema.json exists)', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../schemas/log-record.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(schema.title, 'LogEnvelope');
  assert.equal(schema.$id, 'https://operator.dev/schemas/log-record-1.4.0.json');
  assert.ok(schema.$defs.LogRecord.required.includes('level'));
  assert.ok(schema.$defs.LogRecord.required.includes('message'));
  assert.deepEqual(schema.$defs.LogRecord.properties.level.enum, ['debug', 'info', 'warn', 'error', 'fatal']);
  assert.deepEqual(schema.properties.contract_version.enum, ['1.2.0', '1.3.0', '1.4.0']);
});
