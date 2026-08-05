import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findMissingSubmoduleWorkspaceFiles } from '../ensure-deps.mjs';

test('detects an uninitialized protocol submodule before pnpm scans workspaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ensure-deps-'));
  try {
    assert.deepEqual(findMissingSubmoduleWorkspaceFiles(root), [
      'cindy-protocol/packages/device-link-protocol/package.json',
      'cindy-protocol/packages/slack-hook-protocol/package.json',
    ]);

    for (const packageName of ['device-link-protocol', 'slack-hook-protocol']) {
      const packageDir = path.join(root, 'cindy-protocol', 'packages', packageName);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), '{}\n');
    }

    assert.deepEqual(findMissingSubmoduleWorkspaceFiles(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
