import type { ChatBridgeCapabilities } from './cindy/types';
import { resolveProviderCompatibilityProfile, profileModelListed, type CompatibilityRoute } from './profiles';

/** Convert upstream declarations into the existing bridge's serializer capabilities.
 * Cindy's explicit route capabilities stay authoritative; upstream declarations fill gaps.
 */
export function chatCompatibilityCapabilities(route: CompatibilityRoute, existing: ChatBridgeCapabilities = {}): ChatBridgeCapabilities {
  if (route.protocol !== 'openai-chat') return existing;
  const profile = resolveProviderCompatibilityProfile(route);
  if (!profile) return existing;
  const baseline: ChatBridgeCapabilities = {};
  if (typeof profile.parallelToolCalls === 'boolean') baseline.parallelToolCalls = profile.parallelToolCalls;
  if (profileModelListed(profile.preserveReasoningContentModels, route.model)) baseline.reasoningHistoryField = 'reasoning_content';
  if (profileModelListed(profile.requiresReasoningPlaceholderModels ?? profile.preserveReasoningContentModels, route.model)) baseline.toolCallReasoningPlaceholder = true;
  if (profileModelListed(profile.autoToolChoiceOnlyModels, route.model)) baseline.forceAutoToolChoice = true;
  return { ...baseline, ...existing };
}
