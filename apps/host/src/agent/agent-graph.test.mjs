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
import { fileURLToPath } from 'node:url';

import { createHostAgentGraph } from './runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

// CI installs no agent binaries; the Pi config resolves ripgrep when the agent is built.
function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

test('the PiAgent the Host assembles gets the MCP bridge under the key it reads, with the session context intact', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-agent-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  // A new temporary profile and owner; no real CLI or account is read.
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-graph-owner' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const graph = createHostAgentGraph({
    userDataDir: profile,
    harnessRoot: fixtureHarnessRoot(profile),
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
      codexAccounts: { setCodexAccountRetirement: () => {} },
    },
  });
  assert.ok(graph.pi, 'Pi agent assembled');
  assert.equal(graph.pi.deps.prepareMcpBridge, undefined);
  assert.equal(graph.pi.deps.preparePiExtraSpawnConfig, mcp.piDeps.preparePiExtraSpawnConfig);

  // Pi packages: the deps Pi receives are the Host's package store and managed mutation (pi-packages.ts),
  // the same functions the desktop parity test (hostPiPackagesParity) drives.
  for (const key of ['resolvePiManagedPackageResources', 'resolvePiNativePackagePaths', 'mutatePiManagedPackage', 'onPiManagedPackageMutationSettled']) {
    assert.equal(graph.pi.deps[key], graph.piPackages.deps[key], key);
  }
  graph.piPackages.close();

  // PiAgent calls it as (providers, ctx). The environment records the session's runtime MCP
  // names on ctx.vendorOptions; a context that landed in the logger slot would stay untouched.
  const ctx = { sessionId: 'pi-task', sessionInstanceId: 'pi-instance', workingDir: profile };
  await graph.pi.deps.preparePiExtraSpawnConfig([], ctx);
  assert.deepEqual(ctx.vendorOptions, { cindyRuntimeMcpServerNames: [] });
});

/*
 * 测试价值（第二条）
 * - 可观察结果：Host 组装出的三个引擎实例上，maker-core 读取的按模型解析依赖（上下文上限、输出上限、
 *   核实窗口、思考档位、Codex 线程窗口）存在，且对目录里的真实模型给出目录声明的值。
 * - 规则依据：桌面三个构造点一直注入这些依赖（maker-host/index.ts、pi-host.ts，现经
 *   engineModelResolvers.ts）；Host 之前一个都没给，Claude 与 Pi 用引擎默认窗口，压缩时机与桌面不同。
 * - 最小失败输入：任一引擎缺这些依赖（旧装配）。
 * - tier：unit（只构造实例，不起子进程、不调模型）。
 */
