/**
 * GrokBuildAgent capabilities contract — permissionModes must be strict→wide,
 * `[0]` is the strictest mode (hook-control/defaults.ts falls back to it).
 */
import { describe, expect, it } from 'vitest';

import { GrokBuildAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function buildAgent(): GrokBuildAgent {
  const deps: AgentDeps = {
    auth: {
      getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: {},
    binaryPath: '/nonexistent/grok',
    logger: noopLogger,
  };
  return new GrokBuildAgent(deps);
}

describe('GrokBuildAgent capabilities contract', () => {
  it('declares permission modes strict→wide with ask first (unattended clamp safety)', () => {
    const ids = buildAgent().capabilities.permissionModes.map((m) => m.id);
    expect(ids).toEqual(['ask', 'auto', 'bypassPermissions']);
    expect(ids[0]).toBe('ask');
    expect(ids[ids.length - 1]).toBe('bypassPermissions');
  });

  it('every permission mode ships an English fallback label + description', () => {
    for (const m of buildAgent().capabilities.permissionModes) {
      expect(m.displayName && m.displayName.length > 0).toBe(true);
      expect(m.description && m.description.length > 0).toBe(true);
      expect(/[一-鿿]/.test(`${m.displayName}${m.description}`)).toBe(false);
    }
  });

  it('does not expose Fast mode', () => {
    expect(buildAgent().capabilities.hasFastMode).toBe(false);
  });

  it('supports host turn policies in ask/auto but rejects Full Access', () => {
    expect(buildAgent().capabilities.turnPermissionPolicy).toEqual({
      supported: { supported: true },
      unsupportedPermissionModes: ['bypassPermissions'],
    });
  });

  it('is a Cindy-hosted harness: rewind/fork/plan, no Grok Build model category', () => {
    const capabilities = buildAgent().capabilities;
    expect(buildAgent().kind).toBe('grok-build');
    expect(capabilities.availableModels.some((model) => model.id === 'grok-build')).toBe(false);
    expect(capabilities.rewind).toEqual({ supported: true });
    expect(capabilities.fork).toEqual({ supported: true });
    expect(capabilities.planMode).toEqual({ supported: true });
    expect(capabilities.sameTurnSteer).toEqual({ supported: true });
    expect(capabilities.abort).toEqual({ supported: true });
  });

  it('accepts exclusive Grok catalog slugs from the host model plane', () => {
    const agent = new GrokBuildAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {},
      binaryPath: '/nonexistent/pi',
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.5', displayName: 'Grok 4.5', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
    });
    expect(agent.capabilities.availableModels.map((model) => model.id)).toEqual([
      'grok-4.6',
      'xai/grok-4.5',
    ]);
    expect(agent.capabilities.availableModels.some((model) => model.id === 'grok-build')).toBe(false);
  });
});
