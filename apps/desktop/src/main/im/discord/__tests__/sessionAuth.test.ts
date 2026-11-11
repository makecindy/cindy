import { describe, expect, it, vi } from 'vitest';

import type { AgentKind } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getAgentAuthState: vi.fn(),
  listProviders: vi.fn(),
  hasCustomProviderKey: vi.fn(),
  readXdGatewayApiKey: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: mocks.ipcHandle } }));
vi.mock('../../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../../maker-host', () => ({
  getMaker: () => ({ getAgentAuthState: mocks.getAgentAuthState }),
}));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('../../../maker-host/provider-route', () => ({
  hasCustomProviderKey: mocks.hasCustomProviderKey,
}));
vi.mock('../../shared/apiKey', () => ({
  readXdGatewayApiKey: mocks.readXdGatewayApiKey,
}));

import type { ImAuthCheckDeps } from '../../shared/authCheck';
import type { ImOrchestratorConfig } from '../../shared/types';
import { checkDiscordSessionAuth } from '../sessionAuth';

const config: ImOrchestratorConfig = {
  agentKind: 'claude-code',
  defaultModel: 'claude-opus-4-8',
  defaultPermissionMode: 'auto',
  effortOverrides: { 'claude-opus-4-8': 'xhigh' },
};

function authDeps(providers: ProviderView[]): ImAuthCheckDeps {
  return {
    readXdGatewayApiKey: vi.fn(() => null),
    hasCustomProviderKey: vi.fn(() => false),
    getAgentAuthState: vi.fn(async () => ({ authenticated: false })),
    listProviders: vi.fn(async () => providers),
    warn: vi.fn(),
  };
}

function provider(id: string, name: string, agentKind: AgentKind = 'codex'): ProviderView {
  return {
    id,
    name,
    source: 'builtin',
    connected: true,
    agents: [agentKind],
    auth: { method: 'apiKey' },
    routing: {},
    models: { [agentKind]: [] },
  };
}

describe('checkDiscordSessionAuth', () => {
  it('maps resolved Discord IM defaults through auth check and resolves provider label', async () => {
    const providers = [provider('openai', 'OpenAI'), provider('xd', 'XD Gateway')];
    const deps = authDeps(providers);
    const resolveDefaults = vi.fn(async (receivedConfig: ImOrchestratorConfig) => {
      expect(receivedConfig).toBe(config);
      return {
        agentKind: 'codex' as const,
        model: 'gpt-5.5',
        effort: 'high' as const,
        providerId: 'openai',
        permissionMode: 'auto' as const,
        fastMode: false,
        fingerprint: 'fp',
      };
    });
    const checkAuth = vi.fn(
      async (
        row: { agentKind: AgentKind; model: string; providerId: string | null },
        providerSnapshot: ProviderView[] | null | undefined,
        receivedDeps: ImAuthCheckDeps,
      ) => {
        expect(row).toEqual({
          agentKind: 'codex',
          model: 'gpt-5.5',
          providerId: 'openai',
        });
        expect(providerSnapshot).toBeUndefined();
        await receivedDeps.listProviders();
        return { ok: false, missing: 'provider-key' as const };
      },
    );

    await expect(
      checkDiscordSessionAuth(config, { resolveDefaults, checkAuth, authDeps: deps }),
    ).resolves.toEqual({
      ok: false,
      missing: 'provider-key',
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      providerLabel: 'OpenAI',
    });
    expect(resolveDefaults).toHaveBeenCalledTimes(1);
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(deps.listProviders).toHaveBeenCalledTimes(1);
  });

  it('returns null providerLabel when the selected provider is absent from the snapshot', async () => {
    const deps = authDeps([provider('xd', 'XD Gateway')]);
    const resolveDefaults = vi.fn(async () => ({
      agentKind: 'claude-code' as const,
      model: 'claude-opus-4-8',
      effort: 'xhigh' as const,
      providerId: 'anthropic',
      permissionMode: 'auto' as const,
      fastMode: false,
      fingerprint: 'fp',
    }));
    const checkAuth = vi.fn(async () => ({ ok: true, missing: null }));

    await expect(
      checkDiscordSessionAuth(config, { resolveDefaults, checkAuth, authDeps: deps }),
    ).resolves.toMatchObject({
      ok: true,
      missing: null,
      providerId: 'anthropic',
      providerLabel: null,
    });
  });
});
