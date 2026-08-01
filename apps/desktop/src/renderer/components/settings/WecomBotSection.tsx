import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useWecomBot } from '@/hooks/useWecomBot';
import { cn } from '@/lib/utils';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';

const STATUS_KEY: Record<WecomBotTransportStatus['kind'], string> = {
  idle: 'settings.wecomBot.status.needsConfig',
  connecting: 'settings.wecomBot.status.connecting',
  connected: 'settings.wecomBot.status.connected',
  conflict: 'settings.wecomBot.status.conflict',
  error: 'settings.wecomBot.status.error',
};

function statusColor(status: WecomBotTransportStatus): string {
  switch (status.kind) {
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

const fieldClassName = cn(
  'h-[42px] w-full rounded-full px-[14px]',
  'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
  'text-13 text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
  'outline-none transition-colors focus:border-[var(--settings-input-border-focus)]',
);

export function WecomBotSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const {
    botId,
    setBotId,
    secret,
    setSecret,
    ownerUserId,
    status,
    validationError,
    isSaving,
    isDisconnecting,
    canConnect,
    canReconnect,
    connect,
    reconnect,
    disconnect,
  } = useWecomBot();
  const [showSecret, setShowSecret] = useState(false);
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('wecom');
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const handleDisconnect = useCallback(async () => {
    const approved = await confirm({
      title: t('settings.wecomBot.disconnectConfirm.title'),
      description: t('settings.wecomBot.disconnectConfirm.description'),
      confirmText: t('settings.wecomBot.disconnectConfirm.confirm'),
      cancelText: t('settings.wecomBot.disconnectConfirm.cancel'),
    });
    if (approved) await disconnect();
  }, [confirm, disconnect, t]);

  return (
    <ImChannelSettingsCard
      id="personal-im-wecom"
      title={t('settings.wecomBot.title')}
      description={t('settings.wecomBot.description')}
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
            'border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)]',
            'px-2.5 py-1 text-11 font-medium',
          )}
          style={{
            color:
              status.kind === 'connected'
                ? 'var(--settings-badge-connected-text)'
                : statusColor(status),
          }}
          role="status"
          aria-live="polite"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor(status) }}
            aria-hidden
          />
          {t(STATUS_KEY[status.kind])}
        </span>
      }
    >
      <ImDefaultSettingsSection channel="wecom" embedded onSummaryChange={setRouteSummary} />
      <div className="h-px w-full bg-[var(--border-default)]" />

      {status.kind === 'connected' ? (
        <div
          className={cn(
            'flex flex-col gap-3 rounded-xl p-5',
            'border border-[var(--settings-theme-card-border)]',
            'bg-[var(--settings-theme-card-bg)]',
          )}
        >
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] text-[var(--settings-badge-connected)]">
              <Check size={16} />
            </span>
            <div>
              <div className="text-13 font-medium text-[var(--settings-section-title)]">
                {t('settings.wecomBot.connected.heading')}
              </div>
              <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
                {ownerUserId
                  ? t('settings.wecomBot.connected.ownerBound', { ownerUserId })
                  : t('settings.wecomBot.connected.awaitingOwner')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={isDisconnecting}
            className={cn(
              'flex h-[36px] items-center justify-center gap-1.5 rounded-full',
              'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
              'text-12 font-medium text-[var(--settings-btn-secondary-text)]',
              isDisconnecting && 'cursor-not-allowed opacity-40',
            )}
          >
            {isDisconnecting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
            {t('settings.wecomBot.disconnect')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]">
            {t('settings.wecomBot.setupHint')}
          </p>
          <label className="text-12 font-medium text-[var(--settings-section-desc)]">
            {t('settings.wecomBot.botIdLabel')}
          </label>
          <input
            type="text"
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            placeholder={t('settings.wecomBot.botIdPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            className={fieldClassName}
          />
          <label className="text-12 font-medium text-[var(--settings-section-desc)]">
            {t('settings.wecomBot.secretLabel')}
          </label>
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={t('settings.wecomBot.secretPlaceholder')}
              spellCheck={false}
              autoComplete="new-password"
              className={cn(fieldClassName, 'pr-10')}
            />
            <button
              type="button"
              onClick={() => setShowSecret((shown) => !shown)}
              className="absolute right-[14px] top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] hover:text-[var(--settings-eye-icon-hover)]"
              aria-label={
                showSecret ? t('settings.wecomBot.hideSecret') : t('settings.wecomBot.showSecret')
              }
            >
              {showSecret ? <Eye size={18} /> : <EyeOff size={18} />}
            </button>
          </div>
          {validationError || status.kind === 'error' ? (
            <p className="text-12 text-[var(--settings-error-text)]" role="alert">
              {validationError ?? (status.kind === 'error' ? status.reason : '')}
            </p>
          ) : (
            <p className="text-12 text-[var(--settings-source-meta)]">
              {t('settings.wecomBot.ownerHint')}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {botId.trim() && !secret.trim() ? (
              <button
                type="button"
                onClick={() => void reconnect()}
                disabled={!canReconnect}
                className={cn(
                  'flex h-[42px] flex-1 items-center justify-center gap-1.5 rounded-full',
                  'border border-[var(--settings-btn-primary-border)] bg-[var(--settings-btn-primary-bg)]',
                  'text-13 font-medium text-[var(--settings-btn-primary-text)]',
                  'hover:bg-[var(--settings-btn-primary-hover-bg)]',
                  !canReconnect && 'cursor-not-allowed opacity-40',
                )}
              >
                {isSaving || status.kind === 'connecting' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : null}
                {isSaving || status.kind === 'connecting'
                  ? t('settings.wecomBot.connectingAction')
                  : t('settings.wecomBot.reconnect')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void connect()}
                disabled={!canConnect}
                className={cn(
                  'flex h-[42px] flex-1 items-center justify-center gap-1.5 rounded-full',
                  'border border-[var(--settings-btn-primary-border)] bg-[var(--settings-btn-primary-bg)]',
                  'text-13 font-medium text-[var(--settings-btn-primary-text)]',
                  'hover:bg-[var(--settings-btn-primary-hover-bg)]',
                  !canConnect && 'cursor-not-allowed opacity-40',
                )}
              >
                {isSaving || status.kind === 'connecting' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : null}
                {isSaving || status.kind === 'connecting'
                  ? t('settings.wecomBot.connectingAction')
                  : t('settings.wecomBot.connect')}
              </button>
            )}
            {botId.trim() ? (
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={isDisconnecting}
                className={cn(
                  'flex h-[42px] flex-1 items-center justify-center gap-1.5 rounded-full',
                  'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
                  'text-13 font-medium text-[var(--settings-btn-secondary-text)]',
                  isDisconnecting && 'cursor-not-allowed opacity-40',
                )}
              >
                {isDisconnecting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                {t('settings.wecomBot.disconnect')}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </ImChannelSettingsCard>
  );
}
