/**
 * 测试价值
 * - 可观察结果：同一组输入（引擎、来源、凭证形态、本机/远端、用户设置）下，桌面装配
 *   （runtime-configs.ts、pi-host.ts 的 buildPiAgent）与 Node Host 装配
 *   （apps/host/src/agent/runtime.ts 的 createHostAgentGraph）交给 maker-core 的
 *   runtimeConfig 逐项相同：systemPrompt、answerDeliveryPrompt 逐字比较，函数项
 *   （behaviorFlags、taskShellEnv、换模型评估、子代理模型）按输入矩阵比较输出。
 * - 规则依据：Host 任务必须带与桌面相同的 Cindy 系统提示与运行开关
 *   （docs/host/personal-migration-release-table.md 第 23 行）；提示词只改装配方，不改文字。
 * - 允许不同的字段写死在 ALLOWED_DIFFERENCES，现在为空：两边的 Claude 与 Pi 都指向本机兼容
 *   代理（放行表第 24 行）。出现任何一项差异，或任一方多出／缺少字段，即失败。
 * - tier：unit（只构造实例、读配置，不起子进程、不调模型）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { app } from 'electron';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeConfig } from '@cindy/maker-core';

// Everything below is needed only to construct the desktop PiAgent; none of it
// feeds runtimeConfig, and the Host graph does not import these modules.
vi.mock('../managed-skills.js', () => ({
  listCindyManagedSkills: async () => [],
  cindyManagedSkillRoots: async () => [],
}));
vi.mock('../model-discovery/xai.js', () => ({ discardXaiModelsDiskCache: vi.fn(async () => {}) }));
vi.mock('../../mcp-integrations/piEnvironment.desktop.js', () => ({
  getPiExtraSpawnConfig: async () => ({ mcpBridge: null, mcpEnv: {} }),
}));
vi.mock('../auth-adapters.js', () => ({ desktopCodexAuthAdapter: {}, readClaudeApiKey: () => 'test-key' }));
vi.mock('../anthropic-compat-proxy-host.js', () => ({ getClaudeEndpoint: () => 'http://127.0.0.1:9' }));
vi.mock('../grok-oauth-login.desktop.js', () => ({ hasGrokOAuthLogin: () => false }));
vi.mock('../custom-provider-header-secrets.js', () => ({ listCustomProvidersWithSecureHeaders: async () => [] }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ readCustomProviderKey: () => null }));
vi.mock('../pi-proxy-session-auth.js', () => ({ registerPiProxySession: () => undefined }));
// The desktop Pi binary comes from the binary cache; it is never spawned here.
vi.mock('../../agent-binaries/index.js', () => ({
  getReadyBinaryPath: () => '/nonexistent/parity-pi',
  getCachedBinaryStatus: () => ({ binaryReady: false }),
}));

/** Fields allowed to differ, each with its reason in the release table. None since row 24. */
const ALLOWED_DIFFERENCES = new Set<string>();
/** Both sides' loopback proxy endpoint in this test (desktop mock above, Host proxy view below). */
const PROXY_ENDPOINT = 'http://127.0.0.1:9';

type Config = AgentRuntimeConfig & Record<PropertyKey, unknown>;

const FLAG_CONTEXTS = (['local', 'remote'] as const).flatMap((spawnMode) =>
  [undefined, 'gateway-key', 'oauth-bearer', 'provider-oauth'].flatMap((credentialMode) =>
    [undefined, 'xd', 'anthropic', 'openai', 'custom-fixture'].map((sessionProviderId) => ({
      spawnMode,
      credentialMode,
      sessionProviderId,
    })),
  ),
);
const SUBAGENT_ROUTES = [undefined, null, 'xd', 'anthropic', 'openai'].flatMap((providerId) =>
  [undefined, 'gateway-key', 'oauth-bearer'].map((credentialMode) => [providerId, credentialMode] as const),
);
const CONTEXT_ASSESSMENTS = [[1_000, 200_000], [180_000, 200_000], [250_000, 200_000], [90_000, 128_000]] as const;

/** Every observable value of a runtime config; functions become their outputs over fixed inputs. */
function observe(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(config)) {
    const name = String(key);
    const value = config[key];
    if (typeof value !== 'function') {
      out[name] = value;
      continue;
    }
    switch (name) {
      case 'behaviorFlags':
        out[name] = FLAG_CONTEXTS.map((ctx) => (value as (c: unknown) => unknown)(ctx));
        break;
      case 'taskShellEnv':
        out[name] = (value as (c: unknown) => unknown)({ sessionId: 'parity-task' });
        break;
      case 'shouldHandoffAfterContextAssessment':
        out[name] = CONTEXT_ASSESSMENTS.map(([tokens, window]) => (value as (a: number, b: number) => unknown)(tokens, window));
        break;
      case 'subagentModelForRoute':
        out[name] = SUBAGENT_ROUTES.map(([providerId, mode]) => (value as (p: unknown, m: unknown) => unknown)(providerId, mode));
        break;
      default:
        throw new Error(`runtimeConfig function "${name}" has no comparison inputs; add them here`);
    }
  }
  return out;
}

function compare(kind: string, desktop: Config, host: Config): void {
  const d = observe(desktop);
  const h = observe(host);
  expect(Object.keys(h).sort(), `${kind}: field set`).toEqual(Object.keys(d).sort());
  const differing = Object.keys(d).filter((key) => JSON.stringify(d[key]) !== JSON.stringify(h[key]));
  expect(differing.filter((key) => !ALLOWED_DIFFERENCES.has(key)), `${kind}: unexpected differences`).toEqual([]);
  for (const key of Object.keys(d)) {
    if (!ALLOWED_DIFFERENCES.has(key)) expect(h[key], `${kind}.${key}`).toEqual(d[key]);
  }
}

