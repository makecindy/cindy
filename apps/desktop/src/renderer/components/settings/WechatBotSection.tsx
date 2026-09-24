import { Button } from '@/components/ui/button';
import { Check, FolderOpen, Loader2, RotateCw, Trash2, Unplug } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useWechatBot } from '@/hooks/useWechatBot';
import { cn } from '@/lib/utils';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';

const STATUS_KEYS: Record<WechatBotPhase, string> = {
  disconnected: 'settings.wechatBot.status.disconnected',
  authorizing: 'settings.wechatBot.status.authorizing',
  waiting_confirmation: 'settings.wechatBot.status.waitingConfirmation',
  connected: 'settings.wechatBot.status.connected',
  reconnecting: 'settings.wechatBot.status.reconnecting',
  needs_reauth: 'settings.wechatBot.status.needsReauth',
  disabled_by_policy: 'settings.wechatBot.status.disabled',
  error: 'settings.wechatBot.status.error',
};

function statusColor(phase: WechatBotPhase): string {
  switch (phase) {
    case 'connected':
      return 'var(--settings-badge-connected)';
    case 'authorizing':
    case 'waiting_confirmation':
    case 'reconnecting':
    case 'needs_reauth':
      return 'var(--settings-badge-saved)';
    case 'error':
    case 'disabled_by_policy':
      return 'var(--settings-badge-error)';
    case 'disconnected':
      return 'var(--settings-badge-needs-config)';
  }
}

function statusTextColor(phase: WechatBotPhase): string {
  return phase === 'connected' ? 'var(--settings-badge-connected-text)' : statusColor(phase);
}

