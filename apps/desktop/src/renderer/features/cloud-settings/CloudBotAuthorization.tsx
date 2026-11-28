import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { BlockReadFailure } from './blockRetry';
import { CloudAuthProgress } from './CloudAuthProgress';
import { Switch } from '@/components/ui/switch';
import { ImChannelSettingsCard } from '@/components/settings/ImChannelSettingsCard';
import { OAuthBrowserLink, OAuthDeviceCodeCard } from '@/components/settings/OAuthDeviceCodeCard';
import { CloudBotConnectionForm, cloudBotActionLabel } from './CloudBotConnectionForm';
import {
  CloudPersonalBotSettings,
  personalBotChannels,
  type PersonalBotChannel,
} from './CloudPersonalBotSettings';
import type { ImDefaultSettingsSummary } from '@/components/settings/ImDefaultSettingsSection';
import { ImBotSettingsFrame, ImBotGroupSection } from '@/components/settings/ImBotSettingsLayout';
import {
  ChannelStatusBadge,
  HookConnectionsDescription,
  HookConnectionsSection,
} from '@/components/settings/HookConnectionsSection';
import { SettingsTargetProvider } from '@/components/settings/settingsTarget';
import {
  useCloudAuthorization,
  supportedBotActions,
  type CloudAuthorizationProps,
} from './useCloudAuthorization';
import {
  CloudBotNotificationSettings,
  type CloudBotNotificationPreferences,
} from './CloudBotNotificationSettings';
import {
  BOT_NOTIFICATION_GROUP,
  BOT_NOTIFICATION_ITEMS,
} from '../../../shared/cloudBotNotifications';
import {
  CloudTelegramSettings,
  CloudWechatWorkingDirectory,
  useCloudImTarget,
} from './CloudImNative';

