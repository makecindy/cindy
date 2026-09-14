// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionMenuContextUsage } from "@/session/useSessionMenuContextUsage";
import type { RemoteSession } from "@/session/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});
const task = {
  id: "a",
  deviceLinkDeviceId: "host",
  model: "gpt-5",
  providerId: "openai",
  agentKind: "codex",
  contextTokens: 20,
  contextWindow: 0,
} as RemoteSession;
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function harness() {
  const reader = {
    getContextUsage:
      vi.fn<(id: string, opts?: Record<string, unknown>) => Promise<unknown>>(),
  };
  const onError = vi.fn();
  let value!: ReturnType<typeof useSessionMenuContextUsage>;
  function Probe({
    session,
    inspecting,
  }: {
    session: RemoteSession;
    inspecting: boolean;
  }) {
    value = useSessionMenuContextUsage(session, reader, inspecting, onError);
    return null;
  }
  root = createRoot(document.createElement("div"));
  return {
    reader,
    onError,
    get value() {
      return value;
    },
    async render(session = task, inspecting = true) {
      await act(async () =>
        root!.render(createElement(Probe, { session, inspecting })),
      );
    },
  };
}

describe("menu context snapshot ownership", () => {
  it.each([
    { model: "gpt-other" },
    { providerId: "custom" },
    { agentKind: "pi" },
    { id: "b" },
    { deviceLinkDeviceId: "other-host" },
    { remoteHostId: "ssh" },
    { clearedAt: 1 },
    { runtimeGeneration: 2 },
  ] as Partial<RemoteSession>[])(
    "invalidates the window and reads again for %o while inspecting",
    async (change) => {
      const h = harness();
      h.reader.getContextUsage.mockResolvedValueOnce({ rawMaxTokens: 100 });
      await h.render();
      expect(h.value.contextUsage).toEqual({ rawMaxTokens: 100 });
      const next = deferred();
      h.reader.getContextUsage.mockReturnValueOnce(next.promise);
      await h.render({ ...task, ...change });
      expect(h.value.contextUsage).toBeNull();
      expect(h.value.contextLoading).toBe(true);
      expect(h.reader.getContextUsage).toHaveBeenCalledTimes(2);
      await act(async () => next.resolve({ rawMaxTokens: 200 }));
      expect(h.value.contextUsage).toEqual({ rawMaxTokens: 200 });
    },
  );

  it("does not inspect the primary menu or restart on live counter pushes", async () => {
    const h = harness();
    await h.render(task, false);
    expect(h.reader.getContextUsage).not.toHaveBeenCalled();
    h.reader.getContextUsage.mockResolvedValue({ rawMaxTokens: 100 });
    await h.render();
    await h.render({ ...task, contextTokens: 40 });
    expect(h.reader.getContextUsage).toHaveBeenCalledOnce();
    await h.render(task, false);
    expect(h.value.contextUsage).toEqual({ rawMaxTokens: 100 });
    await h.render({ ...task, model: "other" }, false);
    await h.render(task, false);
    expect(h.value.contextUsage).toBeNull();
    expect(h.reader.getContextUsage).toHaveBeenCalledOnce();
  });

  it("rejects A-B-A late successes and failures without ending the current loading state", async () => {
    const h = harness();
    const oldA = deferred(),
      oldB = deferred(),
      newA = deferred();
    h.reader.getContextUsage
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(oldB.promise)
      .mockReturnValueOnce(newA.promise);
    await h.render();
    await h.render({ ...task, model: "other" });
    await h.render();
    await act(async () => {
      oldA.resolve({ rawMaxTokens: 100 });
      oldB.reject(new Error("old failure"));
    });
    expect(h.value.contextUsage).toBeNull();
    expect(h.value.contextLoading).toBe(true);
    expect(h.onError.mock.calls.every(([error]) => error === null)).toBe(true);
    await act(async () => newA.resolve({ rawMaxTokens: 200 }));
    expect(h.value.contextUsage).toEqual({ rawMaxTokens: 200 });
    expect(h.value.contextLoading).toBe(false);
  });

  it("retains current data on refresh failure without retry loops and cancels reads when info closes", async () => {
    const h = harness();
    h.reader.getContextUsage.mockResolvedValueOnce({ rawMaxTokens: 100 });
    await h.render();
    h.reader.getContextUsage.mockRejectedValueOnce(new Error("offline"));
    await act(async () => h.value.refresh());
    expect(h.value.contextUsage).toEqual({ rawMaxTokens: 100 });
    expect(h.value.contextLoading).toBe(false);
    expect(h.onError).toHaveBeenLastCalledWith(
      expect.stringContaining("offline"),
    );
    expect(h.reader.getContextUsage).toHaveBeenCalledTimes(2);
    const pending = deferred();
    h.reader.getContextUsage.mockReturnValueOnce(pending.promise);
    await act(async () => h.value.refresh());
    await h.render(task, false);
    await act(async () => pending.resolve({ rawMaxTokens: 300 }));
    expect(h.value.contextUsage).toEqual({ rawMaxTokens: 100 });
    expect(h.value.contextLoading).toBe(false);
    h.reader.getContextUsage.mockResolvedValueOnce({ rawMaxTokens: 400 });
    await h.render();
    expect(h.value.contextUsage).toEqual({ rawMaxTokens: 400 });
  });
});
