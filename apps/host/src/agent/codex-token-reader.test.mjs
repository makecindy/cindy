/*
 * 测试价值（放行表第 19 行丙 4，Codex 的 OAuth 令牌读取）
 * - 可观察结果：Host 交给 CodexAgent 的 createCodexAuthTokenReader：先经本引擎的鉴权适配器取 oauth-bearer
 *   状态（Host 适配器里含作废标记、与系统登录对账、恢复要求），已登录才读凭据；每次读取都核对 owner、
 *   区域与本引擎运行时，跨 await 核对 owner 范围。
 * - 规则依据：桌面 maker-host/index.ts 的同一段（逐行比较在 hostDesktopSourceContracts.guard.test.ts，只换三个端口）。
 * - 最小失败输入：不经 getState 直接读；未登录也读；owner、区域、运行时或会话边界变化后仍返回令牌。
 * - tier：unit（真实 app session 状态，假适配器与凭据；不读真实登录，不连网）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHostCodexAuthTokenReader } from './codex-token-reader.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { beginAppSessionBoundary, commitVolatileAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

const TEST_TIMEOUT_MS = 60_000;

/** A temporary profile for the app session state; the owner is committed per case below. */
function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-codex-reader-'));
  configureHostOwner({ userDataDir: dir, ownerId: 'reader-owner' });
  t.after(() => { configureHostOwner({ userDataDir: dir, ownerId: null }); fs.rmSync(dir, { recursive: true, force: true }); });
}

function fixture() {
  const facts = { state: { authenticated: true, authSource: 'oauth' }, creds: { accessToken: 'synthetic-token', accountId: 'synthetic-account' },
    agentCurrent: true, realm: 'global', duringGetState: () => {} };
  const calls = { getState: [], readOneShotCreds: [] };
  const reader = createHostCodexAuthTokenReader({
    codexAuthAdapter: { async getState(opts) { calls.getState.push(opts); facts.duringGetState(); return facts.state; } },
    readOneShotCreds: providerId => { calls.readOneShotCreds.push(providerId); return facts.creds; },
    isCodexAgentCurrent: () => facts.agentCurrent,
    readAuthRealm: () => facts.realm,
  });
  return { facts, calls, reader };
}

test('the Codex token reader reads the login only through an authenticated oauth-bearer state', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  profile(t);
  commitVolatileAppSession('cloud', 'reader-owner', true);
  const f = fixture();
  const read = f.reader('codex-account');
  assert.deepEqual(await read(), { accessToken: 'synthetic-token', chatgptAccountId: 'synthetic-account' });
  assert.deepEqual(f.calls.getState, [{ credentialMode: 'oauth-bearer', providerId: 'codex-account' }]);
  assert.deepEqual(f.calls.readOneShotCreds, ['codex-account']);
  // An invalidated or missing login: no credential read at all.
  f.facts.state = { authenticated: false, errorReason: 'token_revoked' };
  await assert.rejects(read(), /Codex account credentials are unavailable/);
  assert.equal(f.calls.readOneShotCreds.length, 1);
  // A login without its account id is unavailable, as on the desktop.
  f.facts.state = { authenticated: true, authSource: 'oauth' };
  f.facts.creds = null;
  await assert.rejects(read(), /Codex account credentials are unavailable/);
});

test('every read is fenced to the owner, the realm, this agent and the session boundary', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  profile(t);
  const owner = () => commitVolatileAppSession('cloud', 'reader-owner', true);
  const changed = /Codex authentication owner changed/;
  owner();
  let f = fixture();
  let read = f.reader();
  commitVolatileAppSession('cloud', 'another-owner', true);
  await assert.rejects(read(), changed, 'another owner');
  owner(); f = fixture(); read = f.reader();
  f.facts.realm = 'cn';
  await assert.rejects(read(), changed, 'another realm');
  owner(); f = fixture(); read = f.reader();
  f.facts.agentCurrent = false;
  await assert.rejects(read(), changed, 'a replaced Codex agent');
  owner(); f = fixture(); read = f.reader();
  const release = beginAppSessionBoundary();
  try { await assert.rejects(read(), changed, 'a pending session boundary'); } finally { release(); }
  // The owner changes while the state is read: no credential is read.
  owner(); f = fixture(); read = f.reader();
  f.facts.duringGetState = () => commitVolatileAppSession('cloud', 'another-owner', true);
  await assert.rejects(read(), changed, 'an owner change across the await');
  assert.equal(f.calls.readOneShotCreds.length, 0);
  // The realm or the agent changes while the state is read (the owner scope does not): no read.
  owner(); f = fixture(); read = f.reader();
  f.facts.duringGetState = () => { f.facts.realm = 'cn'; };
  await assert.rejects(read(), changed, 'a realm change across the await');
  owner(); f = fixture(); read = f.reader();
  f.facts.duringGetState = () => { f.facts.agentCurrent = false; };
  await assert.rejects(read(), changed, 'an agent replaced across the await');
  assert.equal(f.calls.readOneShotCreds.length, 0);
  // The same owner with a new scope generation (Ghost repair) keeps the reader but fences that read.
  owner(); f = fixture(); read = f.reader();
  f.facts.duringGetState = () => commitVolatileAppSession('cloud', 'reader-owner', true);
  await assert.rejects(read(), changed, 'a scope change across the await');
});