describe('Host runtime config parity with the desktop assembly', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'host-runtime-config-parity-'));
  let desktop: { claude: Config; codex: Config; pi: Config };
  let host: { claude: Config; codex: Config; pi: Config };

  // Both assemblies load the full engine graphs; under the parallel desktop pool
  // a cold transform takes far longer than the 10 s default hook timeout.
  beforeAll(async () => {
    const { commitVolatileAppSession } = await import('../../appSessionState.js');
    commitVolatileAppSession('local');
    const { buildDesktopClaudeRuntimeConfig, desktopCodexRuntimeConfig } = await import('../runtime-configs.js');
    const { getClaudeEndpoint } = await import('../anthropic-compat-proxy-host.js');
    const { buildPiAgent } = await import('../pi-host.js');
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
    const piAgent = buildPiAgent({ logger } as never) as unknown as { deps: { runtimeConfig: Config } } | null;
    if (!piAgent) throw new Error('desktop PiAgent was not built');
    desktop = {
      // maker-host/index.ts builds Claude with the compat proxy endpoint.
      claude: buildDesktopClaudeRuntimeConfig(getClaudeEndpoint) as Config,
      codex: desktopCodexRuntimeConfig as Config,
      pi: piAgent.deps.runtimeConfig,
    };

    // A non-literal specifier keeps the Host sources out of the desktop typecheck;
    // the Host checks them in its own typecheck job.
    const hostRuntime = '../../../../../host/src/agent/runtime.ts';
    const { createHostAgentGraph } = (await import(/* @vite-ignore */ hostRuntime)) as {
      createHostAgentGraph(options: Record<string, unknown>): Record<'agent' | 'codex' | 'pi', unknown>;
    };
    const graph = createHostAgentGraph({
      // The same user-data root the desktop configs read from Electron.
      userDataDir: app.getPath('userData'),
      gateway: { endpoint: 'https://gateway.test/v1', credential: 'fixture-key' },
      binaryPath: path.join(root, 'claude'),
      codexBinaryPath: path.join(root, 'codex'),
      piBinaryPath: path.join(root, 'pi'),
      // The Host's loopback proxy (claude-proxy-runtime.ts), reduced to what the graph reads.
      claudeProxy: { endpoint: () => PROXY_ENDPOINT, isReady: () => true, inboundSecret: () => 'fixture-secret',
        registerPiProxySession: () => () => {}, closeSession() {} },
      mcpRuntime: { codexDeps: {}, piDeps: {}, getActiveCodexBridgeServerNames: () => [] } as never,
      mcpProviders: [],
      storage: {} as never,
      providerConfig: {
        grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
        list: async () => [],
        readKey: () => null,
        oauth: { readCachedGenericOAuthAccessToken: () => null },
        codexAccounts: {
          setCodexAccountRetirement: () => {},
          isCodexAccountProvider: () => false,
          codexAccountState: () => ({ authenticated: false }),
        },
      } as never,
    });
    host = {
      claude: (graph.agent as unknown as { deps: { runtimeConfig: Config } }).deps.runtimeConfig,
      codex: (graph.codex as unknown as { deps: { runtimeConfig: Config } }).deps.runtimeConfig,
      pi: (graph.pi as unknown as { deps: { runtimeConfig: Config } }).deps.runtimeConfig,
    };
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('the product prompts are identical, character for character', () => {
    for (const kind of ['claude', 'codex', 'pi'] as const) {
      expect(typeof host[kind].systemPrompt).toBe('string');
      expect(host[kind].systemPrompt, `${kind} systemPrompt`).toBe(desktop[kind].systemPrompt);
      expect(host[kind].answerDeliveryPrompt, `${kind} answerDeliveryPrompt`).toBe(desktop[kind].answerDeliveryPrompt);
    }
    expect(host.claude.systemPrompt).toContain('You are Cindy');
  });

  it('every field matches under the default settings; only the listed fields may differ', () => {
    compare('claude', desktop.claude, host.claude);
    compare('codex', desktop.codex, host.codex);
    compare('pi', desktop.pi, host.pi);
  });

  it('both read the same user settings at the moment of use', async () => {
    const { writeMemorySetting } = await import('../memory-settings-store.js');
    const { writeSubagentModelSettingsPatch } = await import('../subagent-model-settings-store.js');
    const { writeAgentResourceSetting } = await import('../agent-resource-settings-store.js');
    writeMemorySetting('maker', true);
    writeMemorySetting('claudeCode', false);
    writeMemorySetting('codex', false);
    writeMemorySetting('pi', true);
    writeSubagentModelSettingsPatch({ claudeCode: 'claude-sonnet-4-5' });
    writeAgentResourceSetting('capToolchainThreads', false);
    compare('claude', desktop.claude, host.claude);
    compare('codex', desktop.codex, host.codex);
    compare('pi', desktop.pi, host.pi);
    writeAgentResourceSetting('capToolchainThreads', true);
    writeMemorySetting('maker', false);
    compare('claude', desktop.claude, host.claude);
    compare('pi', desktop.pi, host.pi);
  });

  it('Claude and Pi reach the loopback proxy on both sides, never the gateway directly', () => {
    for (const config of [desktop.claude, host.claude, desktop.pi, host.pi]) {
      expect(config.endpoint).toBe(PROXY_ENDPOINT);
      expect(new URL(String(config.endpoint)).hostname).toBe('127.0.0.1');
    }
    expect('endpoint' in desktop.codex).toBe(false);
    expect('endpoint' in host.codex).toBe(false);
  });
});