test('every engine the Host assembles resolves per-model context the way the desktop does', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { getActiveCatalog } = await import('../../../desktop/src/main/maker-host/active-catalog.ts');
  const { filterLegacyGptContextProfiles } = await import('../../../desktop/src/main/maker-host/legacy-context-profiles.ts');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-agent-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-graph-resolvers' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const graph = createHostAgentGraph({
    userDataDir: profile,
    harnessRoot: fixtureHarnessRoot(profile),
    gateway: null,
    // Never spawned: the test only reads the constructed agents' dependencies.
    binaryPath: path.join(profile, 'claude'),
    codexBinaryPath: path.join(profile, 'codex'),
    piBinaryPath: path.join(profile, 'pi'),
    mcpRuntime: mcp,
    mcpProviders: [],
    storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [],
      readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false },
    },
  });
  const catalog = filterLegacyGptContextProfiles(getActiveCatalog());
  const routed = (agent) => {
    for (const provider of catalog.providers) {
      if (provider.routing[agent]?.disabled === true) continue;
      const model = (provider.models[agent] ?? []).find(entry => Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0);
      if (model) return { providerId: provider.id, model };
    }
    return null;
  };
  for (const [kind, agent] of [['claude-code', graph.agent], ['codex', graph.codex]]) {
    const deps = agent.deps;
    for (const key of ['resolveModelContextLimit', 'resolveModelCompactionPct', 'resolveVerifiedContextWindow']) {
      assert.equal(typeof deps[key], 'function', `${kind} ${key}`);
    }
    const target = routed(kind);
    assert.ok(target, `the catalog routes a ${kind} model`);
    if (kind === 'claude-code') {
      assert.equal(deps.resolveModelContextLimit(target.providerId, target.model.id), target.model.contextWindow);
      assert.equal(typeof deps.resolveModelMaxOutputTokens, 'function');
      assert.equal(typeof deps.resolveModelEfforts, 'function');
    } else {
      // Codex: the CLI limit is only an explicit setting; the thread window falls back to the catalog.
      assert.equal(deps.resolveModelContextLimit(target.providerId, target.model.id), null);
      assert.equal(deps.resolveCodexThreadContextWindow(target.providerId, target.model.id), target.model.contextWindow);
      assert.equal(typeof deps.resolveCodexContextWindowInfo, 'function');
    }
  }
  assert.equal(typeof graph.pi.deps.resolveModelContextLimit, 'function');
  assert.equal(typeof graph.pi.deps.resolveModelCompactionPct, 'function');
  // The desktop start hook's Host steps run for every start (start-options.ts, tested there).
  assert.equal(typeof graph.maker.lifecycleHooks?.prepareStartOptions, 'function');
  assert.equal(typeof graph.maker.lifecycleHooks?.onBeforeStart, 'function');

  // Model lists derived from the selectable catalog, and the desktop's capability routing.
  const { deriveAvailableModels } = await import('../../../desktop/src/main/maker-host/catalog-to-descriptors.ts');
  const { DESKTOP_CAPABILITY_ROUTING_POLICY } = await import('../../../desktop/src/main/maker-host/capability-routing.ts');
  for (const [kind, agent] of [['claude-code', graph.agent], ['codex', graph.codex], ['pi', graph.pi]]) {
    const expected = deriveAvailableModels(catalog, kind).map(model => model.id);
    assert.ok(expected.length > 0, `the catalog has ${kind} models`);
    assert.deepEqual(agent.capabilities.availableModels.map(model => model.id), expected, `${kind} model list`);
  }
  assert.equal(graph.agent.deps.capabilityRouting, DESKTOP_CAPABILITY_ROUTING_POLICY);
  assert.equal(typeof Object.getOwnPropertyDescriptor(graph.codex.deps, 'capabilityRouting')?.get, 'function',
    'Codex routing stays a getter, evaluated after the MCP bridge is prepared');
  assert.equal(typeof graph.codex.deps.resolveCapabilityRouting, 'function');

  // Turn change record (Claude and Pi) and the Codex product-prompt marker, as on the desktop.
  const { captureKnownFileBefore, noteOpaqueTurnChange } = await import('../../../desktop/src/main/turn-change-set/store.ts');
  for (const [kind, agent] of [['claude-code', graph.agent], ['pi', graph.pi]]) {
    assert.equal(agent.deps.turnChangeCapture?.beforeKnownFileWrite, captureKnownFileBefore, `${kind} turn changes`);
    assert.equal(agent.deps.turnChangeCapture?.noteOpaqueWrite, noteOpaqueTurnChange, `${kind} opaque writes`);
  }
  assert.equal(typeof graph.maker.lifecycleHooks?.getCodexHistoryHasProductPrompt, 'function');
  assert.equal(typeof graph.maker.lifecycleHooks?.onCodexProductPromptDelivery, 'function');
});

/*
 * 测试价值（第三条）
 * - 可观察结果：Host 组装出的三个引擎读到的 getDisabledSkillPaths 返回用户在 Cindy 里禁用的 Skill，
 *   getGhostRosterPrompt 是 Host 插件网关给的花名册；getManagedSkills 是 Host 插件网关给的托管
 *   Skill 清单（内置与插件提供，放行表第 2b 行），三个引擎拿到的是同一个函数。
 * - 规则依据：桌面三个构造点都注入 readDisabledSkillPaths（maker-host/index.ts、pi-host.ts）；
 *   Host 之前没有注入，用户在桌面禁用的 Skill 在 Host 任务里仍会被加载。
 * - 最小失败输入：任一引擎缺这个依赖。
 * - tier：unit（只构造实例，偏好写进临时 profile）。
 */
