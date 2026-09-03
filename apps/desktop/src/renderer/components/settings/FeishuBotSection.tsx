import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Check, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useFeishuBot, type FeishuBotService, type FeishuBotStatus } from '@/hooks/useFeishuBot';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { savedCredentialsNoteKey, shouldShowSavedCredentialsCard } from './feishuBotPresentation';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';
import { FeishuBotNotificationSection } from './FeishuBotNotificationSection';
import { useFeishuBotRegistration } from '@/hooks/useFeishuBotRegistration';

const FEISHU_SERVICES = ['feishu', 'lark'] as const;
const FEISHU_ONLY = ['feishu'] as const;

const statusKey: Record<FeishuBotStatus, string> = {
  idle: 'settings.feishuBot.status.needsConfig',
  testing: 'settings.feishuBot.status.connecting',
  connected: 'settings.feishuBot.status.connected',
  reconnecting: 'settings.feishuBot.status.reconnecting',
  conflict: 'settings.feishuBot.status.conflict',
  error: 'settings.feishuBot.status.error',
};

function statusColor(s: FeishuBotStatus): string {
  switch (s) {
    case 'idle':
      return 'var(--settings-badge-needs-config)';
    case 'testing':
    case 'reconnecting':
      return 'var(--settings-badge-saved)';
    case 'connected':
      return 'var(--settings-badge-connected)';
    case 'conflict':
      return 'var(--settings-badge-saved)';
    case 'error':
      return 'var(--settings-badge-error)';
  }
}

function statusTextColor(s: FeishuBotStatus): string {
  return s === 'connected' ? 'var(--settings-badge-connected-text)' : statusColor(s);
}

