import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PluginTaskPrefs } from '@/cindy-brain/PluginTaskPrefs';
import { GhostSettingsWebview } from '@/cindy-brain/GhostSettingsWebview';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import {
  pluginHasModelPreferences,
  type RemotePluginPreferenceSnapshot,
} from '../../../shared/pluginPreferences';
import { DetailSectionHeader } from './GhostPluginDetailView';
import {
  invokePluginManagement,
  parseRemotePluginPreferences,
} from './remotePluginManagementClient';

export function RemotePluginConfiguration({
  ghost,
  device,
  online,
  active,
  busy,
  hostPreferences,
  settingsPage,
}: {
  ghost: InstalledGhost;
  device: { deviceId: string; name: string };
  online: boolean;
  active: boolean;
  busy: boolean;
  hostPreferences: boolean;
  settingsPage: boolean;
}) {
  const { t } = useTranslation();
  const [read, setRead] = useState<{
    ghost: InstalledGhost;
    preferences?: RemotePluginPreferenceSnapshot;
    failed: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0),
    [saving, setSaving] = useState(false);
  const owner = useRef(getDataOwnerGeneration()).current;
  const live = useRef(false),
    epoch = useRef(0),
    saveLock = useRef(false);
  const scope = useRef({ ghost, online, active, deviceId: device.deviceId });
  scope.current = { ghost, online, active, deviceId: device.deviceId };
  const id = installedGhostStoragePart(ghost);
  const current = useCallback(
    (captured: InstalledGhost) =>
      live.current &&
      scope.current.deviceId === device.deviceId &&
      scope.current.ghost === captured &&
      scope.current.online &&
      scope.current.active &&
      isDataOwnerGenerationCurrent(owner),
    [owner, device.deviceId],
  );
  const load = useCallback(async () => {
    const revision = ++epoch.current;
    if (!current(ghost) || !ghost.enabled) return;
    try {
      const preferences = hostPreferences
        ? parseRemotePluginPreferences(
            await invokePluginManagement(
              device.deviceId,
              'preferences',
              { expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval) },
              id,
            ),
          )
        : undefined;
      if (revision === epoch.current && current(ghost))
        setRead({ ghost, preferences, failed: false });
    } catch {
      if (revision === epoch.current && current(ghost)) setRead({ ghost, failed: true });
    }
  }, [current, ghost, device.deviceId, id, hostPreferences]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      ++epoch.current;
    };
  }, [load, attempt, online, active]);
  const data = read?.ghost === ghost ? read : null;
  const preferences = data?.preferences;
  const disabled = !online || !active || busy || saving || !data || data.failed;
  const save = async (patch: Record<string, unknown>) => {
    if (disabled || saveLock.current || !preferences || !current(ghost))
      throw new Error('PLUGIN_SETTINGS_UNAVAILABLE');
    saveLock.current = true;
    setSaving(true);
    try {
      const value = parseRemotePluginPreferences(
        await invokePluginManagement(
          device.deviceId,
          'preferences-set',
          {
            ...patch,
            expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval),
            expectedRevision: preferences.revision,
          },
          id,
        ),
      );
      if (!current(ghost)) throw new Error('PLUGIN_SETTINGS_CLOSED');
      ++epoch.current;
      setRead({ ...data, ghost, preferences: value, failed: false });
      return value;
    } catch (error) {
      if (current(ghost)) {
        setRead((previous) =>
          previous?.ghost === ghost ? { ...previous, failed: true } : previous,
        );
        // Only read the target after an uncertain write; never replay it.
        await load();
      }
      throw error;
    } finally {
      saveLock.current = false;
      if (live.current) setSaving(false);
    }
  };
  const hasTasks = Boolean(
    ghost.manifest.workspace || ghost.manifest.agent?.tasks || ghost.manifest.agent?.errand,
  );
  const hasNative = pluginHasModelPreferences(ghost.manifest) || ghost.manifest.mainView?.html;
  if (!ghost.enabled)
    return (
      <p className="mt-10 text-13 leading-5 text-[var(--text-secondary)]">
        {t('settings.ghosts.remote.enableBeforeConfigure')}
      </p>
    );
  if (!hasNative && !ghost.manifest.settingsHtml) return null;
  return (
    <section className="mt-10" aria-labelledby="ghost-configuration-title">
      <DetailSectionHeader
        id="ghost-configuration-title"
        title={t('settings.ghosts.detail.configurationTitle')}
      />
      <div className="mt-5 max-w-[760px] space-y-3">
        <p className="text-13 leading-5 text-[var(--text-secondary)]">
          {t('settings.ghosts.remote.targetOnly', { device: device.name })}
        </p>
        {!data && online && (
          <p role="status" className="text-13 leading-5 text-[var(--text-secondary)]">
            {t('settings.ghosts.remote.configurationLoading')}
          </p>
        )}
        {data?.failed && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="status" className="text-13 leading-5 text-[var(--text-secondary)]">
              {t('settings.ghosts.remote.configurationReadFailed')}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={!online || saving}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t('settings.ghosts.remote.refreshConfiguration')}
            </Button>
          </div>
        )}
        {preferences?.sidebarVisible !== undefined && (
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
                {t('settings.ghosts.detail.sidebarEntryTitle')}
              </p>
              <p className="text-13 leading-5 text-[var(--text-secondary)]">
                {t('settings.ghosts.detail.sidebarEntryDescription', {
                  title: ghost.manifest.mainView?.title ?? ghost.manifest.name,
                })}
              </p>
            </div>
            <Switch
              disabled={disabled}
              checked={preferences.sidebarVisible}
              aria-label={t('settings.ghosts.detail.showInSidebar')}
              onCheckedChange={(visible) => {
                void save({ kind: 'sidebar', visible }).catch(() => {});
              }}
            />
          </div>
        )}
        {preferences?.tasks && (
          <PluginTaskPrefs
            ghostId={id}
            appearance="plugin"
            disabled={disabled}
            showTaskRows={hasTasks}
            legacyDefault={
              ghost.manifest.agent?.errand === true &&
              !ghost.manifest.agent?.tasks &&
              !ghost.manifest.workspace
            }
            remote={{
              auxiliaryModelLabel: preferences.auxiliaryModelLabel ?? null,
              deviceId: device.deviceId,
              value: preferences.tasks,
              onChange: async (config) => {
                const model =
                  config.agentKind && config.providerId && config.model
                    ? {
                        agentKind: config.agentKind,
                        providerId: config.providerId,
                        model: config.model,
                        ...(config.effort ? { effort: config.effort } : {}),
                        fastMode: config.fastMode ?? false,
                      }
                    : null;
                const next = await save({
                  kind: 'tasks',
                  patch: { model, permissionMode: config.permissionMode ?? null },
                });
                return next.tasks!;
              },
            }}
          />
        )}
        {hasNative && !hostPreferences && (
          <p className="text-13 leading-5 text-[var(--text-secondary)]">
            {t('settings.ghosts.remote.hostPreferencesUnavailable', { device: device.name })}
          </p>
        )}
        {ghost.manifest.settingsHtml && settingsPage && online && active && (
          <GhostSettingsWebview
            ghost={ghost}
            title={t('settings.ghosts.detail.settingsTitle', { name: ghost.manifest.name })}
            appearance="plugin"
            remoteDeviceId={device.deviceId}
          />
        )}
        {ghost.manifest.settingsHtml && !settingsPage && (
          <p className="text-13 leading-5 text-[var(--text-secondary)]">
            {t('settings.ghosts.remote.settingsPageUnavailable', { device: device.name })}
          </p>
        )}
      </div>
    </section>
  );
}
