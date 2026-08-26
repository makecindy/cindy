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

  it('exposes a built-in Grok Build model and abort', () => {
    const capabilities = buildAgent().capabilities;
    expect(capabilities.availableModels.some((model) => model.id === 'grok-build')).toBe(true);
    expect(capabilities.abort).toEqual({ supported: true });
  });
});
