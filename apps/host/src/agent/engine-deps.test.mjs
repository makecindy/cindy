/*
 * 测试价值
 * - 生产入口与可观察结果：createHostAgentGraph 组装出的引擎上 maker-core 读取的几项专有依赖
 *   （放行表第 19 行）调用后的结果：Claude 的只读工具白名单、子代理用量（经回环代理共用的进程级
 *   桥）、Codex 凭证形态切换前对本机会话的处理；Pi 的全局上下文目录、模型解析、缓存兼容记录，以及启动提示与扩展对话框文案（按系统语言）。
 * - 规则依据：桌面 maker-host/index.ts 与 pi-host.ts 的构造点用同样的拼法注入这几项。
 * - 最小失败输入：不传白名单；用量登记或读取接到别的桥；凭证切换不拦忙的会话、不关闲置会话、
 *   误关别的 host 或远程会话、不看 Host 的回合追踪。
 * - tier：unit（只构造实例并调用依赖，不起引擎进程、不调模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createHostAgentGraph } from './runtime.ts';
import { getDesktopClaudeReadOnlyAllowedTools } from '../../../desktop/src/main/maker-host/mcp-tool-approval-policy.ts';
import { claudeSubagentUsageBridge } from '../../../desktop/src/main/maker-host/claude-subagent-usage-bridge.ts';
import { CodexCredentialModeSwitchBusyError } from '../../../desktop/src/main/maker-host/codex-credential-switch.ts';
import { writeCodexServerCompaction } from '../../../desktop/src/main/maker-host/compaction-settings-store.ts';
import { readPiGlobalContext } from '../../../../packages/maker-core/src/agents/pi/global-context.ts';
import { createMainI18n } from '../../../desktop/src/main/i18n.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';
import { resolveHarnessBinaryPath } from './harness-binary.ts';
import { AGENT_BINARY_LAYOUT } from '../../../desktop/src/main/agent-binaries/binaryStatus.ts';

// node:test has no default timeout; an explicit bound turns a hang into a failure.
const TEST_TIMEOUT_MS = 120_000;


function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

const graphProfiles = new WeakMap();

function buildGraph(t, ownerId, extra = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-engine-deps-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const graph = createHostAgentGraph({
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
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false },
    },
    ...extra,
  });
  graphProfiles.set(graph, profile);
  return graph;
}

test('Claude gets the desktop read-only allowed tools', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const graph = buildGraph(t, 'engine-deps-allowed');
  assert.deepEqual(graph.agent.deps.claudeAllowedTools, getDesktopClaudeReadOnlyAllowedTools());
  assert.ok(graph.agent.deps.claudeAllowedTools.length > 0);
});

test('Claude subagent usage goes through the process-wide bridge the loopback proxy fills', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
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
  t = lifoCleanup(t);
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
  t = lifoCleanup(t);
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


// The desktop passes the user's Codex server-compaction choice at every Codex start; the Host passed
// nothing, so a choice made in the window was ignored by Host tasks.
test('Codex reads the user\'s server-compaction choice from the owner file the desktop writes', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const graph = buildGraph(t, 'engine-deps-codex-compaction');
  const read = graph.codex.deps.getCodexServerCompactionPreference;
  assert.equal(read(), null, 'no choice keeps the native policy');
  t.after(() => writeCodexServerCompaction(null));
  writeCodexServerCompaction(false);
  assert.equal(read(), false);
  writeCodexServerCompaction(true);
  assert.equal(read(), true);
});

test('Claude gets the MCP duplicate choices main.ts builds from the plugin gateway reads', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const resolveLocalMcpDuplicateChoices = async () => ({ skipHostServers: [], denyNativeServers: [] });
  const graph = buildGraph(t, 'engine-deps-mcp-duplicates', { resolveLocalMcpDuplicateChoices });
  assert.equal(graph.agent.deps.resolveLocalMcpDuplicateChoices, resolveLocalMcpDuplicateChoices);
  assert.equal(buildGraph(t, 'engine-deps-mcp-duplicates-absent').agent.deps.resolveLocalMcpDuplicateChoices, undefined);
});

test('Claude checks explicit subagent models with the Host gateway key and provider views', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const graph = buildGraph(t, 'engine-deps-subagent-access');
  const resolve = graph.agent.deps.resolveClaudeSubagentModelAccess;
  assert.equal(typeof resolve, 'function');
  // No authoritative XD snapshot in this process: nothing can be denied.
  assert.deepEqual(await resolve({ providerId: 'xd', parentModel: 'fixture-model', model: 'claude-haiku-4-5' }), { status: 'unknown' });
});

test('Pi reads the user\'s own global context from the home the desktop uses', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const graph = buildGraph(t, 'engine-deps-pi-context');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  t.after(() => {
    for (const key of ['HOME', 'USERPROFILE']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    if (saved.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.PI_CODING_AGENT_DIR;
  });
  process.env.HOME = process.env.USERPROFILE = home;
  // In-process reads go through os.homedir(), which reads USERPROFILE on Windows.
  t.mock.method(os, 'homedir', () => home);
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
  t = lifoCleanup(t);
  const graph = buildGraph(t, 'engine-deps-pi-models');
  const deps = graph.pi.deps;
  const models = deps.resolvePiRuntimeModels();
  assert.deepEqual(models, graph.pi.capabilities.availableModels);
  const sample = models.find(model => model.providerId && model.providerId !== 'xd') ?? models[0];
  if (sample) {
    assert.ok(deps.resolvePiRuntimeModelDescriptor(sample.providerId, sample.id), 'a listed model has a descriptor');
  }
});

test('Pi learns cache compatibility in the profile file the desktop uses and reads it back', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const graph = buildGraph(t, 'engine-deps-pi-compat');
  const profile = graphProfiles.get(graph);
  const deps = graph.pi.deps;
  const file = path.join(profile, 'pi-native-compat-overrides.json');
  assert.equal(deps.resolvePiNativeCompatStorePath(), file);
  assert.equal(deps.resolvePiNativeCompatStorePath(null), file);
  assert.equal(deps.resolvePiNativeCompatStorePath('other-device'), '$HOME/.xdt-server/v1/pi-agent-home/pi-native-compat-overrides.json');
  // What the Pi bridge writes there (cache-recovery-source.ts persist): one live and one expired route.
  const routeKey = 'a'.repeat(64);
  const now = Date.now();
  const write = routes => fs.writeFileSync(file, JSON.stringify({ routes }));
  write({
    [JSON.stringify(['openai', 'gpt-x', routeKey])]: { supportsLongCacheRetention: false, learnedAt: now - 1000, expiresAt: now + 86_400_000, evidence: 'explicit' },
    [JSON.stringify(['openai', 'gpt-old', routeKey])]: { supportsLongCacheRetention: false, learnedAt: now - 3 * 86_400_000, expiresAt: now - 1000, evidence: 'opaque' },
  });
  assert.deepEqual(deps.resolvePiNativeCompatOverride('openai', 'gpt-x', routeKey), { supportsLongCacheRetention: false });
  assert.equal(deps.resolvePiNativeCompatOverride('openai', 'gpt-old', routeKey), undefined);
  assert.equal(deps.resolvePiNativeCompatOverride('openai', 'gpt-x', 'not-a-digest'), undefined);
  assert.equal(deps.resolvePiNativeCompatOverride('other', 'gpt-x', routeKey), undefined);
  // A later bridge write is seen on the next read, as on the desktop.
  write({});
  assert.equal(deps.resolvePiNativeCompatOverride('openai', 'gpt-x', routeKey), undefined);
});

test('Pi gets the desktop startup hint and extension dialog strings in the system language', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const deps = buildGraph(t, 'engine-deps-pi-strings').pi.deps;
  // What i18n.desktop.ts gives when the system reports this language and the window has not set one.
  const desktop = createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]);
  const file = '~/Documents/$&$1/AGENTS.md';
  const hint = deps.formatPiStartupCloudFileHint(file);
  assert.equal(hint, desktop.t('logic.errors.piStartupCloudFile').split('{{path}}').join(file));
  assert.ok(hint.includes(file) && !hint.includes('{{path}}'), 'the path is inserted literally');
  const strings = deps.getPiExtensionUiStrings();
  const key = name => `settings.piPackages.${name}`;
  assert.deepEqual(strings, {
    confirm: desktop.t(key('extensionDialogConfirm')),
    cancel: desktop.t(key('cancel')),
    mutationFailed: desktop.t(key('operationFailed')),
    mutationFailure: {
      'source-unavailable': desktop.t(key('failure.sourceUnavailable')),
      'package-not-found': desktop.t(key('failure.packageNotFound')),
      'version-not-found': desktop.t(key('failure.versionNotFound')),
      'state-unavailable': desktop.t(key('failure.stateUnavailable')),
      'native-command-failed': desktop.t(key('failure.nativeCommandFailed')),
    },
    mutationSuccess: {
      install: desktop.t(key('success.install')),
      installEnabled: desktop.t(key('success.installEnabled')),
      update: desktop.t(key('success.update')),
      remove: desktop.t(key('success.remove')),
    },
  });
  // Every string is a translation, not a key the lookup fell back to.
  const values = [strings.confirm, strings.cancel, strings.mutationFailed, ...Object.values(strings.mutationFailure), ...Object.values(strings.mutationSuccess)];
  for (const value of values) assert.ok(value.trim() && !value.startsWith('settings.piPackages.'), value);
});

// The engine binary each harness starts with (harness-binary.ts), chosen with the desktop's rules
// (agent-binaries/index.ts prepare, localOnly). Gap: the Host took the first `.verified` install in
// readdirSync order and ignored Pi's selected.json. Fake engines are scripts that print a version.
const binarySkip = process.platform === 'win32' && 'the fake engines are shell scripts';
const PI_A = '0.70.0-11111111-1111-1111-1111-111111111111';
const PI_B = '0.72.0-22222222-2222-2222-2222-222222222222';
function binaryProfile(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-harness-binary-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return profile;
}
// An install `<profile>/<subdir>/<directory>/<binary>` whose binary prints `version`; verified unless told not.
function installEngine(profile, kind, directory, version, { verified = true } = {}) {
  const layout = AGENT_BINARY_LAYOUT[kind];
  const binary = path.join(profile, layout.installSubdir, directory, layout.binaryName);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  if (verified) fs.writeFileSync(path.join(profile, layout.installSubdir, directory, '.verified'), '');
  return binary;
}
const selectPi = (profile, value) => fs.writeFileSync(path.join(profile, 'pi', 'selected.json'),
  typeof value === 'string' ? value : JSON.stringify(value));
const piSelection = directory => ({ schema: 1, source: 'official', version: directory.split('-')[0], directory });

// Rule (index.ts prepare; pi-kernel-selection.ts "A saved downgrade wins over every higher leftover
// install"): a valid selection of the lower version is used, ahead of the higher install and of the
// bundled binary.
test('Pi starts with its selected version, ahead of a higher install and the bundled binary', { timeout: TEST_TIMEOUT_MS, skip: binarySkip }, async t => {
  const profile = binaryProfile(t);
  const lower = installEngine(profile, 'pi', PI_A, '0.70.0');
  installEngine(profile, 'pi', PI_B, '0.72.0');
  const bundled = installEngine(profile, 'pi', 'bundled', '0.73.0');
  selectPi(profile, piSelection(PI_A));
  assert.deepEqual(await resolveHarnessBinaryPath('pi', { userDataDir: profile, bundledCandidates: [bundled] }),
    { binaryPath: lower });
});

// Rule (index.ts prepare: "Do not resurrect a higher leftover version after an explicit downgrade"): a
// malformed selection, or one naming an install without `.verified`, leaves Pi unavailable.
test('Pi is unavailable with an unusable selection and does not take a higher install', { timeout: TEST_TIMEOUT_MS, skip: binarySkip }, async t => {
  const unusable = { binaryPath: null, error: 'pi_selection_invalid' };
  const malformed = binaryProfile(t);
  installEngine(malformed, 'pi', PI_B, '0.72.0');
  selectPi(malformed, '{"schema":1,');
  assert.deepEqual(await resolveHarnessBinaryPath('pi', { userDataDir: malformed, bundledCandidates: [] }), unusable);
  const unverified = binaryProfile(t);
  installEngine(unverified, 'pi', PI_A, '0.70.0', { verified: false });
  installEngine(unverified, 'pi', PI_B, '0.72.0');
  selectPi(unverified, piSelection(PI_A));
  assert.deepEqual(await resolveHarnessBinaryPath('pi', { userDataDir: unverified, bundledCandidates: [] }), unusable);
});

// Rule (factory.ts findUsableLocalBinary through findPreferredLocalBinary): with no selection, the
// install whose binary reports the highest version, whatever the directory names or their order.
test('with no selection, Pi takes the install that reports the highest version', { timeout: TEST_TIMEOUT_MS, skip: binarySkip }, async t => {
  for (const order of [['a-9.9.9', 'b-0.0.1'], ['b-0.0.1', 'a-9.9.9']]) {
    const profile = binaryProfile(t);
    const reported = { 'a-9.9.9': '0.70.0', 'b-0.0.1': '0.72.0' }; // names disagree with the versions
    const binaries = Object.fromEntries(order.map(directory => [directory, installEngine(profile, 'pi', directory, reported[directory])]));
    assert.deepEqual(await resolveHarnessBinaryPath('pi', { userDataDir: profile, bundledCandidates: [] }),
      { binaryPath: binaries['b-0.0.1'] }, `created in the order ${order.join(', ')}`);
  }
});

// Rule (index.ts: every engine prepares with preserveLocalVersion): Claude Code and Codex take the same
// highest reported version; their bundled binary comes first.
test('Claude Code and Codex take the install that reports the highest version, after the bundled binary', { timeout: TEST_TIMEOUT_MS, skip: binarySkip }, async t => {
  for (const kind of ['claude-code', 'codex']) {
    const profile = binaryProfile(t);
    installEngine(profile, kind, 'a-9.9.9', '1.0.0');
    const highest = installEngine(profile, kind, 'b-0.0.1', '2.0.0');
    assert.deepEqual(await resolveHarnessBinaryPath(kind, { userDataDir: profile, bundledCandidates: [] }), { binaryPath: highest }, kind);
    const bundled = installEngine(profile, kind, 'bundled', '0.1.0', { verified: false });
    assert.deepEqual(await resolveHarnessBinaryPath(kind, { userDataDir: profile, bundledCandidates: [bundled] }), { binaryPath: bundled }, kind);
  }
});
