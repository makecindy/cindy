import type {
  VoiceConversationApi,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { PcmChunk } from '@/voice-input/WebMicAudioEngine';
import type { SpeechPlayer } from './PcmSpeechPlayer';
import { speechChunks, VoiceReplyTracker } from './VoiceReplyTracker';

export type VoicePhase =
  'idle' | 'connecting' | 'listening' | 'thinking' | 'preparing' | 'speaking' | 'paused' | 'error';
export type VoiceSnapshot = {
  phase: VoicePhase;
  transcript: string;
  unsent: string;
  level: number;
  error: 'connection' | 'microphone' | 'send' | 'speech' | null;
  muted: boolean;
};
interface Microphone {
  onPcm16k(callback: (chunk: PcmChunk) => void): void;
  start(): Promise<void>;
  stop(): Promise<unknown>;
}

/** Call-local orchestration. It never stops the companion task or answers permission prompts. */
export class VoiceConversationController {
  private state: VoiceSnapshot = {
    phase: 'idle',
    transcript: '',
    unsent: '',
    level: 0,
    error: null,
    muted: false,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private speechEpoch = 0;
  private callId: string | null = null;
  private microphone: Microphone | null = null;
  private player: SpeechPlayer | null = null;
  private unsubscribe?: () => void;
  private selection?: VoiceConversationSelection;
  private blocked = false;
  private enabled = false;
  private tracker = new VoiceReplyTracker();
  private pendingInput: string | null = null;
  private latestMessages: readonly ChatMessage[] = [];
  private sending = false;
  private inFlight: Promise<void> = Promise.resolve();
  private queued: string[] = [];
  private pendingStart: Promise<unknown> = Promise.resolve();
  private teardown: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      api: VoiceConversationApi;
      botId: string;
      sessionId: string;
      microphone(onInterrupted: () => void): Microphone;
      player(onLevel: (level: number) => void): SpeechPlayer;
      send(
        text: string,
        onCreated: (id: string) => void,
        isCurrent: () => boolean,
      ): Promise<boolean>;
    },
  ) {}

  getSnapshot = (): VoiceSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private patch(patch: Partial<VoiceSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(selection: VoiceConversationSelection): Promise<void> {
    if (this.blocked || this.callId || this.state.phase === 'connecting') return;
    this.selection = selection;
    this.enabled = true;
    const epoch = ++this.epoch;
    this.patch({ phase: 'connecting', error: null, muted: false });
    const current = () => this.enabled && epoch === this.epoch && !this.blocked;
    try {
      this.player = this.deps.player((level) => {
        if (current() && this.state.phase === 'speaking') this.patch({ level });
      });
      await this.teardown;
      if (!current()) return;
      this.unsubscribe = this.deps.api.onEvent(({ callId, event }) => {
        if (!current() || callId !== this.callId) return;
        if (event.type === 'speech-started') {
          this.interrupt();
          this.patch({ phase: 'listening' });
        } else if (event.type === 'draft') {
          this.patch({ transcript: event.text });
        } else if (event.type === 'utterance') {
          this.queued.push(event.text);
          if (this.queued.join(' ').length > 16_000) this.fail('send');
          else void this.drain(epoch);
        } else if (event.type === 'ended') {
          this.end();
        } else if (event.type === 'error') {
          this.fail('connection', event.text);
        }
      });
      // Reserve a call id before IPC so End can cancel an in-flight ASR dial.
      this.callId = crypto.randomUUID();
      const opening = this.deps.api.start({
        ...selection,
        callId: this.callId,
        botId: this.deps.botId,
        sessionId: this.deps.sessionId,
      });
      this.pendingStart = opening
        .then(async (result) => {
          if (!current()) await this.deps.api.end(result.callId);
        })
        .catch(() => undefined);
      const result = await opening;
      if (!current()) {
        await this.pendingStart;
        return;
      }
      this.callId = result.callId;
      const mic = this.deps.microphone(() => {
        if (current()) this.fail('microphone');
      });
      this.microphone = mic;
      mic.onPcm16k(({ pcm16k }) => {
        if (!current() || !this.callId) return;
        this.deps.api.audio({ callId: this.callId, pcm: pcm16k });
        if (this.state.phase !== 'speaking') {
          const samples = new Int16Array(pcm16k);
          const rms = Math.sqrt(
            samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length),
          );
          this.patch({ level: Math.min(1, rms / 5000) });
        }
      });
      try {
        await mic.start();
      } catch {
        if (current()) this.fail('microphone');
        return;
      }
      if (!current()) {
        await mic.stop();
        return;
      }
      this.patch({ phase: this.pendingInput ? 'thinking' : 'listening' });
      this.updateMessages(this.latestMessages);
    } catch {
      if (current()) this.fail('connection');
    }
  }

  /** Speech onset fences old replies and audio before a new transcript is committed. */
  interrupt(): void {
    ++this.speechEpoch;
    this.tracker.interrupt();
    this.pendingInput = null;
    this.player?.cancel();
    if (this.callId) void this.deps.api.interrupt(this.callId).catch(() => undefined);
    if (
      this.state.phase === 'speaking' ||
      this.state.phase === 'preparing' ||
      this.state.phase === 'thinking'
    )
      this.patch({ phase: 'listening', level: 0 });
  }

  private async submit(text: string, epoch: number): Promise<void> {
    const current = () =>
      this.enabled && epoch === this.epoch && !this.blocked && !this.state.muted;
    if (!current()) return;
    this.interrupt();
    this.patch({ phase: 'thinking', transcript: '', unsent: '' });
    const replyEpoch = this.speechEpoch;
    let clientId: string | null = null;
    try {
      const accepted = await this.deps.send(
        text,
        (id) => {
          clientId = id;
        },
        current,
      );
      if (!current()) {
        // A permission/mute boundary can cancel preflight before enqueue. Wait
        // for its outcome before resuming, retaining only genuinely unsent text.
        if (!accepted && this.enabled)
          this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
        return;
      }
      if (!accepted || !clientId) {
        this.fail('send', text);
        return;
      }
      if (replyEpoch !== this.speechEpoch) return;
      this.pendingInput = clientId;
      this.tracker.expect(clientId);
      this.updateMessages(this.latestMessages);
    } catch {
      if (current()) this.fail('send', text);
      else if (this.enabled)
        this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
    }
  }

  private async drain(epoch: number): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queued.length && this.enabled && epoch === this.epoch && !this.blocked) {
        this.inFlight = this.submit(this.queued.shift()!, epoch);
        await this.inFlight;
      }
    } finally {
      this.sending = false;
      if (this.queued.length && this.callId && this.enabled && !this.blocked)
        void this.drain(this.epoch);
    }
  }

  updateMessages(messages: readonly ChatMessage[]): void {
    this.latestMessages = messages;
    if (!this.enabled || !this.callId || this.blocked || this.state.muted || !this.pendingInput)
      return;
    const reply = this.tracker.take(messages);
    if (!reply) {
      if (!this.tracker.hasPendingReply) {
        this.pendingInput = null;
        this.patch({ phase: 'listening' });
      }
      return;
    }
    this.pendingInput = null;
    void this.speak(reply.text);
  }

  private async speak(text: string): Promise<void> {
    const epoch = this.epoch;
    const speechEpoch = ++this.speechEpoch;
    const callId = this.callId;
    const player = this.player;
    if (!callId || !player) return;
    const current = () =>
      epoch === this.epoch && speechEpoch === this.speechEpoch && this.enabled && !this.blocked;
    this.patch({ phase: 'preparing', level: 0 });
    try {
      for (const [index, chunk] of speechChunks(text).entries()) {
        if (!current()) return;
        const requestId = `${speechEpoch}:${index}`;
        const { sampleRate } = await this.deps.api.speak({ callId, requestId, text: chunk });
        if (!current()) return;
        this.patch({ phase: 'speaking' });
        await player.play(() => this.deps.api.readSpeech(callId, requestId), sampleRate);
      }
      if (current()) this.patch({ phase: 'listening', level: 0 });
    } catch {
      if (current()) this.fail('speech');
    }
  }

  finishUtterance(): void {
    const epoch = this.epoch;
    if (this.callId)
      void this.deps.api.finishUtterance(this.callId).catch(() => {
        if (epoch === this.epoch) this.fail('connection');
      });
  }

  setBlocked(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    if (blocked && this.enabled) {
      const unsent = [this.state.unsent, ...this.queued, this.state.transcript]
        .filter(Boolean)
        .join(' ');
      this.release();
      this.patch({ phase: 'paused', unsent, transcript: '', level: 0 });
    }
    // Confirmation completion does not silently restart a microphone.
  }

  toggleMute(): void {
    if (this.state.muted) {
      if (this.selection) void this.start(this.selection);
      return;
    }
    const unsent = [this.state.unsent, ...this.queued, this.state.transcript]
      .filter(Boolean)
      .join(' ');
    this.release();
    this.patch({ muted: true, phase: 'paused', transcript: '', unsent, level: 0 });
  }

  retryUnsent(): void {
    if (!this.state.unsent || !this.callId || this.blocked) return;
    const text = this.state.unsent;
    this.queued.push(text);
    void this.drain(this.epoch);
  }

  private fail(error: VoiceSnapshot['error'], text?: string): void {
    const unsent = [text || this.state.transcript || this.state.unsent, ...this.queued]
      .filter(Boolean)
      .join(' ');
    this.release();
    this.patch({ phase: 'error', error, unsent, transcript: '', level: 0 });
  }

  private release(): void {
    ++this.epoch;
    ++this.speechEpoch;
    this.queued = [];
    const callId = this.callId;
    const microphone = this.microphone;
    this.callId = null;
    this.microphone = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.player?.close();
    this.player = null;
    this.teardown = Promise.allSettled([
      this.teardown,
      this.pendingStart,
      this.inFlight,
      microphone?.stop(),
      callId ? this.deps.api.end(callId) : undefined,
    ]);
  }

  end(): void {
    this.enabled = false;
    this.release();
    this.tracker.interrupt();
    this.pendingInput = null;
    this.patch({ phase: 'idle', transcript: '', level: 0, muted: false });
  }
}
