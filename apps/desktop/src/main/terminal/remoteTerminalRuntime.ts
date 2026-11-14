import { createHmac, randomBytes } from 'node:crypto';
import { isSharedTaskPeer, isProviderSharePeer } from '@cindy/device-link';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, onAppSessionInvalidated, ownerScopedUserDataPath } from '../appSessionState.js';
import { getSessionRowSnapshotStrict } from '../localDb/ipc/sessions.js';
import { remoteInvoke } from '../device-link/index.js';
import { deviceLinkApiFetch } from '../device-link/deviceLinkApi.desktop.js';
import { getRemoteSshPoolHydrated } from '../remote-ssh/index.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type { RemoteTerminalConnection } from '../../shared/terminal-bridge.js';
import { connectionForHost, describeRemoteTerminal, parseRemoteConnection, parseStoredRemoteConnection, remoteLaunch, type InternalRemoteTerminalConnection, type RemoteTerminalRuntime } from './remoteTerminal.js';

/** Only explicitly submitted non-secret connection settings persist, scoped to the account. */
const bindings = createOverrideSettingsFile<{ bindings: Record<string, InternalRemoteTerminalConnection> }>({
  filePath: () => ownerScopedUserDataPath('terminal-remote-bindings.json'),
  defaults: { bindings: {} },
  scopeKey: activeOwnerScopeKey,
  maxBytes: 512 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  log: createLogger('terminal/remote-bindings'),
  label: 'remote terminal',
  normalize(raw) {
    const entries = (raw as { bindings?: unknown })?.bindings;
    const result: Record<string, InternalRemoteTerminalConnection> = {};
    if (entries && typeof entries === 'object') {
      for (const [key, value] of Object.entries(entries)) {
        try { result[key] = parseStoredRemoteConnection(value); } catch { /* Invalid values are never executable. */ }
      }
    }
    return { bindings: result };
  },
});

function scope(): string {
  if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) return throwIpcError('PERMISSION_DENIED', 'Account is unavailable');
  return activeOwnerScopeKey();
}

/** Device-link is used only to read owned task metadata; the SSH PTY stays controller-local. */
export function createRemoteTerminalRuntime(): RemoteTerminalRuntime {
  const referenceSecret = randomBytes(32);
  const reference = (account: string, source: 'host' | 'binding', key: string) => createHmac('sha256', referenceSecret)
    .update(JSON.stringify([account, source, key])).digest('hex');
  const project = (connection: InternalRemoteTerminalConnection, account: string, source: 'host' | 'binding', key: string): RemoteTerminalConnection => ({
    host: connection.host, user: connection.user, port: connection.port,
    ...(connection.identityFile ? { hostRef: reference(account, source, key) } : {}),
  });
  async function resolve(connection: RemoteTerminalConnection, key: string, account: string, assertCurrent: () => void): Promise<InternalRemoteTerminalConnection> {
    const check = () => {
      assertCurrent();
      if (scope() !== account) throwIpcError('PERMISSION_DENIED', 'Account changed');
    };
    check();
    const selected = parseRemoteConnection(connection);
    if (!selected.hostRef) return selected;
    let internal: InternalRemoteTerminalConnection | undefined;
    if (selected.hostRef === reference(account, 'binding', key)) {
      bindings.invalidateIfChanged();
      internal = bindings.read().bindings[key];
    } else {
      const pool = await getRemoteSshPoolHydrated();
      check();
      const host = pool.list().find(host => selected.hostRef === reference(account, 'host', host.config.id));
      if (host) internal = connectionForHost(host.config);
    }
    check();
    // A credential reference cannot be redirected to a client-chosen destination or user.
    if (!internal || internal.host !== selected.host || internal.user !== selected.user || internal.port !== selected.port) {
      return throwIpcError('PRECONDITION_FAILED', 'SSH host reference is unavailable');
    }
    return parseStoredRemoteConnection(internal);
  }
  return {
    scope,
    ownerKey() {
      scope();
      const { mode, dataOwnerId } = getActiveAppSession();
      return JSON.stringify([mode, dataOwnerId]);
    },
    onInvalidated: callback => onAppSessionInvalidated(event => callback(
      event.kind === 'commit' && (event.ownerChanged || event.generationReason !== 'projection-repair'),
    )),
    async describe(context) {
      const account = scope();
      const assertCurrent = () => { if (scope() !== account) throwIpcError('PERMISSION_DENIED', 'Account changed'); };
      try {
        const result = await describeRemoteTerminal(context, {
          async task() {
            if (!context.deviceId) {
              const row = await getSessionRowSnapshotStrict(context.sessionId);
              assertCurrent();
              return row;
            }
            const deviceId = context.deviceId;
            if (isSharedTaskPeer(deviceId) || isProviderSharePeer(deviceId)) return throwIpcError('PERMISSION_DENIED', 'Only account-owned devices are supported');
            const directory = await deviceLinkApiFetch<{ devices: Array<{ deviceId: string }> }>('/api/device-link/devices');
            assertCurrent();
            if (!directory.devices.some(device => device.deviceId === deviceId)) return throwIpcError('PERMISSION_DENIED', 'Device is not owned by this account');
            const reply = await remoteInvoke(deviceId, 'local-db:sessions:get', [context.sessionId], { preSend: assertCurrent });
            assertCurrent();
            if (!reply.ok) return throwIpcError('PRECONDITION_FAILED', 'Remote task metadata is unavailable');
            const row = reply.result as { id?: unknown; workingDir?: unknown; remoteHostId?: unknown; status?: unknown } | null;
            if (!row || row.id !== context.sessionId || typeof row.status !== 'string') return throwIpcError('PRECONDITION_FAILED', 'Incomplete remote task metadata');
            return row;
          },
          async hosts() {
            const pool = await getRemoteSshPoolHydrated();
            assertCurrent();
            return pool.list().map(host => host.config);
          },
          project: (connection, source, key) => project(connection, account, source, key),
          binding(key) {
            assertCurrent();
            bindings.invalidateIfChanged();
            return bindings.read().bindings[key];
          },
        });
        assertCurrent();
        return result;
      } catch (error) {
        // Preserve the error protocol, but never leak database/transport paths or responses.
        if (isIpcError(error)) throw error;
        return throwIpcError('PRECONDITION_FAILED', 'Remote task metadata is unavailable');
      }
    },
    async prepare(connection, cwd, key, account, assertCurrent) {
      try {
        const internal = await resolve(connection, key, account, assertCurrent);
        assertCurrent();
        if (scope() !== account) return throwIpcError('PERMISSION_DENIED', 'Account changed');
        return remoteLaunch(internal, cwd);
      } catch (error) {
        if (isIpcError(error)) throw error;
        return throwIpcError('PRECONDITION_FAILED', 'Unable to prepare SSH connection');
      }
    },
    async save(key, connection, account, assertCurrent) {
      assertCurrent();
      if (scope() !== account) return throwIpcError('PERMISSION_DENIED', 'Account changed');
      try {
        const internal = await resolve(connection, key, account, assertCurrent);
        await bindings.updateAtomic(state => {
          assertCurrent();
          if (scope() !== account) return throwIpcError('PERMISSION_DENIED', 'Account changed');
          return { bindings: { ...state.value.bindings, [key]: internal } };
        });
      } catch (error) {
        if (isIpcError(error)) throw error;
        return throwIpcError('PRECONDITION_FAILED', 'Unable to save SSH connection');
      }
      if (scope() !== account) return throwIpcError('PERMISSION_DENIED', 'Account changed');
    },
  };
}
