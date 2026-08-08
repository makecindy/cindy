import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ownerId: 'owner-a' as string | null,
  generation: 3,
  boundaryPending: false,
  bindingState: 'bound' as 'bound' | 'unbound' | 'unreadable',
  cancelCalls: 0,
  clearCalls: 0,
  clearError: null as Error | null,
  clearResult: 'cleared' as 'cleared' | 'absent',
  pendingResult: true,
  validationResult: null as boolean | null,
  unbindResult: null as boolean | null,
  events: [] as string[],
  unbindCalls: [] as Array<{
    provider: string;
    options: {
      revoked?: boolean;
      expectedOwner?: { dataOwnerId: string; generation: number };
      expectedOperation?: {
        dataOwnerId: string;
        generation: number;
        operationId: string;
        intent: 'revoke';
      };
      requirePendingRevocation?: boolean;
    };
  }>,
  pendingCalls: [] as Array<{
    provider: string;
    owner: { dataOwnerId: string; generation: number };
    options?: {
      supersedeMatchingAuthorization?: boolean;
      operation?: {
        dataOwnerId: string;
        generation: number;
        operationId: string;
        intent: 'revoke';
      };
    };
  }>,
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: h.ownerId ? 'cloud' : 'signed-out',
    dataOwnerId: h.ownerId,
    generation: h.generation,
  }),
  isAppSessionBoundaryPending: () => h.boundaryPending,
}));

vi.mock('../claude-credentials-store.js', () => ({
  clearClaudeAiOAuthWithBindingCommit: (
    validateBinding: () => boolean,
    commitBinding: () => boolean,
  ) => {
    if (!validateBinding()) return 'binding-changed';
    h.events.push('credential-clear');
    h.clearCalls += 1;
    if (h.clearError) throw h.clearError;
    if (!commitBinding()) return 'binding-changed';
    return h.clearResult;
  },
  readClaudeAiOAuth: () => null,
  replaceClaudeAiOAuthIfMatches: vi.fn(() => 'written'),
}));

