/*
 * 测试价值
 * - 生产入口与可观察结果：createHostAgentGraph 组装出的引擎上 maker-core 读取的几项专有依赖
 *   （放行表第 19 行）调用后的结果：Claude 的只读工具白名单、子代理用量（经回环代理共用的进程级
 *   桥）、Codex 凭证形态切换前对本机会话的处理。
 * - 规则依据：桌面 maker-host/index.ts 的 Claude 与 Codex 构造点用同样的拼法注入这几项。
 * - 最小失败输入：不传白名单；用量登记或读取接到别的桥；凭证切换不拦忙的会话、不关闲置会话、
 *   误关别的 host 或远程会话、不看 Host 的回合追踪。
 * - tier：unit（只构造实例并调用依赖，不起引擎进程、不调模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createHostAgentGraph } from './runtime.ts';
import { getDesktopClaudeReadOnlyAllowedTools } from '../../../desktop/src/main/maker-host/mcp-tool-approval-policy.ts';
import { claudeSubagentUsageBridge } from '../../../desktop/src/main/maker-host/claude-subagent-usage-bridge.ts';
import { CodexCredentialModeSwitchBusyError } from '../../../desktop/src/main/maker-host/codex-credential-switch.ts';
import { readPiGlobalContext } from '../../../../packages/maker-core/src/agents/pi/global-context.ts';

// node:test has no default timeout; an explicit bound turns a hang into a failure.
const TEST_TIMEOUT_MS = 120_000;

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopIndex = path.join(agentDir, '..', '..', '..', 'desktop', 'src', 'main', 'maker-host', 'index.ts');

function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

function buildGraph(t, ownerId, extra = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-engine-deps-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  return createHostAgentGraph({
    userDataDir: profile,
    harnessRoot: fixtureHarnessRoot(profile),
    gateway: null,
    // Never spawned: only the constructed agents' dependencies are called.
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
      piNativeProviders: () => ({ providers: [], env: {} }),
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false },
    },
    ...extra,
  });
}

test('Claude gets the desktop read-only allowed tools', { timeout: TEST_TIMEOUT_MS }, t => {
  const graph = buildGraph(t, 'engine-deps-allowed');
  assert.deepEqual(graph.agent.deps.claudeAllowedTools, getDesktopClaudeReadOnlyAllowedTools());
  assert.ok(graph.agent.deps.claudeAllowedTools.length > 0);
});

test('Claude subagent usage goes through the process-wide bridge the loopback proxy fills', { timeout: TEST_TIMEOUT_MS }, t => {
  const graph = buildGraph(t, 'engine-deps-usage');
  t.after(() => claudeSubagentUsageBridge.clear());
  const prompt = 'Summarize the fixture repository layout';
  graph.agent.deps.registerClaudeSubagentTask({ taskId: 'task-1', parentToolUseId: 'tool-1', prompt, model: 'fixture-model' });
  // What the proxy's request transform and response observer do for a matching request.
  const reqId = 4242;
  assert.equal(claudeSubagentUsageBridge.reserveRequest(reqId, {
    model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  }), 'task-1');
  assert.equal(claudeSubagentUsageBridge.activateReservedTask(reqId), 'task-1');
  claudeSubagentUsageBridge.recordResponseUsage('task-1', { input_tokens: 30, cache_read_input_tokens: 10, output_tokens: 7 });
  claudeSubagentUsageBridge.releaseActiveTask('task-1');
  assert.deepEqual(graph.agent.deps.getClaudeSubagentTaskUsage('task-1'), { totalTokens: 47 });
  assert.equal(graph.agent.deps.getClaudeSubagentTaskUsage('unknown-task'), undefined);
});

function fakeSession(id, { agentKind = 'codex', hostKey = 'local', remoteHostId, running = false } = {}) {
  return { id, agentKind, codexHostKey: hostKey, remoteHostId, isTurnRunning: () => running };
}

test('a Codex credential-mode switch closes the idle local sessions of that host only', { timeout: TEST_TIMEOUT_MS }, async t => {
  const graph = buildGraph(t, 'engine-deps-switch-idle', { isSessionInTurn: () => false });
  const closed = [];
  graph.maker.listActiveSessions = () => [
    fakeSession('idle-local'),
    fakeSession('other-host', { hostKey: 'account-a' }),
    fakeSession('remote', { remoteHostId: 'other-device' }),
    fakeSession('claude', { agentKind: 'claude-code' }),
  ];
  graph.maker.closeSession = async (id, reason) => { closed.push([id, reason]); };
  const result = await graph.codex.deps.prepareCodexLocalCredentialModeSwitch({
    hostKey: 'local', fromMode: 'oauth-bearer', fromModeEffective: 'oauth-bearer', toMode: 'gateway-key',
  });
  assert.equal(result, undefined);
  assert.deepEqual(closed, [['idle-local', 'runtime-refresh']]);
});

test('a Codex credential-mode switch is refused while a session is busy, by its own turn or the Host tracker', { timeout: TEST_TIMEOUT_MS }, async t => {
  const inTurn = new Set(['tracked']);
  const graph = buildGraph(t, 'engine-deps-switch-busy', { isSessionInTurn: id => inTurn.has(id) });
  const closed = [];
  graph.maker.closeSession = async (id) => { closed.push(id); };
  for (const sessions of [[fakeSession('running', { running: true }), fakeSession('idle')], [fakeSession('tracked'), fakeSession('idle')]]) {
    graph.maker.listActiveSessions = () => sessions;
    await assert.rejects(graph.codex.deps.prepareCodexLocalCredentialModeSwitch({ hostKey: 'local', toMode: 'gateway-key' }),
      error => error instanceof CodexCredentialModeSwitchBusyError);
  }
  assert.deepEqual(closed, []);
});

test('the three Host lines are the desktop constructor lines', { timeout: TEST_TIMEOUT_MS }, () => {
  const desktop = fs.readFileSync(desktopIndex, 'utf8');
  const host = fs.readFileSync(path.join(agentDir, 'runtime.ts'), 'utf8');
  for (const line of [
    'claudeAllowedTools: getDesktopClaudeReadOnlyAllowedTools(),',
    'registerClaudeSubagentTask: (task) => claudeSubagentUsageBridge.registerTask(task),',
    'getClaudeSubagentTaskUsage: (taskId) => claudeSubagentUsageBridge.getTaskUsage(taskId),',
  ]) {
    assert.equal(desktop.split(line).length - 1, 1, `desktop: ${line}`);
    assert.equal(host.split(line).length - 1, 1, `host: ${line}`);
  }
  // The same arguments to the shared switch, in the same order; the desktop's guard for a Maker that
  // is not built yet has no Host counterpart (the Host closes over its Maker).
  const args = (source) => {
    const start = source.indexOf('await prepareLocalCodexCredentialModeSwitch({');
    const body = source.slice(start, source.indexOf('});', start));
    return [...body.matchAll(/^\s+(\w+)(?::|,)/gm)].map(m => m[1]);
  };
  assert.deepEqual(args(desktop), ['maker', 'isSessionInTurn', 'hostKey', 'fromMode', 'fromModeEffective', 'toMode']);
  assert.deepEqual(args(host), args(desktop));
  // The proxy core the Host's Claude proxy uses records into the default (process-wide) bridge.
  const core = fs.readFileSync(path.join(path.dirname(desktopIndex), 'anthropicCompatProxyHostCore.ts'), 'utf8');
  assert.ok(core.includes('createClaudeSubagentUsageResponseObserver(),'));
  assert.ok(core.includes('createClaudeSubagentUsageRequestTransform(),'));
});

test('Claude gets the MCP duplicate choices main.ts builds from the plugin gateway reads', { timeout: TEST_TIMEOUT_MS }, t => {
  const resolveLocalMcpDuplicateChoices = async () => ({ skipHostServers: [], denyNativeServers: [] });
  const graph = buildGraph(t, 'engine-deps-mcp-duplicates', { resolveLocalMcpDuplicateChoices });
  assert.equal(graph.agent.deps.resolveLocalMcpDuplicateChoices, resolveLocalMcpDuplicateChoices);
  assert.equal(buildGraph(t, 'engine-deps-mcp-duplicates-absent').agent.deps.resolveLocalMcpDuplicateChoices, undefined);
  const main = fs.readFileSync(path.join(agentDir, '..', 'main.ts'), 'utf8');
  assert.ok(main.includes('resolveLocalMcpDuplicateChoices: createHostMcpDuplicateChoices(pluginGateway.customMcp).resolveLocalMcpDuplicateChoices,'));
  // The desktop Claude constructor takes the same function from the same module family.
  const desktop = fs.readFileSync(desktopIndex, 'utf8');
  assert.ok(desktop.includes("import { resolveLocalMcpDuplicateChoices } from './mcp-duplicate-preferences.js';"));
  assert.ok(desktop.includes('    const claudeAgent = new ClaudeCodeAgent({\n      resolveLocalMcpDuplicateChoices,\n'));
});

test('Claude checks explicit subagent models with the Host gateway key and provider views', { timeout: TEST_TIMEOUT_MS }, async t => {
  const graph = buildGraph(t, 'engine-deps-subagent-access');
  const resolve = graph.agent.deps.resolveClaudeSubagentModelAccess;
  assert.equal(typeof resolve, 'function');
  // No authoritative XD snapshot in this process: nothing can be denied.
  assert.deepEqual(await resolve({ providerId: 'xd', parentModel: 'fixture-model', model: 'claude-haiku-4-5' }), { status: 'unknown' });
  const runtime = fs.readFileSync(path.join(agentDir, 'runtime.ts'), 'utf8');
  assert.ok(runtime.includes([
    '    resolveClaudeSubagentModelAccess: createHostClaudeSubagentModelAccess({',
    '      readGatewayKey: () => options.gateway?.credential ?? null,',
    '      listProviderViews: () => config.publicViews(Boolean(options.gateway?.credential)),',
    '    }),',
  ].join('\n')));
  const desktop = fs.readFileSync(desktopIndex, 'utf8');
  assert.ok(desktop.includes('      resolveClaudeSubagentModelAccess: resolveDesktopClaudeSubagentModelAccess,\n'));
});

test('Pi reads the user\'s own global context from the home the desktop uses', { timeout: TEST_TIMEOUT_MS }, async t => {
  const graph = buildGraph(t, 'engine-deps-pi-context');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  t.after(() => {
    process.env.HOME = saved.HOME;
    if (saved.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.PI_CODING_AGENT_DIR;
  });
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'AGENTS.md'), 'fixture global context');
  const resolve = graph.pi.deps.resolvePiGlobalContextHome;
  assert.equal(resolve(), path.join(home, '.pi', 'agent'));
  // What maker-core reads from it: only the context files under that home, inside the fixture.
  assert.deepEqual(await readPiGlobalContext(resolve()), [{ name: 'AGENTS.md', content: 'fixture global context' }]);
  process.env.PI_CODING_AGENT_DIR = '~/custom-pi';
  assert.equal(resolve(), path.join(home, 'custom-pi'));
  assert.equal(resolve('other-device'), '$HOME/.pi/agent');
  for (const value of [resolve(), path.join(home, '.pi', 'agent')]) assert.ok(value.startsWith(`${home}${path.sep}`));
});

test('Pi resolves its live models and descriptors from the Host selectable catalog', { timeout: TEST_TIMEOUT_MS }, t => {
  const graph = buildGraph(t, 'engine-deps-pi-models');
  const deps = graph.pi.deps;
  const models = deps.resolvePiRuntimeModels();
  assert.deepEqual(models, graph.pi.capabilities.availableModels);
  const sample = models.find(model => model.providerId && model.providerId !== 'xd') ?? models[0];
  if (sample) {
    assert.ok(deps.resolvePiRuntimeModelDescriptor(sample.providerId, sample.id), 'a listed model has a descriptor');
  }
  // The same expressions as the desktop's buildPiAgentForDesktop, over the Host catalog.
  const runtime = fs.readFileSync(path.join(agentDir, 'runtime.ts'), 'utf8');
  const desktop = fs.readFileSync(desktopIndex, 'utf8');
  const piHost = fs.readFileSync(path.join(path.dirname(desktopIndex), 'pi-host.ts'), 'utf8');
  const body = (source, from, to) => {
    const start = source.indexOf(from);
    assert.ok(start >= 0, from);
    return source.slice(start, source.indexOf(to, start)).split('\n').map(line => line.trim()).filter(line => !line.startsWith('//')).join('\n');
  };
  const desktopModels = body(desktop, 'resolvePiRuntimeModels: () =>', 'mcpProviders: piMcpProviders,').replaceAll('getDesktopSelectableCatalog()', 'modelContext.getSelectableCatalog()');
  const hostModels = body(runtime, 'resolvePiRuntimeModels: () =>', '        mcpProviders,\n');
  assert.ok(hostModels.startsWith(desktopModels), 'the three model resolvers are the desktop lines');
  assert.equal(body(runtime, 'resolvePiGlobalContextHome: (remoteHostId) => {', '        },'),
    body(piHost, 'resolvePiGlobalContextHome: (remoteHostId) => {', '    },'));
});