test('every engine the Host assembles skips the Skills the user disabled and gets the plugin roster and managed Skills', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { setCindySkillEnabled, skillActivationKey } = await import('../../../desktop/src/main/skillhub/activationPreferences.ts');
  const { configureAppDataDir } = await import('../../../desktop/src/main/userDataPath.ts');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-agent-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-graph-skills' });
  // Host main injects the machine app-data root at startup (main.ts configureAppDataDir).
  configureAppDataDir(path.join(profile, 'app-data'));
  const skill = path.join(profile, 'skills', 'fixture-skill');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: fixture-skill\n---\n');
  await setCindySkillEnabled(skill, false);
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const rosterPrompt = ({ workingDir }) => `roster for ${workingDir}`;
  const managedSkills = async () => [];
  const graph = createHostAgentGraph({
    userDataDir: profile, harnessRoot: fixtureHarnessRoot(profile), gateway: null, getGhostRosterPrompt: rosterPrompt,
    getManagedSkills: managedSkills,
    binaryPath: path.join(profile, 'claude'), codexBinaryPath: path.join(profile, 'codex'), piBinaryPath: path.join(profile, 'pi'),
    mcpRuntime: mcp, mcpProviders: [], storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [], readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false, codexAccountState: () => ({ authenticated: false }) },
    },
  });
  // The key the activation store records (real path; lower case on Windows).
  const disabled = skillActivationKey(skill);
  for (const [kind, agent] of [['claude-code', graph.agent], ['codex', graph.codex], ['pi', graph.pi]]) {
    assert.equal(typeof agent.deps.getDisabledSkillPaths, 'function', kind);
    assert.ok(agent.deps.getDisabledSkillPaths().includes(disabled), `${kind} sees the disabled Skill`);
    // The desktop gives all three engines the plugin roster (maker-host/index.ts, pi-host.ts).
    assert.equal(agent.deps.getGhostRosterPrompt, rosterPrompt, `${kind} plugin roster`);
    // The desktop gives all three engines listCindyManagedSkills (maker-host/index.ts, pi-host.ts).
    assert.equal(agent.deps.getManagedSkills, managedSkills, `${kind} managed Skills`);
  }
});

/*
 * 测试价值（第四条）
 * - 可观察结果：Host 组装出的三个引擎实例上 maker-core 读取的 runtimeConfig：产品系统提示、
 *   回答呈现提示、行为开关、代输入环境、压缩阈值、记忆设置、内置 ripgrep 与 userDataPath。
 * - 规则依据：桌面三个构造点一直注入这些（runtime-configs.ts、pi-host.ts，现经
 *   runtimeConfigsCore.ts）；Host 之前只传了 endpoint 和构造时取一次的记忆开关，任务里没有
 *   Cindy 的身份与回答格式说明。
 * - 最小失败输入：旧装配（runtimeConfig 只有 endpoint）；记忆开关按构造时取值。
 * - tier：unit（只构造实例并读配置，不起子进程、不调模型）。系统提示按桌面的拼接方式从
 *   源文件独立拼出，不经被测代码。
 */
