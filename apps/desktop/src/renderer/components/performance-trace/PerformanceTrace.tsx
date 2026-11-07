import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle2, FolderOpen, Monitor, RotateCcw, Square } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { installPerformanceTraceProbe } from '@/lib/performanceTraceProbe';
import { extractIpcError } from '@/utils/ipcError';
import type {
  PerformanceTraceCommand,
  PerformanceTraceState,
} from '../../../shared/performanceTrace';

const OPEN_EVENT = 'cindy-open-performance-trace';
export function openPerformanceTrace(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}
const INITIAL: PerformanceTraceState = {
  phase: 'idle',
  startedAt: null,
  reportId: null,
  uploaded: false,
  partial: false,
  durationMs: 0,
};

export function PerformanceTrace({
  statusContainer,
}: { statusContainer?: HTMLElement | null } = {}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState(INITIAL);
  const [view, setView] = useState<'start' | 'result' | 'previous'>('start');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const cleanupProbe = useRef<(() => void) | null>(null);
  const noteId = useId();
  useEffect(() => {
    const api = window.electronAPI.performanceTrace;
    if (!api) return;
    let live = true;
    let pushed = false;
    const unsubscribe = api.onState((next) => {
      pushed = true;
      setState(next);
      if (next.phase === 'ready') {
        setView((current) => (current === 'previous' ? current : 'result'));
        setOpen(true);
      }
      if (next.phase === 'idle') {
        setView('start');
        setNote('');
        setError('');
        setOpen(false);
      }
    });
    void api
      .command('state')
      .then((next) => {
        if (live && !pushed) setState(next);
      })
      .catch(() => {});
    const show = () => {
      if (busyRef.current) return;
      setView('start');
      setError('');
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);
  useEffect(() => {
    if (state.phase !== 'recording') return;
    const cleanup = installPerformanceTraceProbe((events) =>
      window.electronAPI.performanceTrace.events(events),
    );
    cleanupProbe.current = cleanup;
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - (state.startedAt ?? Date.now())) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
      if (cleanupProbe.current === cleanup) {
        cleanupProbe.current = null;
        cleanup();
      }
    };
  }, [state.phase, state.startedAt]);
  const run = async (command: PerformanceTraceCommand) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    if (command === 'stop') {
      cleanupProbe.current?.();
      cleanupProbe.current = null;
    }
    try {
      const next = await window.electronAPI.performanceTrace.command(
        command,
        command === 'upload' ? note : undefined,
      );
      setState(next);
      if (command === 'start') {
        setView('start');
        setNote('');
        setOpen(false);
      } else if (command === 'stop' || command === 'upload') {
        setView((current) => (current === 'previous' ? current : 'result'));
        setOpen(true);
      }
    } catch (cause) {
      const code = extractIpcError(cause)?.code;
      setError(
        t(
          code === 'LOG_UPLOAD_UNAVAILABLE'
            ? 'performanceTrace.unavailable'
            : code === 'PRIVACY_CONSENT_REQUIRED'
              ? 'performanceTrace.consent'
              : 'performanceTrace.failed',
        ),
      );
      setOpen(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const recording = state.phase === 'recording';
  const pending = busy || ['starting', 'saving', 'uploading'].includes(state.phase);
  const ready = view !== 'start' && ['ready', 'uploading'].includes(state.phase);
  const previousSummary =
    state.startedAt === null
      ? ''
      : t('performanceTrace.previousSummary', {
          time: new Date(state.startedAt).toLocaleString(i18n.resolvedLanguage, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
          seconds: Math.round(state.durationMs / 1000),
        });
  const status = (recording || state.phase === 'saving') && (
    <div
      data-testid="performance-trace-status"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-2 text-13 text-foreground"
      style={{
        ...WINDOW_NO_DRAG_STYLE,
        paddingRight: 'calc(1rem + var(--content-top-right-actions-inset, 0px))',
        paddingLeft: 'calc(1rem + var(--content-top-left-actions-inset, 0px))',
      }}
    >
      <span role="status" className="flex items-center gap-2 tabular-nums">
        <Activity size={16} aria-hidden className="shrink-0 text-muted-foreground" />
        {t(state.phase === 'saving' ? 'performanceTrace.saving' : 'performanceTrace.recording', {
          seconds: elapsed,
        })}
      </span>
      {recording && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => void run('stop')}>
          <Square size={12} aria-hidden />
          {t('performanceTrace.stop')}
        </Button>
      )}
    </div>
  );
  return (
    <>
      {statusContainer === undefined
        ? status
        : statusContainer && status
          ? createPortal(status, statusContainer)
          : null}
      <ConfirmDialog
        presentation="standard"
        cancelFirst
        maxWidth={460}
        contentSelectable
        descriptionClassName="text-13 leading-relaxed"
        open={open}
        onOpenChange={(next) => {
          if (!pending && !busyRef.current) setOpen(next);
        }}
        title={t(
          ready
            ? view === 'previous'
              ? 'performanceTrace.previousResult'
              : 'performanceTrace.result'
            : 'performanceTrace.title',
        )}
        description={ready ? undefined : t('performanceTrace.description')}
        content={
          <div className="space-y-4 text-13 leading-relaxed text-foreground">
            {!ready && (
              <div className="space-y-2 text-muted-foreground">
                <p className="flex items-start gap-2">
                  <Monitor size={16} aria-hidden className="mt-0.5 shrink-0" />
                  {t('performanceTrace.localScope')}
                </p>
                {state.phase === 'idle' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    tone="quiet"
                    disabled={pending}
                    onClick={() => void run('show-local')}
                  >
                    <FolderOpen size={14} aria-hidden />
                    {t('performanceTrace.keepLocal')}
                  </Button>
                )}
              </div>
            )}
            {!ready && state.phase === 'ready' && (
              <div className="space-y-2 border-t border-border pt-3 text-muted-foreground">
                <p>{previousSummary}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  tone="quiet"
                  disabled={pending}
                  onClick={() => setView('previous')}
                >
                  {t('performanceTrace.previous')}
                </Button>
              </div>
            )}
            {ready && (
              <>
                {view === 'previous' && <p className="text-muted-foreground">{previousSummary}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2
                      size={18}
                      aria-hidden
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="font-medium">
                      {t('performanceTrace.summary', {
                        seconds: Math.round(state.durationMs / 1000),
                      })}
                    </span>
                  </div>
                  {!state.uploaded && (
                    <Button
                      size="sm"
                      variant="secondary"
                      tone="quiet"
                      disabled={pending}
                      onClick={() => void run('start')}
                    >
                      <RotateCcw size={14} aria-hidden />
                      {t('performanceTrace.new')}
                    </Button>
                  )}
                </div>
                {state.partial && <p role="status">{t('performanceTrace.partial')}</p>}
                {state.uploaded ? (
                  <p role="status">{t('performanceTrace.uploaded', { id: state.reportId })}</p>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="block font-medium" htmlFor={noteId}>
                        {t('performanceTrace.note')}
                      </label>
                      <textarea
                        id={noteId}
                        rows={4}
                        maxLength={1000}
                        value={note}
                        disabled={pending}
                        onChange={(event) => setNote(event.target.value)}
                        className="block w-full resize-y rounded-lg border border-input bg-background p-3 text-13 leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    </div>
                  </>
                )}
                <div className="space-y-2 text-muted-foreground">
                  <p>{t('performanceTrace.resultDescription')}</p>
                  <p>{t('performanceTrace.localScope')}</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    tone="quiet"
                    disabled={pending}
                    onClick={() => void run('show-local')}
                  >
                    <FolderOpen size={14} aria-hidden />
                    {t('performanceTrace.keepLocal')}
                  </Button>
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="border-t border-border pt-3 text-destructive">
                {error}
              </p>
            )}
          </div>
        }
        confirmText={t(
          ready
            ? state.uploaded
              ? 'performanceTrace.new'
              : 'performanceTrace.submit'
            : recording
              ? 'performanceTrace.stop'
              : 'performanceTrace.start',
        )}
        onConfirm={() =>
          void run(ready ? (state.uploaded ? 'start' : 'upload') : recording ? 'stop' : 'start')
        }
        cancelText={t('performanceTrace.close')}
        onCancel={() => setOpen(false)}
        loading={pending}
      />
    </>
  );
}
