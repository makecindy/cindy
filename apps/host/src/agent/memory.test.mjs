import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequire } from 'node:module';

import { readMemorySettings, createHostMemoryManager, createHostMemoryMcpProviders, attachAgentsToMakerMemory } from './memory.mjs';
import { configureHostOwner } from './claude-auth.mjs';
import { beginAppSessionBoundary } from '../../../desktop/src/main/appSessionState.ts';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';

const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

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

/**
 * cindy_memory on the Host, called the way an Agent calls it: the provider main.ts registers
 * (createHostMemoryMcpProviders), over MCP, with the review agent attached as main.ts attaches the
 * agent graph. The attached agent counts its one-shot calls: in runReview it is the only way to a
 * model once no auxiliary chain is injected.
 */
async function hostMemoryFixture(t, ownerId) {
  // Real path: a teammate project is recognised from its absolute path, which macOS tmp links hide.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-memory-review-')));
  configureHostOwner({ userDataDir: root, ownerId });
  const manager = createHostMemoryManager({ userDataDir: root, ownerId });
  const oneShots = [];
  attachAgentsToMakerMemory(manager, { 'claude-code': { oneShot: async prompt => { oneShots.push(prompt); return 'merge nothing'; } } });
  const provider = createHostMemoryMcpProviders(manager).find(p => p.name === 'cindy_memory');
  const clients = [];
  t.after(async () => {
    for (const close of clients) await close();
    manager.dispose();
    configureHostOwner({ userDataDir: root, ownerId: null });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const connect = async workingDir => {
    const { instance } = provider.toClaudeSdkConfig({ sessionId: 'task-memory', agentKind: 'claude-code', workingDir });
    const client = new Client({ name: 'host-memory-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), instance.connect(b)]);
    clients.push(async () => { await client.close(); await instance.close(); });
    return (name, args = {}) => client.callTool({ name: 'call_tool', arguments: { name, args } });
  };
  return { root, oneShots, connect };
}

const NOTE = { type: 'project', name: 'release-notes', title: 'Release notes', description: 'Where the release notes live', body: 'docs/release.md' };

// Release table rows 7b and 11: auxiliary model calls on the Host send no paid request. The Host
// did not report the one-shot route disabled, so runReview fell back to the review agent's default
// route (maker-core memory/manager.ts) and sent the memory dump to a model.
// Minimal failing input: one stored memory, then memory_review. Tier: unit (real manager and SQLite
// in a temp profile, in-process MCP).
test('memory_review on the Host reports unavailable and sends no model request', async t => {
  const f = await hostMemoryFixture(t, 'memory-review-owner');
  const workdir = path.join(f.root, 'project');
  fs.mkdirSync(workdir);
  const call = await f.connect(workdir);
  const written = await call('memory_write', NOTE);
  assert.notEqual(written.isError, true, JSON.stringify(written));
  const review = await call('memory_review');
  assert.equal(review.isError, true);
  assert.match(review.content[0].text, /one-shot route for 'claude-code' is disabled/);
  assert.deepEqual(f.oneShots, []);
});

// The desktop maps a scope that is one of this owner's teammate projects to the project's own
// memory folder (maker-memory-host.ts projectMemoryDir); the Host did not bind it, so a Host task
// in that folder stored the memory at the historical place the desktop no longer reads.
// Minimal failing input: a memory_write from a task whose working directory is a teammate project.
test('a memory written from a teammate project lands in the project folder, as on the desktop', async t => {
  const ownerId = 'memory-project-owner';
  const f = await hostMemoryFixture(t, ownerId);
  const workspace = path.join(f.root, 'owners', dataOwnerStorageKey(ownerId), 'bots', 'helper', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const call = await f.connect(workspace);
  const written = await call('memory_write', NOTE);
  assert.notEqual(written.isError, true, JSON.stringify(written));
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.cindy', 'memory')).filter(name => name.endsWith('.md') && name.includes('release-notes')).length, 1);
});
