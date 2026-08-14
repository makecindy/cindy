import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  args: [] as string[],
  binaryPath: '',
  ripgrepPath: '',
  userDataPath: '',
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

vi.mock('../../../../../../packages/maker-core/src/agents/pi/rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;

    constructor(opts: { args: string[] }) {
      state.args = opts.args;
    }

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
    setXdGatewayModels([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('forwards the host roster callback through real PiAgent startSession spawn args', async () => {
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
    await handle.close();
  });
});
