import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { DownloadMeter } from '@/components/settings/DownloadMeter';
import type { GithubSetupState } from '../../../shared/githubSetup';

const isRunning = (phase: GithubSetupState['phase']) =>
  ['checking', 'downloading', 'installing', 'authorizing'].includes(phase);

export function GithubSetupDialog({
  onClose,
  onConnected,
  initialAction = 'login',
}: {
  onClose(): void;
  onConnected?(): void;
  initialAction?: 'install' | 'login';
}) {
  const { t } = useTranslation();
  // The badge changes during setup; keep the original entry reason.
  const [entryAction] = useState(initialAction);
  const [state, setState] = useState<GithubSetupState>({ phase: 'idle' });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string>();
  const [feedback, setFeedback] = useState<'copyFailed' | 'openFailed'>();
  const [opening, setOpening] = useState(false);
  const tracking = useRef(false);
  const notified = useRef(false);
  useEffect(() => {
    if (state.phase === 'connected' && !notified.current) {
      notified.current = true;
      onConnected?.();
    }
  }, [state.phase, onConnected]);
  const key = 'ccAgent.gitContext.pr.setup';
  const copy = (name: string) => t(key + '.' + name);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.electronAPI.gitContext.githubSetupStatus();
        if (stopped) return;
        if (isRunning(next.phase)) tracking.current = true;
        // A previous run's terminal state does not validate a new attempt.
        if (tracking.current) setState(next);
        if (tracking.current && next.phase !== 'idle') setFailed(false);
        if (isRunning(next.phase)) timer = setTimeout(() => void poll(), 750);
      } catch {
        if (!stopped) {
          setFailed(true);
          timer = setTimeout(() => void poll(), 750);
        }
      }
    };
    if (!pending) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);

  const start = async () => {
    tracking.current = true;
    setPending(true);
    setFailed(false);
    setFeedback(undefined);
    setCopiedCode(undefined);
    setState({ phase: 'checking' });
    try {
      setState(await window.electronAPI.gitContext.startGithubSetup());
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const active = isRunning(state.phase);
  const dismiss = async () => {
    if (pending) return;
    if (!active) {
      onClose();
      return;
    }
    setPending(true);
    try {
      await window.electronAPI.gitContext.cancelGithubSetup();
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const copyCode = async () => {
    if (!state.userCode) return;
    try {
      await navigator.clipboard.writeText(state.userCode);
      setCopiedCode(state.userCode);
      setFeedback(undefined);
    } catch {
      setFeedback('copyFailed');
    }
  };
  const openBrowser = async () => {
    setOpening(true);
    try {
      const result = await window.electronAPI.openExternal('https://github.com/login/device');
      setFeedback(result.success ? undefined : 'openFailed');
    } catch {
      setFeedback('openFailed');
    } finally {
      setOpening(false);
    }
  };

  const stage = failed
    ? 'unavailable'
    : state.phase === 'idle'
      ? entryAction
      : state.phase === 'authorizing' && !state.userCode
        ? 'preparing'
        : state.phase;
  const description =
    stage === 'error'
      ? copy('errors.' + (state.error ?? 'login'))
      : copy('stages.' + stage + '.description');
  const readyToAuthorize = stage === 'authorizing' && Boolean(state.userCode);
  const completed = stage === 'connected';
  const retry = ['error', 'cancelled', 'unavailable'].includes(stage);
  const unsupported = stage === 'error' && state.error === 'unsupported';
  const copyLabel = copy(copiedCode === state.userCode ? 'copied' : 'copyCode');

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[10001] flex max-h-[85vh] w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl bg-[var(--confirm-bg)] p-4 shadow-[var(--confirm-shadow)] outline-none"
        >
          <div className="flex items-center gap-2" aria-live="polite">
            {completed ? (
              <Check size={18} className="text-[var(--confirm-title)]" aria-hidden="true" />
            ) : (
              active &&
              !readyToAuthorize &&
              !failed && <Spinner size={16} className="text-[var(--confirm-desc)]" />
            )}
            <Dialog.Title className="text-16 font-medium text-[var(--confirm-title)]">
              {copy('stages.' + stage + '.title')}
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-13 leading-relaxed text-[var(--confirm-desc)]">
            {description}
          </Dialog.Description>
          {stage === 'downloading' && (
            <DownloadMeter progress={{ label: 'GitHub CLI', percent: state.percent }} />
          )}
          {readyToAuthorize && (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg bg-[var(--surface-chip)] px-4 py-3">
                <div className="mb-2 text-12 text-[var(--text-secondary)]">
                  {copy('deviceCode')}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <code className="select-all whitespace-nowrap font-mono text-18 tracking-widest text-[var(--text-primary)]">
                    {state.userCode}
                  </code>
                  <Tip text={copyLabel} contentClassName="z-[10002]">
                    <button
                      type="button"
                      onClick={() => void copyCode()}
                      aria-label={copyLabel}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                    >
                      {copiedCode === state.userCode ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </Tip>
                </div>
              </div>
              <span className="select-text text-12 text-[var(--text-tertiary)]">
                github.com/login/device
              </span>
            </div>
          )}
          {feedback && (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {copy(feedback)}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            {completed || unsupported ? (
              <Button palette="confirmation" onClick={onClose}>
                {copy('done')}
              </Button>
            ) : (
              <>
                <Button
                  palette="confirmation"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void dismiss()}
                >
                  {copy('cancel')}
                </Button>
                {readyToAuthorize ? (
                  <Button
                    palette="confirmation"
                    disabled={opening || pending}
                    onClick={() => void openBrowser()}
                  >
                    {copy('openBrowser')}
                  </Button>
                ) : (
                  (!active || failed) && (
                    <Button palette="confirmation" disabled={pending} onClick={() => void start()}>
                      {copy(retry ? 'retry' : entryAction === 'install' ? 'install' : 'connect')}
                    </Button>
                  )
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
