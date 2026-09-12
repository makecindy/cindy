import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual host callback without bootstrapping Electron or real credentials.
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const callback = source.slice(source.indexOf('createCodexAuthTokenReader:') + 'createCodexAuthTokenReader:'.length,
  source.indexOf('recordCodexThreadLocation:', source.indexOf('createCodexAuthTokenReader:'))).trim().replace(/,$/, '');

describe('Codex token reader owner boundary', () => {
  it.each(['before', 'during', 'stable', 'owner-change'])('handles %s credential reads', async phase => {
    let pending = phase === 'before';
    let owner = 'owner-a';
    const readOneShotCreds = vi.fn(() => ({ accessToken: 'fixture-token', accountId: 'account-b' }));
    const getState = vi.fn(async () => {
      if (phase === 'during') pending = true;
      if (phase === 'owner-change') owner = 'owner-b';
      return { authenticated: true };
    });
    const createReader = runInNewContext(`(${callback})`, {
      activeOwnerScopeKey: () => owner,
      isAppSessionBoundaryPending: () => pending,
      desktopCodexAuthAdapter: { getState, readOneShotCreds },
    });
    const reader = createReader('account-b');
    if (phase === 'stable') {
      await expect(reader()).resolves.toEqual({ accessToken: 'fixture-token', chatgptAccountId: 'account-b' });
      expect(readOneShotCreds).toHaveBeenCalledWith('account-b');
    } else {
      await expect(reader()).rejects.toThrow('Codex authentication owner changed');
      expect(readOneShotCreds).not.toHaveBeenCalled();
      if (phase === 'before') expect(getState).not.toHaveBeenCalled();
    }
  });
});
