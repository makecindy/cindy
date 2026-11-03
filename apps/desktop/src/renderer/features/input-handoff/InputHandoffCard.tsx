import { deviceDisplayName } from '@/lib/deviceName';
/**
 * InputHandoffCard (代输入)
 * ---------------------------------------------------------------------------
 * A strip above the composer says where the computer needs the owner; 填写
 * (or 扫码) opens the dialog with just what the owner fills in. The Host reads
 * one screen of the target UI and shows it as standard fields. Values the
 * owner types stay in the form's local state and leave only through
 * makerTransport.submitInputHandoff — never the store, the transcript or the
 * model. Each new screen remounts the form, so a stale draft can never be
 * applied to a different screen.
 *
 * Password fields are plain `type="password"` + `autocomplete` hints so the
 * platform password manager (1Password, Passwords) can fill them.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  InputHandoffAction,
  InputHandoffSnapshot,
  InputHandoffValues,
} from '@cindy/device-link';
import {
  inputHandoffHeldElsewhere,
  inputHandoffPresentation,
  inputHandoffStepKey,
} from '@cindy/device-link';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { toast } from '@/lib/toast';
import { makerApiForSticky, submitInputHandoff } from '@/lib/makerTransport';
import { cn } from '@/lib/utils';
import { InputHandoffDeviceCode } from './InputHandoffDeviceCode';
import { InputHandoffDialog, InputHandoffPlace, inputHandoffIcon } from './InputHandoffDialog';
import { InputHandoffPictureStep } from './InputHandoffPictureStep';
import { InputHandoffQrStep } from './InputHandoffQrStep';
import { CONTINUE_ATTR, InputHandoffStepForm } from './InputHandoffStepForm';
import {
  changedValues,
  inputHandoffDialogHasContent,
  inputHandoffDialogMode,
  inputHandoffPlace,
} from './inputHandoffModel';

export interface InputHandoffCardProps {
  sessionId: string;
  snapshot: InputHandoffSnapshot;
  /** The task runs on another computer (values go through the signed relay). */
  remote?: boolean;
}

type Decision = 'done' | 'cancel' | 'stay' | 'refresh' | 'claim' | 'picture';

interface StripAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
  /** Stands in for the plain button (it needs hooks of its own). */
  element?: ReactNode;
}

