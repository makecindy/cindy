import { getResolvedMainLocale } from '../i18n.js';
import type { AutoReviewHistoryMessage } from './autoReviewUserIntent.js';
import { formatForwardedRequest as formatLocalizedForwardedRequest, readForwardedRequestSource, type AgentRequestReceipt, type ForwardedRequestSource } from '../../shared/forwardedRequest.js';

export interface RequestInputEvidence {
  clientId: string;
  authoredText?: string;
  originKind?: string;
  delegatedRequest?: ForwardedRequestSource;
}

export interface CapturedAgentRequest {
  message: string;
  autoReviewUserText: AgentRequestReceipt;
  /**
   * The sender's review found this was not a hand-off the owner asked for. Nothing may
   * be delivered; callers return this reason to the sending agent.
   */
  blocked?: string;
  /**
   * What an older peer, which only verifies the quoted format, receives instead: the
   * pre-2026-11-05 envelope when the owner's words are at hand, otherwise plain text.
   */
  legacy?: { message: string; autoReviewUserText: AgentRequestReceipt };
}

/** Thrown where a capture cannot return a result shape; nothing was delivered. */
export class DelegationNotAuthorizedError extends Error {
  readonly code = 'DELEGATION_NOT_AUTHORIZED' as const;
}

/**
 * Whether the owner asked for this hand-off, decided on the sending side where the whole
 * conversation is visible (Auto review, the owner's own confirmation, or Full Access).
 * `none` sends a plain message without owner authority.
 */
export type DelegationAuthorization =
  | { kind: 'authorized' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'none' };

export interface DelegationCheck {
  /** Local id of the receiving task when known; a reply to the request's origin never carries authority. */
  targetSessionId?: string;
  authorize(): Promise<DelegationAuthorization>;
}

/** Who the hand-off goes to; a cross-device teammate has no local session, only its confirmed identity. */
export interface DelegationTarget {
  sessionId?: string;
  targetTeammate?: { name: string; id: string };
}

/** The action payload naming the recipient to the sender review (2026-11-06). */
export type DelegationReviewTarget =
  | { targetSessionId: string }
  | { targetTeammate: { name: string; id: string } };

/**
 * Only a hand-off with no identity at all is "a new task". A confirmed remote teammate keeps its
 * own name and full id, so the review sees the recipient the owner confirmed instead of
 * contradicting it (#9198).
 */
export function delegationReviewTarget(target?: DelegationTarget): DelegationReviewTarget {
  if (target?.sessionId) return { targetSessionId: target.sessionId };
  if (target?.targetTeammate) return { targetTeammate: target.targetTeammate };
  return { targetSessionId: 'a new task' };
}

export function requestSourceFromInput(sessionId: string, input: RequestInputEvidence): ForwardedRequestSource {
  if (input.delegatedRequest) return readForwardedRequestSource(input.delegatedRequest) ?? { userText: null };
  // Older peer hosts persisted the compatibility bridge as desktop input.
  if (input.clientId.startsWith('teammate-bridge:')) return { userText: null };
  if ((!input.originKind || input.originKind === 'desktop') && typeof input.authoredText === 'string') {
    return { userText: input.authoredText, sessionId, clientId: input.clientId };
  }
  return { userText: null };
}

/**
 * IM turns call Session.send directly, without an accepted coordinator input. The lane's
 * per-turn lease names the owner's persisted message (stamped by the IM runner after the
 * row was written); only an owner requester supplies original words.
 */
export async function ownerChannelInputEvidence(
  lane: { requesterIsOwner: boolean; inputClientId?: string } | null,
  readUserText: (clientId: string) => Promise<string | null>,
): Promise<RequestInputEvidence | null> {
  if (!lane?.requesterIsOwner || !lane.inputClientId) return null;
  const text = await readUserText(lane.inputClientId);
  return text?.trim() ? { clientId: lane.inputClientId, authoredText: text } : null;
}

