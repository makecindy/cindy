import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { GithubSetupDialog } from '@/features/cc-agent/GithubSetupDialog';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { toast } from '@/lib/toast';
import {
  isGithubRepository,
  type CindyMakePersonalRemoteAction,
  type CindyMakePersonalRemoteState,
} from '../../../shared/cindyMakePersonalRemote';

const key = 'cindyMake.storage';

/**
 * Main-owned GitHub binding of the personal version. Settings reads it on entry
 * and after GitHub connects; progress of background work arrives by broadcast.
 */
export function useCindyMakePersonalRemote() {
  const { t } = useTranslation();
  const state = useCindyMakeState().personalRemote;
  const [pending, setPending] = useState<CindyMakePersonalRemoteAction>();
  const act = useCallback(
    async (action: CindyMakePersonalRemoteAction) => {
      const invoke = window.electronAPI.cindyMakePersonalRemote;
      if (!invoke) return;
      setPending(action);
      try {
        await invoke(action);
      } catch {
        if (action !== 'refresh') toast.error(t(`${key}.actionFailed`));
      } finally {
        setPending(undefined);
      }
    },
    [t],
  );
  useEffect(() => {
    void act('refresh');
    return window.electronAPI.gitContext?.onGithubConnected?.(() => void act('refresh'));
  }, [act]);
  return { state, act, pending };
}

/**
 * Consent to create or reuse the user's public fork. It stays until a repository
 * is bound or the user explicitly keeps the personal version on this computer.
 */
