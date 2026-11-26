import { apiKeyMemberForConnection, apiKeyPoolMember, apiKeyPoolMembers, legacyApiKeyPoolBinding } from '../../../desktop/src/main/subscription-accounts/apiKeyMembers.js';
import { providerAccounts } from '../../../desktop/src/main/subscription-accounts/placement.js';
import { readAccountBinding, readPool } from '../../../desktop/src/main/subscription-accounts/store.js';
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

/**
 * The provider group refusal of a task start (moved verbatim out of main.ts, where the input queue's
 * assertProviderExecutionSupported was bound): the Host has no provider group assignment service, so a
 * task bound to a group, or routed to a group provider, is refused before its runtime starts. The send
 * path (turn-executor.mjs readExecutionSession) and the Device Link create entry take the same check.
 */
export function createHostProviderExecutionCheck({ hostProviderBindings, hostProviderGroups }: {
  hostProviderBindings: { readProviderGroupBinding(sessionId: string): unknown };
  hostProviderGroups: { readProviderGroup(providerId: string): unknown };
}) {
  return (id: string, providerId?: string | null, nativeId?: string | null) => {
    if (hostProviderBindings.readProviderGroupBinding(id)
      || (providerId && hostProviderGroups.readProviderGroup(providerId))
      || isMixedOpenAiPoolRoute(id, providerId, nativeId)) {
      throw new Error('[UNSUPPORTED_CAPABILITY] Host does not yet support provider groups');
    }
  };
}

/** The flattened local account pool need not have an outer provider group settings row. */
function isMixedOpenAiPoolRoute(id: string, providerId?: string | null, nativeId?: string | null): boolean {
  // Re-read the canonical placements and binding store rather than using a catalog label.
  const config = readPool('openai');
  if (providerId) {
    const own = apiKeyMemberForConnection(providerId);
    if ((own && own.providerId !== providerId)
      || apiKeyPoolMembers(providerId).some(member => member.connectionId !== providerId)
      || (own && config && providerAccounts('openai', config.accounts, providerId).length > 0)
      || legacyApiKeyPoolBinding(id, providerId)) return true;
  }
  return [id && `task:${id}`, nativeId && `native:${nativeId}`].some(key => {
    const binding = key ? readAccountBinding(key, 'openai') : undefined;
    return !!binding && !!apiKeyPoolMember(binding.accountId);
  });
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
