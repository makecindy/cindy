import { AlertCircle, Check, Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import type { PendingPluginSetup, PluginSetupCommandInFlight } from '@/lib/makerChatStore';
import { PluginOauthDeviceCode, type PluginOauthPresentation } from './PluginOauthDeviceCode';

interface Props {
  pending: PendingPluginSetup;
  compact: boolean;
  remoteDeviceId?: string;
  commandInFlight: PluginSetupCommandInFlight | null;
  errorMessage?: string;
  onCommand: (requestId: string, action: 'run_action' | 'cancel', actionId?: string) => void;
}

/** One remote account action, shared by the composer and Bot transcript. */
export function RemoteOauthSetupCard(props: Props) {
  const { pending, remoteDeviceId, commandInFlight } = props;
  const step = pending.steps[0];
  const active =
    !pending.terminal &&
    step.phase !== 'satisfied' &&
    step.phase !== 'cancelled' &&
    commandInFlight?.action !== 'cancel' &&
    (commandInFlight?.action === 'run_action' ||
      ['action_running', 'waiting_external', 'verifying', 'failed'].includes(step.phase));
  if (remoteDeviceId && step.action) {
    return (
      <PluginOauthDeviceCode
        target={{
          deviceId: remoteDeviceId,
          ghostId: pending.ghost.id,
          requestId: pending.requestId,
          actionId: step.action.id,
        }}
        active={active}
        running={commandInFlight?.action === 'run_action'}
      >
        {(presentation) => <AccountCard {...props} presentation={presentation} />}
      </PluginOauthDeviceCode>
    );
  }
  return <AccountCard {...props} />;
}

function AccountCard({
  pending,
  compact,
  commandInFlight,
  onCommand,
  presentation,
  errorMessage,
}: Props & { presentation?: PluginOauthPresentation }) {
  const { t } = useTranslation();
  const step = pending.steps[0];
  const view = presentation?.view;
  const cancelled = step.phase === 'cancelled';
  const complete = step.phase === 'satisfied';
  const expired = !complete && !cancelled && view?.phase === 'expired';
  const ended = !complete && !cancelled && view?.phase === 'ended';
  const failed = step.phase === 'failed';
  const waiting =
    !complete &&
    !cancelled &&
    !expired &&
    !ended &&
    !failed &&
    step.phase !== 'verifying' &&
    (step.phase === 'waiting_external' || view?.phase === 'ready' || view?.phase === 'browser');
  const loading =
    !waiting &&
    !complete &&
    !cancelled &&
    !expired &&
    !ended &&
    (step.phase === 'action_running' || step.phase === 'verifying' || !!commandInFlight);
  const terminal = pending.terminal === true || complete || cancelled;
  const canReopen = waiting && (view?.phase === 'ready' || view?.phase === 'browser');
  const code = waiting && view?.phase === 'ready' ? view : null;
  const title = complete
    ? t('newChat.pluginSetup.account.connected')
    : cancelled
      ? t('newChat.pluginSetup.account.cancelled')
      : expired
        ? t('newChat.pluginSetup.account.expired')
        : ended
          ? t('newChat.pluginSetup.account.ended')
          : failed
            ? t('newChat.pluginSetup.account.failed')
            : waiting
              ? t('newChat.pluginSetup.account.waiting')
              : loading
                ? t(
                    step.phase === 'verifying'
                      ? 'newChat.pluginSetup.account.verifying'
                      : 'newChat.pluginSetup.account.opening',
                  )
                : step.title;
  const description = complete
    ? t('newChat.pluginSetup.account.continue')
    : cancelled
      ? ''
      : expired || ended
        ? t('newChat.pluginSetup.account.reconnectHint')
        : failed
          ? step.errorCode
            ? t(`newChat.pluginSetup.error.${step.errorCode}`)
            : step.errorMessage
          : waiting
            ? t('newChat.pluginSetup.account.waitingHint')
            : loading
              ? ''
              : t('newChat.pluginSetup.account.remoteHint');
  const instructions =
    !terminal && !waiting && !loading
      ? [...new Set([pending.intro?.trim(), step.description.trim()])]
          .filter((text): text is string => !!text && text !== step.title && text !== description)
          .join(' ')
      : '';
  const seconds = code
    ? Math.max(0, Math.ceil((code.expiresAt - (presentation?.now ?? Date.now())) / 1000))
    : 0;
  const cancelBlocked = !!commandInFlight && commandInFlight.action !== 'run_action';
  const canStart =
    !terminal &&
    !!step.action &&
    !commandInFlight &&
    !waiting &&
    !loading &&
    (step.phase === 'pending' || step.phase === 'failed');
  return (
    <section
      aria-label={step.title}
      className={`w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] ${compact ? 'p-4' : 'p-5'}`}
    >
      <div className="flex items-center gap-2 text-13 text-[var(--text-secondary)]">
        <span className="h-5 w-5 shrink-0">
          <GhostPluginIcon
            iconId={pending.ghost.id}
            iconName={pending.ghost.name}
            iconDataUrl={pending.ghost.iconDataUrl}
            size="mini"
          />
        </span>
        <span>{pending.ghost.name}</span>
      </div>
      <div
        className={`${compact ? 'mt-3' : 'mt-4'} flex items-center gap-2`}
        role="status"
        aria-live="polite"
      >
        {complete ? (
          <Check size={18} aria-hidden />
        ) : failed || expired || ended ? (
          <AlertCircle size={18} aria-hidden />
        ) : waiting || loading ? (
          <span className="inline-flex animate-spin motion-reduce:animate-none text-[var(--text-secondary)]">
            <LoaderCircle size={17} aria-hidden />
          </span>
        ) : null}
        <h2 className="text-16 font-semibold text-[var(--text-primary)]">{title}</h2>
      </div>
      {description ? (
        <p
          className={`mt-2 text-13 leading-5 ${failed ? 'text-[var(--error-fg)]' : 'text-[var(--text-secondary)]'}`}
        >
          {description}
        </p>
      ) : null}
      {instructions ? (
        <p className="mt-2 text-13 leading-5 text-[var(--text-secondary)]">{instructions}</p>
      ) : null}
      {code ? (
        <div
          className="mt-4 rounded-lg bg-[var(--surface)] px-4 py-3"
          data-plugin-oauth-device-code
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-13 text-[var(--text-secondary)]">
            <span>
              {t('newChat.pluginSetup.account.codeInstructions', { host: code.verificationHost })}
            </span>
            <span>
              {t('newChat.pluginSetup.account.remaining', {
                time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
              })}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <code
              className="min-w-0 select-all whitespace-pre-wrap break-all text-20 font-medium tracking-wider text-[var(--text-primary)]"
              aria-label={t('newChat.pluginSetup.deviceCode.label')}
            >
              {code.userCode}
            </code>
            <Button
              variant="secondary"
              className="gap-2"
              aria-label={t('newChat.pluginSetup.deviceCode.copyAgain')}
              title={t('newChat.pluginSetup.deviceCode.copyAgain')}
              disabled={!!presentation?.working}
              onClick={() => void presentation?.operate('copy')}
            >
              <Copy size={16} aria-hidden />
              {t('newChat.pluginSetup.deviceCode.copyAgain')}
            </Button>
          </div>
        </div>
      ) : null}
      {!terminal && errorMessage ? (
        <p role="alert" className="mt-3 text-13 text-[var(--error-fg)]">{errorMessage}</p>
      ) : null}
      {!terminal ? (
        <div className={`${compact ? 'mt-4' : 'mt-5'} flex flex-wrap items-center gap-2`}>
          {canReopen ? (
            <Button
              variant="secondary"
              disabled={!!presentation?.working}
              onClick={() => void presentation?.operate('reopen')}
            >
              <ExternalLink size={14} aria-hidden className="mr-2" />
              {t('newChat.pluginSetup.deviceCode.reopen')}
            </Button>
          ) : !waiting && !loading && step.action ? (
            <Button
              variant="cta"
              disabled={!canStart}
              onClick={() => onCommand(pending.requestId, 'run_action', step.action!.id)}
            >
              {expired || ended
                ? t('newChat.pluginSetup.account.reconnect')
                : failed
                  ? t('newChat.pluginSetup.retry')
                  : step.title}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={cancelBlocked}
            onClick={() => onCommand(pending.requestId, 'cancel')}
          >
            {t(
              commandInFlight?.action === 'cancel'
                ? 'newChat.pluginSetup.cancelling'
                : 'newChat.pluginSetup.cancel',
            )}
          </Button>
        </div>
      ) : null}
      {presentation?.failed ? (
        <p role="alert" className="mt-2 text-13 text-[var(--error-fg)]">
          {t('newChat.pluginSetup.deviceCode.actionFailed')}
        </p>
      ) : null}
    </section>
  );
}
