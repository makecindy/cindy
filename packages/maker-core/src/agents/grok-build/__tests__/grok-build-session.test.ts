/**
 * GrokBuildAgent is a Cindy-hosted Pi loop with kind grok-build.
 * ACP stdio session tests no longer apply to this class.
 */
import { describe, expect, it } from 'vitest';

import { GrokBuildAgent } from '../index.js';
import { PiAgent } from '../../pi/index.js';
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
    binaryPath: '/nonexistent/pi',
    logger: noopLogger,
  };
  return new GrokBuildAgent(deps);
}

describe('GrokBuildAgent hosted-loop identity', () => {
  it('is a Pi-hosted Cindy harness with grok-build kind', () => {
    const agent = buildAgent();
    expect(agent).toBeInstanceOf(PiAgent);
    expect(agent.kind).toBe('grok-build');
    expect(agent.kind).not.toBe('pi');
  });
});
