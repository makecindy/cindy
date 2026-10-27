import { useRef, useState } from 'react';
import { mountPage, forbid } from '../../ui-page/harness';
import { CompanionVoiceToolbar } from '../../../src/renderer/features/bots/voice/CompanionVoiceToolbar';
import {
  visibleVoiceCallMessages,
  VoiceCallCard,
  VoiceCallTaskEntry,
} from '../../../src/renderer/features/bots/voice/VoiceCallTranscript';
import type { VoiceCallRecord } from '@cindy/maker-core';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';

const startedAt = Date.now() - 125_000;
const record: VoiceCallRecord = {
  version: 1,
  callId: 'fixture',
  startedAt,
  endedAt: startedAt + 125_000,
  turns: [
    { id: 'u1', role: 'user', text: '今天想聊聊周末怎么安排。', complete: true, createdAt: 1000 },
    {
      id: 'a1',
      role: 'assistant',
      text: '可以呀。你想放松一下，还是想出门走走？',
      complete: true,
      createdAt: 2000,
    },
    {
      id: 'u2',
      role: 'user',
      text: '帮我整理一份周末读书计划，可以在后台继续做。',
      complete: true,
      createdAt: 3000,
    },
    {
      id: 'a2',
      role: 'assistant',
      text: '计划已经整理好了，详细内容在主对话里。',
      complete: true,
      createdAt: 4000,
    },
  ],
  handoffs: [
    {
      id: 'task',
      inputId: 'u2',
      text: '帮我整理一份周末读书计划，可以在后台继续做。',
      state: 'completed',
      result: 'Three steps.',
    },
  ],
};
function Fixture({
  failed,
  empty,
  mode,
  sidebar,
}: {
  failed: boolean;
  empty: boolean;
  mode?: string;
  sidebar: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [live, setLive] = useState(true);
  const [focused, setFocused] = useState(false);
  const [countdown, setCountdown] = useState(mode === 'countdown');
  const [muted, setMuted] = useState(mode === 'muted');
  const [reading, setReading] = useState(mode === 'speaking');
  const speechError = mode === 'speech' || mode === 'speechTimeout' ? mode : null;
  const call: VoiceCallRecord = {
    ...record,
    endedAt: live ? undefined : record.endedAt,
    turns: empty
      ? []
      : failed
        ? [
            ...record.turns,
            {
              id: 'u3',
              role: 'user',
              text: '还有一个想法，请先记下来。',
              failed: true,
              complete: true,
              createdAt: 5000,
            },
          ]
        : mode === 'long'
          ? [
              ...record.turns,
              {
                id: 'long',
                role: 'assistant',
                text: '这是一段较长的回复，展开记录时仍然可以阅读，也可以回看前面的内容。'.repeat(
                  35,
                ),
                complete: true,
                createdAt: 5000,
              },
            ]
          : record.turns,
    handoffs: empty ? [] : record.handoffs,
  };
  const messages: ChatMessage[] = [
    {
      clientId: 'voice-call:fixture',
      role: 'assistant',
      content: '',
      systemCardType: 'voice-call',
      systemCardData: { record: call },
    },
    ...(empty
      ? []
      : [
          {
            clientId: 'task',
            role: 'user' as const,
            content: record.handoffs[0].text,
            systemCardType: 'voice-call-task' as const,
          },
        ]),
  ];
  return (
    // Reserve sidebar space without mounting the app: alignment belongs to
    // the conversation column, not the full window.
    <div className={sidebar ? 'pl-[240px]' : undefined}>
      <main className="mx-auto flex h-screen max-w-[720px] flex-col gap-6 overflow-hidden p-4">
        <div data-fixture-timeline className="min-h-0 flex-1 overflow-y-auto space-y-3">
          {empty && <p className="text-13 text-[var(--text-primary)]">这是通话之前的消息。</p>}
          {visibleVoiceCallMessages(messages, live ? 'fixture' : null).map((message) =>
            message.systemCardType === 'voice-call' ? (
              <VoiceCallCard key={message.clientId} record={call} />
            ) : (
              <div key={message.clientId} data-focused-task={focused}>
                <VoiceCallTaskEntry text={message.content} />
              </div>
            ),
          )}
        </div>
        <div className="shrink-0 flex flex-col items-center gap-3">
          {live && (
            <CompanionVoiceToolbar
              bot={{ id: 'fixture', name: 'Cindy', avatar: 'cindy://avatar/preset/cindy' }}
              state={{
                phase: failed || speechError
                  ? 'error'
                  : reading
                    ? 'speaking'
                    : mode === 'thinking'
                      ? 'thinking'
                      : 'listening',
                transcript: failed || empty || speechError ? '' : '听起来不错。',
                unsent: failed ? '还有一个想法，请先记下来。' : '',
                level: 0.2,
                error: failed ? 'send' : speechError,
                muted,
                microphonePending: false,
                microphoneError: false,
                exitCountdown: countdown ? { reason: 'idle', secondsRemaining: 10 } : null,
                callRecord: call,
              }}
              loading={false}
              blocked={false}
              configurationError={false}
              titleRef={titleRef}
              onResume={forbid('resume')}
              onMute={() => setMuted(!muted)}
              onInterrupt={() => setReading(false)}
              onSend={forbid('send')}
              onCancelExit={() => setCountdown(false)}
              onClose={() => setLive(false)}
              onConfigure={forbid('configure')}
              onOpenTask={() => setFocused(true)}
            />
          )}
          <div
            data-fixture-composer
            className="h-20 w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
          />
        </div>
      </main>
    </div>
  );
}
void mountPage({
  render: (ctx) => (
    <Fixture
      failed={ctx.data.failed === true}
      empty={ctx.data.empty === true}
      mode={typeof ctx.data.mode === 'string' ? ctx.data.mode : undefined}
      sidebar={ctx.data.sidebar === true}
    />
  ),
});