/**
 * Host request handoffs opt in. Accepted input wins over queued text; model labels are not evidence.
 * Since 2026-11-05 the body is always the agent's own text. The owner's words stay in the receipt
 * as provenance; owner authority travels only after the sender checked the hand-off itself.
 */
export async function captureAgentRequest(
  sessionId: string,
  supplement: string,
  active: RequestInputEvidence | null,
  readLatestInput: () => Promise<AutoReviewHistoryMessage[]>,
  preserveUserRequest = false,
  /** The host admitted this call as the owner's request or its accepted continuation. */
  ownerVerified = false,
  delegation?: DelegationCheck,
): Promise<CapturedAgentRequest> {
  if (!preserveUserRequest) return { message: supplement, autoReviewUserText: { kind: 'agent-request' } };
  let source: ForwardedRequestSource;
  if (active) source = requestSourceFromInput(sessionId, active);
  else {
    const rows = await readLatestInput();
    const row = rows.at(-1);
    const receipt = row?.agentMeta?.autoReviewUserText;
    const delegated = receipt && typeof receipt === 'object' && 'kind' in receipt
      && (receipt.kind === 'delegated-continuation' || receipt.kind === 'agent-request') && 'request' in receipt
      ? readForwardedRequestSource(receipt.request) : null;
    source = row && row.role === 'user' ? requestSourceFromInput(sessionId, {
      clientId: row.clientId,
      authoredText: ['turn', 'steer'].includes(String(row.agentMeta?.delivery)) && typeof receipt === 'string'
        ? receipt : undefined,
      originKind: (row.agentMeta?.origin as { kind?: string } | undefined)?.kind,
      ...(delegated ? { delegatedRequest: delegated } : {}),
    }) : { userText: null };
  }
  if (source.userText === null || !source.sessionId || !source.clientId)
    return { message: supplement, autoReviewUserText: { kind: 'agent-request', request: { userText: null } } };
  // Where the owner's request started; the words themselves are not carried forward.
  const provenance: ForwardedRequestSource = { sessionId: source.sessionId, clientId: source.clientId, plainBody: true };
  // An accepted relay still names the same owner request. Only the current
  // input can carry that evidence; a historical fallback cannot revive it.
  const verified = ownerVerified || active?.delegatedRequest?.ownerVerified === true
    || active?.delegatedRequest?.delegatedText !== undefined;
  // Older peers need the quoted owner words, available only while they are this task's own
  // input (or an older host's quotation). A relayed plain hand-off reaches them as plain text.
  const legacyRequest: ForwardedRequestSource | null = typeof source.userText === 'string'
    ? { userText: source.userText, sessionId: source.sessionId, clientId: source.clientId,
      ...(verified ? { ownerVerified: true as const } : {}) } : null;
  const legacy = legacyRequest ? { message: formatForwardedRequest(legacyRequest, supplement),
    autoReviewUserText: { kind: 'agent-request' as const, request: legacyRequest } }
    : { message: supplement, autoReviewUserText: { kind: 'agent-request' as const } };
  const plain: CapturedAgentRequest = { message: supplement,
    autoReviewUserText: { kind: 'agent-request', request: provenance }, legacy };
  // A result or question back to where the request came from is not a new request.
  if (!verified || !delegation || (delegation.targetSessionId && delegation.targetSessionId === provenance.sessionId))
    return plain;
  const decision = await delegation.authorize();
  if (decision.kind === 'blocked') return { ...plain, blocked: decision.reason };
  if (decision.kind !== 'authorized') return plain;
  return { message: supplement, legacy, autoReviewUserText: { kind: 'agent-request',
    request: { ...provenance, delegatedText: supplement } } };
}

/** Quote only a real owner request. Missing-source envelopes remain readable through the shared legacy validator. */
export function formatForwardedRequest(source: ForwardedRequestSource, supplement: string): string {
  return source.plainBody || source.userText == null ? supplement
    : formatLocalizedForwardedRequest(source, supplement, getResolvedMainLocale());
}
