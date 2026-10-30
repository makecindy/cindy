/** Resolve an application's initial group route without creating a Cindy task. */
import type { AgentKind } from '@cindy/maker-core';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import type { ProviderGroupRemoteClient } from '../provider-group/remoteClient.js';
import type { ProviderGroupBinding } from '../provider-group/bindings.js';
import type { ProviderGroupRouter } from '../provider-group/router.js';

export interface LocalAgentExecutionRoute {
  providerId: string;
  agentDeviceId?: string;
  groupAssigned?: boolean;
  groupBinding?: Omit<ProviderGroupBinding, 'at'>;
}

export type LocalAgentRouteResolver = (input: LocalAgentExecutionRoute & {
  sessionId: string;
  agentKind: AgentKind;
  model: string;
}) => Promise<LocalAgentExecutionRoute>;

// Stored only inside the server's existing owner/grant-scoped opaque binding.
// Older bindings remain raw native ids; a downgraded runtime cannot interpret
// this envelope as another member's native thread id.
const RESUME_PREFIX = 'local-agent-group-v1:';
export function localAgentResumeId(native: string, route: LocalAgentExecutionRoute): string {
  return route.groupAssigned
    ? RESUME_PREFIX + Buffer.from(JSON.stringify({ native, route })).toString('base64url')
    : native;
}

export function readLocalAgentResumeId(value: string | undefined): { native?: string; route?: LocalAgentExecutionRoute } {
  if (!value?.startsWith(RESUME_PREFIX)) return { native: value };
  const parsed = JSON.parse(Buffer.from(value.slice(RESUME_PREFIX.length), 'base64url').toString('utf8'));
  const route = parsed?.route;
  if (typeof parsed?.native !== 'string' || !parsed.native || !route || route.groupAssigned !== true
    || typeof route.providerId !== 'string' || !route.providerId
    || (route.agentDeviceId !== undefined && (typeof route.agentDeviceId !== 'string' || !route.agentDeviceId))) {
    throw new Error('Invalid application group resume binding');
  }
  const binding = route.groupBinding;
  if (binding !== undefined && (!binding ||
    !['providerId', 'memberKey'].every((key) => typeof binding[key] === 'string' && binding[key]) ||
    (binding.groupDeviceId !== undefined && (typeof binding.groupDeviceId !== 'string' || !binding.groupDeviceId)))) {
    throw new Error('Invalid application group load binding');
  }
  return { native: parsed.native, route: {
    providerId: route.providerId, agentDeviceId: route.agentDeviceId, groupAssigned: true,
    ...(binding ? { groupBinding: { providerId: binding.providerId, memberKey: binding.memberKey, groupDeviceId: binding.groupDeviceId } } : {}),
  } };
}

export function createLocalAgentGroupRouteResolver(deps: {
  remote: Pick<ProviderGroupRemoteClient, 'pick'>;
  local?: Pick<ProviderGroupRouter, 'pick'>;
  localDeviceId(): string | null;
  assertCurrent(): void;
}): LocalAgentRouteResolver {
  return async ({ sessionId, agentKind, model, ...route }) => {
    deps.assertCurrent();
    // Shared providers are assigned by their owner; they cannot use the
    // same-account group management channel.
    if (route.agentDeviceId && isProviderShareAgentDeviceId(route.agentDeviceId)) return route;
    const self = deps.localDeviceId();
    const pick = route.agentDeviceId ? await deps.remote.pick(route.agentDeviceId, {
      sessionId, providerId: route.providerId, agentKind, model, exclude: [],
    }) : await deps.local?.pick({ providerId: route.providerId, agentKind, model,
      localTask: true, reserveFor: sessionId }) ?? { kind: 'none' as const };
    deps.assertCurrent();
    if (pick.kind === 'none') return route; // No group, or an older peer.
    if (pick.kind === 'unavailable') {
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] No provider group member is available.');
    }
    const member = pick.member;
    const agentDeviceId = member.kind === 'local' ? route.agentDeviceId
      : member.kind === 'device' && member.agentDeviceId === self ? undefined
        : member.agentDeviceId ?? undefined;
    return { providerId: member.providerId, agentDeviceId, groupAssigned: true,
      groupBinding: { providerId: route.providerId, groupDeviceId: route.agentDeviceId, memberKey: member.key },
    };
  };
}
