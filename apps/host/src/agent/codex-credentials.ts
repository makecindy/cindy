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
  const read = (id = 'openai') => {
    if (!authenticated(id)) return null;
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(homeFor(id), 'auth.json'), 'utf8'));
      const accessToken = auth.tokens?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) return null;
      const accountId = chatgptAccountIdFromTokens(auth.tokens);
      const proof = captureCodexOAuthDispatchProof({ home: homeFor(id), accessToken, accountId,
        authenticated: () => authenticated(id),
        authorization: () => id === 'openai' ? captureNativeProviderAuthorizationGeneration('openai')
          : JSON.stringify(currentCodexCredentialGeneration(path.join(homeFor(id), 'account.json'))),
      });
      if (!proof) return null;
      return { accessToken, accountId, canDispatch: () => current() && proof() };
    } catch { return null; }
  };
  return {
    hasLogin: () => read() !== null,
    async readForDispatch(id = 'openai') {
      const value = read(id);
      if (!value) throw new Error('Codex account requires login');
      return value;
    },
  };
}
