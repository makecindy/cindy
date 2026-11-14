import fs from 'node:fs';
import path from 'node:path';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { captureNativeProviderAuthorizationGeneration, isNativeProviderAuthBound } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';
import { shouldSuppressLocalCodexAuth } from '../../../desktop/src/main/maker-host/codex-auth-invalidation.js';
import { captureCodexOAuthDispatchProof, chatgptAccountIdFromTokens, currentCodexCredentialGeneration } from '../../../desktop/src/main/maker-host/codexCredentialRead.js';
import type { createHostProviderConfig } from './provider-config.js';

/** Host-owned OpenAI requests use only this profile's explicit native login.
 * The shared dispatch proof rejects account replacement, logout and token refresh. */
export function createHostCodexCredentials(profileDir: string, accounts: ReturnType<typeof createHostProviderConfig>['codexAccounts']) {
  const owner = activeOwnerScopeKey();
  const current = () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  const homeFor = (id: string) => id === 'openai' ? path.join(profileDir, 'codex-home') : accounts.codexAccountHome(id);
  const authenticated = (id = 'openai') => {
    if (!current()) return false;
    if (id !== 'openai') return accounts.codexAccountState(id).authenticated;
    const home = homeFor(id);
    return isNativeProviderAuthBound('openai') && !shouldSuppressLocalCodexAuth(home, path.join(home, 'auth.json'));
  };
  /** The proof the desktop adapter's captureOAuthDispatchProof gives the subscription bridge. */
  const captureDispatchProof = (accessToken: string, accountId: string | null, id = 'openai') => {
    if (!authenticated(id)) return null;
    const home = homeFor(id);
    return captureCodexOAuthDispatchProof({ home, accessToken, accountId,
      authenticated: () => authenticated(id),
      authorization: () => id === 'openai' ? captureNativeProviderAuthorizationGeneration('openai')
        : JSON.stringify(currentCodexCredentialGeneration(path.join(home, 'account.json'))),
    });
  };
  const read = (id = 'openai') => {
    if (!authenticated(id)) return null;
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(homeFor(id), 'auth.json'), 'utf8'));
      const accessToken = auth.tokens?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) return null;
      const accountId = chatgptAccountIdFromTokens(auth.tokens);
      const proof = captureDispatchProof(accessToken, accountId, id);
      if (!proof) return null;
      return { accessToken, accountId, canDispatch: () => current() && proof() };
    } catch { return null; }
  };
  return {
    hasLogin: () => read() !== null,
    captureDispatchProof,
    /**
     * The access token the subscription bridge checks a rejection against (the desktop
     * adapter's getAccessToken). An independent account also needs its workspace id, as
     * the desktop's readCodexOneShotCredsFromDisk requires.
     */
    readAccessToken(id = 'openai'): string | null {
      if (!authenticated(id)) return null;
      try {
        const tokens = JSON.parse(fs.readFileSync(path.join(homeFor(id), 'auth.json'), 'utf8')).tokens;
        const accessToken = tokens?.access_token;
        if (typeof accessToken !== 'string' || !accessToken) return null;
        if (id !== 'openai' && !chatgptAccountIdFromTokens(tokens)) return null;
        return accessToken;
      } catch { return null; }
    },
    /** The desktop adapter's readOneShotCreds: this login's token and its ChatGPT account id. */
    readOneShotCreds(id = 'openai'): { accessToken: string; accountId: string } | null {
      const value = read(id);
      return value?.accountId ? { accessToken: value.accessToken, accountId: value.accountId } : null;
    },
    async readForDispatch(id = 'openai') {
      const value = read(id);
      if (!value) throw new Error('Codex account requires login');
      return value;
    },
  };
}
