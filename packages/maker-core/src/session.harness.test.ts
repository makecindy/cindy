import { describe, expect, it, vi } from "vitest";
import { Session } from "./session.js";
import type { AgentSessionHandle } from "./agents/base-agent.js";
import type {
  InteractionDecision,
  InteractionRequest,
} from "./types/events.js";

function fixture() {
  let nativeId = "thread-1";
  const handle = {
    get id() {
      return nativeId;
    },
    model: "model",
    getUsageSnapshot: () => ({
      contextTokens: 0,
      contextWindow: 100,
      tokenUsage: 0,
      costUsd: 0,
    }),
    setInteractionResolver: vi.fn(),
    isTurnRunning: () => false,
  } as unknown as AgentSessionHandle;
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  const session = new Session({
    id: "s",
    agentKind: "claude-code",
    workDir: "/unused",
    handle,
    capabilities: {} as never,
    logger,
  });
  const request: InteractionRequest = {
    kind: "permission",
    requestId: "permission-1",
    toolName: "Write",
    input: { path: "/private" },
  };
  return {
    session,
    handle,
    request,
    changeNative: () => {
      nativeId = "thread-2";
    },
  };
}

describe("Session Harness hooks preserve permission authority", () => {
  // Unit regressions: waiting interactions must still stop, while user input
  // cannot join the native compact lane, including after async preparation.
  it('interrupts a turn waiting for permission while keeping compaction blocked', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.handle.isTurnRunning = () => true;
    f.handle.abort = vi.fn(async () => {});
    f.handle.requestHarnessCompaction = vi.fn(async () => ({ noop: true }));
    let release!: (value: InteractionDecision) => void;
    const waiting = f.session.runHostInteraction(f.request, () => new Promise(resolve => { release = resolve; }));
    try {
      expect(await f.session.runHarnessAction('context.compact', 0)).toMatchObject({ errorCode: 'BUSY' });
      expect(await f.session.runHarnessAction('turn.interrupt', 0)).toMatchObject({ ok: true, value: { state: 'requested' } });
      expect(f.handle.abort).toHaveBeenCalledOnce();
      expect(f.handle.requestHarnessCompaction).not.toHaveBeenCalled();
    } finally {
      release({ kind: 'permission', behavior: 'deny' });
      await waiting;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('rejects steering during compaction after preparation=%s', async (afterPreparation) => {
    const f = fixture();
    let running = afterPreparation;
    let finish!: () => void;
    f.session.capabilities.sameTurnSteer = { supported: true };
    f.handle.isTurnRunning = () => running;
    f.handle.steer = vi.fn(async () => {});
    f.handle.requestHarnessCompaction = () => {
      running = true;
      return new Promise<{ noop: true }>(resolve => { finish = () => { running = false; resolve({ noop: true }); }; });
    };
    let release!: () => void;
    let prepared!: () => void;
    const entered = new Promise<void>(resolve => { prepared = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = afterPreparation ? f.session.steer('late input', {
      beforeProviderStart: () => { prepared(); return held; },
    }) : undefined;
    if (afterPreparation) await entered;
    running = false;
    const compact = f.session.runHarnessAction('context.compact', 0);
    try {
      const rejected = expect(pending ?? f.session.steer('new input')).rejects.toThrow('no active turn to steer');
      release();
      await rejected;
      expect(f.handle.steer).not.toHaveBeenCalled();
    } finally {
      finish();
      await compact;
    }
  });

  // Unit regression for the Desktop pre-dispatch cancellation repro: two sends
  // reserve the same number, but a late permission verdict must stay with the
  // first attempt. Existing native-id-change coverage never reused a generation.
  it('rejects a late permission verdict after a rolled-back generation is reused', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    let release!: () => void;
    let pending!: Promise<InteractionDecision>;
    const stop = new Error('cancelled before provider dispatch');
    const original = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission', behavior: 'allow',
    }));
    const dispose = f.session.setHarnessHookHandler(() => new Promise(resolve => {
      finish = () => resolve({ action: 'continue' });
    }));
    try {
      await expect(f.session.send('first', { beforeProviderStart: () => {
        pending = f.session.runHostInteraction(f.request, original);
        throw stop;
      } })).rejects.toBe(stop);
      const held = new Promise<void>(resolve => { release = resolve; });
      const next = f.session.send('second', {
        afterTurnReserved: () => held,
        beforeProviderStart: () => { throw stop; },
      });
      try {
        expect(f.session.getTurnGeneration()).toBe(1);
        finish();
        expect(await pending).toMatchObject({
          behavior: 'deny', reason: 'Harness request is no longer current',
        });
        expect(original).not.toHaveBeenCalled();
      } finally {
        release();
        await expect(next).rejects.toBe(stop);
      }
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('does not advertise native hooks or manual compaction as connected without adapter support', () => {
    const f = fixture();
    f.session.capabilities.manualCompact = { supported: true };
    f.handle.compactSession = vi.fn(async () => ({ noop: true }));
    expect(f.session.getHarnessCapabilities().hooks.find(h => h.name === 'tool.before')).toMatchObject({ connected: false });
    expect(f.session.getHarnessCapabilities().actions).not.toContain('context.compact');
  });

  it('reserves compaction synchronously and rejects concurrent or stale controls', async () => {
    const f = fixture();
    f.session.capabilities.manualCompact = { supported: true };
    let finish!: () => void;
    f.handle.requestHarnessCompaction = vi.fn(() => new Promise<{ noop: true }>(resolve => { finish = () => resolve({ noop: true }); }));
    const pending = f.session.runHarnessAction('context.compact', 0);
    expect(f.session.isTurnRunning()).toBe(true);
    expect(await f.session.runHarnessAction('context.compact', 0)).toMatchObject({ errorCode: 'BUSY' });
    expect(await f.session.runHarnessAction('turn.interrupt', 1)).toMatchObject({ errorCode: 'STALE_RUNTIME' });
    finish();
    expect(await pending).toMatchObject({ ok: true, value: { noop: true } });
    expect(f.session.isTurnRunning()).toBe(false);
    expect(f.handle.requestHarnessCompaction).toHaveBeenCalledOnce();
  });
  it("continues through the original deny instead of granting tool permission", async () => {
    const f = fixture();
    const dispose = f.session.setHarnessHookHandler(async () => ({
      action: "continue",
    }));
    const original = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: "permission",
      behavior: "deny",
      reason: "host policy",
    }));
    expect(
      await f.session.runHostInteraction(f.request, original),
    ).toMatchObject({ behavior: "deny", reason: "host policy" });
    expect(original).toHaveBeenCalledOnce();
    dispose();
  });

  it("blocks before the original approval resolver without rewriting input", async () => {
    const f = fixture();
    const seen = vi.fn(async () => ({
      action: "block" as const,
      reason: "plugin policy",
    }));
    const dispose = f.session.setHarnessHookHandler(seen);
    const original = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: "permission",
      behavior: "allow",
    }));
    expect(
      await f.session.runHostInteraction(f.request, original),
    ).toMatchObject({ behavior: "deny", reason: "plugin policy" });
    expect(original).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledWith({
      name: "permission.request",
      toolName: "Write",
    });
    expect(JSON.stringify(seen.mock.calls)).not.toContain("/private");
    dispose();
  });

  it("rejects an approval continuation after native identity changes, even when the callback fails", async () => {
    const f = fixture();
    let fail!: (reason: Error) => void;
    const dispose = f.session.setHarnessHookHandler(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const original = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: "permission",
      behavior: "allow",
    }));
    const pending = f.session.runHostInteraction(f.request, original);
    f.changeNative();
    fail(new Error("plugin exited"));
    expect(await pending).toMatchObject({
      behavior: "deny",
      reason: "Harness request is no longer current",
    });
    expect(original).not.toHaveBeenCalled();
    dispose();
  });
});
