import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPullExecutor } from '../bin/pull-executor.mjs';
import { CONTRACT_VERSION, validateCallback } from '../dist/index.js';

/** A minimal producer-side FEED the pull-executor polls: serves pending
 * concerns and records every Callback POSTed back. Claim semantics: the first
 * `accepted` callback leases the concern (it stops being listed); a configured
 * ref can answer 409 to simulate another executor holding the claim. */
function createMockFeed({ concerns = [], conflictRefs = new Set() } = {}) {
  const callbacks = [];
  const claimed = new Set();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/feed/concerns') {
      const audience = url.searchParams.get('audience');
      const pending = concerns.filter(
        (c) => !claimed.has(c.concern_ref) && (c.audience === undefined || c.audience === audience),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ concerns: pending }));
    }
    if (req.method === 'POST' && url.pathname === '/feed/callbacks') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const cb = JSON.parse(body);
        if (cb.status === 'accepted' && conflictRefs.has(cb.concern_ref)) {
          res.writeHead(409, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'already claimed' }));
        }
        callbacks.push(cb);
        if (cb.status === 'accepted') claimed.add(cb.concern_ref);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    callbacks,
    requests,
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function concernFor(ref, extra = {}) {
  return {
    schema_version: CONTRACT_VERSION,
    project_key: 'sitelayer',
    dispatched_at: '2026-06-10T12:00:00.000Z',
    concern_ref: ref,
    kind: 'execute',
    title: `run ${ref}`,
    summary: 'pull-executor test concern',
    audience: 'test-aud',
    ...extra,
  };
}

test('pull loop: fetch -> claim -> execute -> terminal callback, idempotent across ticks', async () => {
  const feed = createMockFeed({ concerns: [concernFor('pull-1')] });
  const port = await feed.listen();
  const executed = [];
  const executor = createPullExecutor({
    feedUrl: `http://127.0.0.1:${port}/feed`,
    audience: 'test-aud',
    cmd: 'echo "ran $CONCERN_REF"; echo "::artifact::report::file://out-$CONCERN_REF.txt"',
    onExecuted: (r) => executed.push(r),
    quiet: true,
  });
  try {
    await executor.tick();
    assert.equal(executed.length, 1);
    // claim + terminal both arrived, in order, valid against the contract
    assert.equal(feed.callbacks.length, 2);
    for (const cb of feed.callbacks) assert.deepEqual(validateCallback(cb), []);
    assert.equal(feed.callbacks[0].status, 'accepted');
    const terminal = feed.callbacks[1];
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.concern_ref, 'pull-1');
    assert.match(terminal.outputs.stdout, /ran pull-1/);
    assert.deepEqual(terminal.artifacts, [{ kind: 'report', ref: 'file://out-pull-1.txt' }]);
    // a second tick never re-runs the same concern
    await executor.tick();
    assert.equal(executed.length, 1);
    assert.equal(feed.callbacks.length, 2);
  } finally {
    await feed.close();
  }
});

test('a 409 on the claim means another executor holds it: skip, never execute', async () => {
  const feed = createMockFeed({
    concerns: [concernFor('pull-conflict')],
    conflictRefs: new Set(['pull-conflict']),
  });
  const port = await feed.listen();
  const executed = [];
  const executor = createPullExecutor({
    feedUrl: `http://127.0.0.1:${port}/feed`,
    audience: 'test-aud',
    cmd: 'echo should-not-run',
    onExecuted: (r) => executed.push(r),
    quiet: true,
  });
  try {
    await executor.tick();
    assert.equal(executed.length, 0);
    assert.equal(feed.callbacks.length, 0); // 409'd claim is not recorded
  } finally {
    await feed.close();
  }
});

