/**
 * The Codex OAuth token reader the desktop gives CodexAgent (maker-host/index.ts
 * createCodexAuthTokenReader), for the Node Host. The body is the desktop's, line for line; its
 * desktop reads arrive as ports: the Codex auth adapter, the one-shot credential read, whether this
 * Codex agent is still the live one, and the account realm.
 */
import type { AuthAdapter } from '@cindy/maker-core';

import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';

export interface HostCodexAuthTokenReaderPorts {
  codexAuthAdapter: Pick<AuthAdapter, 'getState'>;
  /** The desktop adapter's readOneShotCreds: the login's own token and ChatGPT account id. */
  readOneShotCreds(providerId?: string): { accessToken: string; accountId: string } | null;
  /** The desktop's `_codexAgent === codexAgent`: the reader's agent is still the live one. */
  isCodexAgentCurrent(): boolean;
  /** The desktop's getActiveAuthRealm. */
  readAuthRealm(): string | null;
}

export function createHostCodexAuthTokenReader(ports: HostCodexAuthTokenReaderPorts) {
  const { codexAuthAdapter, readOneShotCreds, isCodexAgentCurrent, readAuthRealm } = ports;
  return (providerId?: string) => {
    const owner = getActiveAppSession();
    const authRealm = readAuthRealm();
    const assertOwner = () => {
      const current = getActiveAppSession();
      if (isAppSessionBoundaryPending() || !isCodexAgentCurrent() ||
          readAuthRealm() !== authRealm ||
          current.mode !== owner.mode || current.dataOwnerId !== owner.dataOwnerId) {
        throw new Error('Codex authentication owner changed');
      }
    };
    return async () => {
      // Same-owner Ghost repair advances the scope generation while retaining
      // this Maker and its live tasks. Fence each read, not the reader's lifetime.
      // The agent identity also rejects old readers after logout/login to the same owner.
      assertOwner();
      const ownerScope = activeOwnerScopeKey();
      const state = await codexAuthAdapter.getState({ credentialMode: 'oauth-bearer', providerId });
      assertOwner();
      if (activeOwnerScopeKey() !== ownerScope) throw new Error('Codex authentication owner changed');
      const credentials = state.authenticated ? readOneShotCreds(providerId) : null;
      if (!credentials) throw new Error('Codex account credentials are unavailable');
      return { accessToken: credentials.accessToken, chatgptAccountId: credentials.accountId };
    };
  };
}
