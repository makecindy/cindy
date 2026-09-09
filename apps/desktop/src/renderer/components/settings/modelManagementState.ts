import type { ProviderView } from '@cindy/model-providers';

/** One projection for counts, grouping and row appearance. Saved choice never implies readiness. */
export function modelManagementState(
  provider: Pick<ProviderView, 'connected' | 'suspended' | 'availableMediaModelIds'>,
  model: {
    ids: readonly string[];
    capability: boolean;
    savedSelected: boolean;
    disabled: boolean;
    paymentRequired: boolean;
  },
) {
  const ready =
    !provider.suspended &&
    !model.disabled &&
    !model.paymentRequired &&
    (model.capability
      ? model.ids.some((id) => provider.availableMediaModelIds?.includes(id))
      : provider.connected);
  return {
    ready,
    selected: !model.capability && ready && model.savedSelected,
    // Disconnected models remain in their brand groups; they aren't user-disabled models.
    hidden: !model.capability && ready && !model.savedSelected,
    canSelect: !model.capability && ready,
  };
}
