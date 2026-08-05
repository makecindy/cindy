import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Trash2, Check, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useFeishuBot, type FeishuBotStatus } from '@/hooks/useFeishuBot';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { savedCredentialsNoteKey, shouldShowSavedCredentialsCard } from './feishuBotPresentation';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';
import { FeishuBotNotificationSection } from './FeishuBotNotificationSection';

const FEISHU_LAUNCHER_URL = 'https://open.feishu.cn/page/launcher?from=backend_oneclick';

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
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const {
    appId,
    setAppId,
    appSecret,
    setAppSecret,
    status,
    errorMessage,
    hasSavedCreds,
    ownerOpenId,
    validationError,
    isSaving,
    isClearing,
    isReconnecting,
    save,
    reconnect,
    clear,
  } = useFeishuBot();

  const [showSecret, setShowSecret] = useState(false);
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('feishu');
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const canSave = appId.trim().length > 0 && appSecret.trim().length > 0 && !isSaving;
  const showSavedCredentialsCard = shouldShowSavedCredentialsCard(hasSavedCreds);

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

  const openLauncher = useCallback(() => {
    window.electronAPI.openExternal?.(FEISHU_LAUNCHER_URL);
  }, []);

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
          ownerOpenId={ownerOpenId}
          status={status}
          isClearing={isClearing}
          isReconnecting={isReconnecting}
          onReconnect={reconnect}
          onClear={handleClearClick}
        />
      ) : (
        <ManualConfig
          appId={appId}
          setAppId={setAppId}
          appSecret={appSecret}
          setAppSecret={setAppSecret}
          showSecret={showSecret}
          setShowSecret={setShowSecret}
          validationError={validationError}
          errorMessage={errorMessage}
          isSaving={isSaving}
          canSave={canSave}
          onSave={save}
          onOpenLauncher={openLauncher}
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
  ownerOpenId: string | null;
  status: FeishuBotStatus;
  isClearing: boolean;
  isReconnecting: boolean;
  onReconnect: () => Promise<boolean>;
  onClear: () => void;
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
              )}
            </div>
            <Tip text={t('settings.feishuBot.connected.reconnect')} side="top" delay={200}>
              {/* Keep the trigger hoverable while the inner button is disabled. */}
              <span className="inline-flex shrink-0">
                <button
                  type="button"
                  onClick={() => void props.onReconnect()}
                  disabled={props.isReconnecting || props.isClearing}
                  aria-label={t('settings.feishuBot.connected.reconnect')}
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

function ManualConfig(props: {
  appId: string;
  setAppId: (v: string) => void;
  appSecret: string;
  setAppSecret: (v: string) => void;
  showSecret: boolean;
  setShowSecret: (v: boolean) => void;
  validationError: string | null;
  errorMessage: string | null;
  isSaving: boolean;
  canSave: boolean;
  onSave: () => Promise<boolean>;
  onOpenLauncher: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <label
        className="text-12 font-medium text-[var(--settings-section-desc)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {t('settings.feishuBot.appIdLabel')}
      </label>
      <input
        type="text"
        value={props.appId}
        onChange={(e) => props.setAppId(e.target.value)}
        placeholder={t('settings.feishuBot.appIdPlaceholder')}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'h-[42px] w-full rounded-full pl-[14px] pr-[14px]',
          'bg-[var(--settings-input-bg)] border border-[var(--settings-input-border)]',
          'text-13 text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
          'outline-none transition-colors focus:border-[var(--settings-input-border-focus)]',
        )}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      />

      <label
        className="text-12 font-medium text-[var(--settings-section-desc)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {t('settings.feishuBot.appSecretLabel')}
      </label>
      <div className="relative">
        <input
          type={props.showSecret ? 'text' : 'password'}
          value={props.appSecret}
          onChange={(e) => props.setAppSecret(e.target.value)}
          placeholder={t('settings.feishuBot.appSecretPlaceholder')}
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
          onClick={() => props.setShowSecret(!props.showSecret)}
          className="absolute right-[14px] top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] transition-colors hover:text-[var(--settings-eye-icon-hover)]"
          aria-label={
            props.showSecret
              ? t('settings.feishuBot.hideSecret')
              : t('settings.feishuBot.showSecret')
          }
        >
          {props.showSecret ? <Eye size={18} /> : <EyeOff size={18} />}
        </button>
      </div>

      <div className="flex min-h-[18px] items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {props.validationError ? (
            <p className="text-12 text-[var(--settings-error-text)]" role="alert">
              {props.validationError}
            </p>
          ) : props.errorMessage ? (
            <p className="text-12 text-[var(--settings-error-text)]" role="alert">
              {props.errorMessage}
            </p>
          ) : (
            <p
              className="text-12 text-[var(--settings-source-meta)]"
              style={{ letterSpacing: '0.12px' }}
            >
              <button
                type="button"
                onClick={props.onOpenLauncher}
                className="cursor-pointer bg-transparent p-0 font-medium text-[var(--settings-source-link)] underline decoration-[var(--settings-source-link)] decoration-1 underline-offset-2"
              >
                {t('settings.feishuBot.createLink')}
              </button>
              <span>{t('settings.feishuBot.createLinkSuffix')}</span>
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={props.onSave}
        disabled={!props.canSave}
        className={cn(
          'flex h-[42px] w-full items-center justify-center gap-1.5 rounded-full',
          'bg-[var(--settings-btn-primary-bg)] border border-[var(--settings-btn-primary-border)]',
          'text-13 font-medium text-[var(--settings-btn-primary-text)]',
          'transition-colors hover:bg-[var(--settings-btn-primary-hover-bg)]',
          !props.canSave && 'cursor-not-allowed opacity-40',
        )}
      >
        {props.isSaving ? <Spinner size={14} /> : null}
        {t('settings.feishuBot.bind')}
      </button>
    </div>
  );
}