export function WechatBotSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const {
    state,
    channelSettings,
    isAuthorizing,
    isUnbinding,
    isUpdatingWorkingDir,
    authorize,
    cancelAuthorization,
    unbind,
    chooseWorkingDirectory,
    resetWorkingDirectory,
  } = useWechatBot();
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('wechat');

  const authorizationSteps = (
    <ol className="mt-1 grid gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3 text-12 leading-[1.55] text-[var(--text-secondary)]">
      {[1, 2, 3, 4].map((step) => (
        <li key={step} className="flex gap-2">
          <span className="shrink-0 text-[var(--text-tertiary)]">{step}.</span>
          <span>{t(`settings.wechatBot.authorization.steps.${step}`)}</span>
        </li>
      ))}
    </ol>
  );

  const handleAuthorize = useCallback(async () => {
    const replacing = state.bound;
    const accepted = await confirm({
      title: t(
        replacing
          ? 'settings.wechatBot.authorization.rebindTitle'
          : 'settings.wechatBot.authorization.title',
      ),
      description: t(
        replacing
          ? 'settings.wechatBot.authorization.rebindDescription'
          : 'settings.wechatBot.authorization.description',
      ),
      content: authorizationSteps,
      confirmText: t('settings.wechatBot.authorization.confirm'),
      cancelText: t('settings.wechatBot.authorization.cancel'),
      maxWidth: 440,
      autoFocusConfirm: true,
    });
    if (accepted) await authorize();
  }, [authorizationSteps, authorize, confirm, state.bound, t]);

  const handleUnbind = useCallback(async () => {
    const accepted = await confirm({
      title: t('settings.wechatBot.unbind.title'),
      description: t('settings.wechatBot.unbind.description'),
      confirmText: t('settings.wechatBot.unbind.confirm'),
      cancelText: t('settings.wechatBot.unbind.cancel'),
    });
    if (accepted) await unbind();
  }, [confirm, t, unbind]);

  const authorizationPending =
    state.phase === 'authorizing' || state.phase === 'waiting_confirmation';
  const disabledByPolicy = state.phase === 'disabled_by_policy';

  return (
    <ImChannelSettingsCard
      id="personal-im-wechat"
      title={t('settings.wechatBot.title')}
      description={t('settings.wechatBot.description')}
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
            'px-2.5 py-1 text-11 font-medium tracking-[0.12px]',
          )}
          style={{ color: statusTextColor(state.phase) }}
          role="status"
          aria-live="polite"
          aria-label={t('settings.wechatBot.statusAria', {
            status: t(STATUS_KEYS[state.phase]),
          })}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor(state.phase) }}
            aria-hidden
          />
          {t(STATUS_KEYS[state.phase])}
        </span>
      }
    >
      <ImDefaultSettingsSection channel="wechat" embedded onSummaryChange={setRouteSummary} />

      <div className="h-px w-full bg-[var(--border-default)]" />

      <WechatWorkingDirectory
        settings={channelSettings}
        pending={isUpdatingWorkingDir}
        onChoose={() => void chooseWorkingDirectory()}
        onReset={() => void resetWorkingDirectory()}
      />

      <div className="h-px w-full bg-[var(--border-default)]" />

      {authorizationPending ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-5 py-6 text-center">
          <span className="inline-flex animate-spin text-[var(--text-secondary)] motion-reduce:animate-none">
            <Loader2 size={22} />
          </span>
          <div>
            <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
              {t('settings.wechatBot.waiting.heading')}
            </h3>
            <p className="mt-1 max-w-[460px] text-12 leading-[1.6] text-[var(--settings-section-desc)]">
              {t('settings.wechatBot.waiting.note')}
            </p>
          </div>
          <Button
            variant="secondary"
            size="lg"
            type="button"
            onClick={() => void cancelAuthorization()}
          >
            {t('settings.wechatBot.waiting.cancel')}
          </Button>
        </div>
      ) : state.bound ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] text-[var(--settings-badge-connected)]">
              {state.phase === 'connected' ? <Check size={16} /> : <Unplug size={16} />}
            </div>
            <div className="min-w-0">
              <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
                {t(
                  state.phase === 'connected'
                    ? 'settings.wechatBot.bound.heading'
                    : 'settings.wechatBot.bound.attentionHeading',
                )}
              </h3>
              <p className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
                {t(`settings.wechatBot.bound.notes.${state.phase}`)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="lg"
              loading={isAuthorizing}
              type="button"
              onClick={() => void handleAuthorize()}
              disabled={isAuthorizing || disabledByPolicy}
              className="flex-1"
            >
              <RotateCw size={13} />
              {t('settings.wechatBot.actions.rebind')}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              loading={isUnbinding}
              type="button"
              onClick={() => void handleUnbind()}
              disabled={isUnbinding}
              className="flex-1"
            >
              <Trash2 size={13} />
              {t('settings.wechatBot.actions.unbind')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-3">
            <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]">
              {t(
                disabledByPolicy
                  ? 'settings.wechatBot.disabledNote'
                  : state.phase === 'error'
                    ? 'settings.wechatBot.errorNote'
                    : 'settings.wechatBot.intro',
              )}
            </p>
          </div>
          <Button
            variant="cta"
            size="lg"
            loading={isAuthorizing}
            type="button"
            onClick={() => void handleAuthorize()}
            disabled={isAuthorizing || disabledByPolicy}
            className="w-full"
          >
            {t('settings.wechatBot.actions.connect')}
          </Button>
        </div>
      )}
    </ImChannelSettingsCard>
  );
}

function WechatWorkingDirectory({
  settings,
  pending,
  onChoose,
  onReset,
}: {
  settings: WechatChannelSettingsState | null;
  pending: boolean;
  onChoose: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const configured = settings?.workingDir ?? null;

  return (
    <section className="flex flex-col gap-3" aria-label={t('settings.wechatBot.workingDir.title')}>
      <div>
        <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
          {t('settings.wechatBot.workingDir.title')}
        </h3>
        <p className="mt-1 text-12 leading-[1.55] text-[var(--settings-section-desc)]">
          {t('settings.wechatBot.workingDir.hint')}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="secondary"
          size="lg"
          type="button"
          onClick={onChoose}
          disabled={pending}
          className="min-w-0 flex-1"
        >
          <FolderOpen size={15} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate" title={configured ?? undefined} dir="auto">
            {configured ?? t('settings.wechatBot.workingDir.managed')}
          </span>
        </Button>
        {configured && (
          <Button
            variant="secondary"
            size="lg"
            type="button"
            onClick={onReset}
            disabled={pending}
            className="shrink-0"
          >
            {t('settings.wechatBot.workingDir.reset')}
          </Button>
        )}
      </div>
      {settings && !settings.workingDirAvailable && (
        <p className="text-12 text-[var(--settings-error-text)]" role="alert">
          {t('settings.wechatBot.workingDir.unavailable')}
        </p>
      )}
    </section>
  );
}
