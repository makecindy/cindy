import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createServer } from 'node:http';
import { Maker, ClaudeCodeAgent, attachAgentsToMakerMemory } from '@cindy/maker-core';
import { getModelUsageSince } from '../../../desktop/src/main/localDb/dailyModelUsage.ts';
import { createOneShotUsageRecorder } from '../../../desktop/src/main/usage/auxiliaryUsage.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
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

// Run the actual Host memory manager -> Maker -> agent -> auxiliary SQLite chain.
// Real SDK HTTP uses a loopback fixture, with no paid provider or CLI process.
test('legacy memory review retains its route and budget while recording observed usage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-memory-usage-'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE auxiliary_usage_receipts (receipt_id TEXT PRIMARY KEY, provider_id TEXT, model TEXT,
    source TEXT, session_id TEXT, transport TEXT, day TEXT, recorded_at INTEGER, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER)`);
  db.exec(`CREATE TABLE daily_model_usage (day TEXT, agent_kind TEXT, model TEXT, cost_usd REAL,
    cost_amount REAL, cost_currency TEXT, cost_is_approximate INTEGER, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER)`);
  let manager, maker; let fail = false; const calls = [];
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture-response', type: 'message', role: 'assistant', model: 'served-memory',
        content: fail ? [] : [{ type: 'text', text: 'review suggestions' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 2 },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const agent = new ClaudeCodeAgent({ binaryPath: 'unused-fixture-cli', runtimeConfig: { endpoint }, logger,
    auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'fixture-key' }),
      getOneShotAuth: async () => ({ apiKey: 'fixture-key', baseURL: endpoint }) },
  });
  const oneShot = agent.oneShot;
  t.mock.method(agent, 'oneShot', function(prompt, options) {
    calls.push({ prompt, options }); return oneShot.call(this, prompt, options);
  });
  try {
    configureHostOwner({ userDataDir: root, ownerId: 'memory-owner' });
    setCurrentDbClient({ drizzle: drizzle(db), query: async (sql, params) => db.prepare(sql).all(...params) }, 'memory-owner');
    manager = createHostMemoryManager({ userDataDir: root, ownerId: 'memory-owner', getMaker: () => maker ?? null });
    maker = new Maker({ agents: { 'claude-code': agent }, storage: {}, logger, createOneShotUsageRecorder });
    attachAgentsToMakerMemory(manager, { 'claude-code': agent });
    if (!manager.isEnabled()) await manager.enable({ skipAgentSync: true });
    await manager.write(root, { type: 'user', name: 'preference', title: 'Preference', description: 'Durable preference', body: 'Keep it.' });
    assert.equal((await manager.runReview(root)).suggestions, 'review suggestions');
    fail = true;
    await assert.rejects(manager.runReview(root), /Empty response from model/);
    assert.equal(calls.length, 2);
    for (const { prompt, options } of calls) {
      assert.ok(prompt.includes('Keep it.'));
      assert.equal(options.source, 'memory-review');
      assert.equal(options.maxTokens, 800); assert.equal(options.timeoutMs, 60000);
      assert.equal(options.model, undefined, 'no route/model override introduced');
    }
    const rows = db.prepare('SELECT source,model,input_tokens,cache_read_tokens,output_tokens FROM auxiliary_usage_receipts').all();
    assert.deepEqual(rows, [1, 2].map(() => ({ source: 'memory-review', model: 'served-memory', input_tokens: 60, cache_read_tokens: 40, output_tokens: 2 })));
    const read = () => getModelUsageSince('0000-01-01');
    const total = rows => rows.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens + r.cacheCreateTokens + r.outputTokens, 0);
    const projected = await read();
    assert.equal(total(projected), 204, 'real Usage SQL reader equals raw receipt total');
    assert.equal(projected.reduce((n, r) => n + r.requestCount, 0), 2);
    assert.ok(projected.every(r => r.source === 'memory-review' && r.model === 'served-memory'));
    assert.equal(total(await read()), 204, 'reading never inserts receipts');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM auxiliary_usage_receipts').get().n, 2);
  } finally {
    manager?.dispose(); await agent.dispose(); clearCurrentDbClient(); db.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    configureHostOwner({ userDataDir: root, ownerId: null });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
