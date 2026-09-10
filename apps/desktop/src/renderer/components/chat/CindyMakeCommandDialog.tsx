import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CindyMakeDoctorCard } from './CindyMakeDoctorCard';
import { makerChatStore } from '@/lib/makerChatStore';
import { cancelMakeDoctor } from '@/lib/cindyMakeDoctor';
import { toast } from '@/lib/toast';

/** The slash command owns a transient modal card instead of a chat message. */
export function CindyMakeCommandDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? makerChatStore.subscribe(sessionId, listener) : () => {},
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? makerChatStore.getSnapshot(sessionId) : null),
    [sessionId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const card = useMemo(
    () =>
      snapshot?.messages.find(
        (message) =>
          message.systemCardData?.modalOnly === true &&
          (message.systemCardType === 'cindy-make' ||
            message.systemCardType === 'cindy-make-doctor'),
      ),
    [snapshot],
  );

  const close = useCallback(() => {
    if (sessionId && card) {
      const report = card.systemCardData?.report as
        { runId?: string; mode?: 'check' | 'prepare'; status?: string } | undefined;
      if (report?.runId && report.status === 'running') {
        void cancelMakeDoctor(report.runId, report.mode).catch(() =>
          toast.error(t('cindyMakeDoctor.failed')),
        );
      }
      makerChatStore.removeMessageByClientId(sessionId, card.clientId);
    }
    onOpenChange(false);
  }, [card, onOpenChange, sessionId, t]);

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="cindy-make-dialog-overlay"
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
        />
        <Dialog.Content
          ref={contentRef}
          tabIndex={-1}
          className="fixed left-1/2 top-1/2 z-[10001] max-h-[min(88vh,760px)] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] shadow-xl outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
            <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
              {t('cindyMake.title')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                aria-label={t('common.dismiss')}
              >
                <X size={16} aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t('cindyMake.description')}</Dialog.Description>
          <div className="p-4">
            {card ? (
              <CindyMakeDoctorCard
                data={card.systemCardData}
                sessionId={sessionId ?? undefined}
                onDismiss={close}
              />
            ) : (
              <div className="py-8 text-center text-13 text-[var(--text-secondary)]">
                {t('cindyMakeDoctor.running')}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
