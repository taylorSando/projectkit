// Fail-closed doc-drift guard: CONTRACT.md must state the SAME wire version the
// code ships. The header drifted once (said 1.3.0 while src/contract.ts shipped
// 1.4.0 for three days); this test makes that class of drift impossible to land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION } from '../dist/index.js';

const contractMd = readFileSync(
  fileURLToPath(new URL('../CONTRACT.md', import.meta.url)),
  'utf8',
);

test('CONTRACT.md header version equals CONTRACT_VERSION from src/contract.ts', () => {
  const firstLine = contractMd.split('\n', 1)[0];
  const m = firstLine.match(/^# projectkit contract — v(\d+\.\d+\.\d+)\s*$/);
  assert.ok(m, `CONTRACT.md first line must be '# projectkit contract — vX.Y.Z' (got: ${JSON.stringify(firstLine)})`);
  assert.equal(
    m[1],
    CONTRACT_VERSION,
    `CONTRACT.md header says wire v${m[1]} but src/contract.ts ships CONTRACT_VERSION ${CONTRACT_VERSION} — update the doc (header + migration log)`,
  );
});

test('CONTRACT.md intro states the current wire version and mirror path', () => {
  assert.ok(
    contractMd.includes(`The **wire contract is \`${CONTRACT_VERSION}\`**`),
    `CONTRACT.md intro must state the wire contract is ${CONTRACT_VERSION}`,
  );
  assert.ok(
    contractMd.includes(`*-${CONTRACT_VERSION}.json`),
    `CONTRACT.md must point at the mesh vendored mirrors for ${CONTRACT_VERSION} (*-${CONTRACT_VERSION}.json)`,
  );
});
