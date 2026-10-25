import { AgentInputCoordinator as RuntimeAgentInputCoordinator, type AgentInputCoordinatorDeps } from '@cindy/app-runtime/agent-input-coordinator';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import type { SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch.js';
import { assertSharedTaskQueueMutation } from './sharedTaskInput.js';
import { createLogger } from '../logger.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { touchUserSendInDb } from '../localDb/ipc/sessions.js';
import { restoreTrustedDesktopQueuedOrigin, revokeTrustedDesktopQueuedOrigin } from './makerSendTransaction.js';
export * from '@cindy/app-runtime/agent-input-coordinator';

/** Desktop supplies its authenticated invocation and persistence boundaries. */
export class AgentInputCoordinator extends RuntimeAgentInputCoordinator<SharedTaskPeerCapture> {
  constructor(deps: AgentInputCoordinatorDeps) {
    super(deps, {
      logger: createLogger('maker-input-coordinator'),
      getSharedTaskContext: () => getDeviceLinkInvokeContext()?.sharedTask,
      assertSharedTaskQueueMutation, restoreTrustedDesktopQueuedOrigin, revokeTrustedDesktopQueuedOrigin,
      touchUserSendInDb, createUserMessage: createMessage,
    });
  }
}
