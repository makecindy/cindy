/**
 * 测试价值
 * - 可观察结果：桌面的 resolvePiNativeProviders（pi-host.ts，桌面自己的端口）与 Host 引擎图里交给 Pi 的
 *   同名依赖（apps/host/src/agent/runtime.ts → pi-native-providers.ts，Host 自己的端口）对同一组输入给出的
 *   原生供应商清单与 env，或抛出的错误。输入：网关、ChatGPT 订阅、SuperGrok、自定义供应商（会话钉住的
 *   模型接口）、续接时保留原模型、本机托管模型；兼容代理就绪与未就绪。Pi 网关块的 API 与 compat
 *   （P8、P9）两边是同一对函数，读同一份探测状态。
 * - 规则依据：放行表第 19、24 行（审核方 m1-cp18b 的 C2：同一组输入两边逐项相同，允许的差异只有全局 Skill
 *   投影与本机模型两处，写死在例外清单里；“SuperGrok 选了但代理没就绪”必须在探测之前报错；探测失败返回
 *   null 且不缓存）。
 * - 断言方式：逐项比较；不同的输入按名字写死在 ALLOWED_DIFFERENCES 里，多了少了都会失败。探测用一个假 Pi
 *   程序（Node 脚本），每次被调用都记一行，用来看出探测发生在哪一步、失败后是否重试。
 * - tier：unit（真实临时 profile；HOME 是空目录；凭据是合成的；不起真实 Pi，不连网）。
 */
import { configureOwnerContext } from '../../ownerContext.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '@cindy/maker-core';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  userDataDir: '', home: '', dataOwnerId: 'owner-a' as string | null,
  gatewayKey: 'sk-xd-gateway' as string | null,
  proxyReady: true,
  piBinary: '',
  grok: new Set<string>(['xai']),
  customs: [] as unknown[],
  keys: new Map<string, string>(),
  globalSkillRefreshes: 0,
  localRuntimeStarts: 0,
}));

vi.mock('../../userDataPath.js', async (original) => ({
  ...(await original<typeof import('../../userDataPath.js')>()),
  getUserDataDir: () => h.userDataDir,
  userDataPath: (...parts: string[]) => path.join(h.userDataDir, ...parts),
  configureUserDataDir: () => {},
}));
configureOwnerContext({
  read: () => ({ dataOwnerId: h.dataOwnerId, generation: 1, boundaryPending: false }),
  fallbackBaseDir: () => h.userDataDir,
});
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, getAppPath: () => h.userDataDir, isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../managed-skills.js', () => ({ listCindyManagedSkills: async () => [], cindyManagedSkillRoots: async () => [] }));
vi.mock('../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return {
    ...actual,
    getActiveAppSession: () => ({ mode: 'cloud' as const, dataOwnerId: h.dataOwnerId, generation: 1 }),
    activeOwnerScopeKey: () => `cloud:${h.dataOwnerId}:1`,
    isAppSessionBoundaryPending: () => false,
  };
});
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../../secrets/providerSecretStore.js', async (original) => ({
  ...(await original<typeof import('../../secrets/providerSecretStore.js')>()),
  getProviderSecretStore: () => ({ get: () => h.gatewayKey, remove: () => ({ success: true }) }),
  readCustomProviderKey: (id: string) => h.keys.get(id) ?? null,
}));
vi.mock('../grok-oauth-login.desktop.js', async (original) => ({
  ...(await original<typeof import('../grok-oauth-login.desktop.js')>()),
  hasGrokOAuthLogin: (id = 'xai') => h.grok.has(id),
  grokAccountIdentity: (id = 'xai') => (h.grok.has(id) ? `${id}@example.test` : undefined),
}));
vi.mock('../custom-provider-header-secrets.js', async (original) => ({
  ...(await original<typeof import('../custom-provider-header-secrets.js')>()),
  listCustomProvidersWithSecureHeaders: async () => h.customs,
}));
// The desktop's compat proxy: the same loopback endpoint and readiness the Host fake reports.
vi.mock('../anthropic-compat-proxy-host.js', async (original) => ({
  ...(await original<typeof import('../anthropic-compat-proxy-host.js')>()),
  getClaudeEndpoint: () => 'http://127.0.0.1:18765',
  isAnthropicCompatProxyHandleReady: () => h.proxyReady,
}));
vi.mock('../../agent-binaries/index.js', async (original) => ({
  ...(await original<typeof import('../../agent-binaries/index.js')>()),
  getReadyBinaryPath: (kind: string) => (kind === 'pi' ? h.piBinary : null),
}));
// The desktop starts its managed local model runtime; here it reports ready without a process.
vi.mock('../../local-model-runtime/preflight.js', () => ({
  ensureManagedOllamaReadyForSession: async () => { h.localRuntimeStarts += 1; },
}));

