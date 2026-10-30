import type { RemoteAgentKind } from '@cindy/maker-remote-ssh';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Stop the managed daemon before replacing its package, so disk and runtime cannot diverge. */
export async function prepareRemoteAgentInstall(
  agentKind: RemoteAgentKind,
  deps: {
    isInstalled: () => Promise<boolean>;
    hasLiveTurn: () => boolean;
    stopDaemon: () => Promise<{ ok: boolean }>;
  },
): Promise<void> {
  if (agentKind !== 'codex' || await deps.isInstalled()) return;
  if (deps.hasLiveTurn()) {
    throwIpcError('SSH_INSTALL_FAILED', 'Codex upgrade deferred while a remote task is running; retry after it finishes');
  }
  if (!(await deps.stopDaemon()).ok) {
    throwIpcError('SSH_INSTALL_FAILED', 'Unable to stop the old Codex daemon; reconnect and retry the upgrade');
  }
}
