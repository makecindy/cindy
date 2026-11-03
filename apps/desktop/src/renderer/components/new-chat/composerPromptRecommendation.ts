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

/** 生成、Overlay 与 Tab 接受共用输入框资格；草稿和临时锁定不消费候选。 */
export function isComposerReadyForPromptRecommendation(
  input: Omit<ComposerPromptRecommendationVisibilityInput, 'prompt'>,
): boolean {
  return (
    input.enabled &&
    input.hydrated &&
    !input.hasMessage &&
    !input.hasAttachments &&
    !input.hasBrowserComments &&
    !input.hasVoiceDraftText &&
    !input.mutationLocked
  );
}

export function shouldShowComposerPromptRecommendation(
  input: ComposerPromptRecommendationVisibilityInput,
): boolean {
  return !!input.prompt && isComposerReadyForPromptRecommendation(input);
}
