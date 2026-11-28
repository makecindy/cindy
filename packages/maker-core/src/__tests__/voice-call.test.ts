import { describe, expect, it, vi } from "vitest";
import { VoiceCallContext } from "../voice-call.js";

type Deps = ConstructorParameters<typeof VoiceCallContext>[0];
function setup(
  generate = vi.fn<Deps["generate"]>(async () => '{"say":"Hello."}'),
) {
  const handoff = vi.fn<Deps["handoff"]>(async () => true);
  const changed = vi.fn();
  const call = new VoiceCallContext({
    callId: "call-1",
    identity: "Cindy",
    reference: "Previous context",
    generate,
    handoff,
    changed,
  });
  return { call, generate, handoff, changed };
}

describe("independent voice call", () => {
  it("dispatches only the accepted native transcript once and never runs text generation", async () => {
    const { call, handoff, generate } = setup();
    expect(await call.handoffNativeTurn("unknown", "forged")).toBe(false);
    expect(call.recordNativeTurn("native", "user", "请查一下这个问题")).toBe(true);
    expect(call.recordNativeTurn("native", "user", "replacement")).toBe(false);
    await Promise.all([call.handoffNativeTurn("native", "context"), call.handoffNativeTurn("native", "duplicate")]);
    expect(handoff).toHaveBeenCalledExactlyOnceWith({ id: "voice-task:call-1:native", inputId: "native", original: "请查一下这个问题", supplement: "context" });
    expect(generate).not.toHaveBeenCalled();
    call.recordNativeTurn("answer", "assistant", "Partial", false);
    call.interruptNativeTurn("answer");
    expect(call.recordNativeTurn("answer", "assistant", "Late final")).toBe(false);
    expect(call.record.turns.at(-1)).toMatchObject({ text: "Partial", complete: true });
    expect(call.record.turns.at(-1)?.failed).toBeFalsy();
    call.end();
    expect(call.recordNativeTurn("late", "user", "Late")).toBe(false);
  });

  it("delivers native task results once and retains accepted work after ending", async () => {
    const result = vi.fn(), generate = vi.fn();
    const call = new VoiceCallContext({ callId: "native", identity: "Cindy", reference: "", generate, handoff: async () => true, changed: vi.fn(), result });
    call.recordNativeTurn("first", "user", "Do work");
    await call.handoffNativeTurn("first", "");
    call.deliverResult("voice-task:native:first", "Done");
    call.deliverResult("voice-task:native:first", "Duplicate");
    expect(result).toHaveBeenCalledExactlyOnceWith("voice-task:native:first", "Done");
    call.recordNativeTurn("second", "user", "Background work");
    await call.handoffNativeTurn("second", "");
    call.end();
    call.deliverResult("voice-task:native:second", "Late result");
    expect(result).toHaveBeenCalledTimes(1);
    expect(call.record.handoffs[1]).toMatchObject({ state: "completed", result: "Late result" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps casual exchanges in the call and includes them in the next call turn", async () => {
    const { call, generate, handoff } = setup();
    await call.submit("u1", "My name is Pat.");
    await call.submit("u2", "What is my name?");
    expect(handoff).not.toHaveBeenCalled();
    expect(call.record.turns.map((turn) => turn.text)).toEqual([
      "My name is Pat.",
      "Hello.",
      "What is my name?",
      "Hello.",
    ]);
    expect(JSON.parse(generate.mock.calls[1][0]).conversation[0].text).toBe(
      "My name is Pat.",
    );
    expect(generate.mock.calls[1][1]).toContain("Cindy");
  });

  it("hands off the original only once and treats the model text as a supplement", async () => {
    const { call, handoff } = setup(
      vi.fn<Deps["generate"]>(async () => '{"handoff":"Write a brief plan."}'),
    );
    await Promise.all([
      call.submit("u1", "Please make a plan, then leave voice mode."),
      call.submit("u1", "Please make a plan, then leave voice mode."),
    ]);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0][0]).toEqual({
      id: "voice-task:call-1:u1",
      inputId: "u1",
      original: "Please make a plan, then leave voice mode.",
      supplement: "Write a brief plan.",
    });
    expect(call.record.handoffs[0].state).toBe("accepted");
  });

  it("waits for host acceptance for a compound exit without waiting for a model", async () => {
    const { call, generate, handoff } = setup();
    let accept!: (value: boolean) => void;
    handoff.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    let settled = false;
    const sending = call
      .submit("u1", "Make a plan then leave.", true)
      .then((ok) => {
        settled = true;
        return ok;
      });
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    accept(true);
    expect(await sending).toBe(true);
  });

  it("retains original input and a failure receipt when task admission fails", async () => {
    const { call, handoff } = setup();
    handoff.mockResolvedValue(false);
    expect(await call.submit("u1", "Do something then leave.", true)).toBe(
      false,
    );
    expect(call.record.turns[0]).toMatchObject({
      text: "Do something then leave.",
      failed: true,
    });
    expect(call.record.handoffs[0].state).toBe("failed");
  });

  it("returns a task result into the call without dispatching another task", async () => {
    const { call, generate, handoff } = setup();
    await call.submit("u1", "Research this.", true);
    call.deliverResult("voice-task:call-1:u1", "Found three sources.");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(JSON.parse(generate.mock.calls[0][0]).taskResult).toBe(
      "Found three sources.",
    );
    expect(handoff).toHaveBeenCalledTimes(1);
    call.deliverResult("voice-task:call-1:u1", "Duplicate result");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate or cancel accepted tasks when the call ends", async () => {
    const { call, generate, handoff } = setup();
    await call.submit("u1", "Keep working after I hang up.", true);
    call.end();
    call.deliverResult("voice-task:call-1:u1", "Done.");
    expect(generate).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledOnce();
    expect(call.record.endedAt).toBeTypeOf("number");
    expect(await call.submit("u2", "Late")).toBe(false);
  });

  it("only speaks complete structured sentences while the provider is streaming", async () => {
    const { call, changed } = setup(
      vi.fn<Deps["generate"]>(async (_prompt, _system, _signal, update) => {
        update('{"say":"First sentence."}\n{"say":"Sec');
        return '{"say":"First sentence."}\n{"say":"Second sentence."}';
      }),
    );
    await call.submit("u1", "Say two sentences.");
    expect(
      changed.mock.calls.some(
        ([record]) =>
          record.turns.at(-1)?.text === "First sentence." &&
          record.turns.at(-1)?.complete === false,
      ),
    ).toBe(true);
    expect(call.record.turns.at(-1)).toMatchObject({
      text: "First sentence. Second sentence.",
      complete: true,
    });
  });

  it("does not execute unknown or mixed model actions", async () => {
    const { call, handoff } = setup(
      vi.fn<Deps["generate"]>(
        async () => '{"handoff":"Do work"}\n{"end_call":true}',
      ),
    );
    expect(await call.submit("u1", "Hello")).toBe(false);
    expect(handoff).not.toHaveBeenCalled();
  });

  it("keeps the call alive when a reply cannot be used", async () => {
    const generate = vi
      .fn<Deps["generate"]>()
      .mockResolvedValueOnce("Sure! Here is my answer.")
      .mockResolvedValueOnce('{"say":"Hello."}');
    const { call } = setup(generate);
    expect(await call.submit("u1", "Hello")).toBe(false);
    // Clients hang up the whole call when a user turn is flagged failed, so an
    // unusable reply must not flag the turn the user actually spoke.
    expect(
      call.record.turns.find((turn) => turn.role === "user")?.failed,
    ).toBeUndefined();
    // Clients leave the thinking phase when the reply turn is flagged failed,
    // so an unusable reply still has to be published.
    expect(
      call.record.turns.find((turn) => turn.role === "assistant")?.failed,
    ).toBe(true);
    expect(await call.submit("u2", "Still there?")).toBe(true);
    expect(call.record.turns.at(-1)).toMatchObject({
      text: "Hello.",
      complete: true,
    });
  });

  it("does not duplicate a rejected handoff as a failed reply", async () => {
    const { call, handoff } = setup(
      vi.fn<Deps["generate"]>(async () => '{"handoff":"Do work"}'),
    );
    handoff.mockResolvedValue(false);
    expect(await call.submit("u1", "Do work")).toBe(false);
    // The handoff receipt already marks the user turn; adding an empty failed
    // reply would show the user two failure messages for one rejected handoff.
    expect(
      call.record.turns.filter((turn) => turn.failed),
    ).toHaveLength(1);
    expect(
      call.record.turns.find((turn) => turn.role === "user")?.failed,
    ).toBe(true);
    expect(
      call.record.turns.some((turn) => turn.role === "assistant"),
    ).toBe(false);
    expect(call.record.handoffs[0].state).toBe("failed");
  });

  it("accepts a single pretty printed action object", async () => {
    const { call } = setup(
      vi.fn<Deps["generate"]>(async () => '{\n  "say": "Hello there."\n}'),
    );
    expect(await call.submit("u1", "Hello")).toBe(true);
    expect(call.record.turns.at(-1)).toMatchObject({
      text: "Hello there.",
      complete: true,
    });
  });

  it("has independent history for every call", async () => {
    const a = setup();
    const b = setup();
    await a.call.submit("u1", "Private call detail");
    await b.call.submit("u2", "Hello");
    expect(b.generate.mock.calls[0][0]).not.toContain("Private call detail");
  });

  it.each([
    '[]', '{"say":""}', '{"say":"Hi","handoff":"Do work"}',
    '{\n"end_call":true\n}', JSON.stringify({ say: "x".repeat(8_001) }),
  ])("keeps invalid actions bounded without executing a handoff: %s", async (raw) => {
    const { call, handoff } = setup(vi.fn<Deps["generate"]>(async () => raw));
    expect(await call.submit("u1", "Hello")).toBe(false);
    expect(handoff).not.toHaveBeenCalled();
    expect(call.record.turns).toMatchObject([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "", complete: true, failed: true },
    ]);
    expect(call.record.turns[0].failed).toBeUndefined();
  });

  it("settles a partially streamed failed reply and excludes it from the next prompt", async () => {
    const generate = vi.fn<Deps["generate"]>()
      .mockImplementationOnce(async (_prompt, _system, _signal, update) => {
        update('{"say":"First sentence."}\n');
        throw new Error("provider failed");
      })
      .mockResolvedValueOnce('{"say":"Recovered."}');
    const { call } = setup(generate);
    expect(await call.submit("u1", "Hello")).toBe(false);
    expect(call.record.turns.at(-1)).toMatchObject({
      text: "First sentence.", complete: true, failed: true,
    });
    expect(call.record.turns[0].failed).toBeUndefined();
    expect(await call.submit("u2", "Continue")).toBe(true);
    expect(JSON.parse(generate.mock.calls[1][0]).conversation).toEqual([
      { role: "user", text: "Hello" }, { role: "user", text: "Continue" },
    ]);
  });

  it.each(["superseded", "ended"] as const)(
    "does not publish a phantom reply when an unspoken turn is %s",
    async (reason) => {
      let reject!: (error: Error) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const generate = vi.fn<Deps["generate"]>()
        .mockImplementationOnce(async () => {
          started();
          return new Promise<string>((_resolve, fail) => { reject = fail; });
        })
        .mockResolvedValueOnce('{"say":"New answer."}');
      const { call } = setup(generate);
      const first = call.submit("u1", "Old input");
      await ready;
      let next: Promise<boolean> | undefined;
      if (reason === "ended") call.end();
      else next = call.submit("u2", "New input");
      reject(new Error("cancelled"));
      await first;
      await next;
      expect(call.record.turns.some((turn) => turn.id === "u1:reply")).toBe(false);
      expect(call.record.turns[0].failed).toBeUndefined();
      if (next) expect(call.record.turns.at(-1)?.text).toBe("New answer.");
    },
  );
});
