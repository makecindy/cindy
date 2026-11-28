import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInputController } from "../VoiceInputController";
import { VoiceTimelineLogger } from "../VoiceTimelineLogger";
import {
  endsWithSentenceBoundary,
  extractRecentRefinedContext,
  hasAdditionalSentence,
  LEGACY_MANAGED_REFINE_REQUEST_LIMIT,
  resolveManagedRefineRequestLimit,
} from "../pauseRefinement";
import type {
  AsrEvent,
  AsrProvider,
  RefineRequestBudget,
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
  options: { refineRequestBudget?: () => RefineRequestBudget | undefined } = {},
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
    precedingRefinedText?: string;
    resolve: (result: RefinementResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const refine = vi.fn(
    (input: { text: string; precedingRefinedText?: string }) =>
      new Promise<RefinementResult>((resolve, reject) => {
        requests.push({
          text: input.text,
          precedingRefinedText: input.precedingRefinedText,
          resolve,
          reject,
        });
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
    refineRequestBudget: options.refineRequestBudget,
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

// 测试价值：经句末判断和最近句子提取的公开入口，保护长口述中重复标点/空格的线性处理及原有语境输出。
// 依据：PR #13667 CodeQL 告警 564、565；旧正则在不受控 ASR 文本上可发生多项式回溯。
// 缺口：现有停顿润色测试只覆盖短句，未覆盖大段重复标点、空格及换行的边界分组。
// 最小输入：重复 ! 和空格各 10,000 字符，夹带两句及闭合引号；tier: unit，纯字符串处理。
describe("long dictation sentence boundaries", () => {
  it("recognizes terminal punctuation before closing quotes without backtracking", () => {
    expect(endsWithSentenceBoundary(`内容${"!".repeat(10_000)}”`)).toBe(true);
    expect(endsWithSentenceBoundary(`内容${"!".repeat(10_000)}”尾`)).toBe(false);
    expect(endsWithSentenceBoundary(`内容.${"'".repeat(10_000)}`)).toBe(true);
  });

  it("keeps only the recent sentences across long spaces, punctuation and newlines", () => {
    const spaces = " ".repeat(10_000);
    const punctuation = "!".repeat(10_000);
    const context = extractRecentRefinedContext(`旧句。${spaces}第二句${punctuation}\n第三句。`);
    expect(context.length).toBe(240);
    expect(context.endsWith(" 第三句。")).toBe(true);
    expect(context).not.toContain("旧句");
    expect(extractRecentRefinedContext("首句。第二句！\n第三句。", 2)).toBe("第二句！ 第三句。");
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

  it("supports multiple pauses incrementally by freezing refined prefixes without overlapping requests", async () => {
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
    expect(h.requests[1].text).toBe("第二句。");
    expect(h.requests[1].precedingRefinedText).toBe("第一句话。");
    await h.finish(1, "第二句话。");
    expect(h.drafts).toHaveBeenLastCalledWith(
      "第一句话。第二句话。",
      expect.objectContaining({ basedOnText: "第一句。第二句。" }),
      "refinement",
    );
    h.say("第一句。第二句。第三句。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.refine).toHaveBeenCalledTimes(3);
    expect(h.requests[2].text).toBe("第三句。");
    expect(h.requests[2].precedingRefinedText).toBe("第一句话。 第二句话。");
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
    // The frozen refined prefix stays visible on stop while retaining the complete raw ASR source.
    expect(h.submitted).toHaveBeenCalledWith(
      "第一句话。还有新的尾句",
      expect.objectContaining({ basedOnText: "第一句。还有新的尾句" }),
    );
    expect(h.requests[1].text).toBe("还有新的尾句");
    expect(h.requests[1].precedingRefinedText).toBe("第一句话。");
    await h.finish(1, "还有新的尾句。");
    expect(h.applied).toHaveBeenCalledWith(expect.anything(), "第一句话。还有新的尾句。");
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
    events.filter((event) => event.type === "speculative_refine_skipped");
  const budget = (limit: number, sessionKey = "session-1") => () => ({ sessionKey, limit });

  // Speaks three sentences with a pause after each, finishing every pause
  // request so the next pause is allowed to fire.
  async function speakThreeSentencesWithPauses(h: ReturnType<typeof setup>) {
    const sentences = ["第一句。", "第一句。第二句。", "第一句。第二句。第三句。"];
    for (const text of sentences) {
      const before = h.requests.length;
      h.say(text);
      await vi.advanceTimersByTimeAsync(2000);
      if (h.requests.length > before) {
        const last = h.requests.length - 1;
        await h.finish(last, `${h.requests[last].text}✓`);
      }
    }
  }

  it("keeps the last server allowance for the final text (legacy limit of 2)", async () => {
    const h = setup(true, { refineRequestBudget: budget(2) });
    await h.controller.start();
    await speakThreeSentencesWithPauses(h);
    expect(h.requests.map((r) => r.text)).toEqual(["第一句。"]);
    expect(pauseSkips(h.events)).toEqual([
      expect.objectContaining({
        stage: "pause",
        reason: "final_request_reserved",
        requestLimit: 2,
        requestsStarted: 1,
      }),
    ]);

    await h.controller.stop();
    expect(h.requests.map((r) => r.text)).toEqual([
      "第一句。",
      "第二句。第三句。",
    ]);
    await h.finish(1, "完整尾段。");
    expect(h.applied).toHaveBeenCalledExactlyOnceWith(expect.anything(), "第一句。✓完整尾段。");
  });

  it("uses every allowance but one for pauses when the server reports more", async () => {
    const h = setup(true, { refineRequestBudget: budget(3) });
    await h.controller.start();
    await speakThreeSentencesWithPauses(h);
    expect(h.requests).toHaveLength(2);
    expect(pauseSkips(h.events)).toHaveLength(1);
    await h.controller.stop();
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].text).toBe("第三句。");
  });

  it("reads the limit when a pause request is due, after the session reported it", async () => {
    let limit = LEGACY_MANAGED_REFINE_REQUEST_LIMIT;
    const h = setup(true, { refineRequestBudget: () => ({ sessionKey: "session-1", limit }) });
    await h.controller.start();
    limit = 8;
    await speakThreeSentencesWithPauses(h);
    expect(h.requests).toHaveLength(3);
    expect(pauseSkips(h.events)).toHaveLength(0);
    await h.controller.cancel();
  });

  it("starts every recording with a fresh allowance", async () => {
    const h = setup(true, { refineRequestBudget: budget(2) });
    await h.controller.start();
    await speakThreeSentencesWithPauses(h);
    await h.controller.cancel();
    await h.controller.start();
    h.say("新录音。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.requests.at(-1)?.text).toBe("新录音。");
    await h.controller.cancel();
  });

  it("starts a fresh count when a reconnect switches to a new session", async () => {
    let sessionKey = "session-1";
    const h = setup(true, { refineRequestBudget: () => ({ sessionKey, limit: 2 }) });
    await h.controller.start();
    h.say("第一句。");
    await vi.advanceTimersByTimeAsync(2000);
    await h.finish(0, "第一句话。");
    h.say("第一句。第二句。");
    await vi.advanceTimersByTimeAsync(2000);
    // The first session keeps its last request for the final text.
    expect(h.requests).toHaveLength(1);

    sessionKey = "session-2";
    h.say("第一句。第二句。第三句。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.requests.map((r) => r.text)).toEqual([
      "第一句。",
      "第二句。第三句。",
    ]);
    await h.finish(1, "二三句。");
    h.say("第一句。第二句。第三句。第四句。");
    await vi.advanceTimersByTimeAsync(2000);
    // The new session is now down to its reserved final request.
    expect(h.requests).toHaveLength(2);
    await h.controller.stop();
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].text).toBe("第四句。");
  });

  it("keeps the stop-time speculative request within the budget", async () => {
    // Without a pause request, stop speculates on the visible text; when ASR
    // then revises it, a second (final) request follows. A limit of 1 only
    // allows the final one.
    const h = setup(true, { refineRequestBudget: budget(1) });
    await h.controller.start();
    h.say("第一句。");
    h.asr.flushAudio = async () => {
      h.say("修正的第一句。");
    };
    await h.controller.stop();
    expect(h.requests.map((r) => r.text)).toEqual(["修正的第一句。"]);
    expect(pauseSkips(h.events)).toEqual([
      expect.objectContaining({ stage: "stop", requestLimit: 1, requestsStarted: 0 }),
    ]);
    await h.finish(0, "修正后的第一句。");
    expect(h.applied).toHaveBeenCalledExactlyOnceWith(expect.anything(), "修正后的第一句。");
  });

  it("still speculates at stop when the budget leaves room for the final request", async () => {
    const h = setup(true, { refineRequestBudget: budget(2) });
    await h.controller.start();
    h.say("第一句。");
    h.asr.flushAudio = async () => {
      h.say("修正的第一句。");
    };
    await h.controller.stop();
    expect(h.requests.map((r) => r.text)).toEqual(["第一句。", "修正的第一句。"]);
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

  // 测试价值：验证多停顿增量前缀冻结、ASR 回溯撤回与超长尾段分片润色（受预算约束且透传完整原始 basedOnText）。
  // 依据：语音输入优化 ⑤ 要求停顿润色按增量切片发送并附带 precedingRefinedText，避免长语音 O(N²) token 与输出截断，同时兼容 ASR 回改。
  // 缺口：既有停顿润色用例未覆盖 ASR 回溯局部/全局回退与 >600 字超长尾段自动分片润色。
  // 最小输入：2 段冻结文本发生 ASR 回溯 + 900 字多句未润色长尾段。
  // tier: unit，假时钟纯内存执行，耗时 <30ms。
  it("unwinds frozen refined prefix when ASR backtracks an earlier sentence", async () => {
    const h = setup();
    await h.controller.start();
    h.say("今天去上海。");
    await vi.advanceTimersByTimeAsync(2000);
    await h.finish(0, "今天去上海。");

    h.say("今天去上海。明天开会。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.requests[1].text).toBe("明天开会。");
    expect(h.requests[1].precedingRefinedText).toBe("今天去上海。");
    await h.finish(1, "明天开会。");

    // ASR backtracks the second sentence while keeping the first sentence intact:
    // only the second anchor unwinds; the first remains frozen.
    h.say("今天去上海。后天评审。");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.requests[2].text).toBe("后天评审。");
    expect(h.requests[2].precedingRefinedText).toBe("今天去上海。");
    await h.finish(2, "后天评审。");

    await h.controller.stop();
    expect(h.applied).toHaveBeenCalledWith(expect.anything(), "今天去上海。后天评审。");
  });

  it("chunks ultra-long unrefined tail at stop time while preserving full raw basedOnText", async () => {
    const longRaw = Array.from(
      { length: 32 },
      (_, i) => `第${i + 1}条用于验证超长语音分段润色切分边界的完整测试句子。`,
    ).join("");
    const h = setup(true, { refineRequestBudget: budget(5) });
    await h.controller.start();
    h.say(longRaw);

    await h.controller.stop();
    // Chunk 1 starts cleanly bounded under 600 chars on a sentence boundary.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].text.length).toBeLessThanOrEqual(600);
    expect(h.requests[0].text.endsWith("。")).toBe(true);
    const refinedChunk1 = h.requests[0].text.replace(/测试/g, "校验");
    await h.finish(0, refinedChunk1);

    // Chunk 2 follows with precedingRefinedText context from chunk 1.
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].precedingRefinedText).toBeTruthy();
    expect(h.requests[0].text + h.requests[1].text).toBe(longRaw);
    const refinedChunk2 = h.requests[1].text.replace(/测试/g, "校验");
    await h.finish(1, refinedChunk2);

    expect(h.submitted).toHaveBeenCalledTimes(1);
    expect(h.submitted.mock.calls[0][1].basedOnText ?? h.submitted.mock.calls[0][0]).toBe(longRaw);
    expect(h.applied).toHaveBeenCalledWith(expect.anything(), refinedChunk1 + refinedChunk2);
  });

  it("keeps the unrefined tail when only one bounded request remains", async () => {
    const raw = Array.from({ length: 40 }, (_, i) => `第${i}句超长口述需要保持未处理尾段原样。`).join("");
    const h = setup(true, { refineRequestBudget: budget(1) });
    await h.controller.start();
    h.say(raw);
    await h.controller.stop();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].text.length).toBeLessThanOrEqual(600);
    const tail = raw.slice(h.requests[0].text.length);
    await h.finish(0, h.requests[0].text.replace("超长", "长"));
    expect(h.requests).toHaveLength(1);
    expect(h.submitted.mock.calls[0][1].basedOnText ?? h.submitted.mock.calls[0][0]).toBe(raw);
    expect(h.applied).toHaveBeenCalledWith(expect.anything(), h.requests[0].text.replace("超长", "长") + tail);
  });
});
