import type { AutoReviewHistoryMessage } from '@cindy/im-runtime/autoReviewUserIntent';
import { readForwardedRequestSource, type AgentRequestReceipt, type ForwardedRequestSource } from '@cindy/maker-shared/forwarded-request-types';
export interface RequestInputEvidence {
  clientId: string;
  authoredText?: string;
  originKind?: string;
  delegatedRequest?: ForwardedRequestSource;
}

export interface CapturedAgentRequest {
  message: string;
  autoReviewUserText: AgentRequestReceipt;
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

export function createAgentRequestCapture(formatForwardedRequest:(source:ForwardedRequestSource,supplement:string)=>string) {
/** Only companion task instructions opt in. Accepted input wins over queued text; model labels are not evidence. */
async function captureAgentRequest(
  sessionId: string,
  supplement: string,
  active: RequestInputEvidence | null,
  readLatestInput: () => Promise<AutoReviewHistoryMessage[]>,
  preserveUserRequest = false,
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
  return { message: formatForwardedRequest(source, supplement),
    autoReviewUserText: { kind: 'agent-request', request: source } };
}

return captureAgentRequest;
}
