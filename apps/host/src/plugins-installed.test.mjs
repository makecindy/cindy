import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listInstalledGhosts } from './plugins-installed.ts';

test('an owner without plugins lists nothing instead of failing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-ghosts-'));
  try {
    const ghosts = await listInstalledGhosts({ userDataDir: root, ownerId: 'owner-a' });
    assert.deepEqual(ghosts, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
