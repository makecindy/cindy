import {
  getPromptRecommendationPreference,
  subscribePromptRecommendationPreference,
} from '@/hooks/usePromptRecommendationPreference';
import { extractIpcError } from '@/utils/ipcError';

type PredictionApi = Pick<typeof window.electronAPI.maker, 'predictNextPrompt'>;
type PredictionRequest = Exclude<Parameters<PredictionApi['predictNextPrompt']>[0], { cancel: true }>;

/** Keep cancellation attached to the request, even after its composer has unmounted. */
export async function predictPromptUntilDisabled(
  api: PredictionApi, request: PredictionRequest, isCurrent: () => boolean = () => true,
) {
  if (!getPromptRecommendationPreference() || !isCurrent()) return { prompt: null };
  let cancelled = false;
  const unsubscribe = subscribePromptRecommendationPreference((enabled) => {
    if (enabled || cancelled) return;
    cancelled = true;
    // Deliberately omit generation fields: old hosts reject instead of generating another prompt.
    void api.predictNextPrompt({
      sessionId: request.sessionId,
      completionRevision: request.completionRevision,
      cancel: true,
    }).catch(() => undefined);
  });
  try {
    // A transport timeout does not cancel B's model call. Reissue the same
    // session/revision so B joins its in-flight Promise or returns its cache.
    // Backoff is limited to this request; never reset a peer or shared relay.
    const retryDelays = [1_000, 2_000, 4_000];
    for (let attempt = 0; ; attempt++) {
      if (cancelled || !isCurrent() || !getPromptRecommendationPreference()) return { prompt: null };
      try {
        const result = await api.predictNextPrompt(request);
        if (cancelled || !isCurrent()) return { prompt: null };
        // Old hosts and terminal empty model output have no retryable flag.
        if (result.prompt || result.retryable !== true || attempt >= retryDelays.length) return result;
      } catch (error) {
        if (cancelled || !isCurrent()) return { prompt: null };
        const code = extractIpcError(error)?.code;
        if (attempt >= retryDelays.length ||
            (code !== 'DEVICE_LINK_TIMEOUT' && code !== 'DEVICE_LINK_BUSY')) throw error;
      }
      await new Promise<void>(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
  } finally {
    unsubscribe();
  }
}
