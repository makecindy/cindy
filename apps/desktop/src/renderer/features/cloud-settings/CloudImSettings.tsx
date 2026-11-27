import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ModelSelector,
  type RemoteAgentSelectorOptions,
} from '@/components/new-chat/ModelSelector';
import { resolveDeviceModelGroup, useDeviceModelGroups } from '@/features/model-groups/remoteModelGroups';
import type { ModelGroupSelection } from '../../../shared/modelGroups';
import {
  ImDefaultSettingsSectionFrame,
  ImDefaultSettingsSectionView,
  type ImDefaultSettingsSummary,
} from '@/components/settings/ImDefaultSettingsSection';
import {
  TelegramBehaviorSettingsView,
  TelegramGroupActivationSettingsView,
} from '@/components/settings/TelegramBehaviorSettings';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { additionalSettingsSchemas } from '../../../shared/settingsEditableCatalog';
import {
  activeImDefaultAgentSettings,
  isImDefaultBuiltinAgentKind,
  isImDefaultEffort,
  isImDefaultPermissionMode,
  type ImDefaultBuiltinAgentKind,
  type ImDefaultSettingsChannel,
} from '../../../shared/imDefaultSettings';
import type { CloudSettingsDomain, CloudSettingsState } from '../../../shared/cloudSettings';
import type { ImDefaultSettingsState } from '../../../shared/imDefaultSettings';
import { createCloudImCaller } from './cloudImTarget';
import { CloudDesktopFallback } from './CloudDesktopFallback';
import { CloudRequestError } from './CloudRequestError';

// Instance bots run on the instance. The cloud page reads only its catalog and cannot see the
// computers paired with it, so agents on other computers are unavailable here.
const INSTANCE_ONLY_AGENTS: RemoteAgentSelectorOptions | undefined = undefined;

const channels = {
  feishu: 'imFeishu',
  discord: 'imDiscord',
  wechat: 'imWechat',
  telegram: 'imTelegram',
  dingtalk: 'imDingtalk',
  wecom: 'imWecom',
} as const;
const routeKey = (agent: ImDefaultBuiltinAgentKind) =>
  agent === 'claude-code' ? 'claudeCode' : agent;
