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

  it("has independent history for every call", async () => {
    const a = setup();
    const b = setup();
    await a.call.submit("u1", "Private call detail");
    await b.call.submit("u2", "Hello");
    expect(b.generate.mock.calls[0][0]).not.toContain("Private call detail");
  });
});