function maskTail(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}••••${value.slice(-4)}`;
}

export function FeishuBotSection({
  expanded,
  onToggle,
  showLark,
}: {
  expanded: boolean;
  onToggle: () => void;
  showLark: boolean;
}) {
  const {
    service,
    setService,
    appId,
    status,
    errorMessage,
    hasSavedCreds,
    ownerOpenId,
    isClearing,
    isReconnecting,
    reconnect,
    clear,
  } = useFeishuBot();

  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('feishu');
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const showSavedCredentialsCard = shouldShowSavedCredentialsCard(hasSavedCreds);
  // 已保存的 Lark 凭证仍允许查看和清除，身份限制只影响新的配置入口。
  const configurableService = showLark || hasSavedCreds ? service : 'feishu';
  const registration = useFeishuBotRegistration(configurableService);

  useEffect(() => {
    if (!showLark && !hasSavedCreds && service === 'lark') {
      setService('feishu');
    }
  }, [hasSavedCreds, service, setService, showLark]);

  const handleClearClick = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.feishuBot.clearConfirm.title'),
      description: t('settings.feishuBot.clearConfirm.description'),
      confirmText: t('settings.feishuBot.clearConfirm.confirm'),
      cancelText: t('settings.feishuBot.clearConfirm.cancel'),
    });
    if (!confirmed) return;
    await clear();
  }, [confirm, clear, t]);

  return (
    <ImChannelSettingsCard
      id="personal-im-feishu"
      title={t('settings.feishuBot.title')}
      description={t('settings.feishuBot.description')}
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
          aria-label={t('settings.feishuBot.statusAria', { status: t(statusKey[status]) })}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor(status) }}
            aria-hidden
          />
          {t(statusKey[status])}
        </span>
      }
    >
      <ImDefaultSettingsSection channel="feishu" embedded onSummaryChange={setRouteSummary} />
      <div className="h-px w-full bg-[var(--border-default)]" />
      {showSavedCredentialsCard ? (
        <SavedCredentialsCard
          appId={appId}
          service={service}
          ownerOpenId={ownerOpenId}
          status={status}
          isClearing={isClearing}
          isReconnecting={isReconnecting}
          onReconnect={reconnect}
          onClear={handleClearClick}
        />
      ) : (
        <FeishuBotQrConfig
          service={configurableService}
          setService={setService}
          showLark={showLark}
          errorMessage={errorMessage}
          registration={registration}
        />
      )}
      {hasSavedCreds && (
        <>
          <div className="h-px w-full bg-[var(--border-default)]" />
          <FeishuBotNotificationSection />
        </>
      )}
    </ImChannelSettingsCard>
  );
}

function SavedCredentialsCard(props: {
  appId: string;
  service: FeishuBotService;
  ownerOpenId: string | null;
  status: FeishuBotStatus;
  isClearing: boolean;
  isReconnecting: boolean;
  onReconnect: () => Promise<boolean>;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const serviceName = t(`settings.feishuBot.services.${props.service}`);
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
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)]"
          style={{
            color:
              props.status === 'connected'
                ? 'var(--settings-badge-connected)'
                : 'var(--settings-badge-saved)',
          }}
        >
          <Check size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="text-13 font-medium text-[var(--settings-section-title)]">
              {t(
                props.status === 'connected'
                  ? 'settings.feishuBot.connected.heading'
                  : 'settings.feishuBot.saved.heading',
                { service: serviceName },
              )}
            </div>
            <Tip
              text={t('settings.feishuBot.connected.reconnect', { service: serviceName })}
              side="top"
              delay={200}
            >
              {/* Keep the trigger hoverable while the inner button is disabled. */}
              <span className="inline-flex shrink-0">
                <button
                  type="button"
                  onClick={() => void props.onReconnect()}
                  disabled={props.isReconnecting || props.isClearing}
                  aria-label={t('settings.feishuBot.connected.reconnect', {
                    service: serviceName,
                  })}
                  className={cn(
                    'inline-flex h-7 w-7 select-none items-center justify-center rounded-full',
                    'text-[var(--settings-section-desc)] transition-colors',
                    'hover:bg-[var(--surface-hover)] hover:text-[var(--settings-section-title)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    (props.isReconnecting || props.isClearing) && 'cursor-not-allowed opacity-40',
                  )}
                >
                  <Spinner
                    icon={RefreshCw}
                    size={14}
                    strokeWidth={2}
                    spinning={props.isReconnecting}
                  />
                </button>
              </span>
            </Tip>
          </div>
          <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
            {t(savedCredentialsNoteKey(props.status))}
          </div>
        </div>
      </div>
      <div className="grid gap-2 text-12 text-[var(--settings-section-desc)]">
        <div className="flex justify-between gap-4">
          <span>{t('settings.feishuBot.connected.serviceLabel')}</span>
          <span className="font-medium text-[var(--settings-section-title)]">{serviceName}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>{t('settings.feishuBot.connected.appIdLabel')}</span>
          <span className="font-medium text-[var(--settings-section-title)]">
            {maskTail(props.appId)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span>{t('settings.feishuBot.connected.ownerLabel')}</span>
          <span className="font-medium text-[var(--settings-section-title)]">
            {props.ownerOpenId
              ? maskTail(props.ownerOpenId)
              : t('settings.feishuBot.connected.ownerWaiting')}
          </span>
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={props.onClear}
          disabled={props.isClearing}
          className={cn(
            'flex h-[36px] flex-1 items-center justify-center gap-1.5 rounded-full',
            'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
            'text-12 font-medium text-[var(--settings-btn-secondary-text)]',
            props.isClearing && 'cursor-not-allowed opacity-40',
          )}
        >
          {props.isClearing ? <Spinner size={13} /> : <Trash2 size={13} />}
          {t('settings.feishuBot.connected.clear')}
        </button>
      </div>
    </div>
  );
}

function ServiceSelector(props: {
  service: FeishuBotService;
  setService: (service: FeishuBotService) => void;
  showLark: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend
        className="text-12 font-medium text-[var(--settings-section-desc)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {t('settings.feishuBot.serviceLabel')}
      </legend>
      <div
        className={cn(
          'grid gap-1 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] p-1',
          props.showLark ? 'grid-cols-2' : 'grid-cols-1',
        )}
        role="radiogroup"
        aria-label={t('settings.feishuBot.serviceAria')}
      >
        {(props.showLark ? FEISHU_SERVICES : FEISHU_ONLY).map((service) => {
          const selected = props.service === service;
          return (
            <button
              key={service}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.setService(service)}
              className={cn(
                'h-[34px] rounded-full text-12 font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                selected
                  ? 'bg-[var(--surface-chip)] text-[var(--settings-section-title)]'
                  : 'text-[var(--settings-section-desc)] hover:text-[var(--settings-section-title)]',
              )}
            >
              {t(`settings.feishuBot.services.${service}`)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function FeishuBotQrConfig(props: {
  service: FeishuBotService;
  setService: (service: FeishuBotService) => void;
  showLark: boolean;
  errorMessage: string | null;
  registration: ReturnType<typeof useFeishuBotRegistration>;
}) {
  const { t } = useTranslation();
  const { phase, qrDataUrl, userCode, secondsLeft, errorMessage } = props.registration;
  const isGenerating = phase === 'starting';
  const visibleError = errorMessage ?? props.errorMessage;

  return (
    <div className="flex flex-col gap-3">
      <ServiceSelector
        service={props.service}
        setService={props.setService}
        showLark={props.showLark}
      />

      <div
        className="flex flex-col items-center gap-3 rounded-xl border p-4"
        style={{
          borderColor: 'var(--settings-theme-card-border)',
          backgroundColor: 'var(--settings-theme-card-bg)',
        }}
      >
        <div className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('settings.feishuBot.qr.title')}
        </div>
        <p className="max-w-[280px] text-center text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.feishuBot.qr.description')}
        </p>

        {phase === 'qr' && qrDataUrl ? (
          <>
            <img
              src={qrDataUrl}
              alt={t('settings.feishuBot.qr.qrAlt')}
              className="h-[180px] w-[180px] rounded-lg"
            />
            {userCode ? (
              <span
                className="select-all text-12 font-medium text-[var(--settings-section-title)]"
                style={{ letterSpacing: '0.16em' }}
              >
                {t('settings.feishuBot.qr.userCode')}: {userCode}
              </span>
            ) : null}
            {secondsLeft !== null ? (
              <span className="text-11 text-[var(--settings-section-desc)]">
                {secondsLeft < 60
                  ? t('settings.feishuBot.qr.expiresInSeconds', { seconds: secondsLeft })
                  : t('settings.feishuBot.qr.expiresInMinutes', {
                      minutes: Math.floor(secondsLeft / 60),
                      seconds: secondsLeft % 60,
                    })}
              </span>
            ) : null}
          </>
        ) : phase === 'starting' || phase === 'success' ? (
          <div className="flex h-[180px] items-center justify-center gap-2 text-12 text-[var(--settings-section-desc)]">
            <Spinner size={14} />
            {phase === 'starting'
              ? t('settings.feishuBot.qr.generating')
              : t('settings.feishuBot.qr.connecting')}
          </div>
        ) : (
          <div className="flex h-[180px] items-center justify-center text-12 text-[var(--settings-section-desc)]">
            {t('settings.feishuBot.qr.qrPlaceholder')}
          </div>
        )}

        {visibleError ? (
          <p className="text-12 text-[var(--settings-error-text)]" role="alert">
            {visibleError}
          </p>
        ) : null}
      </div>

      {phase === 'qr' ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void props.registration.beginRegistration()}
            className={cn(
              'flex h-[42px] flex-1 items-center justify-center rounded-full border text-12 font-medium transition-colors',
              'border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
              'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
            )}
          >
            {t('settings.feishuBot.qr.regenerate')}
          </button>
          <button
            type="button"
            onClick={() => void props.registration.cancelRegistration()}
            className={cn(
              'flex h-[42px] flex-1 items-center justify-center rounded-full border text-12 font-medium transition-colors',
              'border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
              'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
            )}
          >
            {t('settings.feishuBot.qr.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void props.registration.beginRegistration()}
          disabled={isGenerating}
          className={cn(
            'flex h-[42px] w-full items-center justify-center gap-1.5 rounded-full',
            'bg-[var(--settings-btn-primary-bg)] border border-[var(--settings-btn-primary-border)]',
            'text-13 font-medium text-[var(--settings-btn-primary-text)]',
            'transition-colors hover:bg-[var(--settings-btn-primary-hover-bg)]',
            isGenerating && 'cursor-not-allowed opacity-40',
          )}
        >
          {isGenerating ? <Spinner size={14} /> : null}
          {t(
            phase === 'expired' || phase === 'cancelled' || phase === 'error'
              ? 'settings.feishuBot.qr.regenerate'
              : 'settings.feishuBot.qr.generate',
          )}
        </button>
      )}
    </div>
  );
}
