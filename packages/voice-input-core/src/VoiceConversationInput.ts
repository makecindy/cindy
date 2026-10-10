import type { AsrProvider, AsrSegment, AudioTrace } from "./types.js";
import { ConversationActivity } from "./conversationActivity.js";

export type ConversationInputEvent =
  | { type: "ready" }
  | { type: "speech-started" }
  | { type: "draft"; text: string }
  | { type: "utterance"; id: string; text: string }
  | { type: "error"; text: string };

/**
 * Continuous ASR ownership and endpointing. Provider IDs, never string-prefix
 * subtraction, identify submitted speech. Connections rotate below the managed
 * service's default lifetime while capture is buffered; the product call lives on.
 */
export class VoiceConversationInput {
  private provider: AsrProvider | null = null;
  private generation = 0;
  private sequence = 0;
  private closed = false;
  private rotating = false;
  private activity = new ConversationActivity();
  private speaking = false;
  private manual = false;
  private segments = new Map<string, AsrSegment & { generation: number }>();
  private consumed = new Set<string>();
  private pending: Array<{ pcm: ArrayBuffer; trace?: AudioTrace }> = [];
  private pendingBytes = 0;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private rotationTimer?: ReturnType<typeof setTimeout>;
  private finalTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      createProvider: () => Promise<AsrProvider>;
      emit: (event: ConversationInputEvent) => void;
      rotationMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.closed) return;
    await this.open();
  }

  appendAudio(pcm: ArrayBuffer, trace?: AudioTrace): void {
    if (this.closed) return;
    const activity = this.activity.push(pcm);
    this.speaking = activity.active;
    if (activity.started) {
      clearTimeout(this.finalTimer);
      if (!this.manual) clearTimeout(this.settleTimer);
      this.options.emit({ type: "speech-started" });
    }
    if (!this.provider || this.rotating) {
      this.pending.push({ pcm, trace });
      this.pendingBytes += pcm.byteLength;
      // Five seconds of 16 kHz PCM. Never silently discard a user's speech.
      if (this.pendingBytes > 160_000) this.fail();
      return;
    }
    this.provider.appendAudio(pcm, trace);
    if (activity.ended) this.finishUtterance();
  }

  finishUtterance(force = false): void {
    if (this.closed) return;
    this.manual ||= force;
    this.provider?.commitUtterance?.();
    this.scheduleSettlement();
    clearTimeout(this.finalTimer);
    this.finalTimer = setTimeout(() => {
      if (
        this.segments.size &&
        [...this.segments.values()].some((part) => !part.final)
      )
        this.fail();
    }, 8_000);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    ++this.generation;
    clearTimeout(this.settleTimer);
    clearTimeout(this.rotationTimer);
    clearTimeout(this.finalTimer);
    this.pending = [];
    this.pendingBytes = 0;
    const provider = this.provider;
    this.provider = null;
    if (provider) {
      try {
        await provider.stop();
      } finally {
        await provider.dispose?.();
      }
    }
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    const provider = await this.options.createProvider();
    if (this.closed || generation !== this.generation) {
      await provider.stop();
      await provider.dispose?.();
      return;
    }
    this.provider = provider;
    if (!provider.onSegment)
      throw new Error("Continuous transcription is unavailable.");
    provider.onSegment((segment) => {
      if (this.closed || generation !== this.generation) return;
      const key = `${generation}:${segment.id}`;
      if (this.consumed.has(key)) return;
      const prior = this.segments.get(key);
      if (prior?.final) return;
      if (!prior?.text && segment.text.trim() && !this.speaking)
        this.options.emit({ type: "speech-started" });
      this.segments.set(key, { ...segment, generation });
      this.options.emit({ type: "draft", text: this.draft() });
      if (this.draft().length > 16_000) {
        this.fail();
        return;
      }
      this.scheduleSettlement();
    });
    provider.onEvent((event) => {
      if (this.closed || generation !== this.generation || this.rotating)
        return;
      if (event.type === "error" || event.type === "disconnected") this.fail();
    });
    await provider.start();
    if (this.closed || generation !== this.generation) return;
    this.rotating = false;
    const hadBufferedAudio = this.pending.length > 0;
    for (const chunk of this.pending.splice(0))
      provider.appendAudio(chunk.pcm, chunk.trace);
    this.pendingBytes = 0;
    if (hadBufferedAudio && !this.speaking) provider.commitUtterance?.();
    this.rotationTimer = setTimeout(() => {
      void this.rotate().catch(() => this.fail());
    }, this.options.rotationMs ?? 150_000);
    this.options.emit({ type: "ready" });
  }

  private draft(): string {
    return [...this.segments.values()]
      .sort(
        (a, b) =>
          a.generation - b.generation || (a.order ?? 0) - (b.order ?? 0),
      )
      .map((segment) => segment.text.trim())
      .join(" ")
      .trim();
  }

  private scheduleSettlement(): void {
    clearTimeout(this.settleTimer);
    if ((this.speaking && !this.manual) || this.rotating || !this.segments.size)
      return;
    if ([...this.segments.values()].some((segment) => !segment.final)) return;
    this.settleTimer = setTimeout(
      () => {
        if (this.closed || (this.speaking && !this.manual) || this.rotating)
          return;
        const text = this.draft();
        for (const key of this.segments.keys()) this.consumed.add(key);
        this.segments.clear();
        this.manual = false;
        clearTimeout(this.finalTimer);
        if (text)
          this.options.emit({
            type: "utterance",
            id: String(++this.sequence),
            text,
          });
        this.options.emit({ type: "draft", text: "" });
      },
      this.manual ? 0 : 350,
    );
  }

  private async rotate(): Promise<void> {
    if (this.closed || !this.provider) return;
    this.rotating = true;
    clearTimeout(this.settleTimer);
    const previous = this.provider;
    // Finalize the previous transport before accepting its last segments. New
    // audio is already buffered for the replacement, so boundaries cannot overlap.
    await previous.flushAudio();
    if (this.closed) return;
    if ([...this.segments.values()].some((segment) => !segment.final)) {
      this.fail();
      return;
    }
    ++this.generation;
    await previous.stop();
    await previous.dispose?.();
    this.provider = null;
    this.consumed.clear();
    await this.open();
    this.scheduleSettlement();
  }

  private fail(): void {
    if (this.closed) return;
    this.options.emit({ type: "error", text: this.draft() });
    void this.stop().catch(() => undefined);
  }
}