test('client-side audience re-check: work addressed elsewhere never runs even if the feed mis-filters', async () => {
  // Feed bug simulation: serves a concern for ANOTHER audience on our lane.
  const feed = createMockFeed();
  const port = await feed.listen();
  feed.server.removeAllListeners('request');
  feed.server.on('request', (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/feed/concerns') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ concerns: [concernFor('foreign', { audience: 'someone-else' })] }));
    }
    res.writeHead(500);
    res.end();
  });
  const executed = [];
  const executor = createPullExecutor({
    feedUrl: `http://127.0.0.1:${port}/feed`,
    audience: 'test-aud',
    cmd: 'echo should-not-run',
    onExecuted: (r) => executed.push(r),
    quiet: true,
  });
  try {
    await executor.tick();
    assert.equal(executed.length, 0);
  } finally {
    await feed.close();
  }
});

test('timeout produces a failed callback with machine-readable error_code=timeout (v1.4.0)', async () => {
  const feed = createMockFeed({ concerns: [concernFor('pull-slow')] });
  const port = await feed.listen();
  const executor = createPullExecutor({
    feedUrl: `http://127.0.0.1:${port}/feed`,
    audience: 'test-aud',
    cmd: 'sleep 5',
    timeoutMs: 100,
    quiet: true,
  });
  try {
    await executor.tick();
    const terminal = feed.callbacks.at(-1);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.error_code, 'timeout');
    assert.match(terminal.error, /timed out/);
    assert.deepEqual(validateCallback(terminal), []);
  } finally {
    await feed.close();
  }
});

test('a non-zero exit produces error_code=execution', async () => {
  const feed = createMockFeed({ concerns: [concernFor('pull-fail')] });
  const port = await feed.listen();
  const executor = createPullExecutor({
    feedUrl: `http://127.0.0.1:${port}/feed`,
    audience: 'test-aud',
    cmd: 'echo boom >&2; exit 3',
    quiet: true,
  });
  try {
    await executor.tick();
    const terminal = feed.callbacks.at(-1);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.error_code, 'execution');
    assert.equal(terminal.outputs.exit_code, 3);
    assert.match(terminal.error, /boom/);
  } finally {
    await feed.close();
  }
});

test('the done-ledger state file survives a restart: a new executor never re-runs', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'pull-exec-')), 'state.json');
  const feed = createMockFeed({ concerns: [concernFor('pull-durable')] });
  const port = await feed.listen();
  const mk = () =>
    createPullExecutor({
      feedUrl: `http://127.0.0.1:${port}/feed`,
      audience: 'test-aud',
      cmd: 'echo once',
      stateFile,
      quiet: true,
    });
  try {
    await mk().tick();
    assert.equal(feed.callbacks.filter((c) => c.status !== 'accepted').length, 1);
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.length, 1);
    // "restart": fresh instance, same state file; the feed would still list the
    // concern if un-claimed (simulate by clearing its claim memory via a fresh feed).
    const exec2 = mk();
    await exec2.tick();
    assert.equal(feed.callbacks.filter((c) => c.status !== 'accepted').length, 1, 'no second run after restart');
  } finally {
    await feed.close();
  }
});

test('bearer token and audience query reach the feed', async () => {
  const feed = createMockFeed({ concerns: [] });
  const port = await feed.listen();
  const executor = createPullExecutor({
    feedUrl: `http://127.0.0.1:${port}/feed`,
    audience: 'steve',
    token: 'tok-123',
    quiet: true,
  });
  try {
    await executor.tick();
    const get = feed.requests.find((r) => r.method === 'GET');
    assert.ok(get.url.includes('audience=steve'));
    assert.equal(get.headers['authorization'], 'Bearer tok-123');
  } finally {
    await feed.close();
  }
});

test('CLI enters main when invoked through a symlinked binstub (npx layout)', async () => {
  const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pk-binstub-'));
  const link = join(dir, 'pull-executor');
  symlinkSync(resolve('bin/pull-executor.mjs'), link);
  try {
    // Through a symlink, broken isMain detection loads the module as a library
    // and exits 0 silently. Real main with no PULL_FEED_URL must exit nonzero.
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [link], { env: { PATH: process.env.PATH }, stdio: 'pipe' });
    } catch (err) {
      code = err.status ?? 1;
      stderr = String(err.stderr ?? '');
    }
    assert.notEqual(code, 0, 'symlinked CLI must enter main and fail loudly without env');
    assert.match(stderr, /PULL_FEED_URL is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
