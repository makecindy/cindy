import { getResolvedMainLocale } from '../i18n.js';
import { createAgentRequestCapture } from '@cindy/app-runtime/agentRequestCapture';
export { requestSourceFromInput, ownerChannelInputEvidence } from '@cindy/app-runtime/agentRequestCapture';
export type { RequestInputEvidence, CapturedAgentRequest } from '@cindy/app-runtime/agentRequestCapture';
import { formatForwardedRequest as formatLocalizedForwardedRequest, type ForwardedRequestSource } from '../../shared/forwardedRequest.js';
export const captureAgentRequest=createAgentRequestCapture(formatForwardedRequest);
/** Quote only a real owner request. Missing-source envelopes remain readable through the shared legacy validator. */
export function formatForwardedRequest(source: ForwardedRequestSource, supplement: string): string {
  return source.userText === null ? supplement
    : formatLocalizedForwardedRequest(source, supplement, getResolvedMainLocale());
}
