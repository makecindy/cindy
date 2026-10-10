import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent, AsrProvider, AsrSegment } from "../types.js";
import {
  VoiceConversationInput,
  type ConversationInputEvent,
} from "../VoiceConversationInput.js";
import { ConversationActivity } from "../conversationActivity.js";

class Provider implements AsrProvider {
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
    await vi.advanceTimersByTimeAsync(350);
    provider.segment({ id: "one", text: "你好。", final: true });
    provider.segment({ id: "two", text: "你好。", final: true });
    await vi.advanceTimersByTimeAsync(350);
    expect(events.filter((e) => e.type === "utterance")).toEqual([
      { type: "utterance", id: "1", text: "你好。" },
      { type: "utterance", id: "2", text: "你好。" },
    ]);
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
    await vi.advanceTimersByTimeAsync(350);
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
      rotationMs: 1000,
    });
    await input.start();
    a.segment({ id: "same", text: "before", final: true });
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(650);
    const buffered = pcm(1000, 200);
    input.appendAudio(buffered);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.appendAudio).toHaveBeenCalledWith(buffered, undefined);
    a.segment({ id: "late", text: "ignore", final: true });
    b.segment({ id: "same", text: "after", final: true });
    input.appendAudio(pcm(0, 900));
    await vi.advanceTimersByTimeAsync(350);
    expect(
      emit.mock.calls
        .filter(([e]) => e.type === "utterance")
        .map(([e]) => e.text),
    ).toEqual(["before", "after"]);
    expect(a.dispose).toHaveBeenCalledOnce();
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
    await vi.advanceTimersByTimeAsync(350);
    p.segment({ id: "speech", text: "hello", final: true });
    await vi.advanceTimersByTimeAsync(350);
    expect(emit.mock.calls.filter(([e]) => e.type === "utterance")).toEqual([
      [{ type: "utterance", id: "1", text: "hello" }],
    ]);
    await input.stop();
  });
});

it("keeps soft speech active and does not end it on a short pause", () => {
  const gate = new ConversationActivity();
  expect(gate.push(pcm(800, 200)).started).toBe(true);
  expect(gate.push(pcm(240, 500)).active).toBe(true);
  expect(gate.push(pcm(0, 500)).ended).toBe(false);
  expect(gate.push(pcm(400, 200)).active).toBe(true);
  expect(gate.push(pcm(0, 900)).ended).toBe(true);
});
