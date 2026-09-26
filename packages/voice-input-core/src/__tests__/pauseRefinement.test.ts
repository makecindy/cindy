import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInputController } from "../VoiceInputController";
import { VoiceTimelineLogger } from "../VoiceTimelineLogger";
import {
  hasAdditionalSentence,
  LEGACY_MANAGED_REFINE_REQUEST_LIMIT,
  resolveManagedRefineRequestLimit,
} from "../pauseRefinement";
import type {
  AsrEvent,
  AsrProvider,
  RefinementResult,
  SpeechSegment,
  VoiceTimelineEvent,
} from "../types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup(
  enabled = true,
  options: { refineRequestLimit?: () => number | undefined } = {},
) {
  let event: (value: AsrEvent) => void = () => {};
  const asr: AsrProvider = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    appendAudio: vi.fn(),
    flushAudio: vi.fn(async () => {}),
    onEvent: (listener) => {
      event = listener;
    },
  };
  const requests: Array<{
    text: string;
    resolve: (result: RefinementResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const refine = vi.fn(
    (input: { text: string }) =>
      new Promise<RefinementResult>((resolve, reject) => {
        requests.push({ text: input.text, resolve, reject });
      }),
  );
  const drafts = vi.fn();
  const submitted = vi.fn((text: string, segment: SpeechSegment) => ({
    id: "range",
    segmentIds: [segment.id],
    startOffset: 0,
    endOffset: text.length,
    userTouched: false,
  }));
  const applied = vi.fn(() => true);
  const events: VoiceTimelineEvent[] = [];
  const controller = new VoiceInputController({
    asr,
    refiner: { refine },
    logger: new VoiceTimelineLogger((timelineEvent) => events.push(timelineEvent)),
    pauseRefinementEnabled: enabled,
    refineRequestLimit: options.refineRequestLimit,
    callbacks: {
      onDraftChanged: drafts,
      onSubmitted: submitted,
      applyRefinement: applied,
    },
  });
  const say = (text: string, type: "partial" | "stable" = "stable") =>
    event({ type, text, at: Date.now() });
  const finish = async (index: number, text: string) => {
    requests[index].resolve({
      accepted: true,
      basedOnText: requests[index].text,
      refinedText: text,
      sourceSegmentIds: [],
      elapsedMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    asr,
    controller,
    refine,
    requests,
    drafts,
    submitted,
    applied,
    events,
    say,
    finish,
  };
}

describe("sentence growth", () => {
  it("allows one short sentence and an unpunctuated sentence completed by a pause", () => {
    expect(hasAdditionalSentence("", "好。")).toBe(true);
    expect(hasAdditionalSentence("", "帮我看看")).toBe(true);
    expect(hasAdditionalSentence("", "……")).toBe(false);
  });
  it("requires another sentence, not repeated text or a same-sentence revision", () => {
    expect(hasAdditionalSentence("第一句。", "第一句。")).toBe(false);
    expect(hasAdditionalSentence("第一句。", "修正的第一句。")).toBe(false);
    expect(hasAdditionalSentence("第一句", "第一句。")).toBe(false);
    expect(hasAdditionalSentence("第一句。", "第一句。第二句。")).toBe(true);
    expect(hasAdditionalSentence("Use 3.14.", "Use 3.14. Next sentence.")).toBe(
      true,
    );
  });
});

describe("pause refinement", () => {
  it("refines one sentence after two seconds and publishes immediately while still listening", async () => {
    const h = setup();
    await h.controller.start();
    h.say("帮我看看。");
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.refine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.refine).toHaveBeenCalledOnce();
    await h.finish(0, "帮我看一下。");
    expect(h.controller.currentState).toBe("listening");
    expect(h.drafts).toHaveBeenLastCalledWith(
      "帮我看一下。",
      expect.objectContaining({ basedOnText: "帮我看看。" }),
      "refinement",
    );
    expect(h.submitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.refine).toHaveBeenCalledOnce();
    await h.controller.cancel();
  });

  it("waits for silence and unchanged text; repeated identical ASR events do not delay it", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(1000);
    h.controller.appendAudio(new Int16Array(160).fill(512).buffer);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.refine).not.toHaveBeenCalled();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.refine).toHaveBeenCalledOnce();
    await h.controller.cancel();
  });

  it("supports multiple pauses with at least a sentence added, without overlapping requests", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    h.say("第一句。第二句。");
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.refine).toHaveBeenCalledOnce();
    await h.finish(0, "第一句话。");
    expect(h.drafts).toHaveBeenLastCalledWith(
      "第一句话。第二句。",
      expect.anything(),
      "refinement",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.refine).toHaveBeenCalledTimes(2);
    await h.finish(1, "第一句话。第二句话。");
    h.say("第一句。第二句。第三句。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.refine).toHaveBeenCalledTimes(3);
    expect(h.requests[2].text).toBe("第一句。第二句。第三句。");
    await h.controller.cancel();
  });

  it("does not overwrite revised ASR text with a stale result", async () => {
    const h = setup();
    await h.controller.start();
    h.say("去北京。");
    await vi.advanceTimersByTimeAsync(2000);
    h.say("去南京。");
    await h.finish(0, "去北京市。");
    expect(h.drafts).toHaveBeenLastCalledWith(
      "去南京。",
      expect.anything(),
      "stable",
    );
    await h.controller.cancel();
  });

  it("reuses a completed pause request at stop", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    await h.finish(0, "第一句话。");
    await h.controller.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.refine).toHaveBeenCalledOnce();
    expect(h.applied).toHaveBeenCalledWith(expect.anything(), "第一句话。");
    expect(h.submitted).toHaveBeenCalledExactlyOnceWith(
      "第一句话。",
      expect.objectContaining({ text: "第一句话。", basedOnText: "第一句。" }),
    );
    expect(h.controller.currentState).toBe("done");
  });

  it("reuses an in-flight pause request at stop", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    await h.controller.stop();
    expect(h.refine).toHaveBeenCalledOnce();
    await h.finish(0, "第一句话。");
    expect(h.applied).toHaveBeenCalledOnce();
    expect(h.controller.currentState).toBe("done");
  });

  it("does not reuse old text when the final ASR result changes", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    await h.finish(0, "第一句话。");
    h.asr.flushAudio = async () => {
      h.say("修正的第一句。");
    };
    await h.controller.stop();
    expect(h.refine).toHaveBeenCalledTimes(2);
    expect(h.requests[1].text).toBe("修正的第一句。");
    await h.finish(1, "修正后的第一句话。");
    expect(h.applied).toHaveBeenLastCalledWith(
      expect.anything(),
      "修正后的第一句话。",
    );
  });

  it("ignores late results after cancellation and restart", async () => {
    const h = setup();
    await h.controller.start();
    h.say("旧录音。");
    await vi.advanceTimersByTimeAsync(2000);
    await h.controller.cancel();
    await h.controller.start();
    h.say("新录音。");
    await h.finish(0, "旧的录音。");
    expect(h.drafts).toHaveBeenLastCalledWith(
      "新录音。",
      expect.anything(),
      "stable",
    );
    expect(h.controller.currentState).toBe("listening");
    await h.controller.cancel();
  });

  it("skips the intermediate stop request when text changes again during finalization", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    h.say("第一句。新尾句", "partial");
    let release!: () => void;
    h.asr.flushAudio = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const stopping = h.controller.stop();
    expect(h.requests.map((r) => r.text)).toEqual(["第一句。"]);
    h.say("第一句。最终尾句。");
    release();
    await stopping;
    expect(h.requests.map((r) => r.text)).toEqual([
      "第一句。",
      "第一句。最终尾句。",
    ]);
    await h.finish(0, "旧结果。");
    expect(h.applied).not.toHaveBeenCalled();
    await h.finish(1, "完整结果。");
    expect(h.applied).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "完整结果。",
    );
  });

  it("reuses refinement that completes while ASR is flushing without reverting to raw text", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    let release!: () => void;
    h.asr.flushAudio = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const stopping = h.controller.stop();
    await h.finish(0, "第一句话。");
    expect(h.submitted).not.toHaveBeenCalled();
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.refine).toHaveBeenCalledOnce();
    expect(h.submitted).toHaveBeenCalledExactlyOnceWith(
      "第一句话。",
      expect.anything(),
    );
    expect(h.controller.currentState).toBe("done");
  });

  it("does not drop a newer partial tail in favor of an old stable sentence at stop", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    await h.finish(0, "第一句话。");
    h.say("第一句。还有新的尾句", "partial");
    const stopping = h.controller.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    expect(h.submitted).toHaveBeenCalledWith(
      "第一句。还有新的尾句",
      expect.anything(),
    );
    expect(h.requests[1].text).toBe("第一句。还有新的尾句");
    await h.finish(1, "第一句话。还有新的尾句。");
    expect(h.controller.currentState).toBe("done");
  });

  it("keeps raw text on failure without retrying unchanged text", async () => {
    const h = setup();
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    h.requests[0].reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.refine).toHaveBeenCalledOnce();
    expect(h.drafts).toHaveBeenLastCalledWith(
      "第一句。",
      expect.anything(),
      "stable",
    );
    await h.controller.cancel();
  });

  it("does not enable paid speculative calls for hosts that have not opted in", async () => {
    const h = setup(false);
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.refine).not.toHaveBeenCalled();
    await h.controller.cancel();
  });
});

