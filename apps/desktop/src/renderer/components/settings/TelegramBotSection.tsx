import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { describeTelegramStatusFailure, useTelegramBot } from '@/hooks/useTelegramBot';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';
import { TelegramRemoteDevices } from './TelegramRemoteDevices';
import {
  TelegramBehaviorSettings,
  TelegramGroupActivationSettings,
  TelegramPersonaSettings,
} from './TelegramBehaviorSettings';

const TELEGRAM_BOTFATHER_URL = 'https://t.me/BotFather';

const statusKey: Record<TelegramBotTransportStatus['kind'], string> = {
  idle: 'settings.telegramBot.status.needsConfig',
  connecting: 'settings.telegramBot.status.connecting',
  connected: 'settings.telegramBot.status.connected',
  conflict: 'settings.telegramBot.status.conflict',
  offline: 'settings.telegramBot.status.offline',
  error: 'settings.telegramBot.status.error',
};

/** 已有绑定的三档 —— 都带 appId(bot 数字 id), 卡片可直接展示。 */
type TelegramBoundStatus = Extract<TelegramBotTransportStatus, { appId: string }>;

/**
 * 有凭证的三档(已连接 / 被另一台占用 / 主动下线)都走已连接卡: 它们都不该
 * 显示 token 表单 —— 尤其 conflict, 落表单会让"被另一台设备占用"看起来像
 * "还没配置"。error(token 无效)与 connecting 仍走表单。
 */
function hasBinding(s: TelegramBotTransportStatus): s is TelegramBoundStatus {
  return s.kind === 'connected' || s.kind === 'offline' || s.kind === 'conflict';
}

function statusColor(s: TelegramBotTransportStatus): string {
  switch (s.kind) {
    case 'idle':
      return 'var(--settings-badge-needs-config)';
    case 'connecting':
    case 'conflict':
      return 'var(--settings-badge-saved)';
    // 主动下线是用户自己选的正常状态, 不是故障 —— 中性灰, 不用告警色。
    case 'offline':
      return 'var(--settings-badge-needs-config)';
    case 'connected':
      return 'var(--settings-badge-connected)';
    case 'error':
      return 'var(--settings-badge-error)';
  }
}

function statusTextColor(s: TelegramBotTransportStatus): string {
  return s.kind === 'connected' ? 'var(--settings-badge-connected-text)' : statusColor(s);
}

