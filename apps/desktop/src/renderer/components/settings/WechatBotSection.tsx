import { imBotSettings } from './ImBotSection.settings-search';
import { Button } from '@/components/ui/button';
import { Check, FolderOpen, Loader2, RotateCw, Trash2, Unplug } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useWechatBot } from '@/hooks/useWechatBot';
import { cn } from '@/lib/utils';
import {
  formatImDefaultRouteSummary,
  ImChannelSettingsCard,
  useImChannelSettingsSummary,
} from './ImChannelSettingsCard';
import { SettingsBlock, SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { useBotProfiles } from '@/features/bots/botStore';
import {
  ImBotBlockCard,
  ImBotPersonalWay,
  ImBotStatusText,
  ImBotSubPage,
  useImBotNav,
  type ImBotStatusTone,
} from './ImBotPageParts';
import { ImChannelProjectRows, usePersonalChannelProject } from './ImChannelProjectRows';
import { ImReplyTargetField, type ImReplyTarget } from './ImReplyTargetField';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';
import { ResetGroupButton } from '@/components/ui/reset-buttons';

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
  companion,
  host,
}: {
  expanded: boolean;
  onToggle: () => void;
  companion?: { id: string; name: string };
  /**
   * Set when the teammate runs on another computer: its WeChat API. Authorizing opens a browser and
   * scanning happens on that computer, so connecting stays there; assignment and release work from here.
   */
  host?: { name: string; api: Window['electronAPI']['wechatBot'] };
}) {
  const controller = useWechatBot(host?.api);
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('wechat');
  return (
    <WechatBotSectionView
      expanded={expanded}
      onToggle={onToggle}
      companion={companion}
      host={host}
      controller={controller}
      routeSummary={routeSummary}
      defaultSettings={
        <ImDefaultSettingsSection channel="wechat" embedded onSummaryChange={setRouteSummary} />
      }
      workingDirectory={
        <WechatWorkingDirectory
          settings={controller.channelSettings}
          pending={controller.isUpdatingWorkingDir}
          onChoose={() => void controller.chooseWorkingDirectory()}
          onReset={() => void controller.resetWorkingDirectory()}
        />
      }
    />
  );
}

