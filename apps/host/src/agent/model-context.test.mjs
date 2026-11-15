/*
 * 测试价值
 * - 生产入口与可观察结果：createHostModelContext().getSelectableCatalog() 给 Host 三个引擎和 Codex
 *   代理的目录。
 * - 规则依据与「以哪边为准」：桌面 getDesktopSelectableCatalog（createDesktopProviderService.ts）是
 *   用户能选的目录——先按账号过滤（没有 Cindy 账号时去掉 Cindy AI），再做订阅账号池投影。任务应按
 *   用户能选到的目录解析，所以以桌面为准。Host 之前只做旧上下文档位过滤，两边在没有云账号时不同：
 *   Host 仍给出 Cindy AI。
 * - 最小失败输入：本地模式（没有 Cindy 账号）时 Host 目录里仍有 `xd`；有云账号时把 `xd` 过滤掉。
 * - tier：unit（进程内，临时 profile 与 owner；订阅池投影本身见 desktop
 *   subscriptionPoolCatalog.test.ts）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostModelContext } from './model-context.ts';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.ts';
import { filterLegacyGptContextProfiles } from '../../../desktop/src/main/maker-host/legacy-context-profiles.ts';
import { commitVolatileAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const context = () => createHostModelContext({
  readGatewayKey: () => null, hasCodexOAuthLogin: () => false, codexAccountState: () => ({ authenticated: false }),
});

test('the Host catalog follows the desktop account filter: Cindy AI only with a Cindy account', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-model-context-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  assert.ok(filterLegacyGptContextProfiles(getActiveCatalog()).providers.some(provider => provider.id === 'xd'),
    'the active catalog has Cindy AI');

  configureHostOwner({ userDataDir: profile, ownerId: 'model-context-cloud' });
  assert.ok(context().getSelectableCatalog().providers.some(provider => provider.id === 'xd'));

  // An account-free local owner, as in the desktop's local mode (Host never runs signed out).
  commitVolatileAppSession('local');
  const local = context().getSelectableCatalog();
  assert.equal(local.providers.some(provider => provider.id === 'xd'), false);
  assert.ok(local.providers.length > 0, 'other providers stay selectable');
});
