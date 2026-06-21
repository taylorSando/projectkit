import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NullArtifactSink,
  MemoryArtifactSink,
  HttpArtifactSink,
  FanoutArtifactSink,
  inlineArtifactRef,
} from '../dist/index.js';

// Also reachable via the subpath export, mirroring git-ref-sink / mesh-hmac.
import { HttpArtifactSink as HttpArtifactSinkSubpath } from '../dist/artifact-sink.js';

function makeArtifact(overrides = {}) {
  return {
    kind: 'screenshot',
    sessionId: 'sess-123',
    contentType: 'image/png',
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG magic
    ...overrides,
  };
}

test('inlineArtifactRef formats inline:<kind>:<sessionId>', () => {
  assert.equal(inlineArtifactRef({ kind: 'audio', sessionId: 'abc' }), 'inline:audio:abc');
});

test('NullArtifactSink persists nothing and returns the inline ref (capture-off-safe default)', async () => {
  const sink = new NullArtifactSink();
  const res = await sink.put(makeArtifact({ kind: 'audio', sessionId: 'sX' }));
  assert.equal(res.ok, true);
  assert.equal(res.sink, 'null-artifact');
  assert.equal(res.persistence, 'inline');
  assert.equal(res.ref, 'inline:audio:sX');
});

test('MemoryArtifactSink collects artifacts and returns the inline ref', async () => {
  const sink = new MemoryArtifactSink();
  const a = makeArtifact({ kind: 'video', sessionId: 's1' });
  const res = await sink.put(a);
  assert.equal(res.ok, true);
  assert.equal(res.persistence, 'memory');
  assert.equal(res.ref, 'inline:video:s1');
  assert.equal(sink.artifacts.length, 1);
  assert.equal(sink.artifacts[0], a);
  sink.clear();
  assert.equal(sink.artifacts.length, 0);
});

test('HttpArtifactSink PUTs the raw bytes with the artifact content-type', async () => {
  let captured = null;
  const sink = new HttpArtifactSink({
    url: 'https://blob.example/upload',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response('', { status: 201, headers: { location: 'https://blob.example/o/abc' } });
    },
  });
  const artifact = makeArtifact();
  const res = await sink.put(artifact);

  assert.equal(res.ok, true);
  assert.equal(res.persistence, 'durable');
  assert.equal(res.status, 201);
  // Default ref derivation reads the Location header.
  assert.equal(res.ref, 'https://blob.example/o/abc');
  assert.equal(captured.url, 'https://blob.example/upload');
  assert.equal(captured.init.method, 'PUT'); // default method
  assert.equal(captured.init.headers['content-type'], 'image/png');
  // The exact bytes are sent through unchanged.
  assert.deepEqual(new Uint8Array(captured.init.body), artifact.bytes);
});

test('HttpArtifactSink supports POST and static headers; falls back to url ref without Location', async () => {
  let captured = null;
  const sink = new HttpArtifactSink({
    url: 'https://blob.example/upload',
    method: 'POST',
    headers: { 'x-bucket': 'dock' },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response('', { status: 200 });
    },
  });
  const res = await sink.put(makeArtifact());
  assert.equal(res.ok, true);
  assert.equal(res.persistence, 'durable');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['x-bucket'], 'dock');
  // No Location header → ref falls back to the request URL.
  assert.equal(res.ref, 'https://blob.example/upload');
});

test('HttpArtifactSink injects HMAC headers via sign (never baked in) and signs over the bytes', async () => {
  let captured = null;
  let signedBody = null;
  const sink = new HttpArtifactSink({
    url: 'https://mesh.example/api/artifact/ingest',
    sign: async (body) => {
      signedBody = body;
      return { 'X-Mesh-Signature': 'sha256=deadbeef', 'X-Mesh-Component': 'dock' };
    },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response('', { status: 202 });
    },
  });
  const artifact = makeArtifact({ bytes: new Uint8Array([1, 2, 3, 255]) });
  const res = await sink.put(artifact);

  assert.equal(res.ok, true);
  assert.equal(res.persistence, 'durable');
  assert.equal(captured.init.headers['X-Mesh-Signature'], 'sha256=deadbeef');
  assert.equal(captured.init.headers['X-Mesh-Component'], 'dock');
  // The signer saw a deterministic binary-string view of the exact bytes.
  assert.equal(signedBody, String.fromCharCode(1, 2, 3, 255));
});