test('every engine the Host assembles gets the desktop runtime config: product prompt, answer delivery, flags and live memory settings', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { ANSWER_DELIVERY_PROMPT, PI_ANSWER_DELIVERY_PROMPT } = await import('@cindy/maker-shared/rich-answer-guide');
  const { DEFAULT_MODEL_COMPACTION_PCT } = await import('../../../desktop/src/shared/modelContextLimit.ts');
  const { writeMemorySetting, readMemorySettings } = await import('../../../desktop/src/main/maker-host/memory-settings-store.ts');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-agent-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-graph-runtime-config' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const harnessRoot = fixtureHarnessRoot(profile);
  const ripgrepDir = path.join(harnessRoot, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  const providerConfig = {
    grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
    list: async () => [], readKey: () => null,
    oauth: { readCachedGenericOAuthAccessToken: () => null },
    codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false, codexAccountState: () => ({ authenticated: false }) },
  };
  const engines = { binaryPath: path.join(profile, 'claude'), codexBinaryPath: path.join(profile, 'codex'), piBinaryPath: path.join(profile, 'pi') };
  const graph = createHostAgentGraph({
    userDataDir: profile, harnessRoot, gateway: { endpoint: 'https://gateway.test/v1', credential: 'fixture-key' },
    ...engines, mcpRuntime: mcp, mcpProviders: [], storage: {}, providerConfig,
  });

  const prompts = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../desktop/src/main/maker-host');
  const read = name => fs.readFileSync(path.join(prompts, name), 'utf8');
  const hostPrompt = (agentSpecific) => [read('host-system-prompt.md'), read('business-ownership-prompt.md'),
    read('skill-source-precedence-prompt.md'), agentSpecific].map(s => s.trim()).filter(Boolean).join('\n\n');
  const claude = graph.agent.deps.runtimeConfig;
  const codex = graph.codex.deps.runtimeConfig;
  const pi = graph.pi.deps.runtimeConfig;

  assert.equal(claude.systemPrompt, hostPrompt(read('claude-system-prompt.md')));
  assert.equal(codex.systemPrompt, hostPrompt(read('codex-system-prompt.md')));
  assert.equal(pi.systemPrompt, [`${read('host-system-prompt.md').trim()}\n\n${read('business-ownership-prompt.md').trim()}`,
    read('pi-system-prompt.md')].map(s => s.trim()).filter(Boolean).join('\n\n'));
  assert.ok(claude.systemPrompt.startsWith('You are Cindy'));
  assert.equal(claude.answerDeliveryPrompt, ANSWER_DELIVERY_PROMPT);
  assert.equal(codex.answerDeliveryPrompt, ANSWER_DELIVERY_PROMPT);
  assert.equal(pi.answerDeliveryPrompt, PI_ANSWER_DELIVERY_PROMPT);

  for (const [kind, config] of [['claude-code', claude], ['codex', codex], ['pi', pi]]) {
    assert.equal(config.userDataPath, profile, `${kind} userDataPath`);
    assert.equal(typeof config.behaviorFlags, 'function', `${kind} behavior flags`);
    // The askpass host is never started in the Host, so the shared env stays empty.
    assert.deepEqual(config.taskShellEnv({ sessionId: 'fixture-task' }), {}, `${kind} task shell env`);
  }
  const claudeFlags = claude.behaviorFlags({ credentialMode: 'gateway-key', sessionProviderId: 'xd', spawnMode: 'local' });
  assert.equal(claudeFlags.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
  assert.ok('ENABLE_TOOL_SEARCH' in claudeFlags);
  assert.equal(claude.autoCompactThresholdPct, DEFAULT_MODEL_COMPACTION_PCT);
  assert.equal(pi.piAutoCompactThresholdPct, DEFAULT_MODEL_COMPACTION_PCT);
  assert.equal(typeof claude.shouldHandoffAfterContextAssessment, 'function');
  assert.equal(claude.endpoint, 'https://gateway.test/v1');
  assert.equal(pi.endpoint, 'https://gateway.test/v1');
  assert.equal(codex.pathPrepends[0], ripgrepDir);
  assert.equal(pi.managedExecutablePaths.ripgrep, path.join(ripgrepDir, process.platform === 'win32' ? 'rg.exe' : 'rg'));

  // Memory settings are read on every access from the profile store, as on the desktop.
  const before = readMemorySettings().maker;
  assert.equal(claude.makerMemoryEnabled, before);
  writeMemorySetting('maker', !before);
  assert.equal(claude.makerMemoryEnabled, !before);
  assert.equal(codex.makerMemoryEnabled, !before);
  assert.equal(pi.makerMemoryEnabled, !before);
  writeMemorySetting('codex', false);
  assert.equal(codex.memoryEnabled, false);

  // Without an account gateway the endpoint stays unset, as the Host did before.
  const offline = createHostAgentGraph({
    userDataDir: profile, harnessRoot, gateway: null, ...engines, mcpRuntime: mcp, mcpProviders: [], storage: {}, providerConfig,
  });
  assert.equal(offline.agent.deps.runtimeConfig.endpoint, undefined);
  assert.equal(offline.pi.deps.runtimeConfig.endpoint, undefined);
});