describe("refine request limit", () => {
  const pauseSkips = (events: VoiceTimelineEvent[]) =>
    events.filter((event) => event.type === "pause_refine_skipped");

  // Speaks three sentences with a pause after each, finishing every pause
  // request so the next pause is allowed to fire.
  async function speakThreeSentencesWithPauses(h: ReturnType<typeof setup>) {
    const sentences = ["第一句。", "第一句。第二句。", "第一句。第二句。第三句。"];
    for (const text of sentences) {
      h.say(text);
      await vi.advanceTimersByTimeAsync(2000);
      const last = h.requests.length - 1;
      if (last >= 0 && h.requests[last].text === text) await h.finish(last, `${text}✓`);
    }
  }

  it("keeps the last server allowance for the final text (legacy limit of 2)", async () => {
    const h = setup(true, { refineRequestLimit: () => 2 });
    await h.controller.start();
    await speakThreeSentencesWithPauses(h);
    expect(h.requests.map((r) => r.text)).toEqual(["第一句。"]);
    expect(pauseSkips(h.events)).toEqual([
      expect.objectContaining({
        reason: "final_request_reserved",
        requestLimit: 2,
        requestsStarted: 1,
      }),
    ]);

    await h.controller.stop();
    expect(h.requests.map((r) => r.text)).toEqual([
      "第一句。",
      "第一句。第二句。第三句。",
    ]);
    await h.finish(1, "完整结果。");
    expect(h.applied).toHaveBeenCalledExactlyOnceWith(expect.anything(), "完整结果。");
  });

  it("uses every allowance but one for pauses when the server reports more", async () => {
    const h = setup(true, { refineRequestLimit: () => 3 });
    await h.controller.start();
    await speakThreeSentencesWithPauses(h);
    expect(h.requests).toHaveLength(2);
    expect(pauseSkips(h.events)).toHaveLength(1);
    await h.controller.stop();
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].text).toBe("第一句。第二句。第三句。");
  });

  it("reads the limit when a pause request is due, after the session reported it", async () => {
    let limit = LEGACY_MANAGED_REFINE_REQUEST_LIMIT;
    const h = setup(true, { refineRequestLimit: () => limit });
    await h.controller.start();
    limit = 8;
    await speakThreeSentencesWithPauses(h);
    expect(h.requests).toHaveLength(3);
    expect(pauseSkips(h.events)).toHaveLength(0);
    await h.controller.cancel();
  });

  it("starts every recording with a fresh allowance", async () => {
    const h = setup(true, { refineRequestLimit: () => 2 });
    await h.controller.start();
    await speakThreeSentencesWithPauses(h);
    await h.controller.cancel();
    await h.controller.start();
    h.say("新录音。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.requests.at(-1)?.text).toBe("新录音。");
    await h.controller.cancel();
  });

  it("does not limit refiners without a reported limit", async () => {
    const h = setup();
    await h.controller.start();
    await speakThreeSentencesWithPauses(h);
    expect(h.requests).toHaveLength(3);
    await h.controller.cancel();
  });

  it("falls back to the legacy limit when the server does not report a usable one", () => {
    expect(resolveManagedRefineRequestLimit(8)).toBe(8);
    expect(resolveManagedRefineRequestLimit(undefined)).toBe(2);
    expect(resolveManagedRefineRequestLimit(0)).toBe(2);
    expect(resolveManagedRefineRequestLimit(2.5)).toBe(2);
    expect(resolveManagedRefineRequestLimit("8")).toBe(2);
  });
});
