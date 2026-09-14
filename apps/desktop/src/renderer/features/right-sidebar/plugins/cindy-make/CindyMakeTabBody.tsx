import { FormEvent, useCallback, useEffect, useSyncExternalStore, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { MessageStream } from '@/components/chat/MessageStream';
import { makerChatStore } from '@/lib/makerChatStore';
import { startMakeDoctorInStream } from '@/lib/cindyMakeDoctorStream';
import type { TabKindBodyProps } from '../../types';
import type { CindyMakeState } from './index';

function useCindyMakeChat(sessionId: string) {
  return useSyncExternalStore(
    (onChange) => makerChatStore.subscribe(sessionId, onChange),
    () => makerChatStore.getSnapshot(sessionId),
    () => makerChatStore.getSnapshot(sessionId),
  );
}

export function CindyMakeTabBody({ ctx }: TabKindBodyProps<CindyMakeState>) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const chat = useCindyMakeChat(ctx.sessionId);

  useEffect(() => {
    makerChatStore.ensureInitialMessages(ctx.sessionId);
  }, [ctx.sessionId]);

  const send = useCallback(() => {
    const request = draft.trim();
    if (!request || !ctx.workdir || chat.isStreaming) return;
    startMakeDoctorInStream(ctx.sessionId, { command: 'cindy-make', request });
    setDraft('');
  }, [chat.isStreaming, ctx.sessionId, ctx.workdir, draft]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-base)]">
      <div className="min-h-0 flex-1">
        {chat.messages.length === 0 && (
          <div className="border-b border-[var(--border-default)] px-4 py-3 text-13 text-[var(--text-secondary)]">
            {t('cindyMake.description')}
          </div>
        )}
        <MessageStream
          key={ctx.sessionId}
          sessionId={ctx.sessionId}
          workingDir={ctx.workdir}
          messages={chat.messages}
          historyLoaded={chat.historyLoaded}
          isSessionStreaming={chat.isStreaming}
          onLoadMore={(automatic) => makerChatStore.loadOlderMessages(ctx.sessionId, automatic)}
          isLoadingMore={chat.isLoadingMore}
          hasMoreMessages={chat.hasMoreMessages}
          historyWindowHasIsland={chat.historyWindowIslands.length > 0}
          ownsHardwareScrollActions={false}
        />
      </div>
      <form
        className="shrink-0 border-t border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
        onSubmit={onSubmit}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              send();
            }
          }}
          rows={3}
          disabled={!ctx.workdir || chat.isStreaming}
          placeholder={t('cindyMake.usage')}
          className="w-full resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-base)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        />
        <div className="mt-2 flex justify-end">
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!draft.trim() || !ctx.workdir || chat.isStreaming}
          >
            {t('settings.cindyMake.source.prepare')}
          </Button>
        </div>
      </form>
    </div>
  );
}
