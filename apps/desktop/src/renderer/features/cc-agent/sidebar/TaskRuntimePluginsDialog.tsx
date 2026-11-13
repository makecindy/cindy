import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { GHOST_CONTROL_POINTS, type GhostControlPointCandidate, type GhostControlPointFailureAction } from '../../../../shared/ghost';
import { RUNTIME_PLUGIN_POINTS, type RuntimePluginPoint, type RuntimePluginSettings } from '../../../../shared/pluginRuntime';

export function TaskRuntimePluginsDialog({ session, onDismiss }: { session: Session; onDismiss(): void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<RuntimePluginSettings>({});
  const [candidates, setCandidates] = useState<Partial<Record<RuntimePluginPoint, GhostControlPointCandidate[]>>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const owner = useRef(getDataOwnerGeneration()).current;
  const live = useRef(true);
  const current = () => live.current && isDataOwnerGenerationCurrent(owner);
  useEffect(() => {
    live.current = true;
    void Promise.all([window.electronAPI.ghosts.runtimePlugins(session.id),
      Promise.all(RUNTIME_PLUGIN_POINTS.map(async point => [point,
        await window.electronAPI.ghosts.listControlPointCandidates(point)] as const)),
    ]).then(([value, list]) => {
      if (!current()) return;
      setSettings(value);
      setCandidates(Object.fromEntries(list));
      setLoaded(true);
    }).catch(() => { if (current()) setFailed(true); });
    return () => { live.current = false; };
  }, [session.id, owner]);
  const save = async () => {
    if (busy || !current()) return;
    setBusy(true);
    setFailed(false);
    try {
      await window.electronAPI.ghosts.runtimePlugins(session.id, settings);
      if (current()) onDismiss();
    } catch { if (current()) setFailed(true); }
    finally { if (current()) setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onDismiss(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
      <Dialog.Content className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[88vh] w-[calc(100%-32px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 p-4 [-webkit-app-region:no-drag]"
        onPointerDownOutside={event => event.preventDefault()}>
        <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{t('runtimePlugins.title')}</Dialog.Title>
        <Dialog.Description className="text-13 leading-5 text-[var(--confirm-desc)]">{t('runtimePlugins.description')}</Dialog.Description>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
          {RUNTIME_PLUGIN_POINTS.map(point => {
            const selected = settings[point] ?? [];
            const list = [...(candidates[point] ?? [])];
            for (const target of selected) if (!list.some(item => item.pluginId === target.pluginId)) {
              list.push({ pluginId: target.pluginId, name: t('scheduler.editor.preRunPlugin.unavailable') });
            }
            if (!list.length) return null;
            const unsupported = point === 'will-model-request' && (session.agentKind !== 'pi' || !!session.remoteHostId || !!session.agentDeviceId)
              || point === 'system-prompt' && session.agentKind === 'pi' && !!session.agentDeviceId;
            const spec = GHOST_CONTROL_POINTS[point];
            return <fieldset key={point} disabled={busy || !loaded} className="flex flex-col gap-2">
              <legend className="mb-2 text-14 font-medium text-[var(--text-primary)]">{t(`settings.ghosts.perm.${spec.labelKey}`)}</legend>
              {(point === 'will-compose-context' || point === 'will-search-memory') && <p className="text-13 leading-5 text-[var(--text-secondary)]">{t(`settings.ghosts.perm.${spec.detailKey}`)}</p>}
              {unsupported && <p className="text-13 leading-5 text-[var(--text-secondary)]">{t(point === 'system-prompt' ? 'runtimePlugins.promptUnsupported' : 'runtimePlugins.unsupported')}</p>}
              {list.map(plugin => {
                const target = selected.find(item => item.pluginId === plugin.pluginId);
                return <div key={plugin.pluginId} className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex min-h-8 min-w-0 items-center gap-2 text-13 text-[var(--text-primary)]">
                    <Checkbox checked={!!target} disabled={unsupported && !target} onChange={event => {
                      setSettings(value => ({ ...value, [point]: event.target.checked
                        ? [...(value[point] ?? []), { pluginId: plugin.pluginId, onFailure: spec.defaultOnFailure }]
                        : (value[point] ?? []).filter(item => item.pluginId !== plugin.pluginId) }));
                    }} />
                    <span className="break-words">{plugin.name}</span>
                  </label>
                  {target && <Select label={t('scheduler.editor.preRunPlugin.onFailureLabel')} value={target.onFailure}
                    options={spec.failureActions.map(action => ({ value: action, label: t(`scheduler.editor.preRunPlugin.onFailure.${action}`) }))}
                    onValueChange={action => setSettings(value => ({ ...value, [point]: value[point]?.map(item =>
                      item.pluginId === plugin.pluginId ? { ...item, onFailure: action as GhostControlPointFailureAction } : item) }))} />}
                </div>;
              })}
            </fieldset>;
          })}
          {failed && <p role="alert" className="text-13 text-[var(--text-primary)]">{t('runtimePlugins.failed')}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button palette="confirmation" variant="primary" disabled={!loaded || busy} onClick={() => void save()}>{t('runtimePlugins.save')}</Button>
          <Button palette="confirmation" variant="secondary" disabled={busy} onClick={onDismiss}>{t('commonUi.confirmDialog.cancel')}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
