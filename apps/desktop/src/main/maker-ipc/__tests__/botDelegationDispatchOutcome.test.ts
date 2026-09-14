import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_PROVIDER_NOT_READY_CODE,
  BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS,
  classifyBotDelegationDispatchFailure,
} from '../botDelegationDispatchOutcome';

describe('Bot delegation dispatch outcome', () => {
  it('turns a not-signed-in host into a terminal, human-readable failure instead of endless retries', () => {
    const verdict = classifyBotDelegationDispatchFailure({
      errorCode: 'AGENT_NOT_READY',
      message: `${ACCOUNT_PROVIDER_NOT_READY_CODE}: account provider models are not ready`,
      attempt: 0,
    });
    expect(verdict).toEqual({
      kind: 'fatal',
      errorCode: 'ACCOUNT_NOT_READY',
      message: expect.stringContaining('需要登录后才能执行'),
    });
  });

  it('accepts the readiness marker from the error code as well as the message', () => {
    expect(
      classifyBotDelegationDispatchFailure({
        errorCode: ACCOUNT_PROVIDER_NOT_READY_CODE,
        message: 'anything',
        attempt: 0,
      }).kind,
    ).toBe('fatal');
  });

  it('never retries a child task that no longer exists', () => {
    for (const errorCode of ['ARCHIVED', 'DELETED', 'NOT_FOUND']) {
      expect(
        classifyBotDelegationDispatchFailure({ errorCode, message: 'gone', attempt: 0 }),
      ).toEqual({ kind: 'fatal', errorCode, message: expect.stringContaining('gone') });
    }
  });

  it('retries a transient host failure but gives up before the delegation deadline', () => {
    for (let attempt = 0; attempt < BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS - 1; attempt += 1) {
      expect(
        classifyBotDelegationDispatchFailure({
          errorCode: 'INTERNAL',
          message: 'agent restarting',
          attempt,
        }),
      ).toEqual({ kind: 'retry' });
    }
    expect(
      classifyBotDelegationDispatchFailure({
        errorCode: 'INTERNAL',
        message: 'agent restarting',
        attempt: BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS - 1,
      }),
    ).toEqual({
      kind: 'fatal',
      errorCode: 'DISPATCH_UNAVAILABLE',
      message: expect.stringContaining('agent restarting'),
    });
  });

  it('honours an explicit attempt ceiling', () => {
    expect(
      classifyBotDelegationDispatchFailure({
        errorCode: 'INTERNAL',
        message: 'busy',
        attempt: 0,
        maxAttempts: 1,
      }).kind,
    ).toBe('fatal');
  });
});