export function WechatBotSectionView({
  controller,
  messageTargetName,
  idPrefix = '',
  canDisconnect = true,
  routeSummary,
  defaultSettings,
  workingDirectory,
  authorizationAvailable,
  expanded,
  onToggle,
  companion,
  host,
}: {
  idPrefix?: string;
  /** Names the execution target without instantiating a local or remote controller. */
  messageTargetName?: string;
  canDisconnect?: boolean;
  controller: Omit<
    ReturnType<typeof useWechatBot>,
    'isUpdatingWorkingDir' | 'chooseWorkingDirectory' | 'resetWorkingDirectory'
  >;
  routeSummary: import('./ImDefaultSettingsSection').ImDefaultSettingsSummary | null;
  defaultSettings: React.ReactNode;
  workingDirectory: React.ReactNode;
  authorizationAvailable?: boolean;

  expanded: boolean;
  onToggle: () => void;
  companion?: { id: string; name: string };
  /**
   * Set when the teammate runs on another computer: its WeChat API. Authorizing opens a browser and
   * scanning happens on that computer, so connecting stays there; assignment and release work from here.
   */
  host?: { name: string; api: Window['electronAPI']['wechatBot'] };
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const targetName = messageTargetName;
  const {
    state,
    channelSettings,
    isAuthorizing,
    isUnbinding,
    authorize,
    cancelAuthorization,
    unbind,
    setCompanion,
    isUpdatingCompanion,
  } = controller;
  const assigned = channelSettings?.companionBotId;
  const otherCompanion = !!companion && !!assigned && assigned !== companion.id;
  const needsAssignment = !!companion && assigned !== companion.id;

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
    if (accepted) {
      if (companion && !(await setCompanion(companion.id))) return;
      await authorize();
    }
  }, [authorizationSteps, authorize, companion, confirm, setCompanion, state.bound, t]);

  const handleUnbind = useCallback(async () => {
    const accepted = await confirm({
      title: t('settings.wechatBot.unbind.title'),
      description: t('settings.wechatBot.unbind.description'),
      confirmText: t('settings.wechatBot.unbind.confirm'),
      cancelText: t('settings.wechatBot.unbind.cancel'),
      // 解绑会删除本机微信凭证并清理未完成的执行，不可撤回（DESIGN.md §4 Destructive actions）。
      confirmVariant: 'destructive',
    });
    if (accepted) await unbind();
  }, [confirm, t, unbind]);

  const authorizationPending =
    state.phase === 'authorizing' || state.phase === 'waiting_confirmation';
  const disabledByPolicy = state.phase === 'disabled_by_policy';

  return (
    <ImChannelSettingsCard
      id={`${idPrefix}${companion ? 'companion-im-wechat' : 'personal-im-wechat'}`}
      title={t(imBotSettings.wechat.titleKey)}
      description={t('settings.wechatBot.description')}
      routeSummary={
        companion ? (assigned === companion.id ? companion.name : null)
          : assigned ? t('settings.wechatBot.companion.assigned')
            : formatImDefaultRouteSummary(routeSummary, t)
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
      {companion || assigned ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-13 leading-[1.5] text-[var(--text-secondary)]">
            {t(otherCompanion ? 'settings.wechatBot.companion.other'
              : companion ? 'settings.wechatBot.companion.description' : 'settings.wechatBot.companion.assigned',
            { name: companion?.name })}
          </p>
          <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
            {t('settings.wechatBot.companion.permissionNote')}
          </p>
          {!otherCompanion && assigned ? (
            <Button data-setting-id={imBotSettings.wechat.id} variant="secondary" size="sm" loading={isUpdatingCompanion}
              onClick={() => void setCompanion(null)}>
              {t('settings.wechatBot.companion.remove')}
            </Button>
          ) : !otherCompanion && state.bound && companion ? (
            <Button data-setting-id={imBotSettings.wechat.id} variant="secondary" size="sm" loading={isUpdatingCompanion}
              disabled={!channelSettings} onClick={() => void setCompanion(companion.id)}>
              {t('settings.wechatBot.companion.useExisting', { name: companion.name })}
            </Button>
          ) : null}
        </div>
      ) : <>
      {defaultSettings}

      <div className="h-px w-full bg-[var(--border-default)]" />

      {workingDirectory}
      </>}

      <div className="h-px w-full bg-[var(--border-default)]" />

      {otherCompanion || (needsAssignment && state.bound) ? null : authorizationPending ? (
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
          <Button data-setting-id={imBotSettings.wechat.id}
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
                {t(
                  `settings.wechatBot.bound.notes.${state.phase}${targetName && (state.phase === 'connected' || state.phase === 'reconnecting') ? 'OnHost' : ''}`,
                  { name: targetName },
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {host ? null : (
              <Button data-setting-id={imBotSettings.wechat.id}
                variant="secondary"
                size="lg"
                loading={isAuthorizing}
                type="button"
                onClick={() => void handleAuthorize()}
                disabled={
                  isAuthorizing ||
                  isUpdatingCompanion ||
                  !(authorizationAvailable ?? !!channelSettings) ||
                  disabledByPolicy
                }
                className="flex-1"
              >
                <RotateCw size={13} />
                {t('settings.wechatBot.actions.rebind')}
              </Button>
            )}
            <Button data-setting-id={imBotSettings.wechat.id}
              variant="secondary"
              size="lg"
              loading={isUnbinding}
              type="button"
              onClick={() => void handleUnbind()}
              disabled={!canDisconnect || isUnbinding}
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
                    : targetName
                      ? 'settings.wechatBot.introOnHost'
                      : 'settings.wechatBot.intro',
                { name: targetName },
              )}
            </p>
          </div>
          {host ? (
            <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]">
              {t('bots.remoteSettings.finishOnHost', { device: host.name })}
            </p>
          ) : (
            <Button data-setting-id={imBotSettings.wechat.id}
              variant="cta"
              size="lg"
              loading={isAuthorizing}
              type="button"
              onClick={() => void handleAuthorize()}
              disabled={
                isAuthorizing ||
                isUpdatingCompanion ||
                !(authorizationAvailable ?? !!channelSettings) ||
                disabledByPolicy
              }
              className="w-full"
            >
              {t('settings.wechatBot.actions.connect')}
            </Button>
          )}
        </div>
      )}
    </ImChannelSettingsCard>
  );
}

