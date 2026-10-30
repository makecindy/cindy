import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorNotice } from '@/components/ui/error-notice';
import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { useTransientModelPickerPreferences } from '@/components/new-chat/modelPickerPreferences';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import type { Effort } from '@/lib/userPreferences.types';
import type {
  PluginModelPickerRequest,
  PluginModelPickerPresentation,
} from '../../shared/pluginModelPicker';
import type { PluginTaskRoute } from '../../shared/pluginTasks';

/** Host-owned presentation: selecting and editing only changes this dialog's draft. */
export function PluginModelPickerDialog({
  request,
  deviceId,
  onAnswer,
}: {
  request: PluginModelPickerRequest;
  deviceId?: string;
  onAnswer(route: PluginTaskRoute | null): Promise<{ handled: boolean; accepted: boolean }>;
}) {
  const { t } = useTranslation();
  const [route, setRoute] = useState(request.initial);
  const preferenceStore = useTransientModelPickerPreferences(deviceId);
  const agents = useModelPickerAgents(
    route?.agentKind === 'cc' ? 'claude-code' : (route?.agentKind ?? 'codex'),
    deviceId,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const lock = useRef(false);
  const answer = async (value: PluginTaskRoute | null) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await onAnswer(value);
      if (!result.handled || !result.accepted) setError(true);
    } catch {
      setError(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      title={t('settings.ghosts.modelPicker.title', { name: request.ghostName })}
      confirmText={t('settings.ghosts.modelPicker.useConfiguration')}
      maxWidth={460}
      confirmDisabled={!route}
      loading={busy}
      onConfirm={() => {
        void answer(route ?? null);
      }}
      onCancel={() => {
        void answer(null);
      }}
      onOpenChange={(open) => {
        if (!open && !lock.current) void answer(null);
      }}
      content={
        <>
          <ModelSelectorContent
            preferenceStore={preferenceStore}
            deviceId={deviceId}
            modelId={route?.model ?? ''}
            currentProviderId={route?.providerId ?? null}
            vendorKey={route?.agentKind}
            effort={(route?.effort ?? '') as Effort}
            fastMode={route?.fastMode ?? false}
            unifiedAgents={(agents ?? ['claude-code', 'codex', 'pi']).filter((agent) => agent !== 'zcode')}
            overlayContentClassName="z-[10001]"
            onModelChange={() => false}
            onEffortChange={(effort) => {
              setRoute((r) => (r ? { ...r, effort } : r));
            }}
            onFastModeChange={(fastMode) => {
              setRoute((r) => (r ? { ...r, fastMode } : r));
            }}
            onUnifiedSelect={({ providerId, modelId, engine, effort, fast }) => {
              if (engine === 'zcode') return false;
              setRoute({
                providerId,
                model: modelId,
                agentKind: engine,
                effort: effort ?? '',
                fastMode: fast,
              });
              setError(false);
              return true;
            }}
          />
          {error && (
            <ErrorNotice className="mt-3" message={t('settings.ghosts.modelPicker.unavailable')} />
          )}
        </>
      }
    />
  );
}

export function PluginModelPickerHost() {
  const [request, setRequest] = useState<PluginModelPickerPresentation>();
  const active = useRef<PluginModelPickerPresentation | undefined>(undefined);
  const dismissed = useRef(new Set<string>());
  useEffect(() => {
    const api = window.electronAPI.ghosts;
    const off = api.onModelPickerRequest?.((next) => {
      if (dismissed.current.has(next.requestId)) return;
      if (active.current) {
        if (active.current.requestId !== next.requestId) {
          const answer = next.remoteViewId
            ? api.answerRemoteModelPicker(next.remoteViewId, next.requestId, null)
            : api.resolveModelPicker(next.requestId, null);
          void answer.catch(() => {});
        }
        return;
      }
      active.current = next;
      setRequest(next);
    });
    const dismiss = api.onModelPickerDismissed?.(({ requestId }) => {
      dismissed.current.add(requestId);
      if (dismissed.current.size > 64)
        dismissed.current.delete(dismissed.current.values().next().value!);
      if (active.current?.requestId === requestId) active.current = undefined;
      setRequest((value) => (value?.requestId === requestId ? undefined : value));
    });
    return () => {
      off?.();
      dismiss?.();
    };
  }, []);
  return request ? (
    <PluginModelPickerDialog
      key={request.requestId}
      request={request}
      deviceId={request.deviceId}
      onAnswer={(route) =>
        request.remoteViewId
          ? window.electronAPI.ghosts.answerRemoteModelPicker(
              request.remoteViewId,
              request.requestId,
              route,
            )
          : window.electronAPI.ghosts.resolveModelPicker(request.requestId, route)
      }
    />
  ) : null;
}