test('HttpArtifactSink returns ok:false when the signer throws (fail closed, like HttpSink)', async () => {
  let fetched = false;
  const sink = new HttpArtifactSink({
    url: 'https://mesh.example/ingest',
    sign: async () => {
      throw new Error('no secret');
    },
    fetchImpl: async () => {
      fetched = true;
      return new Response('', { status: 200 });
    },
  });
  const res = await sink.put(makeArtifact());
  assert.equal(res.ok, false);
  assert.equal(res.persistence, 'missing');
  assert.match(res.error ?? '', /sign failed: no secret/);
  assert.equal(fetched, false, 'must not upload when signing fails');
});

test('HttpArtifactSink maps a non-2xx response to ok:false with the status', async () => {
  const sink = new HttpArtifactSink({
    url: 'https://blob.example/upload',
    fetchImpl: async () => new Response('nope', { status: 413 }),
  });
  const res = await sink.put(makeArtifact());
  assert.equal(res.ok, false);
  assert.equal(res.persistence, 'missing');
  assert.equal(res.status, 413);
  assert.match(res.error ?? '', /HTTP 413/);
});

test('HttpArtifactSink fails closed on a ref-only artifact (no bytes to upload)', async () => {
  let fetched = false;
  const sink = new HttpArtifactSink({
    url: 'https://blob.example/upload',
    fetchImpl: async () => {
      fetched = true;
      return new Response('', { status: 200 });
    },
  });
  const res = await sink.put({
    kind: 'audio',
    sessionId: 's9',
    contentType: 'audio/webm',
    ref: 'inline:audio:s9',
  });
  assert.equal(res.ok, false);
  assert.equal(res.persistence, 'missing');
  assert.match(res.error ?? '', /no bytes/);
  assert.equal(fetched, false);
});

test('HttpArtifactSink aborts on timeout and reports a clean failure', async () => {
  const sink = new HttpArtifactSink({
    url: 'https://blob.example/upload',
    timeoutMs: 5,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const res = await sink.put(makeArtifact());
  assert.equal(res.ok, false);
  assert.equal(res.persistence, 'missing');
  assert.match(res.error ?? '', /abort/i);
});

test('HttpArtifactSink throws on missing url', () => {
  assert.throws(() => new HttpArtifactSink({ url: '', fetchImpl: async () => new Response() }), /requires a url/);
});

test('HttpArtifactSink derives its name from the url host by default', () => {
  const sink = new HttpArtifactSink({ url: 'https://blob.example:8080/upload', fetchImpl: async () => new Response() });
  assert.equal(sink.name, 'http-artifact(blob.example:8080)');
});

test('FanoutArtifactSink ok only if ALL succeed; returns the first concrete ref', async () => {
  const mem = new MemoryArtifactSink();
  const http = new HttpArtifactSink({
    url: 'https://blob.example/upload',
    fetchImpl: async () => new Response('', { status: 201, headers: { location: 'https://blob.example/o/z' } }),
  });
  const fan = new FanoutArtifactSink([http, mem]);
  const res = await fan.put(makeArtifact());
  assert.equal(res.ok, true);
  assert.equal(res.persistence, 'durable');
  assert.equal(res.ref, 'https://blob.example/o/z'); // http ref wins (first concrete)
  assert.equal(mem.artifacts.length, 1);
});

test('FanoutArtifactSink reports ok:false when any leg fails', async () => {
  const ok = new NullArtifactSink();
  const bad = new HttpArtifactSink({
    url: 'https://blob.example/upload',
    fetchImpl: async () => new Response('', { status: 500 }),
  });
  const fan = new FanoutArtifactSink([ok, bad]);
  const res = await fan.put(makeArtifact());
  assert.equal(res.ok, false);
  assert.equal(res.persistence, 'missing');
  assert.match(res.error ?? '', /http-artifact.*HTTP 500/);
});

test('subpath export exposes the same HttpArtifactSink class as the barrel', () => {
  assert.equal(HttpArtifactSinkSubpath, HttpArtifactSink);
});

// Regression: the browser's native fetch throws "Illegal invocation" when called
// with a `this` that is not the Window/global. HttpArtifactSink stores fetch as an
// instance field and calls it as `this.fetchImpl(...)`, so it MUST bind to the
// global. strictFetch below simulates the browser by rejecting any non-global `this`.
test('HttpArtifactSink binds fetch to globalThis (no "Illegal invocation" in the browser)', async () => {
  function strictFetch() {
    if (this !== globalThis) throw new TypeError('Failed to execute \'fetch\': Illegal invocation');
    return new Response('', { status: 201, headers: { location: 'https://blob.example/o/bound' } });
  }
  const sink = new HttpArtifactSink({ url: 'https://blob.example/upload', fetchImpl: strictFetch });
  const res = await sink.put(makeArtifact());
  assert.equal(res.ok, true);
  assert.equal(res.ref, 'https://blob.example/o/bound');
});
