import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readMemorySettings, createHostMemoryManager } from './memory.mjs';
import { configureHostOwner } from './claude-auth.mjs';
import { beginAppSessionBoundary } from '../../../desktop/src/main/appSessionState.ts';

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

// The old Host wired a constant owner/generation: a retained MCP call could
// still open the outgoing owner's memory during sign-out or after switching.
// Unit: call the real factory's getStore under a boundary, then another owner;
// rejection must precede creating either owner's SQLite or storage directory.
test('memory retained by an old task cannot reopen storage across an account boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-memory-boundary-'));
  let manager, release;
  try {
    configureHostOwner({ userDataDir: root, ownerId: 'memory-owner-a' });
    manager = createHostMemoryManager({ userDataDir: root, ownerId: 'memory-owner-a' });
    release = beginAppSessionBoundary();
    await assert.rejects(manager.getStore(root), /not.ready|owner/i);
    configureHostOwner({ userDataDir: root, ownerId: 'memory-owner-b' });
    release(); release = null;
    await assert.rejects(manager.getStore(root), /not.ready|owner/i);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    release?.(); manager?.dispose();
    configureHostOwner({ userDataDir: root, ownerId: null });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