const vendorOf = (agent: ImDefaultBuiltinAgentKind) => (agent === 'claude-code' ? 'cc' : agent);
type Props = {
  itemId: string;
  section?: 'defaults' | 'telegram';
  deviceId: string;
  /** The instance's display name. */
  name: string;
  states: Partial<Record<CloudSettingsDomain, CloudSettingsState>>;
  disabled: boolean;
  loading?: boolean;
  readFailed?: boolean;
  supportedDomains?: readonly CloudSettingsDomain[];
  retry?(): void;
  retryDisabled?: boolean;
  /** The instance's own display of the channel defaults (resolved automatic route), when reported. */
  display?: ImDefaultSettingsState | null;
  save(
    state: CloudSettingsState,
    set: Record<string, unknown>,
    clear?: string[],
  ): Promise<CloudSettingsState>;
};
/** All reads/writes target the selected cloud Host. Official hooks never use personal bot scopes. */
export function CloudImSettings({
  itemId,
  section = 'defaults',
  deviceId,
  name,
  states,
  disabled,
  save,
  loading = false,
  readFailed = false,
  supportedDomains,
  retry,
  retryDisabled = false,
  display,
}: Props) {
  const { t } = useTranslation();
  const deviceGroups = useDeviceModelGroups(section === 'defaults' ? deviceId : null, section === 'defaults');
  const lastUnifiedCloudRef = useRef<{ agent: ImDefaultBuiltinAgentKind; modelId: string; providerId: string | null; effort: unknown } | null>(null);
  const channel = itemId.replace(/^bot:/, '') as keyof typeof channels;
  const domain = channels[channel];
  if (!domain || (section === 'telegram' && channel !== 'telegram')) return null;
  const state = states[domain];
  const supported = !supportedDomains || supportedDomains.includes(domain);
  const commit = async (s: CloudSettingsState, set: Record<string, unknown>, clear?: string[]) => {
    if (disabled) return false;
    try {
      await save(s, set, clear);
      return true;
    } catch {
      toast.error(t('hostSettings.saveFailed'));
      return false;
    }
  };
  const parsed =
    state?.status === 'ready' ? additionalSettingsSchemas[domain].safeParse(state.value) : null;
  const value = parsed?.success ? parsed.data : null;
  const behavior = states.telegramBehavior;
  const groups = states.telegramGroups;
  const active = value?.[routeKey(value.agentKind)];
  const agents = (state?.choices?.agentKind ?? [])
    .map((choice) => choice.value)
    .filter(
      (agent): agent is ImDefaultBuiltinAgentKind =>
        agent === 'claude-code' || agent === 'codex' || agent === 'pi',
    );
  const select = (
    agent: ImDefaultBuiltinAgentKind,
    modelId: string,
    providerId: string | null,
    effort: unknown,
  ) => {
    if (!state || !value || !agents.includes(agent)) return false;
    // The DeviceLink picker uses the target catalog. The settings snapshot is the
    // additional allowlist; a route disappearing between reads is never guessed.
    const options = state.choices?.[routeKey(agent)] ?? [];
    const option = options.find((choice) => {
      const route = choice.value;
      return (
        !!route &&
        !Array.isArray(route) &&
        typeof route === 'object' &&
        route.modelId === modelId &&
        route.providerId === providerId
      );
    });
    if (
      !option ||
      !isImDefaultEffort(effort) ||
      (option.efforts?.length && !option.efforts.includes(effort))
    ) {
      toast.error(t('hostSettings.saveFailed'));
      return false;
    }
    return commit(state, {
      agentKind: agent,
      [routeKey(agent)]: { providerId, modelId, effort },
      ...(value.modelGroup ? { modelGroup: null } : {}),
    });
  };
  const selectModelGroup = async (selection: ModelGroupSelection) => {
    if (!state || !value || !deviceGroups.config) return;
    const group = deviceGroups.config.routes.find((r) => r.id === selection.id);
    const preview = await resolveDeviceModelGroup(deviceId, selection, undefined, undefined, undefined);
    if (preview?.outcome !== 'routed') {
      toast.warning(t('modelGroups.picker.chooseUnavailable', { name: group?.name ?? '' }));
      return;
    }
    if (preview.route.agentKind === 'acp') {
      toast.warning(t('modelGroups.picker.chooseUnavailable', { name: group?.name ?? '' }));
      return;
    }
    const agent: ImDefaultBuiltinAgentKind = preview.route.agentKind === 'cc' ? 'claude-code' : preview.route.agentKind;
    if (!agents.includes(agent)) {
      toast.warning(t('modelGroups.picker.chooseUnavailable', { name: group?.name ?? '' }));
      return;
    }
    const effort = isImDefaultEffort(preview.route.effort) ? preview.route.effort : value[routeKey(agent)].effort;
    await commit(state, {
      agentKind: agent,
      [routeKey(agent)]: { providerId: preview.route.providerId, modelId: preview.route.model, effort },
      modelGroup: selection.id,
    });
  };
  const always = Array.isArray(groups?.value?.always)
    ? groups.value.always.filter((id): id is string => typeof id === 'string')
    : [];
  const knownGroups = new Map(
    (groups?.choices?.always ?? [])
      .filter((choice) => typeof choice.value === 'string')
      .map((choice) => [String(choice.value), choice.label]),
  );
  // Retain explicitly configured groups absent from the current discovery page.
  for (const id of always) if (!knownGroups.has(id)) knownGroups.set(id, id);
  const available = !loading && !readFailed && supported && state && value && active;
  // Like the local picker, the automatic route shows the model it resolves to ("Auto · 高").
  const shown =
    display &&
    value &&
    active &&
    !active.modelId &&
    display.automaticModel &&
    isImDefaultBuiltinAgentKind(display.agentKind)
      ? { agentKind: display.agentKind, route: display.agents[display.agentKind] }
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {section === 'defaults' && !available && (
        <ImDefaultSettingsSectionFrame descriptionChannel={channel} embedded>
          {loading ? (
            <p role="status" className="text-13 text-[var(--text-tertiary)]">
              {t('settings.imBot.defaults.loading')}
            </p>
          ) : !readFailed && (!supported || state?.status === 'unavailable') ? (
            // Not offered by this instance.
            <CloudRequestError message={t('bots.remoteSettings.unsupported')} />
          ) : (
            // One line and 「重新读取」, as the client's settings read failure.
            <CloudRequestError
              message={t(
                state?.readErrorCode === 'SETTINGS_RESPONSE_TOO_LARGE' ||
                  state?.readErrorCode === 'MODEL_CATALOG_TOO_LARGE'
                  ? 'cloudSettings.imReadTooLarge'
                  : 'cloudSettings.imReadFailed',
              )}
              retryLabel={t('commonUi.retry')}
              onRetry={retry}
              disabled={retryDisabled}
            />
          )}
        </ImDefaultSettingsSectionFrame>
      )}
      {section === 'telegram' && (
        <>
          <CloudDesktopFallback
            deviceId={deviceId}
            name={name}
            label={t('settings.telegramBot.persona.title')}
          />
          {(['telegramBehavior', 'telegramGroups'] as const)
            .filter((domain) => states[domain]?.status !== 'ready')
            .map((domain) => (
              <ErrorNotice
                key={domain}
                role="alert"
                message={t(
                  domain === 'telegramBehavior'
                    ? 'settings.telegramBot.behavior.title'
                    : 'settings.telegramBot.groups.title',
                )}
                description={
                  states[domain]?.status === 'unavailable'
                    ? t('bots.remoteSettings.unsupported')
                    : undefined
                }
                details={states[domain]?.readErrorCode}
                actions={
                  retry && (
                    <Button size="sm" disabled={retryDisabled} onClick={retry}>
                      {t('cloudSettings.reload')}
                    </Button>
                  )
                }
              />
            ))}
        </>
      )}
      <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
        {section === 'defaults' && available && (
          <ImDefaultSettingsSectionView
            deviceId={deviceId}
            embedded
            channel={channel as ImDefaultSettingsChannel}
            pending={disabled}
            settings={{
              agentKind: value.agentKind,
              groupPermissionMode:
                'groupPermissionMode' in value &&
                isImDefaultPermissionMode(value.groupPermissionMode)
                  ? value.groupPermissionMode
                  : 'auto',
              isCustomized: !!state.isCustomized,
            }}
            reset={() =>
              commit(state, {}, [
                ...Object.keys(state.defaults ?? {}),
                ...(value.modelGroup ? ['modelGroup'] : []),
              ])
            }
            automaticModel={!active.modelId && !value.modelGroup}
            activeModel={active.modelId}
            showAutomaticUnavailable={false}
            useAutomatic={() =>
              commit(state, {
                agentKind: 'claude-code',
                ...(value.modelGroup ? { modelGroup: null } : {}),
                ...Object.fromEntries(
                  ['claudeCode', 'codex', 'pi'].map((key) => [
                    key,
                    { providerId: null, modelId: '', effort: 'high' },
                  ]),
                ),
              })
            }
            onGroupPermissionChange={(groupPermissionMode) =>
              commit(state, { groupPermissionMode })
            }
            modelPicker={
              <ModelSelector
                deviceId={deviceId}
                remoteAgent={INSTANCE_ONLY_AGENTS}
                modelId={shown?.route.model ?? active.modelId}
                effort={shown?.route.effort ?? active.effort}
                disabled={disabled}
                fastModeConfigurable={false}
                unifiedAgents={agents}
                {...(deviceGroups.config ? {
                  modelGroups: {
                    config: deviceGroups.config,
                    active: value.modelGroup && deviceGroups.config.routes.some((r) => r.id === value.modelGroup)
                      ? { type: 'route' as const, id: value.modelGroup }
                      : null,
                    onSelect: (selection: ModelGroupSelection) => { void selectModelGroup(selection); },
                    onAttach: (selection: ModelGroupSelection) => {
                      const last = lastUnifiedCloudRef.current;
                      lastUnifiedCloudRef.current = null;
                      if (!last) return;
                      const effort = isImDefaultEffort(last.effort) ? last.effort : value[routeKey(last.agent)].effort;
                      void commit(state, {
                        agentKind: last.agent,
                        [routeKey(last.agent)]: { providerId: last.providerId, modelId: last.modelId, effort },
                        modelGroup: selection.id,
                      });
                    },
                  },
                } : {})}
                configurationEnabled={false}
                recordRecentUsage={false}
                currentProviderId={active.providerId}
                vendorKey={vendorOf(shown?.agentKind ?? value.agentKind)}
                triggerVariant="field"
                popoverSide="bottom"
                onModelChange={(id) =>
                  select(shown?.agentKind ?? value.agentKind, id, active.providerId, active.effort)
                }
                onEffortChange={(effort) =>
                  select(
                    shown?.agentKind ?? value.agentKind,
                    shown?.route.model ?? active.modelId,
                    active.providerId,
                    effort,
                  )
                }
                onProviderChange={(provider, id, effort) =>
                  select(
                    shown?.agentKind ?? value.agentKind,
                    id ?? shown?.route.model ?? active.modelId,
                    provider,
                    effort ?? active.effort,
                  )
                }
                onUnifiedSelect={({ engine, modelId, providerId, effort }) => {
                  const agent: ImDefaultBuiltinAgentKind = engine === 'cc' ? 'claude-code' : engine;
                  lastUnifiedCloudRef.current = { agent, modelId, providerId, effort };
                  return select(agent, modelId, providerId, effort);
                }}
              />
            }
          />
        )}
        {section === 'telegram' && behavior?.status === 'ready' && (
          <TelegramBehaviorSettingsView
            behavior={additionalSettingsSchemas.telegramBehavior.parse(behavior.value)}
            patch={(patch) => void commit(behavior, patch)}
          />
        )}
        {section === 'telegram' && groups?.status === 'ready' && (
          <TelegramGroupActivationSettingsView
            groups={[...knownGroups].map(([chatId, chatName]) => ({
              chatId,
              chatName,
              activation: always.includes(chatId) ? 'always' : 'mention',
            }))}
            setMode={(id, mode) =>
              void commit(groups, {
                always:
                  mode === 'always'
                    ? [...new Set([...always, id])]
                    : always.filter((value) => value !== id),
              })
            }
          />
        )}
      </fieldset>
    </div>
  );
}

