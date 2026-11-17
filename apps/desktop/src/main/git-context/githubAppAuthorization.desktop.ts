import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { activeOwnerScopeKey, getActiveAppSession } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { genericOAuthSecretIo } from '../secrets/providerSecretStore.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { createGithubAppAuthorization } from './githubAppAuthorization.js';

let refresh: ((token: string) => Promise<unknown>) | undefined;
const listeners = new Set<() => void>();
const endpoint = () => getClientEndpoint('webhookApiBaseUrl');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const storageKey = () => `cindy-github-app-${digest(endpoint())}`;

export function configureGithubAppRefresh(callback: (token: string) => Promise<unknown>): void { refresh = callback; }
export function onGithubAppAuthorizationChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const githubAppAuthorization = createGithubAppAuthorization({
  scope: () => `${activeOwnerScopeKey()}:${endpoint()}`,
  read: () => genericOAuthSecretIo.readStrict(storageKey()),
  write: value => genericOAuthSecretIo.write(storageKey(), value),
  remove: () => genericOAuthSecretIo.remove(storageKey()),
  async lock(work) {
    const owner = getActiveAppSession().dataOwnerId;
    if (!owner || !endpoint()) throw new Error('GITHUB_ACCOUNT_REQUIRED');
    const dir = path.join(app.getPath('userData'), 'safe-storage', 'github-app-locks');
    const lockPath = path.join(dir, `${digest(`${owner}:${endpoint()}`)}.lock`);
    await fs.mkdir(dir, { recursive: true });
    return withCrossProcessLock(lockPath, { label: 'GitHub authorization', waitMs: 35_000 }, async status => {
      if (!status.held) throw new Error('GITHUB_CREDENTIAL_BUSY');
      return work();
    });
  },
  refresh: token => {
    if (!refresh) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return refresh(token);
  },
  changed: () => { for (const listener of listeners) listener(); },
  now: Date.now,
});

export async function readGithubAppToken(): Promise<string | null> {
  if (!getActiveAppSession().dataOwnerId || !endpoint()) return null;
  return githubAppAuthorization.readToken();
}
