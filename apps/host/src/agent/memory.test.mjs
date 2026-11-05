import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readMemorySettings } from './memory.mjs';

/**
 * The toggle decides whether cindy_memory is registered at all, so a corrupt or
 * partial file must fall back to the defaults instead of disabling memory.
 */
test('reads the owner memory settings, defaulting missing or corrupt fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-memory-settings-'));
  try {
    const file = path.join(root, 'memory-settings.json');
    assert.deepEqual(readMemorySettings(root), { maker: true, claudeCode: true, codex: true, pi: true });

    fs.writeFileSync(file, JSON.stringify({ maker: false }));
    assert.deepEqual(readMemorySettings(root), { maker: false, claudeCode: true, codex: true, pi: true });

    fs.writeFileSync(file, '{ not json');
    assert.equal(readMemorySettings(root).maker, true);

    fs.writeFileSync(file, JSON.stringify({ maker: 'yes' }));
    assert.equal(readMemorySettings(root).maker, true, 'a non-boolean is ignored');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
