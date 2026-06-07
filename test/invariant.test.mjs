import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE FAIL-CLOSED INVARIANT (the whole point of the decoupling):
 * projectkit must import NOTHING from control-plane or mesh. A testbed
 * depends on this package; mesh SUBSCRIBES to it. If this test ever goes
 * red, the seam has leaked and the layers have re-coupled.
 */

const FORBIDDEN = [
  /from\s+['"][^'"]*\bmesh\b[^'"]*['"]/,
  /from\s+['"][^'"]*control-plane[^'"]*['"]/,
  /from\s+['"]@operator\/types['"]/, // stay self-contained; don't even pull the old contract pkg
  /require\(\s*['"][^'"]*\b(mesh|control-plane)\b/,
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test('src/ imports nothing from control-plane, mesh, or @operator/types', () => {
  const files = walk(new URL('../src', import.meta.url).pathname);
  assert.ok(files.length > 0, 'expected source files');
  const violations = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) {
      if (re.test(text)) violations.push(`${f} matches ${re}`);
    }
  }
  assert.deepEqual(violations, [], `seam leak — forbidden import found:\n${violations.join('\n')}`);
});

test('package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(deps, [], `projectkit must have zero runtime deps; found: ${deps.join(', ')}`);
});

/**
 * THE PORTABILITY INVARIANT: the published surface (the `files` shipped in the
 * tarball — src, bin, schemas) must carry NO operator-machine coupling. A
 * portable public package cannot bake in a specific home dir, host, tailnet
 * name, or operator-layout path. If this goes red, the package has re-coupled
 * to the operator's machine and is no longer portable.
 *
 * Defaults must come from env/arg/sensible-generic, never a hardcoded operator
 * path or hostname. (test/ is NOT in `files`, so test fixtures here that mention
 * such strings as user-supplied data do not ship — only the dirs below ship.)
 */
const OPERATOR_COUPLING = [
  /\/home\/taylorsando/, // hardcoded operator home
  /~\/projects\//,       // operator's repo-layout assumption baked as a default
  /mesh-hetzner/,        // operator authority host
  /taylor-pc-ubuntu|alienware|beelink|system76|minisforum/, // fleet hostnames
  /\bts\.net\b|\btailnet\b/, // operator tailnet
];

function walkAll(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkAll(p));
    else out.push(p);
  }
  return out;
}

test('published surface (src/bin/schemas/README/CONTRACT) has no operator-machine coupling', () => {
  const root = new URL('../', import.meta.url).pathname;
  const shipped = [
    ...['src', 'bin', 'schemas'].flatMap((d) => walkAll(join(root, d))),
    join(root, 'README.md'),
    join(root, 'CONTRACT.md'),
  ];
  assert.ok(shipped.length > 0, 'expected shipped files');
  const violations = [];
  for (const f of shipped) {
    const text = readFileSync(f, 'utf8');
    for (const re of OPERATOR_COUPLING) {
      if (re.test(text)) violations.push(`${f} matches ${re}`);
    }
  }
  assert.deepEqual(violations, [], `operator-machine coupling in published surface:\n${violations.join('\n')}`);
});
