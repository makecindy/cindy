import { useEffect, useState, type ReactNode, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { WechatBotSectionView } from '@/components/settings/WechatBotSection';
import { WecomBotSectionView } from '@/components/settings/WecomBotSection';
import { FeishuBotSectionView } from '@/components/settings/FeishuBotSection';
import { DingTalkBotSectionView } from '@/components/settings/DingTalkBotSection';
import { DiscordBotSectionView } from '@/components/settings/DiscordBotSection';
import { TelegramBotSectionView } from '@/components/settings/TelegramBotSection';
import type { ImDefaultSettingsSummary } from '@/components/settings/ImDefaultSettingsSection';
import type { ManagementItem } from '../../../shared/settingsManagement';
import type { FeishuBotService } from '@/hooks/useFeishuBot';
import { OWNER_USER_ID_PATTERN as DISCORD_OWNER_USER_ID_PATTERN } from '@/hooks/useDiscordBot';
import {
  OWNER_USER_ID_PATTERN as TELEGRAM_OWNER_USER_ID_PATTERN,
  BOT_TOKEN_PATTERN as TELEGRAM_BOT_TOKEN_PATTERN,
  describeTelegramStatusFailure,
} from '@/hooks/useTelegramBot';
import type { useCloudAuthorization } from './useCloudAuthorization';
import type { CloudImTarget } from './cloudImTarget';
import { CloudDesktopFallback } from './CloudDesktopFallback';

/** The status call each local card reads; replies come with saved credentials removed. */
const statusCalls = {
  telegram: 'telegramBot:get-status',
  discord: 'discordBot:get-status',
  wecom: 'wecomBot:get-status',
  feishu: 'feishuBot:get-state',
  dingtalk: 'dingtalkBot:get-state',
} as const;
type RemoteStatus = {
  status?: unknown;
  ownerUserId?: string | null;
  ownerOpenId?: string | null;
  botUsername?: string | null;
  appId?: string | null;
  appKey?: string | null;
  botId?: string | null;
};
const transportStatus = (value: unknown): DiscordBotTransportStatus | null =>
  value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string'
    ? (value as DiscordBotTransportStatus)
    : null;

export const personalBotChannels = [
  'wechat',
  'wecom',
  'feishu',
  'dingtalk',
  'discord',
  'telegram',
] as const;
export type PersonalBotChannel = (typeof personalBotChannels)[number];

/** Target-only controllers for the SAME native views. Never instantiate a local bot hook.
 * Inputs live for one ticket only (the parent keys this controller by that ticket).
 * Passwords are not prefilled, read back, persisted or sent with a different action.
 */
export function CloudPersonalBotSettings({
  channel,
  deviceId,
  targetName,
  item,
  disabled,
  expanded,
  onToggle,
  defaults,
  summary,
  supplementary,
  telegramSettings,
  notificationSettings,
  pending,
  run,
  cancel,
  workingDirectory,
  readStatus,
}: {
  channel: PersonalBotChannel;
  /** The instance, for settings left to its own page. */
  deviceId: string;
  targetName: string;
  item: ManagementItem;
  disabled: boolean;
  expanded: boolean;
  onToggle(): void;
  defaults: ReactNode;
  summary?: ImDefaultSettingsSummary | null;
  supplementary: ReactNode;
  telegramSettings?: ReactNode;
  /** Target notification controls; `undefined` when the target does not offer them. */
  notificationSettings?: ReactNode;
  pending: boolean;
  run: ReturnType<typeof useCloudAuthorization>['run'];
  cancel(): Promise<void>;
  /** The instance's WeChat working directory row; absent on runtimes without the IM channel. */
  workingDirectory?: ReactNode;
  /** Reads the same connection status as the local card; absent on older runtimes. */
  readStatus?: CloudImTarget['call'];
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [togglingOnline, setTogglingOnline] = useState(false);
  const statusCall = channel === 'wechat' ? null : statusCalls[channel];
  useEffect(() => {
    if (!readStatus || !statusCall || !expanded) return;
    let current = true;
    void readStatus<RemoteStatus>(statusCall)
      .then((next) => current && setRemote(next && typeof next === 'object' ? next : null))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [readStatus, statusCall, expanded, item.status]);
  const validationError = null;
  useEffect(() => {
    // The controller lives above the native accordion, unlike the old form.
    // Clear its draft when the editor closes as well as when the ticket changes.
    if (!expanded) setValues({});
  }, [expanded]);
  const form = item.actions.find((a) => a.intent === 'connect' && a.fields.length > 0);
  const reconnectAction = item.actions.find((a) => a.intent === 'reconnect');
  const disconnectAction = item.actions.find((a) => a.intent === 'disconnect');
  const authorizeAction = item.actions.find((a) => a.intent === 'authorize');
  const value = (key: string) =>
    values[key] ??
    (() => {
      const field = form?.fields.find((f) => f.name === key);
      return field?.kind === 'password' ? '' : (field?.value ?? '');
    })();
  const set = (key: string) => (next: SetStateAction<string>) => {
    setValues((old) => ({
      ...old,
      [key]: typeof next === 'function' ? next(old[key] ?? '') : next,
    }));
  };
  const valid =
    !!form &&
    form.fields.every((field) => {
      const input = value(field.name).trim();
      return (
        (!field.required || !!input) &&
        input.length <= field.maxLength &&
        (field.kind !== 'select' || field.options?.some((option) => option.value === input))
      );
    }) &&
    (channel !== 'discord' || DISCORD_OWNER_USER_ID_PATTERN.test(value('ownerUserId').trim())) &&
    (channel !== 'telegram' ||
      (TELEGRAM_OWNER_USER_ID_PATTERN.test(value('ownerUserId').trim()) &&
        TELEGRAM_BOT_TOKEN_PATTERN.test(value('token').trim())));
  const execute = async (
    action: ManagementItem['actions'][number] | undefined,
    submitted: Record<string, string> = {},
  ) => {
    if (!action || disabled || pending) return false;
    setValues({});
    try {
      await run(item, action, submitted, { confirmed: true });
      return true;
    } finally {
      for (const key of Object.keys(submitted)) delete submitted[key];
    }
  };
  const connect = async () => {
    if (!valid) return false;
    return execute(
      form,
      Object.fromEntries(form!.fields.map((field) => [field.name, value(field.name).trim()])),
    );
  };
  const reconnect = () => execute(reconnectAction);
  const disconnect = async () => {
    await execute(disconnectAction);
  };
  const configured =
    !!disconnectAction || ['connected', 'offline', 'conflict'].includes(item.status);
  const fallback = t('cloudSettings.imConnectionDetailsUnavailable', { name: targetName });
  const details = (
    <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]">{fallback}</p>
  );
  const unsupported = (label: string) => (
    <CloudDesktopFallback deviceId={deviceId} name={targetName} label={t(label)} />
  );
  const notifications = (label: string) =>
    notificationSettings === undefined ? unsupported(label) : notificationSettings;
  const idle = item.status === 'disconnected' || item.status === 'available';
  const remoteTransport = transportStatus(remote?.status);
  const status: DiscordBotTransportStatus =
    pending || item.status === 'connecting'
      ? { kind: 'connecting' }
      : remoteTransport
        ? remoteTransport
        : item.status === 'connected'
        ? { kind: 'connected', appId: '' }
        : item.status === 'conflict' || item.status === 'offline'
          ? { kind: 'conflict', appId: '' }
          : idle
            ? { kind: 'idle' }
            : { kind: 'error', reason: t('settings.discordBot.status.error') };
  const common = {
    expanded,
    onToggle,
    routeSummary: summary ?? null,
    defaultSettings: defaults,
    idPrefix: 'cloud-',
    canDisconnect: !!disconnectAction,
    canReconnect: !!reconnectAction,
    // With the instance's own status the local card shows its own account details.
    connectionDetails: remote ? undefined : details,
  };
  let view: ReactNode;
  switch (channel) {
    case 'wechat':
      view = (
        <WechatBotSectionView
          {...common}
          messageTargetName={targetName}
          authorizationAvailable={!!authorizeAction}
          workingDirectory={workingDirectory ?? unsupported('settings.wechatBot.workingDir.title')}
          controller={{
            state: {
              phase: pending
                ? 'authorizing'
                : item.status === 'connected'
                  ? 'connected'
                  : item.status === 'error'
                    ? 'error'
                    : 'disconnected',
              bound: configured,
              queuedTasks: 0,
            },
            channelSettings: null,
            isAuthorizing: pending,
            isUnbinding: false,
            authorize: () => execute(authorizeAction),
            cancelAuthorization: cancel,
            unbind: () => execute(disconnectAction),
            setCompanion: async () => false,
            isUpdatingCompanion: false,
          }}
        />
      );
      break;
    case 'wecom':
      view = (
        <WecomBotSectionView
          {...common}
          notificationSettings={notifications('settings.notifications.wecomGroupLabel')}
          controller={{
            botId: value('botId'),
            setBotId: set('botId'),
            secret: value('secret'),
            setSecret: set('secret'),
            ownerUserId: remote?.ownerUserId ?? '',
            status,
            validationError,
            isSaving: pending,
            isDisconnecting: false,
            canConnect: valid && !pending,
            canReconnect: !!reconnectAction && !pending,
            connect,
            reconnect,
            disconnect,
          }}
        />
      );
      break;
    case 'feishu':
      view = (
        <FeishuBotSectionView
          {...common}
          notificationSettings={notifications('settings.feishuBot.lifecycleAnnouncement.label')}
          canSubmit={valid}
          services={
            form?.fields
              .find((f) => f.name === 'service')
              ?.options?.map((o) => o.value)
              .filter((s): s is FeishuBotService => s === 'feishu' || s === 'lark') ?? ['feishu']
          }
          controller={{
            service: value('service') === 'lark' ? 'lark' : 'feishu',
            setService: set('service'),
            appId: value('appId'),
            setAppId: set('appId'),
            appSecret: value('appSecret'),
            setAppSecret: set('appSecret'),
            status:
              status.kind === 'connecting'
                ? 'testing'
                : typeof remote?.status === 'string'
                  ? (remote.status as FeishuBotStatus)
                  : status.kind,
            errorMessage: null,
            hasSavedCreds: configured,
            hasLoadedState: true,
            ownerOpenId: remote?.ownerOpenId ?? null,
            validationError,
            isSaving: pending,
            isClearing: false,
            isReconnecting: false,
            save: connect,
            reconnect,
            clear: disconnect,
          }}
        />
      );
      break;
    case 'dingtalk':
      view = (
        <DingTalkBotSectionView
          {...common}
          controller={{
            appKey: value('appKey'),
            setAppKey: set('appKey'),
            appSecret: value('appSecret'),
            setAppSecret: set('appSecret'),
            hasSecret: configured,
            ownerUserId: remote?.ownerUserId ?? '',
            status,
            validationError,
            isSaving: pending,
            isClearing: false,
            canConnect: valid && !pending,
            connect,
            reconnect,
            clear: disconnect,
          }}
        />
      );
      break;
    case 'discord':
      view = (
        <DiscordBotSectionView
          savedConnectionAvailable={!!reconnectAction}
          {...common}
          notificationSettings={notifications('settings.discordBot.lifecycleAnnouncement.label')}
          controller={{
            token: value('token'),
            setToken: set('token'),
            ownerUserId: value('ownerUserId') || (remote?.ownerUserId ?? ''),
            setOwnerUserId: set('ownerUserId'),
            status,
            validationError,
            isSaving: pending,
            isDisconnecting: false,
            canConnect: valid && !pending,
            connect,
            reconnect: async () => {
              await reconnect();
            },
            disconnect,
          }}
        />
      );
      break;
    case 'telegram':
      view = (
        <TelegramBotSectionView
          {...common}
          telegramSettings={telegramSettings}
          canToggleOnline={
            readStatus
              ? (item.status === 'offline' && !!reconnectAction) || item.status === 'connected'
              : item.status === 'offline' && !!reconnectAction
          }
          controller={{
            token: value('token'),
            setToken: set('token'),
            ownerUserId: value('ownerUserId') || (remote?.ownerUserId ?? ''),
            setOwnerUserId: set('ownerUserId'),
            status:
              remoteTransport && !pending
                ? (remoteTransport as TelegramBotTransportStatus)
                : item.status === 'offline' && !pending
                  ? { kind: 'offline', appId: '' }
                  : status,
            botUsername: remote?.botUsername ?? null,
            validationError,
            isSaving: pending,
            isDisconnecting: false,
            isTogglingOnline: togglingOnline,
            canConnect: valid && !pending,
            connect,
            disconnect,
            setOnline: async (online) => {
              if (online) {
                await reconnect();
                return;
              }
              // Going offline keeps the token, like the local switch; it opens no page.
              if (!readStatus || disabled || togglingOnline) return;
              setTogglingOnline(true);
              try {
                const result = await readStatus<{ status?: TelegramBotTransportStatus }>(
                  'telegramBot:set-online',
                  { online: false },
                );
                setRemote(await readStatus<RemoteStatus>('telegramBot:get-status'));
                // Like the local switch, only reaching offline counts as success.
                if (result?.status?.kind === 'offline')
                  toast.success(t('logic.toasts.telegramBotWentOffline'));
                else
                  toast.error(
                    t('logic.toasts.telegramBotToggleOnlineFailed', {
                      message: result?.status ? describeTelegramStatusFailure(result.status, t) : '',
                    }),
                  );
              } catch (error) {
                toast.error(
                  t('logic.toasts.telegramBotToggleOnlineFailed', {
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
              } finally {
                setTogglingOnline(false);
              }
            },
          }}
        />
      );
      break;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
        {view}
      </fieldset>
      {expanded && supplementary}
    </div>
  );
}
