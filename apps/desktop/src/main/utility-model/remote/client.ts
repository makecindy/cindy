import { randomUUID } from 'node:crypto';
import {
  REMOTE_UTILITY_TEXT_CHANNEL, parseRemoteUtilityResponse,
  type RemoteUtilityRoute, type RemoteUtilityResponse,
} from '@cindy/device-link';
import { remoteBackgroundInvoke, remoteInvoke, getRemoteLinkCloseEpoch } from '../../device-link/index.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import type { UtilityTextRequestOptions } from '../oneShotCandidates.js';
import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';
import type { RemoteAuxiliaryRoute } from '../../../shared/remoteAuxiliaryModelRef.js';
import { requestUtilityTextWithinTimeout } from '../utilityTextTimeout.js';
import { getEffectiveAuxiliaryModelChainSnapshot } from '../resolveAuxiliaryModelChain.js';

/** Uses the existing link, scheduler, request deduplication and result outbox. */
export async function readRemoteUtilityTextCapabilities(deviceId: string) {
  const reply = await remoteBackgroundInvoke(deviceId, REMOTE_UTILITY_TEXT_CHANNEL, [{ version: 1, op: 'caps' }]);
  if (!reply.ok) return null;
  const result = parseRemoteUtilityResponse(reply.result);
  return result.op === 'caps' ? result : null;
}

function unavailable(route: RemoteUtilityRoute, reason: 'model_unavailable' | 'timeout' | 'request_failed'): UtilityTextResult {
  return { ok: false, reason: reason === 'timeout' ? 'timeout' : reason === 'model_unavailable' ? 'no_candidate' : 'all_candidates_failed',
    attempts: [{ providerId: route.providerId, model: route.model,
      transport: route.agentKind === 'codex' ? 'codex-responses' : 'litellm-chat-completions',
      status: reason === 'model_unavailable' ? 'skipped' : 'failed', reason }] };
}

/** An exact remote candidate; only the owning auxiliary chain chooses a fallback. */
export async function requestRemoteUtilityText(route: RemoteAuxiliaryRoute, prompt: string, opts: UtilityTextRequestOptions = {}): Promise<UtilityTextResult> {
  const owner = activeOwnerScopeKey();
  const linkEpoch = getRemoteLinkCloseEpoch(route.deviceId);
  // Capture the caller's routing decision too: a chain edited while this request
  // waits for the link must not dispatch the old choice afterwards.
  const chain = getEffectiveAuxiliaryModelChainSnapshot();
  const current = () => activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending()
    && !opts.signal?.aborted && getEffectiveAuxiliaryModelChainSnapshot() === chain
    && getRemoteLinkCloseEpoch(route.deviceId) === linkEpoch;
  const exact = { providerId: route.providerId, agentKind: route.agentKind, model: route.model };
  const timeout = () => unavailable(exact, 'timeout');
  return requestUtilityTextWithinTimeout(async (signal) => {
    let hostEpoch: string | undefined;
    const requestId = randomUUID();
    let submitted = false;
    const cancel = () => {
      if (!submitted || !hostEpoch || activeOwnerScopeKey() !== owner || isAppSessionBoundaryPending()) return;
      // Never retry inference to retrieve an uncertain result. Cancellation is best effort.
      void remoteInvoke(route.deviceId, REMOTE_UTILITY_TEXT_CHANNEL,
        [{ version: 1, op: 'cancel', hostEpoch, requestId }], { preSend: () => {
          if (activeOwnerScopeKey() !== owner || isAppSessionBoundaryPending()
            || getRemoteLinkCloseEpoch(route.deviceId) !== linkEpoch) throw new Error('Request no longer active');
        } }).catch(() => undefined);
      // The local wait is authoritative; the host also sees the cancel envelope.
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (!current() || signal.aborted) return timeout();
      const caps = await readRemoteUtilityTextCapabilities(route.deviceId);
      if (!current() || signal.aborted) return timeout();
      if (!caps || !caps.allowedRoutes.some((item) => item.providerId === exact.providerId && item.agentKind === exact.agentKind && item.model === exact.model))
        return unavailable(exact, 'model_unavailable');
      hostEpoch = caps.hostEpoch;
      if (opts.beforeDispatch && !(await opts.beforeDispatch(exact))) return unavailable(exact, 'request_failed');
      const options = Object.fromEntries(Object.entries({
        maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, reasoningEffort: opts.reasoningEffort,
        disableReasoning: opts.disableReasoning ?? true, systemPrompt: opts.systemPrompt,
        responseInstructions: opts.responseInstructions,
      }).filter(([, value]) => value !== undefined));
      const reply = await remoteBackgroundInvoke(route.deviceId, REMOTE_UTILITY_TEXT_CHANNEL,
        [{ version: 1, op: 'run', requestId, hostEpoch, route: exact, prompt, options }], {
          preSend: () => {
            if (!current() || signal.aborted) throw new Error('Request cancelled');
            submitted = true;
          },

        });
      if (!current() || signal.aborted) return timeout();
      if (opts.beforeDispatch && !(await opts.beforeDispatch(exact))) return unavailable(exact, 'request_failed');
      if (!current() || signal.aborted) return timeout();
      if (!reply.ok) return unavailable(exact, 'request_failed');
      const result: RemoteUtilityResponse = parseRemoteUtilityResponse(reply.result);
      if (result.op !== 'run') {
        const code = result.op === 'error' ? result.code : undefined;
        return unavailable(exact, code === 'TIMEOUT' || code === 'CANCELLED' ? 'timeout'
          : code === 'ROUTE_UNAVAILABLE' || code === 'UNAUTHORIZED' || code === 'STALE_HOST' ? 'model_unavailable' : 'request_failed');
      }
      if (result.requestId !== requestId) return unavailable(exact, 'request_failed');
      if (!result.result.ok) return result.result;
      if (result.result.providerId !== exact.providerId || result.result.model !== exact.model) return unavailable(exact, 'request_failed');
      const text = result.result.text.trim();
      if (!text || (opts.validateResponse && !opts.validateResponse(text))) return unavailable(exact, 'request_failed');
      opts.onText?.(text);
      return { ...result.result, text };
    } catch {
      return unavailable(exact, signal.aborted ? 'timeout' : 'request_failed');
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }, opts.timeoutMs ?? 90_000, opts.signal, timeout);
}
