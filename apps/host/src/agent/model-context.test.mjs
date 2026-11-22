/*
 * 测试价值
 * - 生产入口与可观察结果：createHostModelContext().getSelectableCatalog() 给 Host 三个引擎和 Codex
 *   代理的目录；hostedProviderOffersModel() 的实际推理准入也必须遵守同一账号过滤。
 * - 规则依据与「以哪边为准」：桌面 getDesktopSelectableCatalog（createDesktopProviderService.ts）是
 *   用户能选的目录——先按账号过滤（没有 Cindy 账号时去掉 Cindy AI），再做订阅账号池投影。任务应按
 *   用户能选到的目录解析，所以以桌面为准。Host 之前只做旧上下文档位过滤，两边在没有云账号时不同：
 *   Host 仍给出 Cindy AI。仅检查选择器不能发现推理 guard 仍读取未过滤目录的问题。
 * - 最小失败输入：本地模式、仍有效的托管授权，以及目录里一个可用的 Cindy AI 模型；
 *   旧推理 reader 放行，正确的 Host 装配拒绝，而云账号可正常使用。
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
import { getActiveCatalog, getXdGatewayModels, setXdGatewayModels } from '../../../desktop/src/main/maker-host/active-catalog.ts';
import { filterLegacyGptContextProfiles } from '../../../desktop/src/main/maker-host/legacy-context-profiles.ts';
import { commitVolatileAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { hostedProviderOffersModel, setGuestProviderModelCatalogReader } from '../../../desktop/src/main/maker-host/guest-provider-route-store.ts';
import { bindHostedSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const context = () => createHostModelContext({
  readGatewayKey: () => null, hasCodexOAuthLogin: () => false, codexAccountState: () => ({ authenticated: false }),
});

test('Host selection and hosted inference follow the desktop account filter', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-model-context-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  t.after(() => setGuestProviderModelCatalogReader(getActiveCatalog));
  assert.ok(filterLegacyGptContextProfiles(getActiveCatalog()).providers.some(provider => provider.id === 'xd'),
    'the active catalog has Cindy AI');

  configureHostOwner({ userDataDir: profile, ownerId: 'model-context-cloud' });
  const previous = getXdGatewayModels();
  t.after(() => setXdGatewayModels(previous));
  setXdGatewayModels([{ id: 'deepseek/deepseek-v4-flash', agents: ['codex'] }]);
  const gatewayModel = getActiveCatalog().providers.find(provider => provider.id === 'xd')
    ?.models.codex?.find(model => !model.disabled);
  assert.ok(gatewayModel, 'the fixture publishes an enabled gateway model');
  assert.ok(context().getSelectableCatalog().providers.some(provider => provider.id === 'xd'));
  const binding = bindHostedSessionProvider('model-context-guest', 'xd', () => true);
  t.after(() => binding.release());
  assert.equal(hostedProviderOffersModel('model-context-guest', 'xd', 'codex', gatewayModel.id), true);

  // An account-free local owner, as in the desktop's local mode (Host never runs signed out).
  commitVolatileAppSession('local');
  setGuestProviderModelCatalogReader(getActiveCatalog);
  assert.equal(hostedProviderOffersModel('model-context-guest', 'xd', 'codex', gatewayModel.id), true,
    'the old unfiltered reader still offers the gateway model');
  const local = context().getSelectableCatalog();
  assert.equal(local.providers.some(provider => provider.id === 'xd'), false);
  assert.ok(local.providers.length > 0, 'other providers stay selectable');
  assert.equal(hostedProviderOffersModel('model-context-guest', 'xd', 'codex', gatewayModel.id), false,
    'a valid session grant cannot bypass the current owner account filter');
});
