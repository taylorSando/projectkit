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
