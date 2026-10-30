import { useEffect, useRef, useState } from 'react';
import { mountPage, forbid, subscription } from '../../ui-page/harness';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { AskUserQuestionPrompt } from '../../../src/renderer/components/new-chat/AskUserQuestionPrompt';
import type { AskUserDraft, AskUserViewerState } from '../../../src/renderer/lib/makerChatStore';
import type { VoiceQuestionTarget } from '../../../src/renderer/components/new-chat/voiceQuestionSelection';
import { CompanionVoiceToolbar } from '../../../src/renderer/features/bots/voice/CompanionVoiceToolbar';

function Fixture({ question, voice, multi }: { question: string; voice?: boolean; multi?: boolean }) {
  const [draft, setDraft] = useState<AskUserDraft | null>(null);
  const [viewerState, setViewerState] = useState<AskUserViewerState>('expanded');
  const bridge = useRef<VoiceQuestionTarget | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (voice && multi) bridge.current?.receive('第一项和第二项');
  }, [voice, multi]);
  return <main className="mx-auto w-full max-w-[720px] min-w-0 p-4">
    {voice ? <div className="mb-4"><CompanionVoiceToolbar
      bot={{ id: 'fixture', name: 'Cindy' }}
      state={{ phase: 'listening', transcript: '', unsent: '', level: 0, error: null,
        muted: false, microphonePending: false, microphoneError: false, exitCountdown: null }}
      questionPending loading={false} blocked={false} configurationError={false} titleRef={titleRef}
      onResume={forbid('resume')} onMute={forbid('mute')} onInterrupt={forbid('interrupt')}
      onSend={forbid('send')} onCancelExit={forbid('cancel exit')} onClose={forbid('close')}
      onConfigure={forbid('configure')} /></div> : null}
    <AskUserQuestionPrompt sessionId="question-evidence" workingDir="/project"
      voiceBridge={voice ? bridge : undefined}
      pending={{ requestId: 'review', questions: [{ header: '确认原型', question, multiSelect: multi, options: [
        { label: '可以，按这版实现' }, { label: '还需要调整' },
      ] }] }}
      onAnswer={forbid('answer question')}
      draft={draft} onDraftChange={setDraft} viewerState={viewerState} onViewerStateChange={setViewerState} />
  </main>;
}

void mountPage({
  host: {
    voiceInput: {
      getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('darwin'), playInteractionSound: false, muteSystemAudio: false } }),
      getMicrophonePermissionCached: () => ({ ok: true, status: 'granted' }),
      getSystemPermissionsCached: () => ({ microphone: { ok: true }, accessibility: { ok: true } }),
      getReadinessCached: () => ({ ok: true }),
      getHistoryForRefinement: () => [],
      onEvent: subscription('voice'),
      start: async () => ({ ok: true, runId: 'fixture-voice' }),
      stop: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      drainAudioQueue: async () => ({ ok: true }),
    },
    resolvePathBatch: async ({ hrefs }: { hrefs: string[] }) => Object.fromEntries(hrefs.map((href) => [href,
      href === 'missing.html' ? { status: 'none', candidates: [] }
        : href === 'ambiguous.html' ? { status: 'multiple', candidates: ['/project/a/ambiguous.html', '/project/b/ambiguous.html'] }
        : { status: 'unique', candidates: [href.startsWith('/') ? href : '/project/' + href], kind: 'file' },
    ])),
  },
  render: (ctx) => <Fixture question={String(ctx.data.question)} voice={ctx.data.voice === true} multi={ctx.data.multi === true} />,
});
