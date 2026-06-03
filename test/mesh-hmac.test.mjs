// mesh-hmac.test.mjs — pins projectkit's meshHmacSigner byte-for-byte to the
// cross-implementation fixture shared with console/gateway/lib/mesh-hmac.js and
// the Go verifier (mesh/core/hmac_auth_middleware.go). If the signature pin ever
// fails, Web Crypto diverged from openssl/Go on HMAC — investigate the algorithm
// side, not this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { meshHmacSigner, sha256Hex, meshCanonicalString } from '../dist/mesh-hmac.js';

const SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'; // 32 bytes 0x00..0x1f

test('sha256Hex of empty body matches the well-known constant', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('meshCanonicalString assembles the four-tuple in mesh order', async () => {
  assert.equal(
    await meshCanonicalString({ timestamp: '1700000000', method: 'GET', path: '/api/health', body: '' }),
    '1700000000.GET./api/health.e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('meshHmacSigner pins byte-for-byte to the Go-verifier fixture', async () => {
  const sign = meshHmacSigner({ component: 'gateway', secretHex: SECRET, method: 'GET', path: '/api/health', now: () => 1700000000 });
  const headers = await sign('');
  assert.equal(headers['X-Mesh-Component'], 'gateway');
  assert.equal(headers['X-Mesh-Timestamp'], '1700000000');
  assert.equal(headers['X-Mesh-Signature'], 'sha256=2607a5d2f5ab88e26ef27887507364259807c15cefa68eafec53b30569fafea0');
});

test('meshHmacSigner: empty vs non-empty body produce different signatures', async () => {
  const opts = { component: 'gateway', secretHex: SECRET, method: 'POST', path: '/api/x', now: () => 1700000000 };
  const a = await meshHmacSigner(opts)('');
  const b = await meshHmacSigner(opts)('{"k":"v"}');
  assert.notEqual(a['X-Mesh-Signature'], b['X-Mesh-Signature']);
});

test('meshHmacSigner rejects missing component / missing secret / undersized secret', () => {
  assert.throws(() => meshHmacSigner({ component: '', secretHex: SECRET, path: '/x' }), /component is required/);
  assert.throws(() => meshHmacSigner({ component: 'c', secretHex: '', path: '/x' }), /secretHex is required/);
  assert.throws(() => meshHmacSigner({ component: 'c', secretHex: '00'.repeat(16), path: '/x' }), /expected >= 32/);
});
