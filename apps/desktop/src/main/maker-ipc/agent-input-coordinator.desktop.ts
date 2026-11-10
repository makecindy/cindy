/** Desktop assembly for the shared input coordinator. No queue state lives here. */
import { createMessage } from '../localDb/ipc/messages.js';
import { touchUserSendInDb } from '../localDb/ipc/sessions.js';
import {
  AgentInputCoordinator as InputCoordinator,
  type AgentInputCoordinatorDeps as CoreDeps,
} from './agent-input-coordinator.js';

export * from './agent-input-coordinator.js';

/** Preserve existing desktop callers while making persistence explicit in the core. */
export type AgentInputCoordinatorDeps = Omit<CoreDeps, 'createUserMessage' | 'touchUserSend'> & {
  createUserMessage?: CoreDeps['createUserMessage'];
  touchUserSend?: CoreDeps['touchUserSend'];
};

export class AgentInputCoordinator extends InputCoordinator {
  constructor(deps: AgentInputCoordinatorDeps) {
    super({
      ...deps,
      createUserMessage: deps.createUserMessage ?? createMessage,
      touchUserSend: deps.touchUserSend ?? touchUserSendInDb,
    });
  }
}
