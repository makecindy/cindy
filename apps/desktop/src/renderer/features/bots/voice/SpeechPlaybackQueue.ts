import type { SpeechStartResult, VoiceConversationApi } from '@/../shared/voiceConversation';
import type { SpeechPlayer } from './PcmSpeechPlayer';

type Segment = { text: string; streaming: boolean };
type Prepared = { requestId: string; ready: Promise<SpeechStartResult | { error: true }> };

/** Ordered playback with one bounded lookahead. Text may keep arriving while
 * audio plays; an empty queue is not the end of an unfinished model reply.
 * HTTP adapters share this scheduler; native text-streaming adapters can later
 * replace preparation without owning a second player or interruption lifecycle.
 */
export class SpeechPlaybackQueue {
  private queued: Segment[] = [];
  private prepared: Prepared[] = [];
  private active = false;
  private cancelled = false;
  private paused = false;
  private complete = false;
  private sequence = 0;
  private played = false;
  private lastPlaybackEnd?: number;

  constructor(
    private readonly deps: {
      api: Pick<VoiceConversationApi, 'speak' | 'readSpeech'>;
      callId: string;
      prefix: string;
      player: SpeechPlayer;
      prefetch: boolean;
      phase(phase: 'thinking' | 'preparing' | 'speaking' | null): void;
      drained(): void;
      deferred(alreadyPlayed: boolean): void;
      failed(): void;
      diagnostic(event: string, details: Record<string, string | number | boolean>): void;
    },
  ) {}

  append(texts: string[], complete: boolean): void {
    if (this.cancelled) return;
    this.queued.push(...texts.map((text) => ({ text, streaming: !complete })));
    this.complete ||= complete;
    // Once done is known, queued text no longer bypasses outgoing processing.
    // Only the tracker can declare completion, after ghostReplyPending clears.
    if (complete) for (const segment of this.queued) segment.streaming = false;
    this.pump();
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.pump();
  }

  cancel(): void {
    this.cancelled = true;
    this.queued = [];
    this.prepared = [];
  }

  private prepare(): void {
    const capacity = this.deps.prefetch ? 2 : 1;
    while (
      !this.paused &&
      this.queued.length &&
      this.prepared.length + Number(this.active) < capacity
    ) {
      const segment = this.queued.shift()!;
      const requestId = `${this.deps.prefix}:${this.sequence++}`;
      this.deps.diagnostic('speech requested', {
        requestId,
        characters: segment.text.length,
        streaming: segment.streaming,
      });
      const ready = this.deps.api
        .speak({
          callId: this.deps.callId,
          requestId,
          text: segment.text,
          ...(segment.streaming ? { streaming: true } : {}),
        })
        .catch(() => ({ error: true as const }));
      // Observe rejection immediately, even if playback never reaches this segment.
      this.prepared.push({ requestId, ready });
    }
  }

  private pump(): void {
    if (this.cancelled || this.paused) return;
    this.prepare();
    if (this.active) return;
    const next = this.prepared.shift();
    if (!next) {
      this.deps.phase(this.complete ? null : 'thinking');
      if (this.complete) this.deps.drained();
      return;
    }
    this.active = true;
    this.deps.phase('preparing');
    void this.play(next);
  }

  private async play(segment: Prepared): Promise<void> {
    try {
      const result = await segment.ready;
      if (this.cancelled) return;
      if ('deferred' in result) {
        this.cancel();
        this.deps.deferred(this.played);
        return;
      }
      if ('error' in result) throw new Error('Speech preparation failed');
      await this.deps.player.play(
        () => this.deps.api.readSpeech(this.deps.callId, segment.requestId),
        result.sampleRate,
        () => {
          if (this.cancelled) return;
          this.deps.diagnostic('playback scheduled', {
            requestId: segment.requestId,
            first: !this.played,
            ...(this.lastPlaybackEnd === undefined
              ? {}
              : { gapMs: Date.now() - this.lastPlaybackEnd }),
          });
          this.played = true;
          this.deps.phase('speaking');
        },
      );
      if (this.cancelled) return;
      this.lastPlaybackEnd = Date.now();
      this.deps.diagnostic('playback completed', { requestId: segment.requestId });
      this.active = false;
      this.pump();
    } catch {
      if (!this.cancelled) {
        this.cancel();
        this.deps.failed();
      }
    }
  }
}
