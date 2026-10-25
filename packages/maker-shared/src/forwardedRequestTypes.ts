/** Host-owned source evidence. It describes authorship, never execution permission. */
export interface ForwardedRequestSource {
  userText: string | null;
  sessionId?: string;
  clientId?: string;
  /** Host evidence that the relayed user words were verified as the owner's request. */
  ownerVerified?: true;
}

/** Kept under the existing protected, non-human input receipt. */
export interface AgentRequestReceipt {
  kind: 'agent-request' | 'delegated-continuation';
  request?: ForwardedRequestSource;
}


export const FORWARDED_REQUEST_RECEIPT = Symbol('forwarded-request-receipt');

export function readForwardedRequestSource(value: unknown): ForwardedRequestSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.userText === null) return { userText: null };
  if (typeof source.userText !== 'string' || typeof source.sessionId !== 'string'
    || !source.sessionId || typeof source.clientId !== 'string' || !source.clientId) return null;
  return {
    userText: source.userText,
    sessionId: source.sessionId,
    clientId: source.clientId,
    ...(source.ownerVerified === true ? { ownerVerified: true as const } : {}),
  };
}
