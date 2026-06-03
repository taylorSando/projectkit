import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION,
  createProjectSignal,
  MemorySink,
  NullSink,
  HttpSink,
  FanoutSink,
  validateProjectEvent,
  HANDOFF_VERSION,
  newHandoff,
  serializeHandoff,
  parseHandoff,
  validateHandoff,
  handoffToResumePrompt,
  handoffToMarkdown,
} from '../dist/index.js';

const fixedNow = () => '2026-06-03T20:00:00.000Z';

test('contract version is pinned', () => {
  assert.equal(CONTRACT_VERSION, '1.1.0');
});

test('emit materializes a valid wire event through the sink', async () => {
  const sink = new MemorySink();
  const signal = createProjectSignal({ projectKey: 'chess', sink, now: fixedNow, strict: true });
  const res = await signal.emit({ event_type: 'chess.drill.completed', outcome: 'succeeded', count: 3 });
  assert.equal(res.ok, true);
  assert.equal(sink.events.length, 1);
  const ev = sink.events[0];
  assert.equal(ev.schema_version, CONTRACT_VERSION);
  assert.equal(ev.project_key, 'chess');
  assert.equal(ev.event_type, 'chess.drill.completed');
  assert.equal(ev.occurred_at, fixedNow());
  assert.deepEqual(validateProjectEvent(ev), []);
});

test('defaults are merged but never override per-event fields', async () => {
  const sink = new MemorySink();
  const signal = createProjectSignal({
    projectKey: 'nhl',
    sink,
    now: fixedNow,
    defaults: { environment: 'prod', build_sha: 'abc123' },
  });
  await signal.emit({ event_type: 'nhl.lineup.saved', environment: 'staging' });
  const ev = sink.events[0];
  assert.equal(ev.environment, 'staging');
  assert.equal(ev.build_sha, 'abc123');
});

test('strict mode throws on an invalid event', async () => {
  const signal = createProjectSignal({ projectKey: 'x', sink: new NullSink(), now: fixedNow, strict: true });
  await assert.rejects(() => signal.emit({ event_type: '' }), /invalid event/);
});

test('non-strict mode routes validation failure to onError, does not throw', async () => {
  const errors = [];
  const signal = createProjectSignal({
    projectKey: 'x',
    sink: new NullSink(),
    now: fixedNow,
    onError: (r) => errors.push(r),
  });
  const res = await signal.emit({ event_type: '' });
  assert.equal(res.ok, true); // NullSink still accepts; validation surfaced via onError
  assert.ok(errors.some((e) => e.sink === 'validation'));
});

test('capture() wraps a capture envelope in a .page.captured event', async () => {
  const sink = new MemorySink();
  const signal = createProjectSignal({ projectKey: 'sitelayer', sink, now: fixedNow });
  await signal.capture({
    schema_version: '1.0.0',
    url: 'https://sitelayer.com/x',
    page_title: 'X',
    captured_at: fixedNow(),
    host_id: 'h1',
    screenshot_ref: 'path://s.png',
    dom_excerpt: '<div/>',
    selected_text: '',
    picked_element: null,
    network_captures: [],
    library_hints: [],
    operator_intent: 'fix the thing',
    sensitivity: 'internal',
  });
  const ev = sink.events[0];
  assert.equal(ev.event_type, 'sitelayer.page.captured');
  assert.equal(ev.domain, 'capture');
  assert.ok(ev.payload?.capture_envelope);
});

test('HttpSink posts JSON to the configured url with injected signer; mesh is just a url', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 202 };
  };
  const sink = new HttpSink({
    url: 'https://mesh.example/api/product-trace/ingest',
    sign: (body) => ({ 'x-signature': `sig:${body.length}` }),
    fetchImpl: fakeFetch,
  });
  const signal = createProjectSignal({ projectKey: 'learn', sink, now: fixedNow });
  const res = await signal.emit({ event_type: 'learn.reel.viewed' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 202);
  assert.equal(captured.url, 'https://mesh.example/api/product-trace/ingest');
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.init.headers['x-signature'], /^sig:\d+$/);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.contract_version, CONTRACT_VERSION);
  assert.equal(body.events[0].event_type, 'learn.reel.viewed');
});

test('HttpSink reports failure on non-ok response without throwing', async () => {
  const sink = new HttpSink({ url: 'https://x/y', fetchImpl: async () => ({ ok: false, status: 500 }) });
  const signal = createProjectSignal({ projectKey: 'x', sink, now: fixedNow });
  const res = await signal.emit({ event_type: 'x.y' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test('FanoutSink is ok only when every sink is ok', async () => {
  const good = new MemorySink();
  const bad = new HttpSink({ url: 'https://x/y', fetchImpl: async () => ({ ok: false, status: 503 }) });
  const signal = createProjectSignal({ projectKey: 'x', sink: new FanoutSink([good, bad]), now: fixedNow });
  const res = await signal.emit({ event_type: 'x.y' });
  assert.equal(res.ok, false);
  assert.equal(good.events.length, 1); // good sink still got it
});

// --- handoff protocol ----------------------------------------------------

test('handoff round-trips through serialize/parse', () => {
  const h = newHandoff('sitelayer', 'Sitelayer — Agent Handoff', fixedNow);
  h.summary = 'You are taking over Sitelayer.';
  h.environment.hard_rules = ['ALWAYS HOME=/home/taylorsando', 'PROD never auto-deploys'];
  h.live_state = ['origin/main == origin/dev == 4d6df501'];
  h.immediate_task = { title: 'land integrate/env-split', steps: ['git fetch', 'push to main'] };
  h.gotchas = [{ note: 'e2e flakes on this box', severity: 'warn' }];
  h.operator_gated = ['rotate the doadmin DB password'];
  const round = parseHandoff(serializeHandoff(h));
  assert.deepEqual(round, h);
  assert.equal(validateHandoff(round).length, 0);
  assert.equal(round.handoff_version, HANDOFF_VERSION);
});

test('handoff resume prompt derives from structure and includes hard rules + task', () => {
  const h = newHandoff('nhl', 'NHL handoff', fixedNow);
  h.summary = 'Taking over NHL web.';
  h.environment.hard_rules = ['HOME=/home/taylorsando'];
  h.immediate_task = { title: 'ship home redesign', steps: ['npm run build', 'push'] };
  h.gotchas = [{ note: 'union merge drops CSS delimiters', severity: 'blocker' }];
  const prompt = handoffToResumePrompt(h);
  assert.match(prompt, /taking over NHL handoff/i);
  assert.match(prompt, /HOME=\/home\/taylorsando/);
  assert.match(prompt, /ship home redesign/);
  assert.match(prompt, /\[blocker\]/);
});

test('explicit resume_prompt overrides derivation', () => {
  const h = newHandoff('x', 'X', fixedNow);
  h.summary = 's';
  h.resume_prompt = 'CUSTOM PROMPT';
  assert.equal(handoffToResumePrompt(h), 'CUSTOM PROMPT');
});

test('handoff markdown renders the canonical sections', () => {
  const h = newHandoff('x', 'X handoff', fixedNow);
  h.summary = 's';
  h.environment.hard_rules = ['rule1'];
  h.live_state = ['state1'];
  h.gotchas = [{ note: 'g1' }];
  const md = handoffToMarkdown(h);
  assert.match(md, /## 0\. Environment & hard rules/);
  assert.match(md, /## 1\. Live state/);
  assert.match(md, /## 4\. Gotchas/);
});
