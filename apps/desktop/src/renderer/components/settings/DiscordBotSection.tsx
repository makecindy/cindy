import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useDiscordBot } from '@/hooks/useDiscordBot';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';

const DISCORD_DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';

const statusKey: Record<DiscordBotTransportStatus['kind'], string> = {
  idle: 'settings.discordBot.status.needsConfig',
  connecting: 'settings.discordBot.status.connecting',
  connected: 'settings.discordBot.status.connected',
  conflict: 'settings.discordBot.status.conflict',
  error: 'settings.discordBot.status.error',
};

function statusColor(s: DiscordBotTransportStatus): string {
  switch (s.kind) {
    case 'idle':
      return 'var(--settings-badge-needs-config)';
    case 'connecting':
    case 'conflict':
      return 'var(--settings-badge-saved)';
    case 'connected':
      return 'var(--settings-badge-connected)';
    case 'error':
      return 'var(--settings-badge-error)';
  }
}

function statusTextColor(s: DiscordBotTransportStatus): string {
  return s.kind === 'connected' ? 'var(--settings-badge-connected-text)' : statusColor(s);
}

export function DiscordBotSection({
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
    validationError,
    isSaving,
    isDisconnecting,
    canConnect,
    connect,
    disconnect,
  } = useDiscordBot();

  const [showToken, setShowToken] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('discord');
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const guideSteps = useMemo(
    () => [
      {
        title: t('settings.discordBot.guide.step1.title'),
        body: t('settings.discordBot.guide.step1.body'),
      },
      {
        title: t('settings.discordBot.guide.step2.title'),
        body: t('settings.discordBot.guide.step2.body'),
      },
      {
        title: t('settings.discordBot.guide.step3.title'),
        body: t('settings.discordBot.guide.step3.body'),
      },
      {
        title: t('settings.discordBot.guide.step4.title'),
        body: t('settings.discordBot.guide.step4.body'),
      },
    ],
    [t],
  );

  const handleDisconnectClick = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.discordBot.disconnectConfirm.title'),
      description: t('settings.discordBot.disconnectConfirm.description'),
      confirmText: t('settings.discordBot.disconnectConfirm.confirm'),
      cancelText: t('settings.discordBot.disconnectConfirm.cancel'),
    });
    if (!confirmed) return;
    await disconnect();
  }, [confirm, disconnect, t]);

  const openDeveloperPortal = useCallback(() => {
    window.electronAPI.openExternal?.(DISCORD_DEVELOPER_PORTAL_URL);
  }, []);

  // 非 idle = 主进程已有保存的凭证(连接中/冲突/失败也算),表单区给小垃圾桶解绑入口。
  const hasSavedCreds = status.kind !== 'idle';

  return (
    <ImChannelSettingsCard
      id="personal-im-discord"
      title={t('settings.discordBot.title')}
      description={t('settings.discordBot.description')}
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
          aria-label={t('settings.discordBot.statusAria', { status: t(statusKey[status.kind]) })}
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
      <ImDefaultSettingsSection channel="discord" embedded onSummaryChange={setRouteSummary} />
      <div className="h-px w-full bg-[var(--border-default)]" />
      {/* 与 FeishuBotSection 同构:已连接 → 状态卡(单个解绑);否则表单(单个连接)。 */}
      {status.kind === 'connected' ? (
        <ConnectedCard
          botTag={status.appId}
          ownerUserId={ownerUserId}
          isDisconnecting={isDisconnecting}
          onDisconnect={() => void handleDisconnectClick()}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <label
            className="text-12 font-medium text-[var(--settings-section-desc)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.discordBot.tokenLabel')}
          </label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('settings.discordBot.tokenPlaceholder')}
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
                showToken ? t('settings.discordBot.hideToken') : t('settings.discordBot.showToken')
              }
            >
              {showToken ? <Eye size={18} /> : <EyeOff size={18} />}
            </button>
          </div>

          <label
            className="text-12 font-medium text-[var(--settings-section-desc)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.discordBot.ownerUserIdLabel')}
          </label>
          <input
            type="text"
            value={ownerUserId}
            onChange={(e) => setOwnerUserId(e.target.value)}
            placeholder={t('settings.discordBot.ownerUserIdPlaceholder')}
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

          {/* 提示/错误行:右侧小垃圾桶仅在已有保存凭证时出现(对齐 FeishuBotSection) */}
          <div className="flex min-h-[18px] items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              {validationError ? (
                <p className="text-12 text-[var(--settings-error-text)]" role="alert">
                  {validationError}
                </p>
              ) : status.kind === 'error' ? (
                <p className="text-12 text-[var(--settings-error-text)]" role="alert">
                  {status.reason}
                </p>
              ) : (
                <p className="text-12 text-[var(--settings-source-meta)]">
                  {t('settings.discordBot.formHint')}
                </p>
              )}
            </div>
            {hasSavedCreds && (
              <button
                type="button"
                onClick={() => void handleDisconnectClick()}
                disabled={isDisconnecting}
                aria-label={t('settings.discordBot.disconnectAria')}
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
              ? t('settings.discordBot.connectingAction')
              : t('settings.discordBot.connect')}
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
            {t('settings.discordBot.guide.title')}
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
              onClick={openDeveloperPortal}
              className="w-fit cursor-pointer bg-transparent p-0 text-12 font-medium text-[var(--settings-source-link)] underline decoration-[var(--settings-source-link)] decoration-1 underline-offset-2"
            >
              {t('settings.discordBot.guide.openPortal')}
            </button>
          </div>
        )}
      </div>
    </ImChannelSettingsCard>
  );
}

/** 已连接状态卡 —— 结构对齐 FeishuBotSection 的 ConnectedCard(单个解绑按钮)。 */
function ConnectedCard(props: {
  botTag: string;
  ownerUserId: string;
  isDisconnecting: boolean;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'mt-1 flex flex-col gap-3 rounded-xl p-5',
        'border border-[var(--settings-theme-card-border)]',
        'bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] text-[var(--settings-badge-connected)]">
          <Check size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('settings.discordBot.connected.heading')}
          </div>
          <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
            {t('settings.discordBot.connected.note')}
          </div>
        </div>
      </div>
      <div className="grid gap-2 text-12 text-[var(--settings-section-desc)]">
        <div className="flex justify-between gap-4">
          <span>{t('settings.discordBot.connected.botLabel')}</span>
          <span className="font-medium text-[var(--settings-section-title)]">{props.botTag}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>{t('settings.discordBot.connected.ownerLabel')}</span>
          <span className="font-medium text-[var(--settings-section-title)]">
            {props.ownerUserId || '—'}
          </span>
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={props.onDisconnect}
          disabled={props.isDisconnecting}
          className={cn(
            'flex h-[36px] flex-1 items-center justify-center gap-1.5 rounded-full',
            'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
            'text-12 font-medium text-[var(--settings-btn-secondary-text)]',
            props.isDisconnecting && 'cursor-not-allowed opacity-40',
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
            ? t('settings.discordBot.disconnectingAction')
            : t('settings.discordBot.disconnect')}
        </button>
      </div>
    </div>
  );
}
