import { useState } from 'react';
import type { ForkTarget } from '@cindy/maker-shared/fork-request';
import { ModelRouteSelectorContent } from '@/components/new-chat/ModelRouteSelector';
import { useTransientModelPickerPreferences } from '@/components/new-chat/modelPickerPreferences';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { usePluginModelPickerEngines } from '@/hooks/usePluginModelPickerEngines';
import { modelCatalogKey } from '../../../shared/controlledModelCatalog';
import { PLUGIN_ENGINE_DEFAULT_MODEL } from '@/lib/pluginEngineSelection';
import type { Effort } from '@/lib/userPreferences.types';

/** Draft-only selection. Uses the task host's ordinary model/location catalog. */
export function ForkTargetPicker({ deviceId, onChange }: {
  deviceId?: string;
  onChange(target: ForkTarget): void;
}) {
  const [route, setRoute] = useState<ForkTarget>();
  const preferences = useTransientModelPickerPreferences(deviceId);
  const agents = useModelPickerAgents(route?.agentKind === 'acp' ? 'codex' : route?.agentKind ?? 'codex',
    modelCatalogKey(route?.agentDeviceId ?? deviceId, deviceId));
  const update = (next: ForkTarget) => { setRoute(next); onChange(next); };
  const pluginEngines = usePluginModelPickerEngines({
    enabled: true, allowRemote: true, hostDeviceId: deviceId,
    active: route ? { agentKind: route.agentKind === 'claude-code' ? 'cc' : route.agentKind,
      model: route.model, providerId: route.providerId, agentDeviceId: route.agentDeviceId, effort: route.effort ?? '' } : null,
    onSelect: selection => {
      update({ agentKind: 'acp', providerId: selection.providerId,
        model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL, effort: selection.effort ?? '',
        fastMode: false, agentDeviceId: selection.deviceId ?? null });
      return true;
    },
  });
  return <ModelRouteSelectorContent
    fluidWidth
    deviceId={deviceId} agentDeviceId={route?.agentDeviceId}
    preferenceStore={preferences} unifiedAgents={agents} pluginEngines={pluginEngines}
    modelId={route?.model ?? ''} currentProviderId={route?.providerId ?? null}
    vendorKey={route?.agentKind === 'claude-code' ? 'cc' : route?.agentKind === 'acp' ? undefined : route?.agentKind}
    effort={(route?.effort ?? '') as Effort} fastMode={route?.fastMode ?? false}
    onModelChange={() => false}
    onEffortChange={effort => { if (route) update({ ...route, effort }); }}
    onFastModeChange={fastMode => { if (route) update({ ...route, fastMode }); }}
    onUnifiedSelect={({ providerId, modelId, engine, effort, fast, agentDevice }) => {
      update({ providerId, model: modelId, agentKind: engine === 'cc' ? 'claude-code' : engine,
        effort: effort ?? '', fastMode: fast, agentDeviceId: agentDevice?.deviceId ?? null });
      return true;
    }}
  />;
}
