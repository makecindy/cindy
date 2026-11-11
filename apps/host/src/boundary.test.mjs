import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(mjs|ts)$/.test(entry.name) && !entry.name.endsWith('.test.mjs') ? [full] : [];
  });
}

test('host sources never import Electron', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1] ?? match[2];
      if (spec === 'electron' || spec.startsWith('electron/')) {
        offenders.push(`${path.relative(srcDir, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `host must not depend on Electron:\n${offenders.join('\n')}`);
});

// Architecture invariants §5: the production send factory must load in Node,
// otherwise wiring it into Host prevents startup. The existing Host-source scan
// misses transitive imports such as mcp-apps/runtime -> sandboxProtocol -> Electron.
// Minimal input: load the factory without Electron shims or a desktop profile.
// Tier: Host unit; real module loading, no subprocess, network or account access.
// Standalone file: 0.72 s on macOS (2026-11-11), using the Host test loader.
test('shared send transaction loads in Node without a desktop runtime', async () => {
  const { createMakerSendTransaction } = await import('../../desktop/src/main/maker-ipc/makerSendTransaction.ts');
  assert.equal(typeof createMakerSendTransaction, 'function');
});
