import { isSharedTaskPeer, type ProviderPickerModel } from '@cindy/device-link';
import { getCachedDeviceProviders, needsRetainedProviderModel, retainedProviderModelKey, type RetainedProviderCatalog } from '@/device-link/deviceProvidersCache';
import { getCachedProviderShareCatalogs } from '@/device-link/providerShareCatalogCache';
import { modelNeedsReselection } from './modelReselection';
import { isProviderShareAgentDeviceId } from './providerShareAgentDevice';
import { effectiveAgentDeviceId, sessionAgentKind } from './sessionAgentSwitch';
import type { RemoteSession } from './types';

type TaskModelSession = Pick<RemoteSession, 'agentKind' | 'model' | 'providerId' | 'agentDeviceId' | 'agentSwitchIntent'>;

export function taskModelCatalogRoutes(session: TaskModelSession | null | undefined, controlledDeviceId: string) {
  if (!session) return {};
  // Guests only have the task-scoped host catalog, even when its agent runs on another computer.
  const deviceFor = (intent: TaskModelSession['agentSwitchIntent']) => isSharedTaskPeer(controlledDeviceId)
    ? controlledDeviceId : effectiveAgentDeviceId(session, intent) ?? controlledDeviceId;
  const running = session.model ? { deviceId: deviceFor(null), route: {
    agent: sessionAgentKind(session), modelId: session.model, providerId: session.providerId ?? null,
  } } : undefined;
  const intent = session.agentSwitchIntent;
  const pending = intent ? { deviceId: deviceFor(intent), route: {
    agent: intent.targetAgentKind, modelId: intent.model, providerId: intent.providerId ?? null,
  } } : undefined;
  if (running && pending && running.deviceId === pending.deviceId
    && retainedProviderModelKey(running.route) === retainedProviderModelKey(pending.route)) return { running };
  return { running, pending };
}

/** Check the actual next send against its execution computer's latest snapshot before consuming the draft. */
export function blockedSessionModelAtSend(
  session: TaskModelSession,
  controlledDeviceId: string,
  ...retained: (RetainedProviderCatalog | undefined)[]
): (ProviderPickerModel & { reason: 'hidden' | 'checking' }) | undefined {
  const { running, pending } = taskModelCatalogRoutes(session, controlledDeviceId);
  const target = pending ?? running;
  if (!target) return;
  const { deviceId, route } = target;
  let visibility: Readonly<Record<string, boolean>> | undefined;
  let checking = false;
  if (isProviderShareAgentDeviceId(deviceId)) {
    const share = getCachedProviderShareCatalogs(controlledDeviceId)?.find(entry => entry.agentDeviceId === deviceId);
    visibility = share?.payload?.modelVisibilityOverrides;
  } else {
    const base = getCachedDeviceProviders(deviceId);
    const key = retainedProviderModelKey(route);
    const match = retained.find(item => item && item.base === base && item.key === key);
    visibility = match ? { ...base?.modelVisibilityOverrides, ...match.payload.modelVisibilityOverrides } : base?.modelVisibilityOverrides;
    checking = !!base && !match && needsRetainedProviderModel(base, route);
  }
  if (modelNeedsReselection(visibility, route.agent, route.modelId, route.providerId)) return { ...route, reason: 'hidden' };
  if (checking) return { ...route, reason: 'checking' };
}
