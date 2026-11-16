/*
 * 测试价值（放行表第 24 行，Codex 子代理路由）
 * - 可观察结果：生产的 Host Codex 运行时登记线程产品提示时交给回环代理的子代理路由：智能子代理路由
 *   盖上父任务当前推理档位，与桌面 maker-host/index.ts 的同一表达式（withParentReasoningEffort）相同。
 * - 规则依据：桌面 d142106052“恢复 Codex 任务后子代理不再掉回默认推理档位”。
 * - 最小失败输入：不收 reasoningEffort；没有已选档位（字段缺席或空字符串）时盖上一个档。
 * - tier：unit（构造运行时，替换代理的登记函数观察入参；不起代理、不起 Codex、不连网，HOME 隔离）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostProviderConfig } from './provider-config.ts';
import { createHostModelAccess } from './model-access.ts';
import { createHostCodexRuntime } from './codex-runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createCredentialStore } from '../credentials/store.mjs';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts';
import { withParentReasoningEffort } from '../../../desktop/src/main/maker-host/codex-smart-subagent-routing.ts';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout; an explicit bound turns a hang into a failure.
const TEST_TIMEOUT_MS = 120_000;

test('the Host registers smart subagent routes with the parent reasoning effort, as on the desktop', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-codex-routes-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const savedEnv = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });
  process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
  // In-process reads go through os.homedir(), which reads USERPROFILE on Windows.
  const fixtureHome = process.env.HOME;
  t.mock.method(os, 'homedir', () => fixtureHome);
  await fs.mkdir(process.env.HOME);
  for (const key of ['XDT_OFFICIAL_SHARED_PROFILE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XDT_CODEX_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[key];
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile, { recursive: true });
  const ownerId = 'codex-routes-fixture';
  configureHostOwner({ userDataDir: profile, ownerId });
  t.after(() => configureHostOwner({ userDataDir: profile, ownerId: null }));
  configureAppDataDir(path.join(root, 'app-data'));
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  t.after(async () => { clearCurrentDbClient(database); await database.dispose(); });
  const credentials = await createCredentialStore({ userDataDir: profile, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 5)) });
  let modelAccess;
  const config = createHostProviderConfig({ profileDir: profile, ownerId, credentials, getCodexBinary: () => null,
    gatewayConnected: () => Boolean(modelAccess?.gateway.credential), openExternal: async () => { throw new Error('Unexpected browser request'); } });
  t.after(() => config.close());
  // Never contacted: no request leaves this test.
  modelAccess = createHostModelAccess({ ownerId, region: 'global', readKey: () => config.builtinStore.get('xd'),
    writeKey: value => config.builtinStore.set('xd', value), request: async () => ({ endpoint: 'http://127.0.0.1:9', apiKey: 'synthetic-gateway-key' }),
    onKeyChanged: () => {}, publish: () => {} });
  await modelAccess.start();
  t.after(() => modelAccess.close());
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: config.remoteBridgeToken });
  t.after(() => mcp.close());
  const runtime = createHostCodexRuntime({ profileDir: profile, binaryPath: path.join(root, 'no-codex-binary'), config, modelAccess, mcp,
    availabilityPolicy: createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); }), publish: () => {} });
  t.after(() => runtime.close());

  const registered = [];
  runtime.proxy.registerComposed = (...args) => { registered.push(args); };
  const routes = [{ providerId: 'smart-provider', catalogModel: 'smart/model-cheap' }];
  const subagentRoute = { providerId: 'route-provider', catalogModel: 'route-model' };
  // The desktop's expression (maker-host/index.ts registerCodexSystemPromptForThread).
  const desktop = ({ subagentRoute, smartSubagentRoutes, reasoningEffort }) => ({
    ...(subagentRoute ? { subagentRoute } : {}),
    ...(smartSubagentRoutes
      ? { smartSubagentRoutes: withParentReasoningEffort(smartSubagentRoutes, reasoningEffort !== undefined ? reasoningEffort : null) }
      : {}),
  });
  const cases = [
    { smartSubagentRoutes: routes, reasoningEffort: 'xhigh' },
    { smartSubagentRoutes: routes },
    { smartSubagentRoutes: routes, reasoningEffort: '' },
    { smartSubagentRoutes: routes, subagentRoute, reasoningEffort: 'low' },
    { subagentRoute },
    {},
  ];
  for (const [index, extra] of cases.entries()) {
    runtime.deps.registerCodexSystemPromptForThread({ sessionId: `session-${index}`, threadId: `thread-${index}`, text: 'PRODUCT_PROMPT', ...extra });
    assert.deepEqual(registered.at(-1), [`session-${index}`, `thread-${index}`, 'PRODUCT_PROMPT', desktop(extra)], `case ${index}`);
  }
  // What the desktop rule means for the cases that decide it.
  assert.deepEqual(registered[0][3].smartSubagentRoutes, [{ ...routes[0], reasoningEffort: 'xhigh' }]);
  assert.equal(registered[1][3].smartSubagentRoutes.some(route => 'reasoningEffort' in route), false, 'no effort is stamped when none was selected');
  assert.equal(registered[2][3].smartSubagentRoutes.some(route => 'reasoningEffort' in route), false, 'an empty choice is not replaced by a default');
});