export function CindyMakeStorageCard({
  state,
  pending,
  preparing = false,
  onSave,
  onKeepLocal,
}: {
  state: CindyMakePersonalRemoteState;
  pending?: CindyMakePersonalRemoteAction;
  /** The personal source is being prepared before saving. */
  preparing?: boolean;
  onSave(): void;
  onKeepLocal(): void;
}) {
  const { t } = useTranslation();
  const login = state.githubLogin ?? '';
  const existing = isGithubRepository(state.existingPersonal) ? state.existingPersonal : undefined;
  return (
    <section
      aria-labelledby="cindy-make-storage-card-title"
      className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5"
    >
      <h3
        id="cindy-make-storage-card-title"
        className="text-14 font-medium text-[var(--text-primary)]"
      >
        {t(`${key}.card.${existing ? 'existingTitle' : 'title'}`)}
      </h3>
      <p className="mt-2 text-13 leading-[1.5] text-[var(--text-secondary)]">
        {existing
          ? t(`${key}.card.existingIntro`, { login, repository: existing })
          : t(`${key}.card.intro`, { login })}
      </p>
      {!existing && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-13 leading-[1.5] text-[var(--text-secondary)]">
          <li>{t(`${key}.card.otherComputers`)}</li>
          <li>{t(`${key}.card.contribute`)}</li>
          <li>{t(`${key}.card.autoSync`)}</li>
        </ul>
      )}
      <div className="mt-3 space-y-1 rounded-lg bg-[var(--surface-hover)] px-3 py-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
        <p>
          <strong className="font-medium text-[var(--text-primary)]">
            {t(`${key}.card.public`, { repository: existing ?? `${login}/cindy` })}
          </strong>
        </p>
        <p>{t(`${key}.card.${existing ? 'existingKeeps' : 'unchanged'}`)}</p>
        {state.sourceReady === false && <p>{t(`${key}.card.prepareFirst`)}</p>}
      </div>
      {state.error && (
        <p role="status" className="mt-3 text-12 leading-[1.5] text-[var(--error-fg)]">
          {t(`${key}.errors.${state.error}`)}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="cta"
          loading={pending === 'save' || preparing}
          disabled={!!pending || preparing}
          onClick={onSave}
        >
          {t(`${key}.actions.${existing ? 'useExisting' : 'save'}`)}
        </Button>
        <Button
          variant="secondary"
          loading={pending === 'keep-local'}
          disabled={!!pending || preparing}
          onClick={onKeepLocal}
        >
          {t(`${key}.actions.${existing ? 'keepSeparate' : 'keepLocal'}`)}
        </Button>
      </div>
    </section>
  );
}

/** "保存位置" row inside the version overview. */
export function CindyMakeStorageRow({
  state,
  pending,
  act,
  onOffer,
}: {
  state?: CindyMakePersonalRemoteState;
  pending?: CindyMakePersonalRemoteAction;
  act(action: CindyMakePersonalRemoteAction): Promise<void>;
  /** Show the consent card again for a user who previously postponed or declined. */
  onOffer(): void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [connectOpen, setConnectOpen] = useState(false);
  const confirming = useRef(false);
  if (!state) return null;
  const repository = isGithubRepository(state.repository) ? state.repository : undefined;
  const connected = state.github === 'connected';
  const busy = !!pending || !!state.running;
  const stop = async () => {
    if (confirming.current || busy) return;
    confirming.current = true;
    try {
      const confirmed = await confirm({
        title: t(`${key}.stopConfirm.title`),
        description: t(`${key}.stopConfirm.description`),
        confirmText: t(`${key}.stopConfirm.confirm`),
        cancelText: t(`${key}.stopConfirm.cancel`),
      });
      if (confirmed) await act('disconnect');
    } finally {
      confirming.current = false;
    }
  };

  let value: string;
  let status: ReactNode = null;
  let description: string | undefined;
  let descriptionTone = 'text-[var(--text-secondary)]';
  const actions: ReactNode[] = [];
  const connectButton = (label: 'connect' | 'reconnect') => (
    <Button
      key="connect"
      variant="secondary"
      size="sm"
      compact
      onClick={() => setConnectOpen(true)}
    >
      {t(`${key}.actions.${label}`)}
    </Button>
  );

  if (state.running) {
    value = t(`${key}.running.${state.running}`);
    status = (
      <span className="inline-flex items-center gap-1.5 text-12 font-normal text-[var(--text-secondary)]">
        <Spinner size={12} />
        {state.step ? t(`${key}.step.${state.step}`) : null}
      </span>
    );
  } else if (repository) {
    value = t(`${key}.github`, { repository });
    if (state.error === 'account') {
      description = t(`${key}.status.account`, { login: state.githubLogin ?? '' });
      descriptionTone = 'text-[var(--upgrade-banner-fg)]';
    } else if (state.error) {
      description = t(`${key}.errors.${state.error}`);
      descriptionTone = 'text-[var(--error-fg)]';
    } else if (state.sync === 'synced') {
      status = (
        <span className="inline-flex items-center gap-1 text-12 font-normal text-[var(--status-success)]">
          <CircleCheck size={13} aria-hidden />
          {t(`${key}.status.synced`)}
        </span>
      );
    } else if (state.sync) {
      status = (
        <span className="text-12 font-normal text-[var(--text-secondary)]">
          {t(`${key}.status.${state.sync}`)}
        </span>
      );
    }
    // Both sides changed: Sync combines them; its progress and conflicts show under the summary.
    if (state.sync === 'needsMerge' && !state.error) description = t(`${key}.needsMergeHint`);
    else if (state.sync === 'buildFirst' && !state.error) description = t(`${key}.buildFirstHint`);
    if (!connected && state.error !== 'account')
      description = t(
        `${key}.${state.github === 'missing' ? 'disconnectedHint' : 'unavailableHint'}`,
      );
    if (state.github === 'unavailable')
      actions.push(
        <Button
          key="recheck"
          variant="secondary"
          size="sm"
          compact
          loading={pending === 'refresh'}
          disabled={busy}
          onClick={() => void act('refresh')}
        >
          {t(`${key}.actions.recheck`)}
        </Button>,
      );
    else if (!connected) actions.push(connectButton('connect'));
    // A revoked or narrow authorization is fixed by reconnecting; Sync then retries the upload.
    else if (state.error === 'github' || state.error === 'workflowScope' || state.error === 'account')
      actions.push(connectButton('reconnect'));
    // The repository is gone: stop syncing with it and save to a new one, with consent again.
    else if (state.error === 'forkMissing')
      actions.push(
        <Button
          key="save-again"
          variant="secondary"
          size="sm"
          compact
          loading={pending === 'disconnect'}
          disabled={busy}
          onClick={() =>
            void act('disconnect').then(() => {
              onOffer();
            })
          }
        >
          {t(`${key}.actions.saveAgain`)}
        </Button>,
      );
    actions.push(
      <Button
        key="view"
        variant="secondary"
        tone="quiet"
        size="sm"
        compact
        onClick={() =>
          void window.electronAPI.openExternal(
            `https://github.com/${repository}/tree/cindy-personal`,
          )
        }
      >
        {t(`${key}.actions.view`)}
      </Button>,
      <Button
        key="stop"
        variant="secondary"
        tone="quiet"
        size="sm"
        compact
        loading={pending === 'disconnect'}
        disabled={busy}
        onClick={() => void stop()}
      >
        {t(`${key}.actions.stop`)}
      </Button>,
    );
  } else {
    value = t(`${key}.localOnly`);
    if (state.error) {
      description = t(`${key}.errors.${state.error}`);
      descriptionTone = 'text-[var(--error-fg)]';
    } else
      description = t(
        `${key}.${
          state.github === 'unavailable'
            ? 'unavailableHint'
            : connected && state.choice === 'local'
              ? 'localChosenHint'
              : 'localOnlyHint'
        }`,
      );
    if (state.github === 'missing') actions.push(connectButton('connect'));
    else if (state.github === 'unavailable')
      actions.push(
        <Button
          key="recheck"
          variant="secondary"
          size="sm"
          compact
          loading={pending === 'refresh'}
          disabled={busy}
          onClick={() => void act('refresh')}
        >
          {t(`${key}.actions.recheck`)}
        </Button>,
      );
    else {
      if (state.error === 'github' || state.error === 'workflowScope')
        actions.push(connectButton('reconnect'));
      // A retry asks again: the connected login may differ from the one the user agreed to.
      if (!state.offerMigration)
        actions.push(
          <Button
            key="save"
            variant="secondary"
            size="sm"
            compact
            disabled={busy}
            onClick={onOffer}
          >
            {t(`${key}.actions.${state.error ? 'retry' : 'save'}`)}
          </Button>,
        );
    }
  }

  return (
    <section
      aria-label={t(`${key}.title`)}
      className="border-t border-[var(--border-default)] px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-[72px] shrink-0 text-12 text-[var(--text-secondary)]">
          {t(`${key}.title`)}
        </span>
        <div className="min-w-0 flex-[1_1_240px]" role="status">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13 font-medium text-[var(--text-primary)]">
            <span className="min-w-0 break-all">{value}</span>
            {status}
          </div>
          {description && (
            <p className={`mt-0.5 text-12 leading-[1.45] ${descriptionTone}`}>{description}</p>
          )}
        </div>
        {actions.length > 0 && (
          <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1.5">{actions}</div>
        )}
      </div>
      {connectOpen && (
        <GithubSetupDialog
          onClose={() => setConnectOpen(false)}
          onConnected={() => void act('refresh')}
        />
      )}
    </section>
  );
}