import { desktopClaudeAuthAdapter } from '../auth-adapters.js';
import { resolvePiNativeProviders, resolvePiCindyGatewayModelApi, resolvePiCindyGatewayModelSpec } from '../pi-host.js';
import { getActiveCatalog, setActiveCatalog } from '../active-catalog.js';
import { configureSessionModelInterfaceStorage } from '../session-model-interface.js';
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime.js';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../../shared/llamaCpp.js';

type Resolve = NonNullable<AgentDeps['resolvePiNativeProviders']>;
type HostPiDeps = Pick<AgentDeps, 'resolvePiNativeProviders' | 'resolvePiGatewayModelApi' | 'resolvePiGatewayModelSpec'>;
let host: HostPiDeps;
let restoreCatalog: (() => void) | undefined;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pi-native-parity-'));
const probeLog = path.join(root, 'probe.log');
const probeFail = path.join(root, 'probe-fail');

/** A fake Pi: `--list-models` and the RPC `get_available_models`, one log line per start. */
function writeFakePi(file: string): void {
  const models = [
    { provider: 'openai-codex', id: 'gpt-5.6-sol', api: 'openai-codex-responses', contextWindow: 272000, maxTokens: 128000, compat: { supportsStrictTools: true } },
    { provider: 'xai', id: 'grok-4.6', api: 'openai-responses', reasoning: true, contextWindow: 256000 },
    { provider: 'anthropic', id: 'claude-sonnet-4-5', api: 'anthropic-messages', compat: { supportsStrictTools: true, supportsMidConvoSystemMessages: true } },
  ];
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(probeLog)}, process.argv.slice(2).join(' ') + '\\n');
if (fs.existsSync(${JSON.stringify(probeFail)})) process.exit(3);
const models = ${JSON.stringify(models)};
if (process.argv.includes('--list-models')) {
  process.stdout.write('provider model\\n' + models.map(m => m.provider + ' ' + m.id).join('\\n') + '\\n');
  process.exit(0);
}
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ type: 'response', command: 'get_available_models', success: true, data: { models } }) + '\\n');
});
`, { mode: 0o755 });
}
const probes = () => (fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').split('\n').filter(Boolean) : []);

beforeAll(async () => {
  h.home = path.join(root, 'home');
  fs.mkdirSync(h.home);
  vi.spyOn(os, 'homedir').mockReturnValue(h.home);
  h.userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(path.join(h.userDataDir, 'codex-home'), { recursive: true });
  h.piBinary = path.join(root, 'pi-bin', 'pi');
  fs.mkdirSync(path.dirname(h.piBinary));
  writeFakePi(h.piBinary);
  configureSessionModelInterfaceStorage(() => path.join(h.userDataDir, 'model-interface-snapshots'));
  vi.spyOn(desktopClaudeAuthAdapter, 'ensureSharedGlobalSkills').mockImplementation(async () => { h.globalSkillRefreshes += 1; });
  const previous = getActiveCatalog();
  setActiveCatalog(previous);
  restoreCatalog = () => setActiveCatalog(previous);
  const piRuntime = (models: Array<Record<string, unknown>>) => ({ baseUrl: 'https://byom.example.test/v1', wireProtocol: 'openai-chat', models });
  h.customs = [
    { id: 'cprov-key', name: 'Keyed', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime([{ id: 'm', contextWindow: 8192 }]) } },
    { id: 'cprov-nokey', name: 'Unkeyed', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime([{ id: 'm' }]) } },
    { id: 'cprov-none', name: 'Keyless', auth: { method: 'none' }, runtimes: { pi: piRuntime([{ id: 'm' }]) } },
    { id: 'cprov-routes', name: 'Routes', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime([
      { id: 'r', route: { baseUrl: 'https://alt.example.test/v1', wireProtocol: 'anthropic-messages' } },
    ]) } },
    { id: 'openai-codex', name: 'Same id as a Pi bundled provider', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime([{ id: 'm' }]) } },
  ];
  h.keys.set('cprov-key', 'fixture-byom-key');
  h.keys.set('cprov-routes', 'fixture-routes-key');
  h.keys.set('openai-codex', 'fixture-collision-key');

  // Module paths in variables, as the other parity tests: the desktop typecheck does not follow them into the Host.
  const providerConfigModule = '../../../../../host/src/agent/provider-config.ts';
  const runtimeModule = '../../../../../host/src/agent/runtime.ts';
  const mcpModule = '../../../../../host/src/agent/mcp-runtime.ts';
  const claudeAuthModule = '../../../../../host/src/agent/claude-auth.mjs';
  const { createHostCodexAccounts } = (await import(/* @vite-ignore */ providerConfigModule)) as {
    createHostCodexAccounts(options: Record<string, unknown>, scope: Record<string, unknown>): unknown;
  };
  const { createHostAgentGraph } = (await import(/* @vite-ignore */ runtimeModule)) as {
    createHostAgentGraph(options: Record<string, unknown>): { pi: { deps: HostPiDeps } };
  };
  const { createHostMcpRuntime } = (await import(/* @vite-ignore */ mcpModule)) as {
    createHostMcpRuntime(ports: Record<string, unknown>): unknown;
  };
  const { configureHostOwner } = (await import(/* @vite-ignore */ claudeAuthModule)) as {
    configureHostOwner(input: Record<string, unknown>): void;
  };
  configureHostOwner({ userDataDir: h.userDataDir, ownerId: 'owner-a' });
  const harnessRoot = path.join(root, 'harnesses');
  const rgDir = path.join(harnessRoot, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(rgDir, { recursive: true });
  fs.writeFileSync(path.join(rgDir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  const graph = createHostAgentGraph({
    userDataDir: h.userDataDir, harnessRoot,
    gateway: { endpoint: 'https://gateway.test', get credential() { return h.gatewayKey; } },
    binaryPath: path.join(root, 'claude'), codexBinaryPath: path.join(root, 'codex'), piBinaryPath: h.piBinary,
    mcpRuntime: createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null }), mcpProviders: [], storage: {},
    // The Host's loopback proxy as the agent graph reads it: the same endpoint and readiness.
    claudeProxy: {
      endpoint: () => 'http://127.0.0.1:18765', isReady: () => h.proxyReady, inboundSecret: () => 'fixture-inbound',
      registerPiProxySession: () => {}, closeSession: () => {},
    },
    providerConfig: {
      grok: { hasGrokOAuthLogin: (id = 'xai') => h.grok.has(id), grokAccountIdentity: (id = 'xai') => (h.grok.has(id) ? `${id}@example.test` : undefined) },
      list: async () => h.customs,
      readKey: (id: string) => h.keys.get(id) ?? null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: createHostCodexAccounts({ profileDir: h.userDataDir, getCodexBinary: () => null },
        { owner: 'cloud:owner-a:1', check: () => {}, closed: () => false }),
      publicViews: async () => [],
    },
  });
  host = graph.pi.deps;
});

afterAll(() => {
  restoreCatalog?.();
  vi.restoreAllMocks();
  expect(fs.readdirSync(h.home)).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

const settle = (promise: Promise<unknown>) => promise.then(
  value => ({ result: value }),
  (error: Error) => ({ thrown: `${error.constructor.name}: ${error.message}` }),
);

type Input = Parameters<Resolve>[0];
const workingDir = () => path.join(root, 'work');
const inputs: Array<{ name: string; ctx: () => Input; proxyReady?: boolean }> = [
  { name: 'gateway', ctx: () => ({ workingDir: workingDir(), providerId: 'xd', model: 'claude-sonnet-4-5' }) },
  { name: 'gateway, no provider', ctx: () => ({ workingDir: workingDir(), model: 'claude-sonnet-4-5' }) },
  { name: 'ChatGPT subscription', ctx: () => ({ workingDir: workingDir(), providerId: 'openai', model: 'chatgpt/gpt-5.6-sol' }) },
  { name: 'ChatGPT subscription, resumed retired profile', ctx: () => ({
    workingDir: workingDir(), sessionId: 'session-resume', resumeSessionId: 'native-resume', providerId: 'openai', model: 'chatgpt/gpt-5.6-sol[1m]',
  }) },
  { name: 'SuperGrok', ctx: () => ({ workingDir: workingDir(), providerId: 'xai', model: 'grok-4.6' }) },
  { name: 'SuperGrok, resumed historical model', ctx: () => ({ workingDir: workingDir(), providerId: 'xai', model: 'xai/grok-legacy', resumeSessionId: 'native-resume' }) },
  { name: 'custom provider, session-pinned interface', ctx: () => ({ workingDir: workingDir(), sessionId: 'session-custom', providerId: 'cprov-routes', model: 'r' }) },
  { name: 'custom provider, preview', ctx: () => ({ workingDir: workingDir(), sessionId: 'session-custom', providerId: 'cprov-key', model: 'm', purpose: 'preview' }) },
  { name: 'remote session', ctx: () => ({ workingDir: workingDir(), remoteHostId: 'ssh-host', providerId: 'cprov-key', model: 'm' }) },
  { name: 'managed Ollama', ctx: () => ({ workingDir: workingDir(), providerId: MANAGED_OLLAMA_PROVIDER_ID, model: 'qwen3:8b' }) },
  { name: 'managed llama.cpp', ctx: () => ({ workingDir: workingDir(), providerId: MANAGED_LLAMACPP_PROVIDER_ID, model: 'local' }) },
  { name: 'gateway, proxy not ready', proxyReady: false, ctx: () => ({ workingDir: workingDir(), providerId: 'xd', model: 'claude-sonnet-4-5' }) },
  { name: 'SuperGrok, proxy not ready', proxyReady: false, ctx: () => ({ workingDir: workingDir(), providerId: 'xai', model: 'grok-4.6' }) },
];

/** What the desktop gives for each input (provider id and model count), so both sides cannot agree on nothing. */
const local = ['openai-codex:12', 'xai:5', 'cprov-key:1', 'cprov-none:1', 'cprov-routes:1', 'cindy-byom-openai-codex:1'];
const EXPECTED_SHAPES: Record<string, string[] | string> = {
  gateway: local, 'gateway, no provider': local, 'ChatGPT subscription': local,
  'ChatGPT subscription, resumed retired profile': local, SuperGrok: local, 'SuperGrok, resumed historical model': local,
  'custom provider, session-pinned interface': local, 'custom provider, preview': local,
  'remote session': ['cprov-key:1', 'cprov-none:1', 'cprov-routes:1', 'cindy-byom-openai-codex:1', 'cindy-byom-xai:5'],
  'managed Ollama': local, 'managed llama.cpp': local,
  'gateway, proxy not ready': ['cprov-key:1', 'cprov-none:1', 'cprov-routes:1', 'cindy-byom-openai-codex:1'],
  'SuperGrok, proxy not ready': 'PiNativeProviderProxyNotReadyError: SuperGrok Pi provider unavailable: local compatibility proxy is not ready',
};
const shape = (outcome: { result: unknown } | { thrown: string }) => ('result' in outcome
  ? (outcome.result as { providers: Array<{ id: string; models: unknown[] }> }).providers.map(p => `${p.id}:${p.models.length}`)
  : outcome.thrown);

/** The only differences allowed (C2): the Host has no managed local model runtime. */
const ALLOWED_DIFFERENCES: Record<string, { desktop: 'result'; host: string }> = {
  'managed Ollama': { desktop: 'result', host: 'Error: [LOCAL_OLLAMA_NOT_READY] Local model service is not ready (absent). Open Settings → Model Providers → Ollama.' },
  'managed llama.cpp': { desktop: 'result', host: 'Error: [LOCAL_LLAMACPP_NOT_READY] Reconnect llama.cpp in Settings → Model Providers.' },
};

// The fake Pi is a script with a shebang; the probe starts the binary without a shell, which
// Windows cannot do for a script. Cases that need the probe to run are POSIX only.
const fakePiRuns = process.platform !== 'win32';

describe('Host and desktop Pi native providers', () => {
  it.skipIf(!fakePiRuns)('report a failed probe as null without caching it, then probe again', async () => {
    fs.writeFileSync(probeFail, '');
    const first = await settle(host.resolvePiNativeProviders!({ workingDir: workingDir(), providerId: 'xd', model: 'claude-sonnet-4-5' }));
    expect(first).toHaveProperty('result');
    expect(probes()).toEqual(['--list-models']);
    // The failed probe left no catalog: the gateway block has no probed API for a Pi-only model.
    expect(resolvePiCindyGatewayModelSpec('xd', 'grok-4.6', { remote: false, runtimeBinaryPath: h.piBinary })).toBeUndefined();
    fs.rmSync(probeFail);
    await host.resolvePiNativeProviders!({ workingDir: workingDir(), providerId: 'xd', model: 'claude-sonnet-4-5' });
    expect(probes()).toEqual(['--list-models', '--list-models', expect.stringContaining('--mode rpc')]);
  });

  it('give the same providers and env for the same inputs, differing only where allowed', async () => {
    const differences: Record<string, unknown> = {};
    const shapes: Record<string, unknown> = {};
    let compared = 0;
    for (const input of inputs) {
      h.proxyReady = input.proxyReady ?? true;
      const desktop = await settle(resolvePiNativeProviders(input.ctx()));
      const hostResult = await settle(host.resolvePiNativeProviders!(input.ctx()));
      compared += 1;
      shapes[input.name] = shape(desktop);
      if (JSON.stringify(desktop) === JSON.stringify(hostResult)) continue;
      differences[input.name] = {
        desktop: 'result' in desktop ? 'result' : desktop.thrown,
        host: 'result' in hostResult ? 'result' : hostResult.thrown,
      };
    }
    h.proxyReady = true;
    expect(compared).toBe(inputs.length);
    expect(differences).toEqual(ALLOWED_DIFFERENCES);
    expect(shapes).toEqual(EXPECTED_SHAPES);
    // The probe ran once for this binary (the previous case); every later start reused it.
    if (fakePiRuns) expect(probes().filter(line => line === '--list-models')).toHaveLength(2);
  });

  it('refuse SuperGrok without the proxy before probing, on both sides', async () => {
    h.proxyReady = false;
    // A Pi binary this process has not probed yet: a probe would leave a line in the log.
    const unprobed = path.join(root, 'pi-bin-unprobed', 'pi');
    fs.mkdirSync(path.dirname(unprobed));
    writeFakePi(unprobed);
    const before = probes().length;
    const ctx = { workingDir: workingDir(), providerId: 'xai', model: 'grok-4.6', runtimeBinaryPath: unprobed };
    const desktop = await settle(resolvePiNativeProviders(ctx));
    const hostResult = await settle(host.resolvePiNativeProviders!(ctx));
    h.proxyReady = true;
    expect(desktop).toEqual({ thrown: expect.stringMatching(/^PiNativeProviderProxyNotReadyError/) });
    expect(hostResult).toEqual(desktop);
    expect(probes()).toHaveLength(before);
  });

  it('refresh the global Skill projection only on the desktop (row 25)', async () => {
    const before = h.globalSkillRefreshes;
    await resolvePiNativeProviders({ workingDir: workingDir(), providerId: 'xd', model: 'claude-sonnet-4-5' });
    expect(h.globalSkillRefreshes).toBe(before + 1);
    await host.resolvePiNativeProviders!({ workingDir: workingDir(), providerId: 'xd', model: 'claude-sonnet-4-5' });
    expect(h.globalSkillRefreshes).toBe(before + 1);
  });

  it('give Pi the gateway block API and compat from the same functions (P8, P9)', () => {
    expect(host.resolvePiGatewayModelApi).toBe(resolvePiCindyGatewayModelApi);
    expect(host.resolvePiGatewayModelSpec).toBe(resolvePiCindyGatewayModelSpec);
  });
});
