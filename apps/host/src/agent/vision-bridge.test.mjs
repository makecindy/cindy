/*
 * 测试价值
 * - 生产入口与可观察结果：createHostAgentGraph 组装出的视觉桥（放行表第 5 行）：Maker 拿到钩子、
 *   Pi 拿到环境函数，进程级 controller 在图建成后设置、图关闭时清掉；Host 运行时收尾时关闭它。
 * - 规则依据：桌面 maker-host/index.ts 的视觉桥接线；行为与桌面的对照在
 *   apps/desktop/src/main/vision-bridge/__tests__/hostVisionBridgeParity.test.ts。
 * - tier：unit（只构造实例，不起子进程、不调模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHostAgentGraph } from './runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

const providerConfig = {
  grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
  list: async () => [], readKey: () => null,
  oauth: { readCachedGenericOAuthAccessToken: () => null },
  codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false, codexAccountState: () => ({ authenticated: false }) },
};

test('the Host graph hands the vision bridge to Maker and Pi and owns the controller until it closes', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-vision-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'vision-graph-owner' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const { getVisionBridgeController } = await import('../../../desktop/src/main/vision-bridge/vision-bridge-controller.ts');
  const graph = createHostAgentGraph({
    userDataDir: profile, harnessRoot: fixtureHarnessRoot(profile), gateway: null,
    piBinaryPath: path.join(profile, 'pi'), mcpRuntime: mcp, mcpProviders: [], storage: {}, providerConfig,
  });
  assert.equal(graph.maker.visionBridge, graph.visionBridge.hook);
  assert.equal(graph.pi.deps.resolvePiVisionBridgeEnv, graph.visionBridge.resolvePiVisionBridgeEnv);
  assert.ok(getVisionBridgeController(), 'the controller is set once Maker exists');
  graph.visionBridge.close();
  assert.equal(getVisionBridgeController(), null);
});

