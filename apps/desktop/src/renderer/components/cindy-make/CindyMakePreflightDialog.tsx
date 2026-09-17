import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { MakeDoctorReportCard } from '@/components/chat/CindyMakeDoctorCard';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { startMakeDoctor, cancelMakeDoctor } from '@/lib/cindyMakeDoctor';
import { toast } from '@/lib/toast';
import type { CindyMakeTaskOptions, MakeDoctorReport } from '../../../shared/cindyMakeDoctor';

export interface CindyMakePreflightProps {
  request: string;
  sessionId?: string;
  createOptions?: CindyMakeTaskOptions;
  onOpenChange: (open: boolean) => void;
}

/** Checks belong to this dialog; only Continue creates a persistent task. */
export function CindyMakePreflightDialog({
  request,
  sessionId,
  createOptions,
  onOpenChange,
}: CindyMakePreflightProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [report, setReport] = useState<MakeDoctorReport>();
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const owner = useRef(getDataOwnerGeneration());
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const current = () =>
    mounted.current &&
    isDataOwnerGenerationCurrent(owner.current) &&
    !getStickySessionDeviceId(sessionId);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let latest: MakeDoctorReport | undefined;
    // StrictMode rehearses effect cleanup before the real mount. Do not dispatch
    // a run from that discarded effect and immediately cancel the shared checks.
    queueMicrotask(() => {
      if (
        controller.signal.aborted ||
        !isDataOwnerGenerationCurrent(owner.current) ||
        getStickySessionDeviceId(sessionId)
      )
        return;
      startMakeDoctor(
        (next) => {
          latest = next;
          setReport(next);
        },
        undefined,
        'cindy-make',
        { request, signal: controller.signal },
      );
    });
    return () => {
      mounted.current = false;
      controller.abort();
      if (latest?.status === 'running' && isDataOwnerGenerationCurrent(owner.current))
        void cancelMakeDoctor(latest.runId, latest.mode).catch(() => {});
    };
  }, [request, sessionId, attempt]);

  const start = async () => {
    if (
      !current() ||
      submitting.current ||
      report?.status !== 'completed' ||
      !['found', 'notFound'].includes(report.upstream?.status ?? '')
    )
      return;
    submitting.current = true;
    setStarting(true);
    setFailed(false);
    try {
      const chars = Array.from(request.replace(/\s+/gu, ' ').trim());
      const createdId = await window.electronAPI.startCindyMakeTask({
        originSessionId: sessionId,
        runId: report.runId,
        request,
        title: t('cindyMake.code.taskTitle', {
          request: chars.slice(0, 60).join('') + (chars.length > 60 ? '…' : ''),
        }),
        createOptions,
      });
      if (!isDataOwnerGenerationCurrent(owner.current)) return;
      const [{ makerChatStore }, sessionService, { sessionsStore }] = await Promise.all([
        import('@/lib/makerChatStore'),
        import('@/lib/sessionService'),
        import('@/lib/sessionsStore'),
      ]);
      if (!isDataOwnerGenerationCurrent(owner.current)) return;
      makerChatStore.setSessionRuntime(createdId, { autoTitleDisabled: true });
      const session = await sessionService.get(createdId).catch(() => null);
      if (!isDataOwnerGenerationCurrent(owner.current)) return;
      if (session) sessionsStore.prependCreated(session);
      if (current()) {
        onOpenChange(false);
        navigate('/cc-agent/' + createdId);
      }
    } catch {
      if (current()) setFailed(true);
    } finally {
      submitting.current = false;
      if (mounted.current) setStarting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !submitting.current && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          ref={contentRef}
          tabIndex={-1}
          className="fixed left-1/2 top-1/2 z-[10001] flex max-h-[85vh] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl bg-[var(--confirm-bg)] p-4 shadow-[var(--confirm-shadow)] outline-none"
          onOpenAutoFocus={(event) => {
            // The report and Continue action arrive asynchronously. Start at the
            // readable content instead of making Cancel the initial action.
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.isConnected && returnFocus.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (submitting.current || event.isComposing || event.keyCode === 229)
              event.preventDefault();
          }}
        >
          <Dialog.Title className="text-16 font-medium text-[var(--confirm-title)]">
            {t('cindyMake.title')}
          </Dialog.Title>
          <Dialog.Description className="whitespace-pre-wrap break-words text-13 text-[var(--confirm-desc)]">
            {request}
          </Dialog.Description>
          {report && (
            <MakeDoctorReportCard
              report={report}
              request={request}
              startingCode={starting}
              onChoose={(choice) => {
                if (submitting.current) return;
                if (choice === 'wait') onOpenChange(false);
                else void start();
              }}
              onRecheck={() => {
                if (!submitting.current && current()) {
                  setFailed(false);
                  setAttempt((value) => value + 1);
                }
              }}
              onStop={() => {
                if (current())
                  void cancelMakeDoctor(report.runId, report.mode).catch(() =>
                    toast.error(t('cindyMakeDoctor.failed')),
                  );
              }}
            />
          )}
          {failed && (
            <p role="alert" className="text-13 text-[var(--error-fg)]">
              {t('cindyMake.code.preparationFailed')}
            </p>
          )}
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary" disabled={starting}>
                {t('settings.cindyMake.create.cancel')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