/** Collapsed native card summary comes only from the selected Host snapshot. */
export function cloudImSettingsSummary(
  itemId: string,
  states: Props['states'],
  automaticLabel: string,
  display?: ImDefaultSettingsState | null,
): ImDefaultSettingsSummary | null {
  const domain = channels[itemId.replace(/^bot:/, '') as keyof typeof channels];
  if (!domain) return null;
  // The instance's display wire is what the local collapsed row shows ("Pi · auto").
  if (display?.automaticModel)
    return {
      agentKind: display.agentKind,
      model: activeImDefaultAgentSettings(display).model || automaticLabel,
    };
  const state = states[domain];
  const parsed =
    state?.status === 'ready' ? additionalSettingsSchemas[domain].safeParse(state.value) : null;
  if (!parsed?.success) return null;
  const value = parsed.data;
  const route = value[routeKey(value.agentKind)];
  const choice = state?.choices?.[routeKey(value.agentKind)]?.find(
    ({ value: option }) =>
      option &&
      typeof option === 'object' &&
      !Array.isArray(option) &&
      option.modelId === route.modelId &&
      option.providerId === route.providerId,
  );
  return {
    agentKind: value.agentKind,
    model: route.modelId ? (choice?.label ?? route.modelId) : automaticLabel,
  };
}

