import { Button } from '@/components/ui/button';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Eye, EyeOff, Send, Trash2 } from 'lucide-react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Switch } from '@/components/ui/switch';
import { useWecomBot } from '@/hooks/useWecomBot';
import { useWecomGroupNotificationSettings } from '@/hooks/useWecomGroupNotificationSettings';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
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
  const wecomGroup = useWecomGroupNotificationSettings();
  const [webhookUrl, setWebhookUrl] = useState('');

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
          <Button
            variant="secondary"
            size="lg"
            loading={isDisconnecting}
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={isDisconnecting}
          >
            <Trash2 size={13} />
            {t('settings.wecomBot.disconnect')}
          </Button>
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
              <Button
                variant="cta"
                size="lg"
                loading={isSaving || status.kind === 'connecting'}
                type="button"
                onClick={() => void reconnect()}
                disabled={!canReconnect}
                className="flex-1"
              >
                {t('settings.wecomBot.reconnect')}
              </Button>
            ) : (
              <Button
                variant="cta"
                size="lg"
                loading={isSaving || status.kind === 'connecting'}
                type="button"
                onClick={() => void connect()}
                disabled={!canConnect}
                className="flex-1"
              >
                {t('settings.wecomBot.connect')}
              </Button>
            )}
            {botId.trim() ? (
              <Button
                variant="secondary"
                size="lg"
                loading={isDisconnecting}
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={isDisconnecting}
                className="flex-1"
              >
                <Trash2 size={13} />
                {t('settings.wecomBot.disconnect')}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <div className="h-px w-full bg-[var(--border-default)]" />
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p
              className="text-13 font-medium text-[var(--settings-section-sublabel)]"
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.notifications.wecomGroupLabel')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {wecomGroup.configured
                ? t('settings.notifications.wecomGroupConfiguredHint', {
                    maskedKey: wecomGroup.maskedKey,
                  })
                : t('settings.notifications.wecomGroupHint')}
            </p>
          </div>
          <Switch
            checked={wecomGroup.enabled && wecomGroup.configured}
            onCheckedChange={(next) => {
              void wecomGroup
                .setEnabled(next)
                .catch(() => toast.error(t('settings.notifications.wecomGroupToggleFailed')));
            }}
            disabled={!wecomGroup.configured || wecomGroup.busy}
            aria-label={t('settings.notifications.wecomGroupAria')}
          />
        </div>

        {wecomGroup.configured ? (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              loading={wecomGroup.busy}
              type="button"
              disabled={wecomGroup.busy}
              onClick={() => {
                void wecomGroup
                  .test(t('settings.notifications.wecomGroupTestMessage'))
                  .then(() => toast.success(t('settings.notifications.wecomGroupTestSuccess')))
                  .catch(() => toast.error(t('settings.notifications.wecomGroupTestFailed')));
              }}
              className="flex-1"
            >
              <Send size={13} />
              {t('settings.notifications.wecomGroupTest')}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              type="button"
              disabled={wecomGroup.busy}
              onClick={() => {
                void wecomGroup
                  .clear()
                  .then(() => toast.success(t('settings.notifications.wecomGroupCleared')))
                  .catch(() => toast.error(t('settings.notifications.wecomGroupClearFailed')));
              }}
              className="flex-1"
            >
              <Trash2 size={13} />
              {t('settings.notifications.wecomGroupClear')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              type="password"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder={t('settings.notifications.wecomGroupPlaceholder')}
              autoComplete="new-password"
              spellCheck={false}
              aria-label={t('settings.notifications.wecomGroupLabel')}
              className={cn(
                'h-[42px] w-full rounded-full px-[14px]',
                'border border-[var(--settings-input-border)]',
                'bg-[var(--settings-input-bg)] text-13 text-[var(--settings-input-text)]',
                'placeholder:text-[var(--settings-input-placeholder)] outline-none',
                'focus:border-[var(--settings-input-border-focus)]',
              )}
            />
            <Button
              variant="cta"
              size="lg"
              loading={wecomGroup.busy}
              type="button"
              disabled={wecomGroup.busy || !webhookUrl.trim()}
              onClick={() => {
                void wecomGroup
                  .saveAndTest(
                    webhookUrl.trim(),
                    t('settings.notifications.wecomGroupTestMessage'),
                  )
                  .then(() => {
                    setWebhookUrl('');
                    toast.success(t('settings.notifications.wecomGroupSaveSuccess'));
                  })
                  .catch(() => toast.error(t('settings.notifications.wecomGroupSaveFailed')));
              }}
            >
              <Send size={14} />
              {t('settings.notifications.wecomGroupSaveAndTest')}
            </Button>
          </div>
        )}
      </div>
    </ImChannelSettingsCard>
  );
}
