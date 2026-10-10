import { effectiveSourceIdForModel, getModel, isModelSelectableForNewRoute, type AgentKind, type ProviderView } from '@cindy/model-providers';
import { isSelectableVendor, SELECTABLE_VENDORS, type SelectableVendor } from '@/lib/agentVendors';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { Effort } from '@/lib/userPreferences.types';
import { calibrateDraftModel, resolveDraftSessionProviderId } from '@/lib/draftModelCalibration';
import { resolveFastSupported } from '@/lib/providerModels';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';
import type { VendorPrefs } from '@/state/newMakerDraft';
import { resolveNewMakerDraftEffort } from '@/features/cc-agent/newMakerDraftModelPrefs';

export function selectDiagnosisAgent(
  preferred: MakerVendor,
  availableVendors: ReadonlySet<MakerVendor>,
  loaded: boolean,
): SelectableVendor | null {
  if (isSelectableVendor(preferred) && (!loaded || availableVendors.has(preferred))) return preferred;
  return SELECTABLE_VENDORS.find((vendor) => !loaded || availableVendors.has(vendor)) ?? null;
}

/** 解析常规本地任务偏好，不修改全局新建任务草稿。 */
export function resolveSkillUsageDiagnosisSessionPrefs({
  agentKind, prefs, modelChosenByUser, providers, providersLoading, capabilities,
  effortForModel, fastForModel, legacyFastForModel,
}: {
  agentKind: SelectableVendor;
  prefs: VendorPrefs;
  modelChosenByUser: boolean;
  providers: ProviderView[];
  providersLoading: boolean;
  capabilities: AgentCapabilities | null;
  effortForModel: (agent: AgentKind, providerId: string, model: string) => Effort | undefined;
  fastForModel: (agent: AgentKind, providerId: string, model: string) => boolean | undefined;
  legacyFastForModel: (model: string) => boolean;
}) {
  const agent: AgentKind = agentKind === 'cc' ? 'claude-code' : agentKind;
  const candidates = providers.map((provider) => ({
    ...provider,
    models: {
      ...provider.models,
      [agent]: (provider.models[agent] ?? []).filter((model) =>
        isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })),
    },
  })).filter((provider) => (provider.models[agent] ?? []).length > 0);
  const healthy = candidates.filter((provider) => !provider.modelDiscoveryFailure);
  const calibrationProviders = modelChosenByUser || prefs.providerId || healthy.length === 0
    ? candidates : healthy;
  const calibrated = calibrateDraftModel({
    providers: calibrationProviders, agent, model: prefs.model, chosenByUser: modelChosenByUser,
    preferredProviderId: prefs.providerId, providersLoading,
  });
  const effectiveProviderId = effectiveSourceIdForModel(
    calibrationProviders, prefs.providerId ?? calibrated.providerId, calibrated.model, agent,
  );
  const provider = providers.find((item) => item.id === effectiveProviderId);
  const model = provider ? getModel(provider, calibrated.model, agent) : undefined;
  const effort = effectiveProviderId ? resolveNewMakerDraftEffort({
    currentEffort: prefs.effort,
    presetEffort: effortForModel(agent, effectiveProviderId, calibrated.model),
    efforts: model?.efforts ?? [],
    defaultEffort: model?.defaultEffort ?? null,
  }) : prefs.effort;
  const supportsFast = resolveFastSupported({
    deviceId: undefined, deviceProviders: [], localProviders: providers, capabilities,
    providerId: effectiveProviderId, modelId: calibrated.model, agentKind: agent,
  });
  return {
    agentKind,
    model: calibrated.model,
    providerId: resolveDraftSessionProviderId({
      providers, agent, model: calibrated.model,
      explicitProviderId: prefs.providerId, effectiveProviderId,
    }),
    effort,
    permissionMode: prefs.permissionMode,
    planModeEnabled: prefs.planMode === true,
    fastMode: supportsFast && (effectiveProviderId
      ? fastForModel(agent, effectiveProviderId, calibrated.model) ?? legacyFastForModel(calibrated.model)
      : legacyFastForModel(calibrated.model)),
  };
}
