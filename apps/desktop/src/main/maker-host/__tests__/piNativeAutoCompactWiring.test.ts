/**
 * Desktop Pi runtime leaves automatic compaction to Pi itself.
 * The shared host percentage remains a Claude Code setting.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
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
  claudeUpstreamEndpoint: () => 'https://example.test',
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

import { buildPiAgent } from '../pi-host.js';
import type { AgentRuntimeConfig } from '@cindy/maker-core';

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

describe('Desktop Pi auto-compact wiring', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'pi-ac-wiring-'));
    state.userDataPath = path.join(root, 'user-data');
    state.binaryPath = path.join(root, 'pi');
    state.ripgrepPath = path.join(root, 'rg');
    mkdirSync(state.userDataPath, { recursive: true });
    writeFileSync(state.ripgrepPath, 'fake managed ripgrep');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not inject the shared host compaction threshold into Pi runtimeConfig', () => {
    const agent = buildPiAgent({ logger });
    expect(agent).not.toBeNull();
    const runtimeConfig = (agent as unknown as { deps: { runtimeConfig: AgentRuntimeConfig } })
      .deps.runtimeConfig;
    expect(runtimeConfig.autoCompactThresholdPct).toBeUndefined();
  });
});
