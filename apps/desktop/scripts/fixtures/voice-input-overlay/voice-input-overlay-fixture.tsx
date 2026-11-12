import { mountPage, subscription } from '../../ui-page/harness';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { VoiceInputOverlay } from '../../../src/renderer/voice-input/VoiceInputOverlay';

// Only the microphone and host service are synthetic. The overlay owns the
// real submit/cancel/paste waiters, event scope and rendering under test.
void mountPage({
  host: (ctx) => {
    let run = 0;
    const emit = (event: object) => window.__uiPage.emit('voice', { runId: `voice-${run}`, ...event });
    ctx.data.pastes = [];
    ctx.data.closes = [];
    return {
      voiceInput: {
        getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('win32'),
          playInteractionSound: false, muteSystemAudio: false } }),
        getMicrophonePermissionCached: () => ({ ok: true, status: 'granted' }),
        getSystemPermissionsCached: () => ({ microphone: { ok: true }, accessibility: { ok: true } }),
        getReadinessCached: () => ({ ok: true }),
        getHistoryForRefinement: () => [],
        recordHistory: () => 'fixture-history',
        updateHistoryEntry: () => {},
        onDataChanged: () => () => {},
        onDictionaryLearningEvidence: () => () => {},
        onPowerStateChange: () => () => {},
        onEvent: subscription('voice'),
        onGlobalOverlayCommand: subscription('command'),
        notifyGlobalOverlayReady: () => {},
        prewarm: async () => ({ ok: true }),
        start: async () => ({ ok: true, runId: `voice-${++run}` }),
        drainAudioQueue: async () => ({ ok: true }),
        restoreSystemAudio: async () => ({ ok: true }),
        stop: async () => {
          emit({ type: 'submitted', text: 'Keep these original words.', segment: { basedOnText: 'Keep these original words.' } });
          emit({ type: 'state', state: 'refining' });
          emit({ type: 'refinement-preview', text: 'A changing preview' });
          return { ok: true };
        },
        cancel: async () => {
          // A late completion is intentionally delivered after the user acts.
          emit({ type: 'refined', text: 'Unwanted late replacement', segment: {} });
          emit({ type: 'state', state: 'done', outcome: 'cancelled' });
          return { ok: true };
        },
        closeGlobalOverlay: async (options: unknown) => { (ctx.data.closes as unknown[]).push(options); return { ok: true }; },
        pasteIntoFocusedTarget: async (text: string) => { (ctx.data.pastes as unknown[]).push({ text }); return { ok: true }; },
      },
    };
  },
  render: () => <VoiceInputOverlay />,
});