/** 个人 Telegram bot 设置卡 — 结构对齐 DiscordBotSection(token 手填模式)。 */
export function TelegramBotSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const {
    token,
    setToken,
    ownerUserId,
    setOwnerUserId,
    status,
    botUsername,
    validationError,
    isSaving,
    isDisconnecting,
    isTogglingOnline,
    canConnect,
    connect,
    disconnect,
    setOnline,
  } = useTelegramBot();

  const [showToken, setShowToken] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('telegram');
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const guideSteps = useMemo(
    () => [
      {
        title: t('settings.telegramBot.guide.step1.title'),
        body: t('settings.telegramBot.guide.step1.body'),
      },
      {
        title: t('settings.telegramBot.guide.step2.title'),
        body: t('settings.telegramBot.guide.step2.body'),
      },
      {
        title: t('settings.telegramBot.guide.step3.title'),
        body: t('settings.telegramBot.guide.step3.body'),
      },
      {
        title: t('settings.telegramBot.guide.step4.title'),
        body: t('settings.telegramBot.guide.step4.body'),
      },
    ],
    [t],
  );

  const handleDisconnectClick = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.telegramBot.disconnectConfirm.title'),
      description: t('settings.telegramBot.disconnectConfirm.description'),
      confirmText: t('settings.telegramBot.disconnectConfirm.confirm'),
      cancelText: t('settings.telegramBot.disconnectConfirm.cancel'),
    });
    if (!confirmed) return;
    await disconnect();
  }, [confirm, disconnect, t]);

  const openBotFather = useCallback(() => {
    window.electronAPI.openExternal?.(TELEGRAM_BOTFATHER_URL);
  }, []);

  // 非 idle = 主进程已有保存的凭证(连接中/冲突/失败也算),表单区给小垃圾桶解绑入口。
  const hasSavedCreds = status.kind !== 'idle';

  return (
    <ImChannelSettingsCard
      id="personal-im-telegram"
      title={t('settings.telegramBot.title')}
      description={t('settings.telegramBot.description')}
      routeSummary={
        routeSummary
          ? `${t(`settings.imBot.defaults.agents.${routeSummary.agentKind}`)} · ${routeSummary.model}`
          : null
      }
      expanded={expanded}
      onToggle={onToggle}
      status={
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full',
            'px-2.5 py-1',
            'bg-[var(--settings-badge-bg)]',
            'border border-[var(--settings-badge-border)]',
            'text-11 font-medium tracking-[0.12px]',
          )}
          style={{ letterSpacing: '0.12px', color: statusTextColor(status) }}
          role="status"
          aria-live="polite"
          aria-label={t('settings.telegramBot.statusAria', { status: t(statusKey[status.kind]) })}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor(status) }}
            aria-hidden
          />
          {t(statusKey[status.kind])}
        </span>
      }
    >
      <ImDefaultSettingsSection channel="telegram" embedded onSummaryChange={setRouteSummary} />
      <div className="h-px w-full bg-[var(--border-default)]" />
      <TelegramPersonaSettings />
      <div className="h-px w-full bg-[var(--border-default)]" />
      <TelegramBehaviorSettings />
      <div className="h-px w-full bg-[var(--border-default)]" />
      <TelegramGroupActivationSettings />
      <div className="h-px w-full bg-[var(--border-default)]" />
      {hasBinding(status) ? (
        <ConnectedCard
          status={status}
          botLabel={botUsername ? `@${botUsername}` : status.appId}
          ownerUserId={ownerUserId}
          isDisconnecting={isDisconnecting}
          isTogglingOnline={isTogglingOnline}
          onDisconnect={() => void handleDisconnectClick()}
          onToggleOnline={() => void setOnline(status.kind === 'offline')}
          remoteDevices={<TelegramRemoteDevices selfAppId={status.appId} />}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <label
            className="text-12 font-medium text-[var(--settings-section-desc)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.telegramBot.tokenLabel')}
          </label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('settings.telegramBot.tokenPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className={cn(
                'h-[42px] w-full rounded-full pl-[14px] pr-10',
                'bg-[var(--settings-input-bg)] border border-[var(--settings-input-border)]',
                'text-13 text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
                'outline-none transition-colors focus:border-[var(--settings-input-border-focus)]',
              )}
              style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-[14px] top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] transition-colors hover:text-[var(--settings-eye-icon-hover)]"
              aria-label={
                showToken
                  ? t('settings.telegramBot.hideToken')
                  : t('settings.telegramBot.showToken')
              }
            >
              {showToken ? <Eye size={18} /> : <EyeOff size={18} />}
            </button>
          </div>

          <label
            className="text-12 font-medium text-[var(--settings-section-desc)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.telegramBot.ownerUserIdLabel')}
          </label>
          <input
            type="text"
            value={ownerUserId}
            onChange={(e) => setOwnerUserId(e.target.value)}
            placeholder={t('settings.telegramBot.ownerUserIdPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            inputMode="numeric"
            className={cn(
              'h-[42px] w-full rounded-full pl-[14px] pr-[14px]',
              'bg-[var(--settings-input-bg)] border border-[var(--settings-input-border)]',
              'text-13 text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
              'outline-none transition-colors focus:border-[var(--settings-input-border-focus)]',
            )}
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
          />

          <div className="flex min-h-[18px] items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              {validationError ? (
                <p className="text-12 text-[var(--settings-error-text)]" role="alert">
                  {validationError}
                </p>
              ) : status.kind === 'error' ? (
                <p className="text-12 text-[var(--settings-error-text)]" role="alert">
                  {describeTelegramStatusFailure(status, t)}
                </p>
              ) : (
                <p className="text-12 text-[var(--settings-source-meta)]">
                  {t('settings.telegramBot.formHint')}
                </p>
              )}
            </div>
            {hasSavedCreds && (
              <button
                type="button"
                onClick={() => void handleDisconnectClick()}
                disabled={isDisconnecting}
                aria-label={t('settings.telegramBot.disconnectAria')}
                className={cn(
                  'mr-[4px] flex shrink-0 items-center justify-center bg-transparent p-0',
                  'text-[var(--settings-trash-icon)] transition-colors hover:text-[var(--settings-trash-icon-hover)]',
                  isDisconnecting && 'cursor-not-allowed opacity-40',
                )}
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => void connect()}
            disabled={!canConnect}
            className={cn(
              'flex h-[42px] w-full items-center justify-center gap-1.5 rounded-full',
              'bg-[var(--settings-btn-primary-bg)] border border-[var(--settings-btn-primary-border)]',
              'text-13 font-medium text-[var(--settings-btn-primary-text)]',
              'transition-colors hover:bg-[var(--settings-btn-primary-hover-bg)]',
              !canConnect && 'cursor-not-allowed opacity-40',
            )}
          >
            {isSaving ? (
              <span className="inline-flex animate-spin motion-reduce:animate-none" aria-hidden>
                <Loader2 size={14} />
              </span>
            ) : null}
            {isSaving
              ? t('settings.telegramBot.connectingAction')
              : t('settings.telegramBot.connect')}
          </button>
        </div>
      )}

      <div className="border-t border-[var(--settings-theme-card-border)] pt-3">
        <button
          type="button"
          onClick={() => setGuideOpen(!guideOpen)}
          className="flex w-full items-center justify-between gap-3 bg-transparent p-0 text-left"
          aria-expanded={guideOpen}
        >
          <span className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('settings.telegramBot.guide.title')}
          </span>
          <span className="text-[var(--settings-section-desc)]">
            {guideOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>

        {guideOpen && (
          <div className="mt-3 flex flex-col gap-3">
            {guideSteps.map((step, index) => (
              <div key={step.title} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] text-11 font-medium text-[var(--settings-section-title)]">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-12 font-medium text-[var(--settings-section-title)]">
                    {step.title}
                  </div>
                  <div className="mt-0.5 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
                    {step.body}
                  </div>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={openBotFather}
              className="w-fit cursor-pointer bg-transparent p-0 text-12 font-medium text-[var(--settings-source-link)] underline decoration-[var(--settings-source-link)] decoration-1 underline-offset-2"
            >
              {t('settings.telegramBot.guide.openBotFather')}
            </button>
          </div>
        )}
      </div>
    </ImChannelSettingsCard>
  );
}

/** 已绑定状态卡(已连接 / 已下线 / 被占用三档共用) —— 结构对齐 DiscordBotSection。 */
function ConnectedCard(props: {
  status: TelegramBoundStatus;
  botLabel: string;
  ownerUserId: string;
  isDisconnecting: boolean;
  isTogglingOnline: boolean;
  onDisconnect: () => void;
  onToggleOnline: () => void;
  /** 「我的其他设备」区块;无其他设备时组件自身渲染 null。 */
  remoteDevices: React.ReactNode;
}) {
  const { t } = useTranslation();
  const kind = props.status.kind;
  const isOffline = kind === 'offline';
  const busy = props.isDisconnecting || props.isTogglingOnline;
  const headingKey =
    kind === 'offline'
      ? 'settings.telegramBot.connected.headingOffline'
      : kind === 'conflict'
        ? 'settings.telegramBot.connected.headingConflict'
        : 'settings.telegramBot.connected.heading';
  const noteKey =
    kind === 'offline'
      ? 'settings.telegramBot.connected.noteOffline'
      : kind === 'conflict'
        ? 'settings.telegramBot.connected.noteConflict'
        : 'settings.telegramBot.connected.note';
  return (
    <div
      className={cn(
        'mt-1 flex flex-col gap-3 rounded-xl p-5',
        'border border-[var(--settings-theme-card-border)]',
        'bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            'border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)]',
          )}
          style={{ color: statusColor(props.status) }}
        >
          {kind === 'offline' ? (
            <PowerOff size={16} />
          ) : kind === 'conflict' ? (
            <AlertTriangle size={16} />
          ) : (
            <Check size={16} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-13 font-medium text-[var(--settings-section-title)]">
            {t(headingKey)}
          </div>
          <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
            {t(noteKey)}
          </div>
        </div>
      </div>
      <div className="grid gap-2 text-12 text-[var(--settings-section-desc)]">
        <div className="flex justify-between gap-4">
          <span>{t('settings.telegramBot.connected.botLabel')}</span>
          <span className="font-medium text-[var(--settings-section-title)]">
            {props.botLabel}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span>{t('settings.telegramBot.connected.ownerLabel')}</span>
          <span className="font-medium text-[var(--settings-section-title)]">
            {props.ownerUserId || '—'}
          </span>
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        {/* 下线/上线: 可逆且零数据损失, 不加二次确认(解绑才需要确认)。 */}
        <button
          type="button"
          onClick={props.onToggleOnline}
          disabled={busy}
          className={cn(
            'flex h-[36px] flex-1 items-center justify-center gap-1.5 rounded-full',
            'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
            'text-12 font-medium text-[var(--settings-btn-secondary-text)]',
            busy && 'cursor-not-allowed opacity-40',
          )}
        >
          {props.isTogglingOnline ? (
            <span className="inline-flex animate-spin motion-reduce:animate-none" aria-hidden>
              <Loader2 size={13} />
            </span>
          ) : isOffline ? (
            <Power size={13} />
          ) : (
            <PowerOff size={13} />
          )}
          {props.isTogglingOnline
            ? t(
                isOffline
                  ? 'settings.telegramBot.goingOnlineAction'
                  : 'settings.telegramBot.goingOfflineAction',
              )
            : t(isOffline ? 'settings.telegramBot.goOnline' : 'settings.telegramBot.goOffline')}
        </button>
        <button
          type="button"
          onClick={props.onDisconnect}
          disabled={busy}
          className={cn(
            'flex h-[36px] flex-1 items-center justify-center gap-1.5 rounded-full',
            'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
            'text-12 font-medium text-[var(--settings-btn-secondary-text)]',
            busy && 'cursor-not-allowed opacity-40',
          )}
        >
          {props.isDisconnecting ? (
            <span className="inline-flex animate-spin motion-reduce:animate-none" aria-hidden>
              <Loader2 size={13} />
            </span>
          ) : (
            <Trash2 size={13} />
          )}
          {props.isDisconnecting
            ? t('settings.telegramBot.disconnectingAction')
            : t('settings.telegramBot.disconnect')}
        </button>
      </div>
      {props.remoteDevices}
    </div>
  );
}
