import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useDingTalkBot } from '@/hooks/useDingTalkBot';
import { cn } from '@/lib/utils';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';

const DEVELOPER_PORTAL_URL = 'https://open-dev.dingtalk.com/';

const statusKey: Record<DingTalkBotTransportStatus['kind'], string> = {
  idle: 'settings.dingtalkBot.status.needsConfig',
  connecting: 'settings.dingtalkBot.status.connecting',
  connected: 'settings.dingtalkBot.status.connected',
  conflict: 'settings.dingtalkBot.status.connecting',
  error: 'settings.dingtalkBot.status.error',
};

function statusColor(status: DingTalkBotTransportStatus): string {
  if (status.kind === 'connected') return 'var(--settings-badge-connected)';
  if (status.kind === 'error') return 'var(--settings-badge-error)';
  if (status.kind === 'idle') return 'var(--settings-badge-needs-config)';
  return 'var(--settings-badge-saved)';
}

export function DingTalkBotSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const bot = useDingTalkBot();
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();
  const [showSecret, setShowSecret] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('dingtalk');

  const guideSteps = useMemo(
    () => [1, 2, 3, 4].map((step) => t(`settings.dingtalkBot.guide.step${step}`)),
    [t],
  );

  const clear = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.dingtalkBot.disconnectConfirm.title'),
      description: t('settings.dingtalkBot.disconnectConfirm.description'),
      confirmText: t('settings.dingtalkBot.disconnectConfirm.confirm'),
      cancelText: t('settings.dingtalkBot.disconnectConfirm.cancel'),
    });
    if (confirmed) await bot.clear();
  }, [bot, confirm, t]);

  const connected = bot.status.kind === 'connected';

  return (
    <ImChannelSettingsCard
      id="personal-im-dingtalk"
      title={t('settings.dingtalkBot.title')}
      description={t('settings.dingtalkBot.description')}
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
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
            'border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)]',
            'text-11 font-medium tracking-[0.12px]',
          )}
          style={{ color: statusColor(bot.status) }}
          role="status"
          aria-live="polite"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor(bot.status) }}
            aria-hidden
          />
          {t(statusKey[bot.status.kind])}
        </span>
      }
    >
      <ImDefaultSettingsSection channel="dingtalk" embedded onSummaryChange={setRouteSummary} />
      <div className="h-px w-full bg-[var(--border-default)]" />

      {connected ? (
        <div
          className={cn(
            'flex flex-col gap-3 rounded-xl p-5',
            'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
          )}
        >
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] text-[var(--settings-badge-connected)]">
              <Check size={16} />
            </div>
            <div>
              <div className="text-13 font-medium text-[var(--settings-section-title)]">
                {t('settings.dingtalkBot.connected.heading')}
              </div>
              <div className="mt-1 text-12 text-[var(--settings-section-desc)]">
                {bot.ownerUserId
                  ? t('settings.dingtalkBot.connected.ownerBound')
                  : t('settings.dingtalkBot.connected.waitingOwner')}
              </div>
            </div>
          </div>
          <InfoRow label={t('settings.dingtalkBot.appKeyLabel')} value={bot.appKey} />
          <InfoRow
            label={t('settings.dingtalkBot.connected.ownerLabel')}
            value={bot.ownerUserId || t('settings.dingtalkBot.connected.notBound')}
          />
          <button
            type="button"
            onClick={() => void clear()}
            disabled={bot.isClearing}
            className={cn(
              'flex h-9 items-center justify-center gap-1.5 rounded-full',
              'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
              'text-12 font-medium text-[var(--settings-btn-secondary-text)]',
              bot.isClearing && 'cursor-not-allowed opacity-40',
            )}
          >
            {bot.isClearing ? (
              <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Trash2 size={13} />
            )}
            {t('settings.dingtalkBot.disconnect')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <FieldLabel>{t('settings.dingtalkBot.appKeyLabel')}</FieldLabel>
          <TextInput
            value={bot.appKey}
            onChange={bot.setAppKey}
            placeholder={t('settings.dingtalkBot.appKeyPlaceholder')}
          />
          <FieldLabel>{t('settings.dingtalkBot.appSecretLabel')}</FieldLabel>
          <div className="relative">
            <TextInput
              type={showSecret ? 'text' : 'password'}
              value={bot.appSecret}
              onChange={bot.setAppSecret}
              placeholder={
                bot.hasSecret
                  ? t('settings.dingtalkBot.appSecretSavedPlaceholder')
                  : t('settings.dingtalkBot.appSecretPlaceholder')
              }
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowSecret((value) => !value)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)]"
              aria-label={
                showSecret
                  ? t('settings.dingtalkBot.hideSecret')
                  : t('settings.dingtalkBot.showSecret')
              }
            >
              {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <div className="min-h-[18px] text-12">
            {bot.validationError ? (
              <span className="text-[var(--settings-error-text)]" role="alert">
                {bot.validationError}
              </span>
            ) : bot.status.kind === 'error' ? (
              <span className="text-[var(--settings-error-text)]" role="alert">
                {t('settings.dingtalkBot.errorHint')}
              </span>
            ) : (
              <span className="text-[var(--settings-source-meta)]">
                {t('settings.dingtalkBot.formHint')}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {bot.hasSecret && !bot.appSecret.trim() ? (
              <button
                type="button"
                onClick={() => void bot.reconnect()}
                disabled={bot.isSaving}
                className={primaryButtonClass}
              >
                {bot.isSaving && (
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                )}
                {t('settings.dingtalkBot.reconnect')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void bot.connect()}
                disabled={!bot.canConnect}
                className={cn(
                  primaryButtonClass,
                  !bot.canConnect && 'cursor-not-allowed opacity-40',
                )}
              >
                {bot.isSaving && (
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                )}
                {t('settings.dingtalkBot.connect')}
              </button>
            )}
            {bot.hasSecret && (
              <button
                type="button"
                onClick={() => void clear()}
                disabled={bot.isClearing}
                className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full border border-[var(--settings-btn-secondary-border)] text-[var(--settings-trash-icon)]"
                aria-label={t('settings.dingtalkBot.disconnect')}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="border-t border-[var(--settings-theme-card-border)] pt-3">
        <button
          type="button"
          onClick={() => setGuideOpen((value) => !value)}
          className="flex w-full items-center justify-between bg-transparent p-0 text-left"
          aria-expanded={guideOpen}
        >
          <span className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('settings.dingtalkBot.guide.title')}
          </span>
          <span className="text-[var(--settings-section-desc)]">
            {guideOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>
        {guideOpen && (
          <div className="mt-3 flex flex-col gap-2 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
            {guideSteps.map((step, index) => (
              <div key={step} className="flex gap-2">
                <span className="font-medium text-[var(--settings-section-title)]">
                  {index + 1}.
                </span>
                <span>{step}</span>
              </div>
            ))}
            <button
              type="button"
              onClick={() => window.electronAPI.openExternal?.(DEVELOPER_PORTAL_URL)}
              className="mt-1 w-fit bg-transparent p-0 text-12 font-medium text-[var(--settings-source-link)] underline underline-offset-2"
            >
              {t('settings.dingtalkBot.guide.openPortal')}
            </button>
          </div>
        )}
      </div>
    </ImChannelSettingsCard>
  );
}

const primaryButtonClass = cn(
  'flex h-[42px] flex-1 items-center justify-center gap-1.5 rounded-full',
  'border border-[var(--settings-btn-primary-border)] bg-[var(--settings-btn-primary-bg)]',
  'text-13 font-medium text-[var(--settings-btn-primary-text)]',
);

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-12 font-medium text-[var(--settings-section-desc)]">{children}</label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: 'text' | 'password';
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        'h-[42px] w-full rounded-full px-3.5',
        'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
        'text-13 text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
        'outline-none focus:border-[var(--settings-input-border-focus)]',
        className,
      )}
      style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
    />
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-12 text-[var(--settings-section-desc)]">
      <span>{label}</span>
      <span className="max-w-[65%] truncate font-medium text-[var(--settings-section-title)]">
        {value}
      </span>
    </div>
  );
}
