import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// Unit: production worktree metadata must be loadable by the Node execution
// host. A normal directory must not receive a managed-worktree lease; journal
// placement must use the exact profile injected by that host, without Electron.
test('shared worktree metadata loads under Node and uses the configured Host profile', async () => {
  const { configureUserDataDir, configureAppDataDir } = await import('../../desktop/src/main/userDataPath.ts');
  const profile = path.join(os.tmpdir(), 'cindy-metadata-profile');
  configureUserDataDir(profile);
  configureAppDataDir(path.join(os.tmpdir(), 'cindy-metadata-app-data'));
  const { recycleJournalRoot } = await import('../../desktop/src/main/worktree/recycleJournal.ts');
  const { acquireWorktreeRuntimeLease } = await import('../../desktop/src/main/worktree/runtimeLeases.ts');
  await import('../../desktop/src/main/worktree/piSubagentReferences.ts');
  assert.equal(recycleJournalRoot(), path.join(profile, 'worktree-recycle'));
  assert.equal(await acquireWorktreeRuntimeLease('fixture-task', path.join(os.tmpdir(), 'cindy-unmanaged-project')), null);
});
