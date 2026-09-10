import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  args: [] as string[],
  env: {} as Record<string, string | undefined>,
  binaryPath: '',
  ripgrepPath: '',
  userDataPath: '',
}));

// Account discovery persistence is outside this runtime/route fixture.
vi.mock('../model-discovery/xai.js', () => ({
  discardXaiModelsDiskCache: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userDataPath,
  },
}));

vi.mock('../../agent-binaries/index.js', () => ({
  getReadyBinaryPath: () => state.binaryPath,
}));

vi.mock('../runtime-configs.js', () => ({
  getRipgrepBinaryPath: () => state.ripgrepPath,
}));

vi.mock('../../mcp-integrations/piEnvironment.js', () => ({
  getPiExtraSpawnConfig: async () => ({ mcpBridge: null, mcpEnv: {} }),
}));

vi.mock('../auth-adapters.js', () => ({
  desktopClaudeAuthAdapter: { ensureSharedGlobalSkills: async () => undefined },
  desktopCodexAuthAdapter: {},
  readClaudeApiKey: () => 'test-key',
}));

vi.mock('../anthropic-compat-proxy-host.js', () => ({
  getClaudeEndpoint: () => 'http://127.0.0.1:9',
}));

vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuth: () => false,
}));

vi.mock('../grok-oauth-login.js', () => ({
  hasGrokOAuthLogin: () => false,
}));

vi.mock('../custom-provider-header-secrets.js', () => ({
  listCustomProvidersWithSecureHeaders: async () => [],
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: () => null,
}));

vi.mock('../memory-settings-store.js', () => ({
  readMemorySettings: () => ({ pi: false, maker: false }),
}));

vi.mock('../pi-package-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pi-package-store.js')>()),
  resolveManagedPiNativePackagePaths: async () => [],
  resolveManagedPiPackageResources: async () => ({
    extensions: [],
    skills: [],
    promptTemplates: [],
    packageRoots: [],
  }),
}));

vi.mock('../pi-proxy-session-auth.js', () => ({
  registerPiProxySession: () => undefined,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child() {
      return this;
    },
  }),
}));

// args 经 createTransport → createPiStdioTransport 传递(不在 PiRpcProcess 构造
// 参数里, 自轮 22 起); 测试从 stdio transport 的 opts 捕获 spawn args。
vi.mock('../../../../../../packages/maker-core/src/agents/pi/transport.js', () => ({
  createPiStdioTransport: (opts: { args: string[]; env: Record<string, string | undefined> }) => {
    state.args = opts.args;
    state.env = opts.env;
    return {} as never;
  },
}));

vi.mock('../../../../../../packages/maker-core/src/agents/pi/rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;

    constructor(_opts: Record<string, unknown>) {}

    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown }> {
      if (cmd.type === 'get_state') {
        return {
          success: true,
          data: { sessionFile: '/mock/session.jsonl', model: { contextWindow: 200_000 } },
        };
      }
      return { success: true, data: { entries: [] } };
    }

    send(): void {}

    async close(): Promise<void> {
      this.isClosed = true;
    }
  },
}));

import { buildPiAgent } from '../pi-host.js';
import { setXdGatewayModels } from '../active-catalog.js';

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child() {
    return this;
  },
};

describe('buildPiAgent roster prompt assembly', () => {
  let root = '';
  let workingDir = '';

  beforeEach(() => {
    state.args = [];
    root = mkdtempSync(path.join(tmpdir(), 'pi-roster-assembly-'));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'native-pi-home'));
    mkdirSync(process.env.PI_CODING_AGENT_DIR!);
    writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, 'AGENTS.md'), 'host global context canary');
    workingDir = path.join(root, 'workspace');
    state.userDataPath = path.join(root, 'user-data');
    state.binaryPath = path.join(root, 'pi');
    state.ripgrepPath = path.join(root, 'rg');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(state.userDataPath, { recursive: true });
    writeFileSync(state.ripgrepPath, 'fake managed ripgrep');
    setXdGatewayModels([{
      id: 'm',
      name: 'M',
      contextWindow: 200_000,
      agents: ['pi'],
      perAgent: { pi: { wireProtocol: 'openai-responses' } },
    }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setXdGatewayModels([]);
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['default', 'override', 'tilde'])('forwards roster and %s user context through real PiAgent startup', async (source) => {
    if (source !== 'override') {
      const defaultHome = path.join(root, '.pi', 'agent');
      mkdirSync(defaultHome, { recursive: true });
      writeFileSync(path.join(defaultHome, 'AGENTS.md'), 'host global context canary');
      vi.stubEnv('PI_CODING_AGENT_DIR', source === 'tilde' ? '~/.pi/agent' : undefined);
    }
    const getGhostRosterPrompt = vi.fn(({ workingDir: cwd }: { workingDir?: string }) =>
      cwd ? '<ghost-roster>\n{"id":"art"}\n</ghost-roster>' : '',
    );
    const agent = buildPiAgent({
      logger,
      getGhostRosterPrompt,
      capabilityAdditions: {
        availableModels: [
          {
            id: 'm',
            displayName: 'M',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            maxOutputTokens: 64_000,
          },
        ],
      },
    });
    expect(agent).not.toBeNull();

    const handle = await agent!.startSession({
      sessionId: 'roster-session',
      workingDir,
      model: 'm',
    });
    const promptIndex = state.args.indexOf('--append-system-prompt');
    expect(promptIndex).toBeGreaterThan(-1);
    expect(state.args[promptIndex + 1]).toContain(
      '<ghost-roster>\n{"id":"art"}\n</ghost-roster>',
    );
    expect(getGhostRosterPrompt).toHaveBeenCalledWith({ workingDir });
    expect(readFileSync(path.join(state.env.PI_CODING_AGENT_DIR!, 'AGENTS.md'), 'utf8'))
      .toBe('host global context canary');
    await handle.close();
  });
});
