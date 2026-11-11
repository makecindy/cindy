import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { VoiceInputOverlay } from '../../../src/renderer/voice-input/VoiceInputOverlay';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';

void mountPage({
  host: {
    platform: 'darwin',
    voiceInput: {
      getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('darwin'), playInteractionSound: false, muteSystemAudio: false, refinementEnabled: false } }),
      getMicrophonePermissionCached: () => ({ ok: true, status: 'granted' }),
      getSystemPermissionsCached: () => ({ microphone: { ok: true }, accessibility: { ok: ctx.case === 'global-after-reply' } }),
      getReadinessCached: () => ({ ok: true }),
      getHistoryForRefinement: () => [],
      onDataChanged: subscription('data'),
      onEvent: subscription('voice'),
      onSessionPromptStart: subscription('session-prompt'),
      onGlobalOverlayCommand: subscription('overlay-command'),
      onDictionaryLearningEvidence: subscription('dictionary'),
      notifyGlobalOverlayReady() {},
      migrateLegacyRendererData() {},
      prewarm: async () => ({ ok: true }),
      start: async () => ({ ok: true, runId: 'fixture-run' }),
      stop: async () => {
        const emit = (window as unknown as { __uiPage: { emit: (name: string, event: unknown) => void } }).__uiPage.emit;
        emit('voice', { type: 'submitted', runId: 'fixture-run', text: '请把结果整理成一份简短的周报。', segment: {} });
        emit('voice', { type: 'state', runId: 'fixture-run', state: 'done' });
        return ctx.case === 'recording-error-retained' ? { ok: false, error: '识别失败' } : { ok: true };
      },
      recordHistory: () => ({ id: 'history-1' }),
      drainAudioQueue: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      restoreSystemAudio: async () => ({ ok: true }),
      closeGlobalOverlay: async () => ({ ok: true }),
      submitSessionPrompt: async () => ctx.case === 'send-failed' ? { ok: false, errorCode: 'SEND_FAILED' } : { ok: true },
    },
  },
  render: () => <VoiceInputOverlay />,
});