export function WechatWorkingDirectory({
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
        <Button data-setting-id={imBotSettings.wechat.id}
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
          <ResetGroupButton data-setting-id={imBotSettings.wechat.id}
            onClick={onReset}
            disabled={pending}
            className="shrink-0"
            label={t('settings.wechatBot.workingDir.reset')}
          />
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

const STATUS_TONE: Record<WechatBotPhase, ImBotStatusTone> = {
  disconnected: 'off',
  authorizing: 'progress',
  waiting_confirmation: 'progress',
  connected: 'connected',
  reconnecting: 'progress',
  needs_reauth: 'attention',
  disabled_by_policy: 'error',
  error: 'error',
};

export function useWechatListStatus(): { configured: boolean; tone: ImBotStatusTone; labelKey: string; companionBotId: string | null } {
  const { state, channelSettings } = useWechatBot();
  return {
    configured: state.bound || state.phase !== 'disconnected',
    tone: STATUS_TONE[state.phase],
    labelKey: STATUS_KEYS[state.phase],
    companionBotId: channelSettings?.companionBotId ?? null,
  };
}

/** 个人微信的「谁来回复」: 微信本来就是单实例 + 伙伴归属(凭证不动), 直接用它的接口。 */
function useWechatReplyTarget(wechat: ReturnType<typeof useWechatBot>): ImReplyTarget {
  const bots = useBotProfiles();
  const { channelSettings, setCompanion, isUpdatingCompanion } = wechat;
  const companionBotId = channelSettings?.companionBotId ?? null;
  return {
    supported: !!channelSettings,
    companionBotId,
    companion: companionBotId ? bots.find((bot) => bot.id === companionBotId) ?? null : null,
    pending: isUpdatingCompanion,
    change: async (next) => { await setCompanion(next, { allowReassign: true }); },
  };
}

/** 设置 → IM 机器人 → 微信。个人微信只有扫码这一种方式。 */
export function WechatBotSettings() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const nav = useImBotNav();
  const wechat = useWechatBot();
  const { state, channelSettings, isAuthorizing, isUnbinding, isUpdatingWorkingDir, authorize, cancelAuthorization,
    unbind, chooseWorkingDirectory, resetWorkingDirectory, isUpdatingCompanion } = wechat;

  const authorizationSteps = (
    <ol className="mt-1 grid gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-3 text-12 leading-[1.55] text-[var(--text-secondary)]">
      {[1, 2, 3, 4].map((step) => (
        <li key={step} className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-primary)] text-10 font-semibold text-[var(--text-primary)]">
            {step}
          </span>
          <span>{t(`settings.wechatBot.authorization.steps.${step}`)}</span>
        </li>
      ))}
    </ol>
  );

  const handleAuthorize = useCallback(async () => {
    const accepted = await confirm({
      title: t(state.bound ? 'settings.wechatBot.authorization.rebindTitle' : 'settings.wechatBot.authorization.title'),
      description: t(state.bound ? 'settings.wechatBot.authorization.rebindDescription' : 'settings.wechatBot.authorization.description'),
      content: authorizationSteps,
      confirmText: t('settings.wechatBot.authorization.confirm'),
      cancelText: t('settings.wechatBot.authorization.cancel'),
    });
    if (!accepted) return;
    await authorize();
  }, [authorize, confirm, state.bound, t]);

  const handleUnbind = useCallback(async () => {
    const accepted = await confirm({
      title: t('settings.wechatBot.unbind.title'),
      description: t('settings.wechatBot.unbind.description'),
      confirmText: t('settings.wechatBot.unbind.confirm'),
      cancelText: t('settings.wechatBot.unbind.cancel'),
      confirmVariant: 'destructive',
    });
    if (accepted) await unbind();
  }, [confirm, t, unbind]);

  const replyTarget = useWechatReplyTarget(wechat);
  const toCompanion = !!replyTarget.companionBotId;
  // 选了项目时任务放进项目; 「对话」时才看下面这个微信自己的对话目录。
  const inProject = !!usePersonalChannelProject('wechat').state?.projectDir;
  const authorizationPending = state.phase === 'authorizing' || state.phase === 'waiting_confirmation';
  const disabledByPolicy = state.phase === 'disabled_by_policy';

  if (nav.page === 'model') {
    return (
      <ImBotSubPage title={t('settings.imBot.rows.model')} description={t('settings.imBot.apps.wechat')}>
        <ImBotBlockCard><ImDefaultSettingsSection channel="wechat" embedded /></ImBotBlockCard>
      </ImBotSubPage>
    );
  }

  if (authorizationPending) {
    return (
      <ImBotPersonalWay id="personal-im-wechat">
        <ImBotBlockCard>
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="inline-flex animate-spin text-[var(--text-secondary)] motion-reduce:animate-none"><Loader2 size={22} /></span>
            <div>
              <h3 className="text-13 font-medium text-[var(--settings-section-title)]">{t('settings.wechatBot.waiting.heading')}</h3>
              <p className="mt-1 max-w-[460px] text-12 leading-[1.6] text-[var(--settings-section-desc)]">{t('settings.wechatBot.waiting.note')}</p>
            </div>
            <Button data-setting-id={imBotSettings.wechat.id} variant="secondary" size="lg" type="button" onClick={() => void cancelAuthorization()}>
              {t('settings.wechatBot.waiting.cancel')}
            </Button>
          </div>
        </ImBotBlockCard>
      </ImBotPersonalWay>
    );
  }

  if (!state.bound) {
    return (
      <ImBotPersonalWay id="personal-im-wechat">
        <SettingsCard>
          <SettingsRow
            wrap
            title={t('settings.wechatBot.title')}
            hint={t(disabledByPolicy ? 'settings.wechatBot.disabledNote'
              : state.phase === 'error' ? 'settings.wechatBot.errorNote' : 'settings.wechatBot.intro')}
            trailing={<Button data-setting-id={imBotSettings.wechat.id} variant="cta" size="sm" loading={isAuthorizing} type="button"
              onClick={() => void handleAuthorize()}
              disabled={isAuthorizing || isUpdatingCompanion || !channelSettings || disabledByPolicy}>
              {t('settings.wechatBot.actions.connect')}
            </Button>}
          />
        </SettingsCard>
      </ImBotPersonalWay>
    );
  }

  return (
    <ImBotPersonalWay id="personal-im-wechat">
      <SettingsCard>
        <ImReplyTargetField target={replyTarget} setting="wechat" />
        {toCompanion ? null : <ImChannelProjectRows channel="wechat" appName={t('settings.imBot.apps.wechat')} settingId={imBotSettings.wechat.id} />}
        {toCompanion || inProject ? null : (
          <SettingsBlock>
            <WechatWorkingDirectory
              settings={channelSettings}
              pending={isUpdatingWorkingDir}
              onChoose={() => void chooseWorkingDirectory()}
              onReset={() => void resetWorkingDirectory()}
            />
          </SettingsBlock>
        )}
      </SettingsCard>
      <SettingsCard>
        <SettingsRow
          wrap
          title={t('settings.wechatBot.title')}
          hint={<ImBotStatusText tone={STATUS_TONE[state.phase]}>{t(`settings.wechatBot.bound.notes.${state.phase}`)}</ImBotStatusText>}
          trailing={<Button data-setting-id={imBotSettings.wechat.id} variant="secondary" size="sm" loading={isAuthorizing} type="button"
            onClick={() => void handleAuthorize()}
            disabled={isAuthorizing || isUpdatingCompanion || !channelSettings || disabledByPolicy}>
            <RotateCw size={13} />
            {t('settings.wechatBot.actions.rebind')}
          </Button>}
        />
        <SettingsRow data-setting-id={imBotSettings.wechat.id} danger title={t('settings.imBot.rows.unbind')}
          disabled={isUnbinding} onClick={() => void handleUnbind()} />
      </SettingsCard>
    </ImBotPersonalWay>
  );
}
