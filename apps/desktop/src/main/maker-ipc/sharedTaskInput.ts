import { stampSharedTaskInput as stamp, type SharedTaskPeerCapture } from '@cindy/app-runtime/sharedTaskInput';
import type { AgentInputCreateOpts, AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { sharedTaskOwnedQueueReferences } from '../device-link/sharedTaskDispatch.js';
export { assertSharedTaskQueueMutation } from '@cindy/app-runtime/sharedTaskInput';
export function stampSharedTaskInput(item: AgentInputQueuedMessage, capture: SharedTaskPeerCapture | undefined, task: AgentInputCreateOpts | undefined) {
 return stamp(item, capture, task, capture ? sharedTaskOwnedQueueReferences(capture, item.clientId) : undefined);
}