vi.mock('../nativeProviderAuthBinding.js', () => ({
  captureNativeProviderAuthOwnerFence: () =>
    h.ownerId && !h.boundaryPending ? { dataOwnerId: h.ownerId, generation: h.generation } : null,
  beginNativeProviderAuthDisconnect: () => {
    h.events.push('logout-intent');
    return {
      dataOwnerId: 'owner-a',
      generation: 3,
      operationId: 'logout-operation',
      intent: 'revoke',
    };
  },
  getNativeProviderAuthBindingState: () => h.bindingState,
  getNativeProviderAuthBindingStateForOperation: () => h.bindingState,
  abandonNativeProviderAuthOperation: () => {
    h.events.push('logout-intent-cleared');
    return true;
  },
  validateNativeProviderAuthRevocationPending: () => {
    h.events.push('binding-check');
    return h.validationResult ?? h.bindingState === 'bound';
  },
  markNativeProviderAuthRevocationPending: (
    provider: string,
    owner: { dataOwnerId: string; generation: number },
    options?: {
      supersedeMatchingAuthorization?: boolean;
      operation?: {
        dataOwnerId: string;
        generation: number;
        operationId: string;
        intent: 'revoke';
      };
    },
  ) => {
    h.events.push('revoke-staged');
    h.pendingCalls.push({ provider, owner, options });
    return h.pendingResult;
  },
  unbindNativeProviderAuth: (
    provider: string,
    options: {
      revoked?: boolean;
      expectedOwner?: { dataOwnerId: string; generation: number };
      expectedOperation?: {
        dataOwnerId: string;
        generation: number;
        operationId: string;
        intent: 'revoke';
      };
      requirePendingRevocation?: boolean;
    },
  ) => {
    h.events.push('binding-commit');
    h.unbindCalls.push({ provider, options });
    if (h.unbindResult !== null) return h.unbindResult;
    return (
      h.bindingState === 'bound' &&
      h.ownerId === options.expectedOperation?.dataOwnerId &&
      h.generation === options.expectedOperation?.generation &&
      !h.boundaryPending
    );
  },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../outbound-fetch.js', () => ({ outboundFetch: vi.fn() }));

import {
  disconnectClaudeAiOAuth,
  setClaudeOAuthLoginCancellationHandler,
} from '../claude-oauth-refresh.js';

describe('disconnectClaudeAiOAuth — shared logout transaction', () => {
  beforeEach(() => {
    h.ownerId = 'owner-a';
    h.generation = 3;
    h.boundaryPending = false;
    h.bindingState = 'bound';
    h.cancelCalls = 0;
    h.clearCalls = 0;
    h.clearError = null;
    h.clearResult = 'cleared';
    h.pendingResult = true;
    h.validationResult = null;
    h.unbindResult = null;
    h.events.length = 0;
    h.unbindCalls.length = 0;
    h.pendingCalls.length = 0;
    setClaudeOAuthLoginCancellationHandler(() => {
      h.cancelCalls += 1;
      h.events.push('login-cancelled');
    });
  });

  it('clears the bound credential and persists revocation for the same owner generation', () => {
    expect(disconnectClaudeAiOAuth()).toBe('revoked');

    expect(h.clearCalls).toBe(1);
    expect(h.unbindCalls).toEqual([
      {
        provider: 'anthropic',
        options: {
          revoked: true,
          expectedOperation: {
            dataOwnerId: 'owner-a',
            generation: 3,
            operationId: 'logout-operation',
            intent: 'revoke',
          },
          requirePendingRevocation: true,
        },
      },
    ]);
    expect(h.pendingCalls).toEqual([
      {
        provider: 'anthropic',
        owner: { dataOwnerId: 'owner-a', generation: 3 },
        options: {
          supersedeMatchingAuthorization: true,
          operation: {
            dataOwnerId: 'owner-a',
            generation: 3,
            operationId: 'logout-operation',
            intent: 'revoke',
          },
        },
      },
    ]);
    expect(h.events).toEqual([
      'login-cancelled',
      'logout-intent',
      'revoke-staged',
      'binding-check',
      'credential-clear',
      'binding-commit',
    ]);
  });

  it('closes a stale binding but reports absent OAuth so the adapter can continue gateway logout', () => {
    h.clearResult = 'absent';

    expect(disconnectClaudeAiOAuth()).toBe('confirmed-unbound');

    expect(h.clearCalls).toBe(1);
    expect(h.unbindCalls).toHaveLength(1);
    expect(h.events).toEqual([
      'login-cancelled',
      'logout-intent',
      'revoke-staged',
      'binding-check',
      'credential-clear',
      'binding-commit',
    ]);
  });

  it('binding unreadable: records a durable pending revocation and deletes no credential', () => {
    h.bindingState = 'unreadable';

    expect(() => disconnectClaudeAiOAuth()).toThrow(/ownership changed/i);
    expect(h.clearCalls).toBe(0);
    expect(h.unbindCalls).toHaveLength(0);
    expect(h.pendingCalls).toEqual([
      {
        provider: 'anthropic',
        owner: { dataOwnerId: 'owner-a', generation: 3 },
        options: {
          supersedeMatchingAuthorization: true,
          operation: {
            dataOwnerId: 'owner-a',
            generation: 3,
            operationId: 'logout-operation',
            intent: 'revoke',
          },
        },
      },
    ]);
  });

  it('credential clear failure keeps the durable pending marker before reporting failure', () => {
    h.clearError = new Error('keychain locked');

    expect(() => disconnectClaudeAiOAuth()).toThrow('keychain locked');
    expect(h.unbindCalls).toHaveLength(0);
    expect(h.pendingCalls).toHaveLength(1);
  });

  it('confirmed unbound ownership never clears a shared Claude CLI credential', () => {
    h.bindingState = 'unbound';

    expect(() => disconnectClaudeAiOAuth()).not.toThrow();
    expect(h.cancelCalls).toBe(1);
    expect(h.clearCalls).toBe(0);
    expect(h.unbindCalls).toEqual([]);
  });

  it('does not touch credentials when a later authorization replaces the staged revoke', () => {
    h.validationResult = false;

    expect(() => disconnectClaudeAiOAuth()).toThrow(/cleanup did not complete/i);
    expect(h.clearCalls).toBe(0);
    expect(h.events).toEqual([
      'login-cancelled',
      'logout-intent',
      'revoke-staged',
      'binding-check',
    ]);
  });
});
