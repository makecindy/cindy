import type { AgentEvent } from '@cindy/maker-core';
import { GATEWAY_PROXY_TOKEN_INVALID_REASON } from '@cindy/maker-shared/error-redaction';
import { describe, expect, it } from 'vitest';

import { isGatewayProxyTokenRecoveryErrorEventForProvider } from '../gatewayProxyTokenRecovery.js';

function errorEvent(data: Record<string, unknown>): AgentEvent {
  return { type: 'error', source: 'claude-code', data } as AgentEvent;
}

describe('isGatewayProxyTokenRecoveryErrorEventForProvider', () => {
  const tokenInvalid = errorEvent({ message: 'Authentication failed', reason: GATEWAY_PROXY_TOKEN_INVALID_REASON });

  it('matches terminal key failures on Cindy AI sessions, including legacy sessions without a provider', () => {
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider('xd', tokenInvalid)).toBe(true);
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider(null, tokenInvalid)).toBe(true);
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider(undefined, tokenInvalid)).toBe(true);
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider(
      'xd',
      errorEvent({ message: 'Invalid proxy server token passed' }),
    )).toBe(true);
  });

  it('ignores other providers, other errors, retryable errors and non-error events', () => {
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider('openai', tokenInvalid)).toBe(false);
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider('xd', errorEvent({ message: 'Rate limited' }))).toBe(false);
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider(
      'xd',
      errorEvent({ reason: GATEWAY_PROXY_TOKEN_INVALID_REASON, isTerminal: false }),
    )).toBe(false);
    expect(isGatewayProxyTokenRecoveryErrorEventForProvider(
      'xd',
      { type: 'done', source: 'claude-code', data: {} } as AgentEvent,
    )).toBe(false);
  });
});
