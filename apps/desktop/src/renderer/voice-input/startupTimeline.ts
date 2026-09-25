import { createLogger } from '@/lib/logger';

const log = createLogger('voice-input-startup');

type StartupStage =
  | 'requested'
  | 'checks_finished'
  | 'microphone_requested'
  | 'engine_ready'
  | 'first_pcm'
  | 'first_buffered_audio'
  | 'connection_ready'
  | 'first_transcript'
  | 'mute_finished';

/** One attempt's local clock, starting at the UI action; never records audio or text. */
export function createVoiceInputStartupTimeline(
  source: 'inline' | 'overlay',
  startedAt = performance.now(),
) {
  const seen = new Set<StartupStage>();
  const attempt = `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  const mark = (stage: StartupStage) => {
    if (seen.has(stage)) return;
    seen.add(stage);
    log.info('startup stage', { attempt, source, stage, elapsedMs: elapsedMs() });
  };
  mark('requested');
  return { mark, elapsedMs };
}

export type VoiceInputStartupTimeline = ReturnType<typeof createVoiceInputStartupTimeline>;
