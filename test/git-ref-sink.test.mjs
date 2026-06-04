import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { CONTRACT_VERSION, HttpSink } from '../dist/index.js';
import { GitRefSink } from '../dist/git-ref-sink.js';

const REF = 'refs/operator/signals';
const FILE = 'signals.jsonl';
const AT = '2026-06-04T12:00:00.000Z';

function gitInitTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'pk-gitref-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
}

function readLog(dir) {
  return execFileSync('git', ['-C', dir, 'cat-file', '-p', `${REF}:${FILE}`], {
    encoding: 'utf8',
  });
}

function commitCount(dir) {
  return execFileSync('git', ['-C', dir, 'rev-list', '--count', REF], {
    encoding: 'utf8',
  }).trim();
}

function makeEnvelope(projectKey, ...eventTypes) {
  return {
    contract_version: CONTRACT_VERSION,
    project_key: projectKey,
    emitted_at: AT,
    producer: { name: 'test', version: '0' },
    events: eventTypes.map((event_type) => ({
      schema_version: CONTRACT_VERSION,
      event_type,
      project_key: projectKey,
      occurred_at: AT,
    })),
  };
}

test('GitRefSink stores the byte-identical envelope HttpSink would POST (boundary test)', async () => {
  const dir = gitInitTmp();
  try {
    const envelope = makeEnvelope('nhl', 'nhl.lineup.saved');

    // Capture exactly what HttpSink (the "to mesh" transport) puts on the wire.
    let httpBody = '';
    const http = new HttpSink({
      url: 'https://mesh.example/api/product-trace/ingest',
      fetchImpl: async (_url, init) => {
        httpBody = init.body;
        return new Response('', { status: 202 });
      },
    });
    const httpRes = await http.deliver(envelope);
    assert.equal(httpRes.ok, true);

    // Deliver the SAME envelope to a git ref instead.
    const git = new GitRefSink({ repoDir: dir });
    const gitRes = await git.deliver(envelope);
    assert.equal(gitRes.ok, true, gitRes.error);
    assert.equal(gitRes.accepted, 1);

    const stored = readLog(dir).trimEnd();

    // THE BOUNDARY TEST: the wire bytes are identical regardless of transport,
    // so mesh-over-HTTP is swappable for a git ref without the producer changing.
    assert.equal(stored, httpBody);
    // …and it round-trips back to the exact envelope.
    assert.deepEqual(JSON.parse(stored), envelope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitRefSink is an append-only log: one commit per delivery, order preserved', async () => {
  const dir = gitInitTmp();
  try {
    const sink = new GitRefSink({ repoDir: dir });
    assert.equal((await sink.deliver(makeEnvelope('chess', 'chess.drill.completed'))).ok, true);
    assert.equal((await sink.deliver(makeEnvelope('chess', 'chess.game.resigned'))).ok, true);

    const lines = readLog(dir).trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).events[0].event_type, 'chess.drill.completed');
    assert.equal(JSON.parse(lines[1]).events[0].event_type, 'chess.game.resigned');
    assert.equal(commitCount(dir), '2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitRefSink survives concurrent writers via CAS retry (no lost events)', async () => {
  const dir = gitInitTmp();
  try {
    // maxRetries generous so 8-way contention never exhausts the loop in CI.
    const sink = new GitRefSink({ repoDir: dir, maxRetries: 100 });
    const n = 8;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => sink.deliver(makeEnvelope('winwar', `winwar.turn.${i}`))),
    );
    assert.ok(
      results.every((r) => r.ok),
      `all deliveries ok: ${results.map((r) => r.error).filter(Boolean).join(' | ')}`,
    );

    const lines = readLog(dir).trimEnd().split('\n');
    assert.equal(lines.length, n, 'every concurrent envelope landed');
    const seen = new Set(lines.map((l) => JSON.parse(l).events[0].event_type));
    for (let i = 0; i < n; i++) {
      assert.ok(seen.has(`winwar.turn.${i}`), `turn ${i} present`);
    }
    assert.equal(commitCount(dir), String(n));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitRefSink reports a clean failure when the dir is not a git repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-nogit-'));
  try {
    const sink = new GitRefSink({ repoDir: dir });
    const res = await sink.deliver(makeEnvelope('sandolab', 'sandolab.sim.ran'));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /git /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
