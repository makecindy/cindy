/*
 * 测试价值
 * - 生产入口与可观察结果：createHostAgentGraph 组装出的 PiAgent 实例上 maker-core 实际读取的依赖，
 *   以及按 PiAgent 的调用方式调用 MCP 桥后会话上下文是否完整。
 * - Bug／规则依据：Host 曾把 Pi 的 MCP 桥以 `prepareMcpBridge` 传给 PiAgent，而 PiAgent 只读
 *   `preparePiExtraSpawnConfig`，Host 上的 Pi 任务因此没有进程内 MCP；共享的 Pi 环境函数参数是
 *   (providers, logger, ctx)，PiAgent 按 (providers, ctx) 调用，不能直接挂上。
 * - 现有覆盖缺口：plugins-installed.e2e.mjs 直接调 Host 的桥函数，不经 PiAgent。
 * - 最小失败输入：旧键名；把三参数函数直接挂上；会话上下文落到 logger 位置。
 * - tier：unit（进程内组装，不起子进程、不调模型，单文件约 2 秒；键名的静态约定见
 *   scripts/__tests__/host-agent-deps-contract.test.mjs）。新文件：Host 现有单测都不构造
 *   createHostAgentGraph，这里需要自己的临时 profile 与 owner。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHostAgentGraph } from './runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';

test('the PiAgent the Host assembles gets the MCP bridge under the key it reads, with the session context intact', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-agent-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  // A new temporary profile and owner; no real CLI or account is read.
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-graph-owner' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const graph = createHostAgentGraph({
    userDataDir: profile,
    gateway: null,
    // Never spawned: the test only reads the constructed agent's dependencies.
    piBinaryPath: path.join(profile, 'pi'),
    mcpRuntime: mcp,
    mcpProviders: [],
    storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [],
      readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      piNativeProviders: () => ({ providers: [], env: {} }),
      codexAccounts: { setCodexAccountRetirement: () => {} },
    },
  });
  assert.ok(graph.pi, 'Pi agent assembled');
  assert.equal(graph.pi.deps.prepareMcpBridge, undefined);
  assert.equal(graph.pi.deps.preparePiExtraSpawnConfig, mcp.piDeps.preparePiExtraSpawnConfig);

  // PiAgent calls it as (providers, ctx). The environment records the session's runtime MCP
  // names on ctx.vendorOptions; a context that landed in the logger slot would stay untouched.
  const ctx = { sessionId: 'pi-task', sessionInstanceId: 'pi-instance', workingDir: profile };
  await graph.pi.deps.preparePiExtraSpawnConfig([], ctx);
  assert.deepEqual(ctx.vendorOptions, { cindyRuntimeMcpServerNames: [] });
});