/**
 * The instance's display of each personal channel's defaults over its IM channel. Older
 * runtimes return nothing and the cards keep the stored snapshot.
 *
 * Each read resolves the model catalog on the instance (about half a second, one call at a
 * time), so a channel is read once per visit and again only when its own settings revision
 * changes, not on every settings change of the page.
 */
export function useCloudImDisplays(
  deviceId: string,
  enabled: boolean,
  states: Partial<Record<CloudSettingsDomain, CloudSettingsState>>,
) {
  const [displays, setDisplays] = useState<Partial<Record<string, ImDefaultSettingsState>>>({});
  const visit = useRef<{
    key: string;
    live: boolean;
    read: Map<string, { revision: unknown }>;
  } | null>(null);
  useEffect(() => {
    setDisplays({});
  }, [deviceId]);
  useEffect(
    () => () => {
      if (visit.current) visit.current.live = false;
    },
    [],
  );
  const revisions = JSON.stringify(
    Object.values(channels).map((domain) => states[domain]?.revision ?? null),
  );
  useEffect(() => {
    const key = `${deviceId}\n${enabled}`;
    if (visit.current?.key !== key) {
      if (visit.current) visit.current.live = false;
      visit.current = { key, live: true, read: new Map() };
    }
    if (!enabled || !deviceId) return;
    const current = visit.current;
    const latest = JSON.parse(revisions) as unknown[];
    const call = createCloudImCaller(deviceId);
    Object.keys(channels).forEach((channel, index) => {
      const revision = latest[index];
      if (current.read.has(channel) && current.read.get(channel)!.revision === revision) return;
      const read = { revision };
      current.read.set(channel, read);
      void call<ImDefaultSettingsState>('maker:im-default-settings:get', channel)
        .then((state) => {
          if (
            current.live &&
            current.read.get(channel) === read &&
            state &&
            typeof state === 'object'
          )
            setDisplays((old) => ({ ...old, [channel]: state }));
        })
        .catch(() => {});
    });
  }, [deviceId, enabled, revisions]);
  return displays;
}
