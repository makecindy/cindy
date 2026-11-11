import path from 'node:path';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';

/** Read these facts from this owner's task row, never from the wire item. */
export interface HostTaskExecutionFacts {
  source?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  orcaRole?: string | null;
  orcaRemoteLead?: string | null;
  botId?: string | null;
}

/** These runtimes require services which the Node launcher has not wired yet.
 * Checking before send, steer and restore prevents a remote task running here. */
export function assertHostTaskExecutionSupported(facts: HostTaskExecutionFacts): void {
  const unsupported = facts.remoteHostId || facts.agentDeviceId ? 'remote execution'
    : facts.orcaRole || facts.orcaRemoteLead ? 'Orca tasks'
    : facts.botId || facts.source === 'bot' ? 'teammate tasks'
    : facts.source === 'review' || facts.source === 'cindy-make' || facts.source === 'cindy-make-merge' ? 'managed product tasks'
    : null;
  if (unsupported) throwIpcError('UNSUPPORTED_CAPABILITY', `Host does not yet support ${unsupported}`);
}

/** Preserve Host's existing text/mention/local-file input. Desktop cache and
 * transfer references need the shared materializer before they can reach core;
 * never pass them as a local file or quietly drop an attachment. */
export async function prepareHostUserMessage(_sessionId: string, message: unknown) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object' || !('content' in message)) {
    throwIpcError('INVALID_PARAMS', 'Invalid Host message');
  }
  const input = message as { type: 'user'; content: string | Array<{ type: string; [key: string]: unknown }> };
  if (input.type !== 'user' || (typeof input.content !== 'string' && !Array.isArray(input.content))) {
    throwIpcError('INVALID_PARAMS', 'Invalid Host message');
  }
  if (Array.isArray(input.content)) {
    for (const block of input.content) {
      if (block.type !== 'image' && block.type !== 'file') continue;
      if (block.base64 || typeof block.path !== 'string' || !path.isAbsolute(block.path)) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'This attachment needs a materializer that is not yet available in Host');
      }
    }
  }
  return input;
}
