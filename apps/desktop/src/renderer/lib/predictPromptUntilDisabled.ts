import {
  getPromptRecommendationPreference,
  subscribePromptRecommendationPreference,
} from '@/hooks/usePromptRecommendationPreference';

type PredictionApi = Pick<typeof window.electronAPI.maker, 'predictNextPrompt'>;
type PredictionRequest = Exclude<Parameters<PredictionApi['predictNextPrompt']>[0], { cancel: true }>;

/** Keep cancellation attached to the request, even after its composer has unmounted. */
export async function predictPromptUntilDisabled(api: PredictionApi, request: PredictionRequest) {
  if (!getPromptRecommendationPreference()) return { prompt: null };
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
    const result = await api.predictNextPrompt(request);
    return cancelled ? { prompt: null } : result;
  } finally {
    unsubscribe();
  }
}
