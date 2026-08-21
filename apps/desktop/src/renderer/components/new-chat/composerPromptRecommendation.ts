export interface ComposerPromptRecommendationVisibilityInput {
  enabled: boolean;
  hydrated: boolean;
  prompt: string | null;
  hasMessage: boolean;
  hasAttachments: boolean;
  hasBrowserComments: boolean;
  hasVoiceDraftText: boolean;
  mutationLocked: boolean;
}

/** Overlay 与 Tab 接受共用的唯一可见性判据。 */
export function shouldShowComposerPromptRecommendation(
  input: ComposerPromptRecommendationVisibilityInput,
): boolean {
  return (
    input.enabled &&
    input.hydrated &&
    !!input.prompt &&
    !input.hasMessage &&
    !input.hasAttachments &&
    !input.hasBrowserComments &&
    !input.hasVoiceDraftText &&
    !input.mutationLocked
  );
}
