import { isSharedTaskPeer, type ProviderPickerModel } from '@cindy/device-link';
import { getCachedDeviceProviders, retainedProviderModelKey, type RetainedProviderCatalog } from '@/device-link/deviceProvidersCache';
import { getCachedProviderShareCatalogs } from '@/device-link/providerShareCatalogCache';
import { modelNeedsReselection } from './modelReselection';
import { isProviderShareAgentDeviceId } from './providerShareAgentDevice';
import { effectiveAgentDeviceId, sessionAgentKind } from './sessionAgentSwitch';
import type { RemoteSession } from './types';

/** Check the actual next send against its execution computer's latest snapshot before consuming the draft. */
export function hiddenSessionModelAtSend(
  session: Pick<RemoteSession, 'agentKind' | 'model' | 'providerId' | 'agentDeviceId' | 'agentSwitchIntent'>,
  controlledDeviceId: string,
  retained?: RetainedProviderCatalog,
): ProviderPickerModel | undefined {
  const intent = session.agentSwitchIntent;
  const route = intent
    ? { agent: intent.targetAgentKind, modelId: intent.model, providerId: intent.providerId ?? null }
    : { agent: sessionAgentKind(session), modelId: session.model, providerId: session.providerId ?? null };
  // Guests only have the task-scoped host catalog, even when its agent runs on another computer.
  const device = isSharedTaskPeer(controlledDeviceId) ? null : effectiveAgentDeviceId(session, intent);
  let visibility: Readonly<Record<string, boolean>> | undefined;
  if (isProviderShareAgentDeviceId(device)) {
    const share = getCachedProviderShareCatalogs(controlledDeviceId)?.find(entry => entry.agentDeviceId === device);
    visibility = share?.payload?.modelVisibilityOverrides;
  } else {
    const base = getCachedDeviceProviders(device ?? controlledDeviceId);
    visibility = retained && retained.base === base && retained.key === retainedProviderModelKey(route)
      ? retained.payload.modelVisibilityOverrides
      : base?.modelVisibilityOverrides;
  }
  return modelNeedsReselection(visibility, route.agent, route.modelId, route.providerId) ? route : undefined;
}
