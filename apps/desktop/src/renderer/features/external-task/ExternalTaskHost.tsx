import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { useComposerDraftPresence } from '@/hooks/useComposerDraftPresence';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import {
  acceptExternalTaskDraft,
  clearExternalTasks,
  dismissExternalTask,
  getExternalTask,
  subscribeExternalTasks,
} from './externalTaskHandoff';

export function ExternalTaskHost() {
  const entry = useSyncExternalStore(subscribeExternalTasks, getExternalTask);
  useEffect(() => () => clearExternalTasks(), []);
  return entry ? (
    <ExternalTaskDialog
      key={entry.payload.type === 'external-task' ? entry.payload.request.id : 'invalid'}
      entry={entry}
    />
  ) : null;
}

function ExternalTaskDialog({ entry }: { entry: NonNullable<ReturnType<typeof getExternalTask>> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const request = entry.payload.type === 'external-task' ? entry.payload.request : null;
  const [question, setQuestion] = useState(request?.question ?? '');
  const [expired, setExpired] = useState(!!request && request.expires <= Date.now());
  const [failed, setFailed] = useState(false);
  const occupied = useComposerDraftPresence(NEW_MAKER_DRAFT_KEY);
  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, request.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [request]);
  const close = () => dismissExternalTask(entry);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
        <Dialog.Content
          className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(480px,calc(100vw-32px))] flex-col gap-4 overflow-y-auto p-4 outline-none"
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
            {t('externalTask.title')}
          </Dialog.Title>
          <Dialog.Description className="text-13 leading-normal text-[var(--confirm-desc)]">
            {t('externalTask.description')}
          </Dialog.Description>
          {request ? (
            <>
              {request.source && (
                <p className="break-words text-13 text-[var(--text-secondary)]">
                  {t('externalTask.source', { source: request.source })}
                </p>
              )}
              <label className="flex flex-col gap-2 text-13 text-[var(--text-primary)]">
                {t('externalTask.question')}
                <Textarea
                  value={question}
                  readOnly={expired}
                  maxLength={4096}
                  onChange={setQuestion}
                  className="min-h-28 resize-y"
                />
              </label>
              {request.context && (
                <details className="text-13 text-[var(--text-secondary)]">
                  <summary className="cursor-pointer py-2">{t('externalTask.context')}</summary>
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-12">
                    {request.context}
                  </pre>
                </details>
              )}
              {occupied && (
                <p role="status" className="text-13 text-[var(--text-secondary)]">
                  {t('externalTask.occupied')}
                </p>
              )}
              {expired && (
                <p role="alert" className="text-13 text-[var(--error-fg)]">
                  {t('externalTask.invalid')}
                </p>
              )}
              {failed && (
                <p role="alert" className="text-13 text-[var(--error-fg)]">
                  {t('externalTask.failed')}
                </p>
              )}
            </>
          ) : (
            <p role="alert" className="text-13 text-[var(--error-fg)]">
              {t('externalTask.invalid')}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {t('externalTask.cancel')}
            </Button>
            {request && !expired && (
              <Button
                disabled={occupied || !question.trim()}
                onClick={() => {
                  if (
                    acceptExternalTaskDraft(
                      entry,
                      question,
                      t('externalTask.context'),
                      request?.source
                        ? t('externalTask.source', { source: request.source })
                        : undefined,
                    )
                  ) {
                    navigate('/cc-agent/new');
                  } else setFailed(true);
                }}
              >
                {t('externalTask.openDraft')}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
