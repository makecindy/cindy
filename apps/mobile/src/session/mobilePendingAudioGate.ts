import type { AudioGate, AudioTrace } from '@cindy/voice-input-core';

/**
 * Opening the microphone must not wait for AsyncStorage / Keychain. Hold the
 * first PCM locally until createMobileSpeakerGate's bounded hydration finishes;
 * no unfiltered samples reach the ASR while the account's settings are unknown.
 */
export class MobilePendingAudioGate implements AudioGate {
  private gate?: AudioGate;
  private ready = false;
  private emit?: (chunk: ArrayBuffer, trace?: AudioTrace) => void;
  private pending: Array<{ chunk: ArrayBuffer; trace?: AudioTrace }> = [];
  private readonly resolved: Promise<void>;

  constructor(gate: Promise<AudioGate | undefined>, onError: (error: unknown) => void) {
    this.resolved = gate.then((value) => {
      this.gate = value;
      this.ready = true;
      if (!this.emit) return;
      value?.begin(this.emit);
      const pending = this.pending;
      this.pending = [];
      for (const { chunk, trace } of pending) this.push(chunk, trace);
    }).catch((error: unknown) => {
      this.abort();
      onError(error);
      throw error;
    });
    // finish() observes failure. Never leak an unhandled rejection if cancelled.
    void this.resolved.catch(() => undefined);
  }

  begin(emit: (chunk: ArrayBuffer, trace?: AudioTrace) => void): void {
    this.abort();
    this.emit = emit;
    if (this.ready) this.gate?.begin(emit);
  }

  push(chunk: ArrayBuffer, trace?: AudioTrace): void {
    if (!this.emit) return;
    if (!this.ready) {
      this.pending.push({ chunk, trace });
    } else if (this.gate) {
      this.gate.push(chunk, trace);
    } else {
      this.emit(chunk, trace);
    }
  }

  async finish(): Promise<void> {
    await this.resolved;
    if (this.emit) await this.gate?.finish();
  }

  abort(): void {
    this.emit = undefined;
    this.pending = [];
    this.gate?.abort();
  }
}