export function InputHandoffCard({ sessionId, snapshot, remote }: InputHandoffCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stays wanted across steps: after Continue the dialog hides while the
  // computer types and comes back by itself for the next screen to fill.
  const [dialogWanted, setDialogWanted] = useState(false);
  // The owner chose the form over the window (the live view or the window could not be used).
  const [formFor, setFormFor] = useState<string | null>(null);

  // A new screen clears any message about the previous one.
  const stepKey = inputHandoffStepKey(snapshot);
  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [stepKey]);
  useEffect(() => {
    if (snapshot.terminal) setDialogWanted(false);
  }, [snapshot.terminal]);

  const decide = useCallback(
    async (action: Decision) => {
      setBusy(true);
      setError(null);
      try {
        const result = await makerApiForSticky(sessionId).resolveInteraction(snapshot.requestId, {
          kind: 'input_handoff',
          action,
          expectedRevision: snapshot.revision,
        });
        if (!result.accepted) setError(t('inputHandoff.error.stale'));
      } catch {
        setError(t('inputHandoff.error.decision'));
      } finally {
        setBusy(false);
      }
    },
    [sessionId, snapshot.requestId, snapshot.revision, t],
  );

  const submit = useCallback(
    async (draft: InputHandoffValues, action: InputHandoffAction) => {
      setBusy(true);
      setError(null);
      try {
        const result = await submitInputHandoff(sessionId, {
          submission: {
            expectedRevision: snapshot.revision,
            values: changedValues(snapshot, draft),
            action,
          },
          presentation: inputHandoffPresentation(snapshot),
        });
        if (!result.accepted) setError(t('inputHandoff.error.stale'));
        return result.accepted;
      } catch {
        setError(t('inputHandoff.error.submit'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionId, snapshot, t],
  );

  // Starting to type on an unheld screen takes the handoff quietly, so other
  // devices show "being handled on …". It never blocks the field being typed in.
  const claimQuietly = useCallback(() => {
    if (snapshot.holder) return;
    void makerApiForSticky(sessionId)
      .resolveInteraction(snapshot.requestId, {
        kind: 'input_handoff',
        action: 'claim',
        expectedRevision: snapshot.revision,
      })
      .catch(() => undefined);
  }, [sessionId, snapshot.holder, snapshot.requestId, snapshot.revision]);

  const inputBlocked = remote === true && snapshot.remoteInput !== true;
  const selfDeviceId = useOptionalAuthDeviceId();
  const heldElsewhere = inputHandoffHeldElsewhere(
    snapshot,
    remote === true ? { deviceId: selfDeviceId } : { local: true },
  );
  const liveView = liveViewDevice(sessionId, snapshot);
  const dialogContent = inputHandoffDialogHasContent(snapshot, heldElsewhere);
  // A sign-in happens on the window: here on this computer, through the live view from elsewhere.
  // Without a live view from another computer, the form stays the way to finish it.
  const onThisComputer = !getStickySessionDeviceId(sessionId);
  const canUseForm = snapshot.controls.length > 0 || snapshot.picture === true;
  const directSignIn = snapshot.directSignIn === true && (onThisComputer || !!liveView) && formFor !== snapshot.requestId;
  const qrScan = snapshot.qr === 'scan' && snapshot.picture === true;

  const skip: StripAction = { label: t('inputHandoff.action.skip'), onClick: () => void decide('cancel') };
  const handBack: StripAction = {
    label: t('inputHandoff.action.done'),
    primary: true,
    onClick: () => void decide('done'),
  };
  let status: ReactNode = null;
  let spinner = false;
  let actions: StripAction[] = [];
  if (snapshot.terminal) {
    status = t(
      (snapshot.phase === 'failed' || snapshot.failure === 'nothing_to_fill') && snapshot.failure
        ? `inputHandoff.failure.${snapshot.failure}`
        : `inputHandoff.terminal.${snapshot.phase}`,
    );
  } else if (snapshot.phase === 'ready' && heldElsewhere) {
    status = t('inputHandoff.holder.elsewhere', { device: holderLabel(snapshot, t) });
    actions = [
      skip,
      {
        label: t('inputHandoff.action.claim'),
        primary: true,
        onClick: () => {
          setDialogWanted(true);
          void decide('claim');
        },
      },
    ];
  } else if (snapshot.phase === 'ready' && snapshot.qr === 'scanned') {
    // The code was scanned; the sign-in finishes on the phone that scanned it.
    spinner = true;
    status = t('inputHandoff.qr.scanned');
    actions = [skip, handBack];
  } else if (snapshot.phase === 'ready' && directSignIn) {
    status = t('inputHandoff.directSignIn.hint');
    actions = [
      skip,
      {
        label: t(!onThisComputer ? 'inputHandoff.action.openRemoteDesktop' : 'inputHandoff.action.openWindow'),
        primary: true,
        onClick: () => {
          setError(null);
          // Working on the window is answering: take the card, so other devices show it as being handled.
          claimQuietly();
          void window.electronAPI.maker
            .raiseInputHandoff(snapshot.requestId)
            .then((raised) => {
              if (!raised) setError(t('inputHandoff.error.raise'));
            })
            .catch(() => setError(t('inputHandoff.error.raise')));
        },
        ...(liveView ? { element: <LiveViewButton deviceId={liveView} requestId={snapshot.requestId} onBeforeOpen={claimQuietly} /> } : {}),
      },
    ];
  } else if (snapshot.phase === 'ready' && dialogContent) {
    actions = [
      skip,
      {
        label: t(qrScan ? 'inputHandoff.action.scan' : 'inputHandoff.action.fill'),
        primary: true,
        onClick: () => setDialogWanted(true),
      },
    ];
  } else if (snapshot.phase === 'ready') {
    // Nothing left to type here (the owner stayed on, or an action did not take).
    status = snapshot.failure ? t(`inputHandoff.failure.${snapshot.failure}`) : t('inputHandoff.nothingLeft');
    actions = [skip, handBack];
  } else if (snapshot.phase === 'finishing') {
    status = <FinishingCountdown until={snapshot.finishingUntil} />;
    actions = [{ label: t('inputHandoff.action.stay'), onClick: () => void decide('stay') }, handBack];
  } else {
    spinner = true;
    status = t(snapshot.phase === 'working' ? 'inputHandoff.phase.working' : 'inputHandoff.phase.reading');
    actions = [skip];
  }

  const place = inputHandoffPlace(snapshot.source);
  const Icon = inputHandoffIcon(snapshot);
  const dialogOpen = dialogWanted && dialogContent;
  return (
    <section
      aria-label={snapshot.purpose}
      data-testid="input-handoff-strip"
      className={cn(
        'w-full max-w-[914px] rounded-[12px] border px-3 py-2.5',
        'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-[var(--surface-chip)] text-[var(--text-primary)]">
          <Icon size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-14 font-medium leading-snug">{snapshot.purpose}</p>
          <InputHandoffPlace label={place.label} secure={place.secure} />
        </div>
        {actions.length > 0 && (
          <div className="flex shrink-0 items-center gap-2">
            {actions.map((action) =>
              action.element ? (
                <Fragment key={action.label}>{action.element}</Fragment>
              ) : (
                <Button
                  key={action.label}
                  size="sm"
                  variant={action.primary ? 'primary' : 'secondary'}
                  tone={action.primary ? 'default' : 'quiet'}
                  disabled={busy}
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ),
            )}
          </div>
        )}
      </div>
      {status && (
        <div className="mt-2 flex items-center gap-2 pl-12 text-13 text-[var(--text-secondary)]" role="status">
          {spinner && <Spinner size={14} />}
          <span className="min-w-0 [overflow-wrap:anywhere]">{status}</span>
        </div>
      )}
      {error && !dialogOpen && (
        <p role="alert" className="mt-2 pl-12 text-12 text-[var(--error-fg)]">
          {error}
        </p>
      )}
      {directSignIn && canUseForm && snapshot.directSignIn === true && (
        <div className="mt-1 pl-12">
          <QuietLink onClick={() => setFormFor(snapshot.requestId)}>{t('inputHandoff.action.useForm')}</QuietLink>
        </div>
      )}
      {liveView && !dialogContent && !directSignIn && (
        <div className="mt-1 pl-12">
          <LiveViewLink deviceId={liveView} requestId={snapshot.requestId} />
        </div>
      )}
      {dialogContent && (
        <InputHandoffStepDialog
          open={dialogOpen}
          sessionId={sessionId}
          snapshot={snapshot}
          busy={busy}
          inputBlocked={inputBlocked}
          error={error}
          liveView={liveView}
          onError={setError}
          onDecide={(action) => void decide(action)}
          onSubmit={submit}
          onStart={claimQuietly}
          onClose={() => setDialogWanted(false)}
        />
      )}
    </section>
  );
}

function InputHandoffStepDialog({
  open,
  sessionId,
  snapshot,
  busy,
  inputBlocked,
  error,
  liveView,
  onError,
  onDecide,
  onSubmit,
  onStart,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  snapshot: InputHandoffSnapshot;
  busy: boolean;
  inputBlocked: boolean;
  error: string | null;
  /** The computer running the task, when it offers a live view of the window. */
  liveView: string | null;
  onError: (message: string | null) => void;
  onDecide: (action: Decision) => void;
  onSubmit: (draft: InputHandoffValues, action: InputHandoffAction) => Promise<boolean>;
  onStart: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const mode = inputHandoffDialogMode(snapshot);
  const formId = `input-handoff-${snapshot.requestId}`;
  // One picture or code per revision: remount so it is fetched afresh, and never claim
  // quietly there (that bumps the revision).
  const revisionKey = `${snapshot.requestId}:${snapshot.revision}`;
  let body: ReactNode;
  let footer: ReactNode = null;
  if (mode === 'qr') {
    body = (
      <InputHandoffQrStep
        key={revisionKey}
        sessionId={sessionId}
        snapshot={snapshot}
        busy={busy}
        inputBlocked={inputBlocked}
        onError={onError}
      />
    );
    // Cindy cannot see the agent's screen, so the owner says when the scan is done.
    if (snapshot.agentPicture) {
      footer = (
        <div className="flex flex-col gap-2">
          <Button size="lg" variant="cta" palette="confirmation" disabled={busy} onClick={() => onDecide('done')}>
            {t('inputHandoff.action.done')}
          </Button>
          <Button size="lg" variant="secondary" palette="confirmation" onClick={onClose}>
            {t('inputHandoff.action.close')}
          </Button>
        </div>
      );
    }
  } else if (mode === 'picture') {
    body = (
      <InputHandoffPictureStep
        key={revisionKey}
        sessionId={sessionId}
        snapshot={snapshot}
        busy={busy}
        inputBlocked={inputBlocked}
        onDecide={onDecide}
        onError={onError}
      />
    );
  } else {
    body = (
      <>
        <InputHandoffDeviceCode snapshot={snapshot} />
        {mode === 'fields' && (
          <InputHandoffStepForm
            key={inputHandoffStepKey(snapshot)}
            formId={formId}
            snapshot={snapshot}
            busy={busy}
            inputBlocked={inputBlocked}
            onSubmit={onSubmit}
            onStart={onStart}
          />
        )}
      </>
    );
    footer = (
      <div className="flex flex-col gap-2">
        <p className="text-center text-12 leading-relaxed text-[var(--text-tertiary)]">
          {t('inputHandoff.dialogNote')}
        </p>
        {mode === 'code' ? (
          <Button size="lg" variant="cta" palette="confirmation" disabled={busy} onClick={() => onDecide('done')}>
            {t('inputHandoff.action.done')}
          </Button>
        ) : (
          <Button
            type="submit"
            form={formId}
            size="lg"
            variant="cta"
            palette="confirmation"
            loading={busy}
            disabled={busy || inputBlocked}
            {...{ [CONTINUE_ATTR]: '' }}
          >
            {t('inputHandoff.action.continue')}
          </Button>
        )}
        <Button size="lg" variant="secondary" palette="confirmation" onClick={onClose}>
          {t('inputHandoff.action.close')}
        </Button>
      </div>
    );
  }
  // A terminal prompt has no screen to look at; a picture step already is one, except a QR code cut out of it.
  const canPicture = !snapshot.command && mode !== 'picture' && !snapshot.agentPicture;
  const links =
    canPicture || liveView ? (
      <>
        {canPicture && (
          <QuietLink disabled={busy} onClick={() => onDecide('picture')}>
            {t('inputHandoff.action.picture')}
          </QuietLink>
        )}
        {liveView && <LiveViewLink deviceId={liveView} requestId={snapshot.requestId} />}
      </>
    ) : null;
  return (
    <InputHandoffDialog
      open={open}
      snapshot={snapshot}
      inputBlocked={inputBlocked}
      error={error}
      footer={footer}
      links={links}
      onClose={onClose}
    >
      {body}
    </InputHandoffDialog>
  );
}

function QuietLink({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-8 text-12 text-[var(--text-tertiary)] transition-colors enabled:hover:text-[var(--text-secondary)] disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/**
 * The host offers a live view of just the target window (remote desktop is on
 * there). Navigation only: the host picks the window from the request id and
 * keeps input inside it; this device never names a window.
 */
function liveViewDevice(sessionId: string, snapshot: InputHandoffSnapshot): string | null {
  const deviceId = getStickySessionDeviceId(sessionId);
  return deviceId && snapshot.liveView && !snapshot.terminal ? deviceId : null;
}

function useLiveViewOpener(deviceId: string | null, requestId: string): () => void {
  const { t } = useTranslation();
  const devices = useDeviceLinkDeviceList();
  return () => {
    if (!deviceId) return;
    const name = deviceDisplayName(deviceId, undefined, devices ?? []);
    void window.electronAPI
      .openRemoteDesktop({ deviceId, name, handoff: requestId })
      .catch(() => toast.error(t('remoteDesktop.connectionError')));
  };
}

function LiveViewButton({
  deviceId,
  requestId,
  onBeforeOpen,
}: {
  deviceId: string;
  requestId: string;
  onBeforeOpen: () => void;
}) {
  const { t } = useTranslation();
  const open = useLiveViewOpener(deviceId, requestId);
  return (
    <Button
      size="sm"
      variant="primary"
      tone="default"
      onClick={() => {
        onBeforeOpen();
        open();
      }}
    >
      {t('inputHandoff.action.openRemoteDesktop')}
    </Button>
  );
}

function LiveViewLink({ deviceId, requestId }: { deviceId: string; requestId: string }) {
  const { t } = useTranslation();
  const open = useLiveViewOpener(deviceId, requestId);
  return <QuietLink onClick={open}>{t('inputHandoff.action.liveView')}</QuietLink>;
}

function holderLabel(snapshot: InputHandoffSnapshot, t: (key: string) => string): string {
  const holder = snapshot.holder;
  if (holder?.local) return t('inputHandoff.holder.host');
  if (holder?.name) return holder.name;
  return t(
    holder?.platform === 'mobile' ? 'inputHandoff.holder.phone' : 'inputHandoff.holder.otherDevice',
  );
}

function FinishingCountdown({ until }: { until?: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [until]);
  const seconds = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return (
    <>
      {until
        ? t('inputHandoff.phase.finishing', { count: seconds })
        : t('inputHandoff.phase.finishingNow')}
    </>
  );
}
