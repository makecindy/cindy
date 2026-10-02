import type { ToolCallAuthorizer } from '@cindy/mcps';
import type { SessionOperation } from '@cindy/maker-shared/session-controller';
import { assertModelSessionOperationAllowed } from './modelAccess.js';
import { SessionAdmissionError } from './controller.js';
import type { SessionCallerPolicy } from './callerContext.js';

// Adapter to the existing per-turn bot policy. The domain admission
// always checks the actual operation/target as well as the originating tool.
// This table is not an alternate permission list: all decisions remain with the
// current host authorizer and its live owner / arranged / other classification.
const toolForOperation: Partial<Record<SessionOperation, string>> = {
  listRecords: 'list_sessions',
  listActive: 'list_sessions', capabilities: 'get_session_runtime',
  inspect: 'get_session_runtime', diagnose: 'get_session_runtime',
  inspectRuntime: 'get_session_runtime', inspectQueue: 'list_session_queue',
  steer: 'steer_session', requestStop: 'stop_session_turn',
  selectRuntime: 'set_session_runtime', editOwnedInput: 'update_session_queued_message',
  withdrawOwnedInput: 'cancel_session_queued_message',
  send: 'send_to_session', createRecord: 'send_to_session',
  updateMetadata: 'rename_sessions', setRecordStatus: 'archive_sessions',
  subscribe: 'get_session_runtime', inspectInteractions: 'control_session',
  ensureRuntime: 'control_session', enqueue: 'control_session', pauseQueue: 'control_session', resumeQueue: 'control_session',
  retryInput: 'control_session', clearInputError: 'control_session', moveInput: 'control_session',
  abortTurn: 'control_session', closeRuntime: 'control_session', inspectHistory: 'control_session', fork: 'control_session',
  rewind: 'control_session', compact: 'control_session', listBackgroundTasks: 'control_session', stopBackgroundTask: 'control_session',
};

export function sessionToolPolicy(
  input: Parameters<ToolCallAuthorizer>[0],
  authorize: ToolCallAuthorizer,
  assertCurrent: () => void,
): SessionCallerPolicy {
  const check = async (request: Parameters<ToolCallAuthorizer>[0]) => {
    assertCurrent();
    const decision = await authorize(request);
    assertCurrent();
    if (!decision.ok) throw new SessionAdmissionError('NOT_AUTHORIZED', decision.message);
  };
  return {
    source: 'session', assertCurrent,
    async authorize(admission) {
      assertModelSessionOperationAllowed(admission.operation);
      await check(input);
      const tool = toolForOperation[admission.operation];
      if (!tool) throw new SessionAdmissionError('NOT_AUTHORIZED', 'Session operation is not granted to this tool');
      if (admission.operation === 'createRecord') {
        await check({ ...input, server: 'cindy_helper', tool, args: {} });
        return;
      }
      for (const target of admission.targets) {
        const args = tool === 'control_session' ? { request: { target, deviceId: admission.deviceId, command: { operation: admission.operation } } } : tool === 'send_to_session' ? { target_session_id: target.sessionId }
          : tool === 'rename_sessions' ? { changes: [{ session_id: target.sessionId }] }
          : tool === 'archive_sessions' ? { session_ids: [target.sessionId] }
          : { session_id: target.sessionId };
        await check({ ...input, server: 'cindy_helper', tool,
          args });
      }
    },
  };
}
