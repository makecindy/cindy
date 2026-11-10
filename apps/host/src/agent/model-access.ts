import { isProviderDisabled } from '@cindy/model-providers';
import type { AuthRegion } from '@cindy/auth-client';
import { createCredentialsSync, type CredentialsPayload } from '../../../desktop/src/main/model-access/credentialsSync.js';
import { createModelAccessCredentialsStore } from '../../../desktop/src/main/model-access/credentialsStore.js';
import { createGatewayKeyRejectionReporter, keyFingerprint } from '../../../desktop/src/main/model-access/gatewayKeyRejectionCore.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { readModelDisableOverrides } from '../../../desktop/src/main/maker-host/model-disable-store.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import type { ModelAccessStatus } from '../../../desktop/src/shared/modelAccess.js';

/** The same credential state machine and owner metadata used by Desktop. The
 * gateway object is live: running adapters never retain a replaced API key. */
export function createHostModelAccess(options: {
  ownerId: string; region: AuthRegion;
  readKey(): string | null; writeKey(value: string): boolean;
  request(path: string, method: 'GET' | 'POST'): Promise<CredentialsPayload>;
  publish(status: ModelAccessStatus): void;
  onKeyChanged(): void;
}) {
  const owner = activeOwnerScopeKey();
  const log = createLogger('host-model-access');
  const metadata = createModelAccessCredentialsStore();
  let closed = false;
  const replaced = new Set<string>();
  const current = () => !closed && owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  const check = () => { if (!current()) throw new Error('MODEL_ACCESS_OWNER_CHANGED'); };
  const enabled = () => current() && !isProviderDisabled(readModelDisableOverrides(), 'xd');
  const request = async (path: string, method: 'GET' | 'POST') => {
    check(); const payload = await options.request(path, method); check(); return payload;
  };
  const sync = createCredentialsSync({
    isProviderEnabled: enabled,
    fetchCredentials: () => request('/api/model-access/credentials', 'GET'),
    rotateCredentials: () => request('/api/model-access/credentials/rotate', 'POST'),
    readXdKey: () => { check(); return options.readKey(); },
    writeXdKey: async value => {
      check();
      const previous = options.readKey();
      if (!options.writeKey(value)) return false;
      if (previous && previous !== value) replaced.add(keyFingerprint(previous));
      try { options.onKeyChanged(); }
      catch { log.warn('Codex refresh could not be scheduled after saving its new gateway key'); }
      return true;
    },
    store: metadata,
    onStatusChange: status => { if (current()) options.publish(status); },
    log,
  });
  const rejection = createGatewayKeyRejectionReporter({
    canUseCindyGateway: enabled,
    isSessionBoundaryPending: () => !current(),
    getCredentialSource: () => metadata.getSource(),
    readCurrentKey: options.readKey,
    requestSync: () => sync.resyncAfterKeyRejection(),
    log,
  });
  const gateway = {
    get endpoint() { return current() ? metadata.getServerEndpoint()?.replace(/\/+$/, '') ?? '' : ''; },
    get credential() { return enabled() && metadata.getSource() === 'server' ? options.readKey() ?? '' : ''; },
  };
  return {
    gateway, sync, reportRejectedKey: rejection.reportUsedKey,
    isReplacedKey: (value: string) => current() && replaced.has(keyFingerprint(value)),
    async start() {
      check(); sync.handleAuthChange({ isAuthenticated: true, userId: options.ownerId, realm: options.region });
      const status = await sync.sync(); check(); return status;
    },
    close() {
      closed = true;
      sync.handleAuthChange({ isAuthenticated: false, userId: null, realm: null });
      replaced.clear();
    },
  };
}
