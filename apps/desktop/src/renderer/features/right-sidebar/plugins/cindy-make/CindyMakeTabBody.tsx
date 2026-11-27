import { FormEvent, useCallback, useEffect, useRef, useSyncExternalStore, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { MessageStream } from '@/components/chat/MessageStream';
import { makerChatStore } from '@/lib/makerChatStore';
import { CindyMakePreflightDialog } from '@/components/cindy-make/CindyMakePreflightDialog';
import { FieldVoiceInputNotice } from '@/voice-input/FieldVoiceInputNotice';
import { useFieldVoiceInput } from '@/voice-input/useFieldVoiceInput';
import { VoiceInputButton } from '@/voice-input/VoiceInputButton';
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
  const [request, setRequest] = useState<string | null>(null);
  const [stoppingVoice, setStoppingVoice] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submittingVoiceRef = useRef(false);
  const chat = useCindyMakeChat(ctx.sessionId);

  const voice = useFieldVoiceInput({
    draftKey: `cindy-make-tab:${ctx.sessionId}`,
    inputRef: textareaRef,
    value: draft,
    onChange: (next) => setDraft(next),
    disabled: !ctx.workdir || chat.isStreaming,
  });

  useEffect(() => {
    makerChatStore.ensureInitialMessages(ctx.sessionId);
  }, [ctx.sessionId]);

  const send = useCallback(async () => {
    if (!ctx.workdir || chat.isStreaming || submittingVoiceRef.current) return;
    let nextDraft = draft;
    if (voice.isBusy) {
      submittingVoiceRef.current = true;
      setStoppingVoice(true);
      try {
        const stoppedDraft = await voice.stop();
        if (stoppedDraft === null) return;
        nextDraft = stoppedDraft;
      } finally {
        submittingVoiceRef.current = false;
        setStoppingVoice(false);
      }
    }
    const nextRequest = nextDraft.trim();
    if (!nextRequest) return;
    setRequest(nextRequest);
    setDraft('');
  }, [chat.isStreaming, ctx.workdir, draft, voice.isBusy, voice.stop]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };

  return (
    <div className="app-wallpaper-surface flex h-full min-h-0 flex-col bg-[var(--surface)]">
      {request && (
        <CindyMakePreflightDialog
          key={ctx.sessionId}
          request={request}
          sessionId={ctx.sessionId}
          onOpenChange={(open) => !open && setRequest(null)}
        />
      )}
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
          // 宿主给出的执行端：本地-only 能力(如嵌入媒体的任务目录搜索)只在已确认本机时开启。
          remoteHostId={ctx.remoteHostId}
          ownerDeviceId={ctx.deviceLinkDeviceId}
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
        <div className="flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]">
          <textarea
            ref={textareaRef}
            value={voice.displayText}
            readOnly={voice.isBusy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void send();
              }
            }}
            rows={3}
            disabled={!ctx.workdir || chat.isStreaming}
            placeholder={t('cindyMake.usage')}
            className="w-full resize-none bg-transparent px-3 pt-2 pb-1 text-13 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none"
          />
          <div className="flex items-center justify-end px-2 pb-2 pt-1">
            <VoiceInputButton {...voice.buttonProps} testId="cindy-make-tab-voice" tipSide="top" />
          </div>
        </div>
        <FieldVoiceInputNotice error={voice.lastError} speakerFiltered={voice.speakerFiltered} className="mt-1.5" />
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={stoppingVoice}
            disabled={!voice.displayText.trim() || !ctx.workdir || chat.isStreaming || stoppingVoice}
          >
            {t('settings.cindyMake.source.prepare')}
          </Button>
        </div>
      </form>
    </div>
  );
}