/*
 * 测试价值（第五条）
 * - 可观察结果：Host 找不到内置 ripgrep 时与桌面同样失败：Pi 在构造时抛错，Codex 在启动读取
 *   PATH 前缀时抛错，报错文字与桌面相同（同一份 runtimeConfigsCore.ts）。
 * - 规则依据：桌面缺 rg 时不静默退化（runtime-configs.ts 注释，issue #1956）；Host 的 rg 来自
 *   `<harnessRoot>/ripgrep-bin/<平台>`（开发时为检出目录的 apps/ripgrep-bin，发布版为 resources/harnesses）。
 * - 最小失败输入：harnessRoot 下没有 ripgrep-bin。
 * - tier：unit。
 */
test('without the bundled ripgrep the Host fails the way the desktop does', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-agent-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-graph-no-ripgrep' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const missing = path.join(profile, 'no-harnesses');
  const message = `Bundled ripgrep not found for ${process.platform}-${process.arch}. Run "pnpm install:ripgrep" before starting desktop dev or packaging.`;
  const providerConfig = {
    grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
    list: async () => [], readKey: () => null,
    oauth: { readCachedGenericOAuthAccessToken: () => null },
    codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false, codexAccountState: () => ({ authenticated: false }) },
  };
  const base = { userDataDir: profile, harnessRoot: missing, gateway: null, mcpRuntime: mcp, mcpProviders: [], storage: {}, providerConfig };
  assert.throws(() => createHostAgentGraph({ ...base, piBinaryPath: path.join(profile, 'pi') }), { message });
  const graph = createHostAgentGraph({ ...base, codexBinaryPath: path.join(profile, 'codex') });
  assert.throws(() => graph.codex.deps.runtimeConfig.pathPrepends, { message });
});

/*
 * 测试价值（放行表第 24 行，24a）
 * - 可观察结果：给了回环代理时，Host 组装的 Claude 与 Pi 的 runtimeConfig.endpoint 是代理的
 *   端点（随代理就绪状态现取），Pi 拿到登记会话 token 的函数，与桌面 pi-host.ts 相同。
 * - 最小失败输入：仍把网关地址交给引擎；Pi 不登记 token（经代理的请求全部 401）。
 * - tier：unit（只构造实例）。
 */
test('with the loopback proxy, Claude and Pi use its endpoint and Pi registers its session tokens', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-agent-graph-proxy-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-graph-proxy' });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  let endpoint = 'https://gateway.test/v1';
  const registerPiProxySession = () => () => {};
  const claudeProxy = { endpoint: () => endpoint, isReady: () => true, inboundSecret: () => 'secret', gatewayInboundSecret: () => 'gateway-secret', registerPiProxySession, closeSession() {} };
  const graph = createHostAgentGraph({
    userDataDir: profile, harnessRoot: fixtureHarnessRoot(profile), claudeProxy,
    gateway: { endpoint: 'https://gateway.test/v1', credential: 'fixture-key' },
    binaryPath: path.join(profile, 'claude'), piBinaryPath: path.join(profile, 'pi'),
    mcpRuntime: mcp, mcpProviders: [], storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [], readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false, codexAccountState: () => ({ authenticated: false }) },
    },
  });
  endpoint = 'http://127.0.0.1:43210';
  assert.equal(graph.agent.deps.runtimeConfig.endpoint, endpoint);
  assert.equal(graph.pi.deps.runtimeConfig.endpoint, endpoint);
  assert.equal(graph.pi.deps.registerPiProxySession, registerPiProxySession);
});
