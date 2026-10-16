import type {
  VoiceConversationApi,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import { createLogger } from '@/lib/logger';
import type { SpeechPlayer } from './PcmSpeechPlayer';
import { SpeechPlaybackQueue } from './SpeechPlaybackQueue';
import { speechChunks, speechText } from './VoiceReplyTracker';

const log = createLogger('voice-conversation');
type Snapshot = { messageId: string | null; phase: 'idle' | 'preparing' | 'playing' | 'error' };
type Playback = {
  id: string;
  messageId: string;
  player: SpeechPlayer;
  queue?: SpeechPlaybackQueue;
  opened: boolean;
  unsubscribe: () => void;
};

/** Explicitly reads an existing reply. No capture, task submission or preference writes. */
export class MessageReadAloudController {
  private state: Snapshot = { messageId: null, phase: 'idle' };
  private current: Playback | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private readonly deps: {
      api: Pick<VoiceConversationApi, 'startPlayback' | 'speak' | 'readSpeech' | 'end' | 'onEvent'>;
      botId: string;
      sessionId: string;
      player(): SpeechPlayer;
    },
  ) {}

  getSnapshot = (): Snapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(state: Snapshot): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private end(id: string): Promise<void> {
    const end = this.deps.api.end(id).catch(() => undefined);
    this.stopping = Promise.all([this.stopping, end]).then(() => undefined);
    return this.stopping;
  }
  stop = (): Promise<void> => {
    const current = this.current;
    this.current = null;
    if (current) {
      current.unsubscribe();
      current.queue?.cancel();
      current.player.close();
      log.info('message playback stopped', { callId: current.id });
      if (current.opened) void this.end(current.id);
    }
    this.update({ messageId: null, phase: 'idle' });
    return this.stopping;
  };

  async start(
    messageId: string,
    markdown: string,
    resolveSelection: () => Promise<VoiceConversationSelection | undefined>,
  ): Promise<void> {
    const text = speechText(markdown);
    if (!text) return;
    const stopped = this.stop();
    let player: SpeechPlayer;
    try {
      // Resume output during the click gesture, before configuration/network awaits.
      player = this.deps.player();
    } catch {
      this.update({ messageId: null, phase: 'error' });
      return;
    }
    const run: Playback = {
      id: crypto.randomUUID(),
      messageId,
      player,
      opened: false,
      unsubscribe: () => {},
    };
    this.current = run;
    this.update({ messageId, phase: 'preparing' });
    const isCurrent = () => this.current === run;
    const finish = (failed = false) => {
      if (!isCurrent()) return;
      void this.stop();
      if (failed) {
        log.warn('message playback failed', { callId: run.id });
        this.update({ messageId: null, phase: 'error' });
      }
    };
    try {
      await stopped;
      if (!isCurrent()) return;
      const selection = await resolveSelection();
      if (!isCurrent()) return;
      if (!selection) throw new Error('speech_unavailable');
      run.unsubscribe = this.deps.api.onEvent((event) => {
        if (event.callId === run.id && event.event.type === 'ended') finish();
      });
      run.opened = true;
      await this.deps.api.startPlayback({
        ...selection,
        callId: run.id,
        botId: this.deps.botId,
        sessionId: this.deps.sessionId,
      });
      if (!isCurrent()) return;
      log.info('message playback ready', { callId: run.id, characters: text.length });
      run.queue = new SpeechPlaybackQueue({
        api: this.deps.api,
        callId: run.id,
        prefix: run.id,
        player,
        prefetch: true,
        phase: (phase) => {
          if (isCurrent() && phase)
            this.update({ messageId, phase: phase === 'speaking' ? 'playing' : 'preparing' });
        },
        drained: () => finish(),
        deferred: () => finish(true),
        failed: () => finish(true),
        diagnostic: (event, details) => log.info(event, { callId: run.id, ...details }),
      });
      // Bound each request, retain the complete reply and prefetch at most one segment.
      run.queue.append(speechChunks(text, 500), true);
    } catch {
      finish(true);
    } finally {
      // A cancelled IPC start can settle after a replacement. End only its own lease.
      if (!isCurrent() && run.opened) await this.end(run.id);
    }
  }
}
