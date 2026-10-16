import type {
  VoiceConversationApi,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import type { SpeechPlayer } from './PcmSpeechPlayer';

type Phase = 'idle' | 'preparing' | 'playing' | 'complete' | 'error';

/** Playback-only preview. It never captures the microphone, submits a message or saves a preference. */
export class VoicePreviewController {
  private phase: Phase = 'idle';
  private generation = 0;
  private current: { id: string; player: SpeechPlayer } | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private readonly deps: {
      api: Pick<VoiceConversationApi, 'preview' | 'readPreview' | 'stopPreview'>;
      botId: string;
      sessionId: string;
      player(): SpeechPlayer;
    },
  ) {}

  getSnapshot = (): Phase => this.phase;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(phase: Phase): void {
    this.phase = phase;
    this.listeners.forEach((listener) => listener());
  }

  stop(): Promise<void> {
    ++this.generation;
    const current = this.current;
    this.current = null;
    current?.player.close();
    this.update('idle');
    if (current) {
      const stop = this.deps.api.stopPreview(current.id).catch(() => undefined);
      this.stopping = Promise.all([this.stopping, stop]).then(() => undefined);
    }
    return this.stopping;
  }

  async start(selection: VoiceConversationSelection, text: string): Promise<void> {
    const stopped = this.stop();
    const generation = this.generation;
    const id = crypto.randomUUID();
    let player: SpeechPlayer;
    try {
      // Construct/resume AudioContext during the user's click, before awaiting IPC.
      player = this.deps.player();
    } catch {
      this.update('error');
      return;
    }
    this.current = { id, player };
    this.update('preparing');
    try {
      await stopped;
      if (generation !== this.generation) return;
      const { sampleRate } = await this.deps.api.preview({
        ...selection,
        previewId: id,
        botId: this.deps.botId,
        sessionId: this.deps.sessionId,
        text,
      });
      if (generation !== this.generation) return;
      this.update('playing');
      await player.play(() => this.deps.api.readPreview(id), sampleRate);
      if (generation === this.generation) this.update('complete');
    } catch {
      if (generation === this.generation) this.update('error');
    } finally {
      player.close();
      if (this.current?.id === id) this.current = null;
      // Include teardown in the next preview/call's barrier, including a late start.
      const stop = this.deps.api.stopPreview(id).catch(() => undefined);
      this.stopping = Promise.all([this.stopping, stop]).then(() => undefined);
      await this.stopping;
    }
  }
}