/** Same accordion and group layout as local IM settings; only cloud tickets are executed. */
export function CloudBotAuthorization(
  props: CloudAuthorizationProps & {
    /** Target device; the native IM cards call it over its private DeviceLink channel. */
    deviceId: string;
    settings?(itemId: string, section?: 'defaults' | 'telegram'): ReactNode;
    summary?(itemId: string): ImDefaultSettingsSummary | null;
    notificationPreferences?: CloudBotNotificationPreferences;
  },
) {
  const {
    t,
    items,
    loading,
    failure,
    readFailure,
    operationItem,
    requesting,
    run,
    operate,
    prompt,
    open,
    busy,
    phaseText,
    progressUnreadable,
    settling,
    checking,
  } = useCloudAuthorization(props, 'bots');
  const [expanded, setExpanded] = useState<Record<string, string | null>>({});
  // Cards remount on every list reload (their key carries the ticket), so the typed
  // webhook lives here to survive a failed save, as the local input does.
  const [wecomWebhook, setWecomWebhook] = useState('');
  const wecomEditing =
    props.online &&
    props.active &&
    expanded.personal === 'bot:wecom' &&
    items.some(
      (item) => item.id === BOT_NOTIFICATION_ITEMS.wecomGroup && item.status !== 'connected',
    );
  useEffect(() => {
    if (!wecomEditing) setWecomWebhook('');
  }, [wecomEditing]);
  const disabled = !props.online || requesting || loading;
  // Runtimes with the IM channel get the local cards; older ones keep the ticket cards below.
  const native = useCloudImTarget({
    deviceId: props.deviceId,
    deviceName: props.name,
    // The trial has no instance to call; it keeps the ticket cards.
    enabled: props.online && props.active && !props.trial,
    items,
    run: (item, action) => run(item, action, {}, { confirmed: true }),
    cancelOperation: () => operate('cancel'),
    operationItem,
    operationActive: busy,
  });
  const nativeIm = native.support === 'ready';
  const nativeFailed = native.support === 'failed';
  const officialOperation = operationItem?.startsWith('bot:official:') ?? false;
  // Notification items belong inside their channel card. An older target lists none,
  // and its cards keep the explicit "not available" note.
  const notificationsSupported = items.some((item) => item.group === BOT_NOTIFICATION_GROUP);
  const notificationSettings = (channel: PersonalBotChannel) => {
    if (channel !== 'wecom' && channel !== 'feishu' && channel !== 'discord') return undefined;
    // Like the credential forms, no webhook input stays on screen for an offline target.
    if (!props.online) return null;
    if (!notificationsSupported) return undefined;
    const item = items.find(
      (entry) => entry.id === BOT_NOTIFICATION_ITEMS[channel === 'wecom' ? 'wecomGroup' : channel],
    );
    // Feishu, like the local card, shows no notification section before credentials exist.
    if (!item) return channel === 'feishu' ? null : undefined;
    const own = operationItem === item.id;
    return (
      <CloudBotNotificationSettings
        channel={channel}
        item={item}
        targetName={props.name}
        webhookDraft={[wecomWebhook, setWecomWebhook]}
        preferences={props.notificationPreferences}
        disabled={disabled || !props.active || (busy && !own)}
        pending={own && busy}
        runSettled={(target, action, values) =>
          new Promise((settled) => void run(target, action, values, { confirmed: true, settled }))
        }
      />
    );
  };
  const label = (id: string, fallback: string) =>
    ['wechat', 'wecom', 'feishu', 'dingtalk', 'discord', 'telegram'].includes(
      id.replace(/^bot:/, ''),
    )
      ? t(`settings.${id.slice(4)}Bot.title`)
      : fallback;
  // Official channels reuse the local card copy; other items (e.g. a bound Slack
  // workspace) name the target instance instead.
  const description = (id: string) =>
    id === 'bot:official:slack'
      ? t('settings.remoteControl.hook.slackDescription')
      : id === 'bot:official:telegram' || id === 'bot:official:x' || id === 'bot:official:feishu'
        ? t(`settings.remoteControl.hook.${id.slice(13)}.description`)
        : props.name;
  return (
    <ImBotSettingsFrame
      context={
        <>
          {/* Re-read on its own (category, window and network changes): no reload here. */}
          <p className="text-13 text-[var(--settings-section-desc)]">
            {t('cloudSettings.authScope', { name: props.name })}
          </p>
          {failure && failure !== 'readFailed' && (
            <p role="alert" className="text-13 text-[var(--text-secondary)]">
              {/* A binding that did not complete, in the reused card's words. */}
              {t(
                failure === 'authNotDone'
                  ? 'settings.remoteControl.hook.binding.state.failed'
                  : `cloudSettings.${failure}`,
              )}
            </p>
          )}
          {(readFailure ?? native.readFailure) && (
            <BlockReadFailure
              title={t('cloudSettings.botsReadFailed')}
              code={(readFailure ?? native.readFailure)!.code}
              disabled={loading || !props.online}
              onReload={(readFailure ?? native.readFailure)!.reload}
            />
          )}
          {/* While reading, nothing: the page's notice says it. */}
        </>
      }
    >
      {(['cindy', 'personal'] as const).map((group) => {
        // The instance's IM channel is not answering: its cards wait for it instead of falling
        // back to the ticket cards.
        if (nativeFailed) return null;
        const entries = items.filter(
          (item) =>
            item.group !== BOT_NOTIFICATION_GROUP &&
            (item.group === 'management.officialBots') === (group === 'cindy'),
        );
        if (group === 'cindy' && nativeIm)
          return (
            <ImBotGroupSection key={group} group={group} idPrefix="cloud-">
              {/* The reused cards show their own binding state: only the sign-in prompt. */}
              {officialOperation && prompt && (
                <div className="flex flex-col gap-2">
                  {prompt &&
                    (prompt.kind === 'device' && prompt.userCode ? (
                      <OAuthDeviceCodeCard
                        deviceCode={{
                          verificationUrl: prompt.url,
                          userCode: prompt.userCode,
                          expiresAt: prompt.expiresAt,
                        }}
                        onOpen={open}
                      />
                    ) : (
                      <OAuthBrowserLink url={prompt.url} onOpen={open} />
                    ))}
                  {prompt && props.trial && (
                    <Button variant="secondary" size="md" onClick={() => void operate('respond')}>
                      {t('cloudSettings.authTrialComplete')}
                    </Button>
                  )}
                </div>
              )}
              <fieldset
                disabled={!props.online || !props.active}
                className="m-0 min-w-0 border-0 p-0"
              >
                <SettingsTargetProvider key={props.deviceId} target={native.target}>
                  <HookConnectionsSection />
                </SettingsTargetProvider>
              </fieldset>
            </ImBotGroupSection>
          );
        if (!entries.length) return null;
        if (group === 'personal') {
          const rank = (id: string) => {
            const index = personalBotChannels.indexOf(
              id.replace(/^bot:/, '') as PersonalBotChannel,
            );
            return index < 0 ? personalBotChannels.length : index;
          };
          entries.sort((left, right) => rank(left.id) - rank(right.id));
        }
        return (
          <ImBotGroupSection key={group} group={group} idPrefix="cloud-">
            {group === 'cindy' && <HookConnectionsDescription />}
            {entries.map((item) => {
              const own = operationItem === item.id;
              const connected = item.status === 'connected';
              const actions = supportedBotActions(item);
              const toggleAction = actions.find(
                (action) => action.intent === (connected ? 'disconnect' : 'authorize'),
              );
              const form = actions.find((action) => action.fields.length > 0);
              const personal = item.group === 'management.personalBots' && item.id !== 'bot:wechat';
              const statusKey =
                item.status === 'connected'
                  ? 'connected'
                  : item.status === 'disconnected'
                    ? 'needsConfig'
                    : item.status;
              const channel = item.id.replace(/^bot:/, '') as PersonalBotChannel;
              if (
                item.group === 'management.personalBots' &&
                personalBotChannels.includes(channel)
              ) {
                return (
                  <CloudPersonalBotSettings
                    key={`${item.id}:${form?.id ?? 'no-form'}:${props.online}:${props.active}`}
                    item={item}
                    channel={channel}
                    deviceId={props.deviceId}
                    targetName={props.name}
                    disabled={
                      disabled ||
                      !props.active ||
                      (busy && !own) ||
                      (own && settling)
                    }
                    pending={own && (busy || checking)}
                    expanded={expanded[group] === item.id}
                    onToggle={() =>
                      setExpanded((old) => ({
                        ...old,
                        [group]: old[group] === item.id ? null : item.id,
                      }))
                    }
                    defaults={props.settings?.(item.id)}
                    summary={props.summary?.(item.id)}
                    telegramSettings={
                      nativeIm ? (
                        <CloudTelegramSettings key={props.deviceId} target={native.target} />
                      ) : (
                        props.settings?.(item.id, 'telegram')
                      )
                    }
                    workingDirectory={
                      nativeIm ? (
                        <CloudWechatWorkingDirectory
                          key={props.deviceId}
                          target={native.target}
                          disabled={disabled || !props.active}
                        />
                      ) : undefined
                    }
                    readStatus={nativeIm ? native.target.call : undefined}
                    notificationSettings={notificationSettings(channel)}
                    run={run}
                    cancel={() => operate('cancel')}
                    supplementary={
                      own ? (
                        <>
                          <CloudAuthProgress
                            text={phaseText}
                            unreadable={progressUnreadable}
                            disabled={disabled}
                          />
                          {busy && channel !== 'wechat' && (
                            <Button
                              variant="secondary"
                              disabled={disabled}
                              onClick={() => void operate('cancel')}
                            >
                              {t('settings.providers.button.cancel')}
                            </Button>
                          )}
                          {prompt &&
                            (prompt.kind === 'device' && prompt.userCode ? (
                              <OAuthDeviceCodeCard
                                deviceCode={{
                                  verificationUrl: prompt.url,
                                  userCode: prompt.userCode,
                                  expiresAt: prompt.expiresAt,
                                }}
                                onOpen={open}
                              />
                            ) : (
                              <OAuthBrowserLink url={prompt.url} onOpen={open} />
                            ))}
                          {prompt && props.trial && (
                            <Button onClick={() => void operate('respond')}>
                              {t('cloudSettings.authTrialComplete')}
                            </Button>
                          )}
                        </>
                      ) : null
                    }
                  />
                );
              }
              return (
                <ImChannelSettingsCard
                  key={item.id}
                  id={`cloud-${item.id}`}
                  title={label(item.id, item.label)}
                  description={description(item.id)}
                  routeSummary={null}
                  status={
                    <ChannelStatusBadge
                      tone={connected ? 'ok' : 'attention'}
                      label={t(
                        personal
                          ? `settings.${item.id.slice(4)}Bot.status.${statusKey}`
                          : connected
                            ? 'cloudSettings.authConnected'
                            : 'cloudSettings.authDisconnected',
                      )}
                    />
                  }
                  expanded={expanded[group] === item.id}
                  onToggle={() =>
                    setExpanded((old) => ({
                      ...old,
                      [group]: old[group] === item.id ? null : item.id,
                    }))
                  }
                  headerAction={
                    personal ? undefined : (
                      <Switch
                        checked={connected}
                        aria-label={label(item.id, item.label)}
                        disabled={
                          disabled ||
                          (busy && !own) ||
                          (own && settling) ||
                          (!toggleAction && !busy)
                        }
                        onCheckedChange={() => {
                          setExpanded((old) => ({ ...old, [group]: item.id }));
                          if (own && busy) void operate('cancel');
                          else if (toggleAction) void run(item, toggleAction);
                        }}
                      />
                    )
                  }
                >
                  {own && (
                    <CloudAuthProgress
                      text={phaseText}
                      unreadable={progressUnreadable}
                      disabled={disabled}
                    />
                  )}
                  {own &&
                    prompt &&
                    (prompt.kind === 'device' && prompt.userCode ? (
                      <OAuthDeviceCodeCard
                        deviceCode={{
                          verificationUrl: prompt.url,
                          userCode: prompt.userCode,
                          expiresAt: prompt.expiresAt,
                        }}
                        onOpen={open}
                      />
                    ) : (
                      <OAuthBrowserLink url={prompt.url} onOpen={open} />
                    ))}
                  {form &&
                    props.online &&
                    props.active &&
                    !(own && (busy || settling)) && (
                      <CloudBotConnectionForm
                        key={`${item.id}:${form.id}`}
                        item={item}
                        action={form}
                        disabled={disabled || busy}
                        submit={(values) => run(item, form, values)}
                      />
                    )}
                  <div className="flex flex-wrap gap-2">
                    {own && settling && !checking ? null : own && busy ? (
                      <Button
                        variant="secondary"
                        size="md"
                        disabled={disabled}
                        onClick={() => void operate('cancel')}
                      >
                        {t('settings.providers.button.cancel')}
                      </Button>
                    ) : (
                      actions
                        .filter((action) => !action.fields.length)
                        .map((action) => (
                          <Button
                            key={action.id}
                            variant="secondary"
                            size="md"
                            // While an unknown result is read back, only the buttons spin.
                            loading={own && checking}
                            disabled={disabled || busy}
                            onClick={() => void run(item, action)}
                          >
                            {t(cloudBotActionLabel(item, action))}
                          </Button>
                        ))
                    )}
                    {own && prompt && props.trial && (
                      <Button variant="secondary" size="md" onClick={() => void operate('respond')}>
                        {t('cloudSettings.authTrialComplete')}
                      </Button>
                    )}
                  </div>
                  {props.settings?.(item.id)}
                </ImChannelSettingsCard>
              );
            })}
          </ImBotGroupSection>
        );
      })}
      {/* No channel offered by this instance (as RemoteBotSettings). */}
      {!loading && !failure && !items.length && !nativeIm && !nativeFailed && (
        <p className="py-3 text-13 text-[var(--text-secondary)]">{t('bots.remoteSettings.unsupported')}</p>
      )}
      {native.directoryPicker}
      {props.trial && (
        <p className="text-12 text-[var(--text-tertiary)]">{t('cloudSettings.authTrial')}</p>
      )}
    </ImBotSettingsFrame>
  );
}
