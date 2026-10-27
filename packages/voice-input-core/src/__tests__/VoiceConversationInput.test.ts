import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent, AsrProvider, AsrSegment } from "../types.js";
import {
  VoiceConversationInput,
  type ConversationInputEvent,
} from "../VoiceConversationInput.js";
import { ConversationActivity } from "../conversationActivity.js";
import {
  SpeakerGate,
  SPEAKER_GATE_VAD_FRAME,
  type AudioGateEmit,
} from "../SpeakerGate.js";

class Provider implements AsrProvider {
  endpointing?: AsrProvider["endpointing"];
  segment: (value: AsrSegment) => void = () => {};
  event: (value: AsrEvent) => void = () => {};
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  dispose = vi.fn(async () => {});
  appendAudio = vi.fn();
  flushAudio = vi.fn(async () => {});
  commitUtterance = vi.fn();
  onSegment(callback: (value: AsrSegment) => void) {
    this.segment = callback;
  }
  onEvent(callback: (value: AsrEvent) => void) {
    this.event = callback;
  }
}
const pcm = (amplitude: number, ms = 100) =>
  new Int16Array(16 * ms).fill(amplitude).buffer;

describe("continuous speech input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Source: office-noise acceptance report. Successful-settlement diagnostics
  // cannot explain a send that never happens. Exercise the real input with fake
  // PCM/ASR and time: unit tier, no microphone, network or wall-clock waits.
  // Measured: this file's 38 tests take 56ms in the focused core run.
  it("rate-limits blocked diagnostics during sustained noise without changing auto-send timing", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const blockedDiagnostic = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => provider, emit, blockedDiagnostic,
    });
    await input.start();
    input.appendAudio(pcm(2000, 200));
    provider.segment({ id: "private-id", text: "private utterance", final: true });
    for (let frame = 0; frame < 99; frame++) {
      input.appendAudio(pcm(500));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(blockedDiagnostic).toHaveBeenCalledTimes(1);
    expect(blockedDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({
      reasons: ["speaking", "acoustic-silence"],
      pendingMs: 5_000,
      speaking: true,
      pendingFinalSegments: 0,
      rms: 500,
      threshold: 180,
      noiseFloor: 80,
      speakerFilterActive: false,
    }));
    input.appendAudio(pcm(500));
    await vi.advanceTimersByTimeAsync(100);
    expect(blockedDiagnostic).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
    // Once sound actually stops, the same 1.25s acoustic pause still applies.
    input.appendAudio(pcm(0, 900));
    await vi.advanceTimersByTimeAsync(1_149);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "private utterance" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(blockedDiagnostic).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(blockedDiagnostic.mock.calls)).not.toMatch(/private/);
    await input.stop();
  });

  it("distinguishes stalled ASR finalization from noise and stops diagnostics on teardown or stale ownership", async () => {
    const provider = new Provider();
    const blockedDiagnostic = vi.fn();
    let current = true;
    const input = new VoiceConversationInput({
      createProvider: async () => provider, emit: vi.fn(), blockedDiagnostic,
      isCurrent: () => current,
    });
    await input.start();
    input.appendAudio(pcm(0));
    provider.segment({ id: "a", text: "partial", final: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(blockedDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      reasons: ["asr-final"],
      speaking: false,
      pendingFinalSegments: 1,
      captureAgeMs: 5_000,
      forwardedAudioAgeMs: 5_000,
      asrUpdateAgeMs: 5_000,
    }));
    current = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(blockedDiagnostic).toHaveBeenCalledOnce();
    current = true;
    await input.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(blockedDiagnostic).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports audio held by the speaker gate even when capture continues", async () => {
    const provider = new Provider();
    const blockedDiagnostic = vi.fn();
    let release!: AudioGateEmit;
    let hold = false;
    const input = new VoiceConversationInput({
      createProvider: async () => provider, emit: vi.fn(), blockedDiagnostic,
      audioGate: {
        begin: (emit) => { release = emit; },
        push: (pcm, trace) => { if (!hold) release(pcm, trace); },
        abort: vi.fn(),
        finish: vi.fn(async () => {}),
      },
    });
    await input.start();
    input.appendAudio(pcm(0, 100));
    provider.segment({ id: "a", text: "soft speech", final: true, audioEndMs: 100 });
    input.finishUtterance();
    hold = true;
    await vi.advanceTimersByTimeAsync(4_900);
    input.appendAudio(pcm(0));
    await vi.advanceTimersByTimeAsync(100);
    expect(blockedDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      reasons: ["filtered-silence", "audio-silence"],
      speakerFilterActive: true,
      captureAgeMs: 100,
      forwardedAudioAgeMs: 5_000,
      filteredQuietRemainingMs: 1_150,
      audioQuietRemainingMs: 1_250,
    }));
    await input.stop();
  });

  it("rejects a short click, commits on a pause, waits for final text and sends each segment once", async () => {
    const provider = new Provider();
    const events: ConversationInputEvent[] = [];
    const input = new VoiceConversationInput({
      createProvider: async () => provider,
      emit: (event) => events.push(event),
    });
    await input.start();
    input.appendAudio(pcm(2000, 40));
    input.appendAudio(pcm(0, 1000));
    expect(events.filter((e) => e.type === "speech-started")).toHaveLength(0);
    input.appendAudio(pcm(2000));
    input.appendAudio(pcm(2000));
    provider.segment({ id: "one", text: "你好", final: false });
    input.appendAudio(pcm(0, 800));
    expect(provider.commitUtterance).not.toHaveBeenCalled();
    input.appendAudio(pcm(0, 100));
    expect(provider.commitUtterance).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(400);
    expect(events.filter((e) => e.type === "utterance")).toHaveLength(0);
    provider.segment({ id: "one", text: "你好。", final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    provider.segment({ id: "one", text: "你好。", final: true });
    provider.segment({ id: "two", text: "你好。", final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(events.filter((e) => e.type === "utterance")).toEqual([
      { type: "utterance", id: "1", text: "你好。" },
      { type: "utterance", id: "2", text: "你好。" },
    ]);
    await input.stop();
  });

  // Regression: delayed final text used to restart the complete pause timer.
  // Unit/fake time through the real input: provider audio offsets distinguish
  // already-captured speech from ASR-only speech with no reliable timing.
  it("settles a delayed corrected final after text stability without restarting acoustic silence", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({ createProvider: async () => provider, emit });
    await input.start();
    input.appendAudio(pcm(2000, 200));
    provider.segment({ id: "late", text: "partial", final: false });
    await vi.advanceTimersByTimeAsync(1_500);
    input.appendAudio(pcm(0, 1_500));
    provider.segment({ id: "late", text: "corrected final", final: true, audioEndMs: 200 });
    await vi.advanceTimersByTimeAsync(349);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "corrected final" });
    await input.stop();
  });

  it("uses audio progress for a quiet voice seen only by ASR and keeps the remaining pause", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({ createProvider: async () => provider, emit });
    await input.start();
    input.appendAudio(pcm(80, 200));
    await vi.advanceTimersByTimeAsync(900);
    input.appendAudio(pcm(0, 900));
    provider.segment({ id: "soft", text: "hello", final: true, audioEndMs: 200 });
    await vi.advanceTimersByTimeAsync(350);
    // Elapsed wall time alone is not proof the remaining captured audio is quiet.
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
    input.appendAudio(pcm(0, 350));
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "hello" });
    await input.stop();
  });

  it.each([undefined, -1, Number.NaN, 10_000])(
    "falls back to 1.25 seconds for missing or invalid ASR audio end %s",
    async (audioEndMs) => {
      const provider = new Provider();
      const emit = vi.fn();
      const input = new VoiceConversationInput({ createProvider: async () => provider, emit });
      await input.start();
      input.appendAudio(pcm(0, 2_000));
      provider.segment({ id: "soft", text: "hello", final: true, audioEndMs });
      await vi.advanceTimersByTimeAsync(1_249);
      expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
      await vi.advanceTimersByTimeAsync(1);
      expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "hello" });
      await input.stop();
    },
  );

  it.each(["segment-final", "acoustic", "manual", "semantic"] as const)(
    "does not bypass the fallback pause just because the provider declares %s",
    async (endpointing) => {
      const provider = new Provider();
      provider.endpointing = endpointing;
      const emit = vi.fn();
      const diagnostic = vi.fn();
      const input = new VoiceConversationInput({ createProvider: async () => provider, emit, diagnostic });
      await input.start();
      provider.segment({ id: "a", text: "hello", final: true,
        ...(endpointing !== "segment-final" ? { turnEnd: endpointing } : {}) });
      await vi.advanceTimersByTimeAsync(1_249);
      expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
      await vi.advanceTimersByTimeAsync(1);
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ endpointing, endSignal: endpointing }));
      expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "hello" });
      await input.stop();
    },
  );

  it("new speech cancels settlement of a delayed final and keeps both parts in one message", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({ createProvider: async () => provider, emit });
    await input.start();
    input.appendAudio(pcm(2000, 200));
    await vi.advanceTimersByTimeAsync(1_300);
    input.appendAudio(pcm(0, 1_300));
    provider.segment({ id: "a", text: "first", final: true, audioEndMs: 200 });
    await vi.advanceTimersByTimeAsync(300);
    input.appendAudio(pcm(2000, 200));
    provider.segment({ id: "b", text: "second", final: false });
    await vi.advanceTimersByTimeAsync(900);
    input.appendAudio(pcm(0, 900));
    provider.segment({ id: "b", text: "second", final: true, audioEndMs: 1_700 });
    await vi.advanceTimersByTimeAsync(349);
    input.appendAudio(pcm(0, 349));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
    await vi.advanceTimersByTimeAsync(1);
    input.appendAudio(pcm(0, 1));
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "first second" });
    await input.stop();
  });

  it("rebases provider audio offsets after rotation and rejects the previous socket's final", async () => {
    const a = new Provider();
    const b = new Provider();
    const createProvider = vi.fn().mockResolvedValueOnce(a).mockResolvedValue(b);
    const emit = vi.fn();
    const input = new VoiceConversationInput({ createProvider, emit, rotationMs: 5_000 });
    await input.start();
    input.appendAudio(pcm(0, 5_000));
    await vi.advanceTimersByTimeAsync(5_000);
    input.appendAudio(pcm(80, 200));
    input.appendAudio(pcm(0, 900));
    b.segment({ id: "same", text: "new turn", final: true, audioEndMs: 200 });
    a.segment({ id: "same", text: "stale", final: true, audioEndMs: 200 });
    await vi.advanceTimersByTimeAsync(350);
    // The old provider's 5s of audio cannot satisfy the new provider's pause.
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
    input.appendAudio(pcm(0, 350));
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "new turn" });
    await input.stop();
  });

  it("requires 1.25 quiet seconds for ASR-only soft speech and merges a thinking pause", async () => {
    const provider = new Provider();
    const events: ConversationInputEvent[] = [];
    const diagnostic = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => provider,
      emit: (event) => events.push(event),
      diagnostic,
    });
    await input.start();
    provider.segment({ id: "soft", text: "first part", final: true });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(events.some((event) => event.type === "utterance")).toBe(false);
    // Continue within the thinking pause. Even a provider-finalized first part
    // must remain in this utterance until the new activity has also settled.
    input.appendAudio(pcm(2000, 200));
    provider.segment({ id: "next", text: "second part", final: true });
    await vi.advanceTimersByTimeAsync(900);
    input.appendAudio(pcm(0, 900));
    expect(provider.commitUtterance).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(349);
    expect(events.some((event) => event.type === "utterance")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.filter((event) => event.type === "utterance")).toEqual([
      { type: "utterance", id: "1", text: "first part second part" },
    ]);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      trigger: "silence",
      inactiveMs: 1_250,
      pauseBasis: "text-fallback",
      endpointing: "segment-final",
      endSignal: "segment-final",
      finalStableMs: 1_250,
      segments: 2,
      characters: 22,
    });
    await input.stop();
  });

  // #5718 review: existing soft-speech cases deliver a final, and timeout
  // coverage manually finishes input. Unit/fake time through the production
  // input: a partial without local VAD must time out after quiet, retaining text.
  // Standalone file validation: 0.40s wall time.
  it("bounds finalization for ASR-only speech and preserves the partial", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const failureDiagnostic = vi.fn();
    const input = new VoiceConversationInput({ createProvider: async () => provider, emit, failureDiagnostic });
    await input.start();
    input.appendAudio(pcm(80, 200));
    provider.segment({ id: "soft", text: "keep this", final: false });
    await vi.advanceTimersByTimeAsync(4_000);
    provider.segment({ id: "soft", text: "keep this", final: false });
    await vi.advanceTimersByTimeAsync(5_249);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({ type: "error", text: "keep this" });
    expect(failureDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "final_timeout", finalWaitMs: 8_000,
    }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "utterance" }));
    await input.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("extends the soft-speech deadline on new words and cancels it on real speech or a final", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({ createProvider: async () => provider, emit });
    await input.start();
    provider.segment({ id: "soft", text: "first", final: false });
    await vi.advanceTimersByTimeAsync(8_000);
    provider.segment({ id: "soft", text: "first second", final: false });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    input.appendAudio(pcm(2_000, 200));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    input.appendAudio(pcm(0, 900));
    provider.segment({ id: "soft", text: "first second third", final: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledWith({ type: "utterance", id: "1", text: "first second third" });
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await input.stop();
  });

  it("releases a noise-only onset after the quiet window without sending or waiting for an ASR segment", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => provider,
      emit,
    });
    await input.start();
    input.appendAudio(pcm(800, 200));
    expect(emit).toHaveBeenCalledWith({ type: "speech-started" });
    await vi.advanceTimersByTimeAsync(900);
    input.appendAudio(pcm(0, 900));
    await vi.advanceTimersByTimeAsync(349);
    expect(emit).not.toHaveBeenCalledWith({ type: "speech-idle" });
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({ type: "speech-idle" });
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "utterance" }),
    );
    await input.stop();
  });

  it("does not let an unchanged final bypass the remaining quiet window or retain an empty draft", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => provider,
      emit,
    });
    await input.start();
    provider.segment({ id: "one", text: "soft speech", final: false });
    await vi.advanceTimersByTimeAsync(1_000);
    provider.segment({ id: "one", text: "soft speech", final: true });
    await vi.advanceTimersByTimeAsync(349);
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "utterance" }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({
      type: "utterance",
      id: "1",
      text: "soft speech",
    });
    provider.segment({ id: "empty", text: "discarded partial", final: false });
    provider.segment({ id: "empty", text: "", final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(emit).toHaveBeenCalledWith({ type: "speech-idle" });
    expect(
      emit.mock.calls.filter(([event]) => event.type === "utterance"),
    ).toHaveLength(1);
    await input.stop();
  });

  it("does not mistake an out-of-order final for the complete utterance", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => provider,
      emit,
    });
    await input.start();
    provider.segment({ id: "a", text: "", final: false, order: 0 });
    provider.segment({ id: "b", text: "second", final: true, order: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "utterance" }),
    );
    provider.segment({ id: "a", text: "first", final: true, order: 0 });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(emit).toHaveBeenCalledWith({
      type: "utterance",
      id: "1",
      text: "first second",
    });
    await input.stop();
  });

  it("lets Send finish a finalized sentence despite background activity, but never sends a partial", async () => {
    const provider = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => provider,
      emit,
    });
    await input.start();
    input.appendAudio(pcm(2000, 200));
    provider.segment({ id: "one", text: "partial", final: false });
    input.finishUtterance(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "utterance" }),
    );
    provider.segment({ id: "one", text: "final", final: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({
      type: "utterance",
      id: "1",
      text: "final",
    });
    await input.stop();
  });

  it("buffers capture during rotation and fences repeated/late segments from the previous socket", async () => {
    const a = new Provider();
    const b = new Provider();
    const emit = vi.fn();
    let finish!: () => void;
    a.flushAudio.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const createProvider = vi
      .fn()
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b);
    const input = new VoiceConversationInput({
      createProvider,
      emit,
      rotationMs: 10_000,
    });
    await input.start();
    a.segment({ id: "same", text: "before", final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.advanceTimersByTimeAsync(8_750);
    const buffered = pcm(1000, 200);
    input.appendAudio(buffered);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.appendAudio).toHaveBeenCalledWith(buffered, undefined);
    a.segment({ id: "late", text: "ignore", final: true });
    b.segment({ id: "same", text: "after", final: true });
    input.appendAudio(pcm(0, 900));
    await vi.advanceTimersByTimeAsync(1_250);
    expect(
      emit.mock.calls
        .filter(([e]) => e.type === "utterance")
        .map(([e]) => e.text),
    ).toEqual(["before", "after"]);
    expect(a.dispose).toHaveBeenCalledOnce();
    await input.stop();
  });

  it("stays available through ten minutes of silence and ASR rotation without sending empty messages", async () => {
    const providers: Provider[] = [];
    const emit = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => {
        const provider = new Provider();
        providers.push(provider);
        return provider;
      },
      emit,
    });
    await input.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(providers).toHaveLength(5);
    expect(
      emit.mock.calls.filter(([event]) => event.type === "ready"),
    ).toHaveLength(5);
    expect(
      emit.mock.calls.some(
        ([event]) => event.type === "error" || event.type === "utterance",
      ),
    ).toBe(false);
    expect(providers[4].stop).not.toHaveBeenCalled();
    providers[4].segment({
      id: "after-silence",
      text: "still listening",
      final: true,
    });
    await vi.advanceTimersByTimeAsync(1_249);
    expect(emit.mock.calls.some(([event]) => event.type === "utterance")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith({
      type: "utterance",
      id: "1",
      text: "still listening",
    });
    await input.stop();
  });

  it("retains a partial transcript on disconnect and ignores late finals after stopping", async () => {
    const p = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => p,
      emit,
    });
    await input.start();
    p.segment({ id: "a", text: "keep me", final: false });
    p.event({ type: "disconnected", at: 0 });
    p.segment({ id: "a", text: "late", final: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit).toHaveBeenCalledWith({ type: "error", text: "keep me" });
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "utterance" }),
    );
    expect(p.stop).toHaveBeenCalledOnce();
  });

  it("disposes a provider whose creation resolves after cancellation", async () => {
    const p = new Provider();
    let resolve!: (provider: AsrProvider) => void;
    const input = new VoiceConversationInput({
      createProvider: () =>
        new Promise((done) => {
          resolve = done;
        }),
      emit: vi.fn(),
    });
    const starting = input.start();
    await input.stop();
    resolve(p);
    await starting;
    expect(p.start).not.toHaveBeenCalled();
    expect(p.dispose).toHaveBeenCalledOnce();
  });

  it("settles an empty recognition without sending noise or leaving a stale pending item", async () => {
    const p = new Provider();
    const emit = vi.fn();
    const input = new VoiceConversationInput({
      createProvider: async () => p,
      emit,
    });
    await input.start();
    p.segment({ id: "noise", text: "", final: false });
    p.segment({ id: "noise", text: "", final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    p.segment({ id: "speech", text: "hello", final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(emit.mock.calls.filter(([e]) => e.type === "utterance")).toEqual([
      [{ type: "utterance", id: "1", text: "hello" }],
    ]);
    await input.stop();
  });
});

// Real input + SpeakerGate, synthetic VAD/embedding only. Prior input tests
// bypassed speaker verification: a rejected 200ms voice could interrupt or
// reach ASR. Unit/fake-time cases also protect short onsets and delayed audio
// from being mistaken for silence; no model downloads or microphone access.
describe("speaker-filtered conversation input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fixture(rotationMs?: number) {
    const provider = new Provider();
    const createProvider = vi.fn(async () => provider);
    const emit = vi.fn();
    const engine = {
      resetVad: vi.fn(async () => {}),
      detectSpeech: vi.fn(async (samples: Float32Array) =>
        Array.from(
          { length: samples.length / SPEAKER_GATE_VAD_FRAME },
          (_, i) => Math.abs(samples[i * SPEAKER_GATE_VAD_FRAME]) > 0.01,
        ),
      ),
      embed: vi.fn(
        async (samples: Float32Array) =>
          new Float32Array(
            samples.reduce((sum, value) => sum + value, 0) > 0
              ? [1, 0]
              : [0, 1],
          ),
      ),
    };
    const audioGate = new SpeakerGate({
      engine,
      enrolledEmbedding: new Float32Array([1, 0]),
    });
    const input = new VoiceConversationInput({
      createProvider,
      audioGate,
      emit,
      rotationMs,
    });
    const feed = async (level: number, ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 40) {
        input.appendAudio(pcm(level, Math.min(40, ms - elapsed)));
        await vi.advanceTimersByTimeAsync(Math.min(40, ms - elapsed));
      }
    };
    return { input, provider, emit, engine, audioGate, feed, createProvider };
  }

  it.each([160, 240])(
    "preserves a %ims short phrase including its onset, without waiting for a full window",
    async (duration) => {
      const f = fixture();
      f.provider.appendAudio.mockImplementation((chunk: ArrayBuffer) => {
        if (new Int16Array(chunk).some((sample) => sample > 0))
          f.provider.segment({ id: "short", text: "hello", final: true });
      });
      await f.input.start();
      await f.feed(2000, duration);
      expect(f.provider.appendAudio).not.toHaveBeenCalled();
      expect(f.emit).not.toHaveBeenCalledWith({ type: "speech-started" });
      await f.feed(0, 80);
      expect(f.emit).toHaveBeenCalledWith({ type: "speech-started" });
      const voicedSamples = f.provider.appendAudio.mock.calls.reduce(
        (count, [chunk]) =>
          count +
          new Int16Array(chunk).filter((sample) => sample === 2000).length,
        0,
      );
      expect(voicedSamples).toBe(16 * duration);
      await f.feed(0, 2_000);
      expect(
        f.emit.mock.calls.filter(([event]) => event.type === "utterance"),
      ).toEqual([[{ type: "utterance", id: "1", text: "hello" }]]);
      await f.input.stop();
    },
  );

  it("turns bystander speech into silence before ASR and interruption/exit activity", async () => {
    const f = fixture();
    await f.input.start();
    await f.feed(-2000, 1_600);
    await f.feed(0, 2_000);
    expect(f.engine.embed).toHaveBeenCalled();
    expect(f.provider.appendAudio).toHaveBeenCalled();
    expect(
      f.provider.appendAudio.mock.calls.every(([chunk]) =>
        new Int16Array(chunk).every((sample) => sample === 0),
      ),
    ).toBe(true);
    expect(f.emit.mock.calls).toEqual([[{ type: "ready" }]]);
    await f.input.stop();
  });

  it("signals accepted continuous speech after the existing first decision window, without a second hold", async () => {
    const f = fixture();
    await f.input.start();
    await f.feed(2000, 1_480);
    expect(f.emit).not.toHaveBeenCalledWith({ type: "speech-started" });
    await f.feed(2000, 80);
    expect(
      f.emit.mock.calls.filter(([event]) => event.type === "speech-started"),
    ).toHaveLength(1);
    await f.input.stop();
  });

  it("retains a short onset held across ASR rotation and forwards it only to the new transport", async () => {
    const f = fixture(1_000);
    const next = new Provider();
    f.createProvider.mockResolvedValueOnce(f.provider).mockResolvedValue(next);
    await f.input.start();
    await f.feed(0, 960);
    await f.feed(2000, 240);
    await f.feed(0, 80);
    expect(f.createProvider).toHaveBeenCalledTimes(2);
    expect(
      f.provider.appendAudio.mock.calls.every(([chunk]) =>
        new Int16Array(chunk).every((sample) => sample === 0),
      ),
    ).toBe(true);
    expect(
      next.appendAudio.mock.calls.reduce(
        (count, [chunk]) =>
          count +
          new Int16Array(chunk).filter((sample) => sample === 2000).length,
        0,
      ),
    ).toBe(16 * 240);
    expect(f.emit).toHaveBeenCalledWith({ type: "speech-started" });
    await f.input.stop();
  });

  it("keeps the existing filter failure fallback usable for ASR and interruption", async () => {
    const f = fixture();
    f.engine.embed.mockRejectedValueOnce(new Error("engine unavailable"));
    await f.input.start();
    await f.feed(2000, 240);
    await f.feed(0, 80);
    expect(
      f.provider.appendAudio.mock.calls.some(([chunk]) =>
        new Int16Array(chunk).some((sample) => sample === 2000),
      ),
    ).toBe(true);
    expect(f.emit).toHaveBeenCalledWith({ type: "speech-started" });
    expect(f.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
    await f.input.stop();
  });

  it.each([false, true])("does not count held audio as quiet and split a continued sentence (timed final: %s)", async (timed) => {
    const provider = new Provider();
    const emit = vi.fn();
    let release!: AudioGateEmit;
    const input = new VoiceConversationInput({
      createProvider: async () => provider,
      emit,
      audioGate: {
        begin: (callback) => {
          release = callback;
        },
        push: () => {},
        finish: async () => {},
        abort: () => {},
      },
    });
    await input.start();
    release(pcm(2000, 200));
    provider.segment({ id: "first", text: "first", final: true, ...(timed ? { audioEndMs: 200 } : {}) });
    release(pcm(0, 900));
    // The gate is still deciding the next voice. Wall-clock quiet alone would
    // submit "first" while that voice is waiting for its speaker verdict.
    input.appendAudio(pcm(2000, 800));
    await vi.advanceTimersByTimeAsync(1_250);
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "utterance" }),
    );
    release(pcm(2000, 800));
    provider.segment({ id: "second", text: "second", final: true, ...(timed ? { audioEndMs: 1900 } : {}) });
    release(pcm(0, 1_250));
    await vi.advanceTimersByTimeAsync(1_250);
    expect(emit).toHaveBeenCalledWith({
      type: "utterance",
      id: "1",
      text: "first second",
    });
    await input.stop();
  });

  it("lets Send submit verified text without flushing undecided speech or waiting for filtered silence", async () => {
    const f = fixture();
    const finish = vi.spyOn(f.audioGate, "finish");
    await f.input.start();
    await f.feed(2000, 240);
    await f.feed(0, 80);
    f.provider.segment({ id: "accepted", text: "send this", final: true });
    await f.feed(-2000, 160);
    const callsBeforeSend = f.provider.appendAudio.mock.calls.length;
    f.input.finishUtterance(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.emit).toHaveBeenCalledWith({
      type: "utterance",
      id: "1",
      text: "send this",
    });
    expect(finish).not.toHaveBeenCalled();
    expect(f.provider.appendAudio).toHaveBeenCalledTimes(callsBeforeSend);
    await f.input.stop();
  });

  it.each(["stop", "error"] as const)(
    "discards an in-flight speaker verdict on %s",
    async (action) => {
      const f = fixture();
      let finish!: (embedding: Float32Array<ArrayBuffer>) => void;
      f.engine.embed.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await f.input.start();
      await f.feed(2000, 240);
      await f.feed(0, 80);
      expect(f.engine.embed).toHaveBeenCalledOnce();
      if (action === "stop") await f.input.stop();
      else f.provider.event({ type: "disconnected", at: 0 });
      f.emit.mockClear();
      finish(new Float32Array([1, 0]));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.provider.appendAudio).not.toHaveBeenCalled();
      expect(f.emit).not.toHaveBeenCalled();
    },
  );
});

it("keeps soft speech active and does not end it on a short pause", () => {
  const gate = new ConversationActivity();
  expect(gate.push(pcm(800, 200)).started).toBe(true);
  expect(gate.push(pcm(240, 500)).active).toBe(true);
  expect(gate.push(pcm(0, 500)).ended).toBe(false);
  expect(gate.push(pcm(400, 200)).active).toBe(true);
  expect(gate.push(pcm(0, 900)).ended).toBe(true);
});
