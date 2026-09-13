import { it, expect, vi } from "vitest";
import {
  RemoteDesktopViewerSession,
  type DesktopViewerRequest,
} from "../remoteDesktopViewerSession";
import type { RemoteDesktopRequest } from "../remoteDesktop";

const caps = {
  version: 1,
  enabled: true,
  canControl: true,
  automaticReconnect: true,
  connectionTakeover: true,
  displays: [{ id: "screen" }],
};
function fixture() {
  const request = vi.fn(async (r: RemoteDesktopRequest): Promise<unknown> =>
    r.op === "capabilities"
      ? caps
      : r.op === "start"
        ? { lease: "lease", display: { id: "screen" }, controlling: false }
        : { controlling: true },
  );
  return {
    request,
    session: new RemoteDesktopViewerSession(request as DesktopViewerRequest),
  };
}
it("uses the same peer protocol for a normal start, explicit takeover and an older host", async () => {
  const f = fixture();
  await f.session.connect({ isCurrent: () => true, takeover: true });
  expect(f.request.mock.calls[1][0]).toEqual({
    op: "start",
    displayId: "screen",
    takeover: true,
  });
  await f.session.stop();
  f.request.mockResolvedValueOnce({ ...caps, automaticReconnect: false });
  await expect(
    f.session.connect({ isCurrent: () => true, resume: true }),
  ).rejects.toThrow("CHANNEL_NOT_ALLOWED");
});
it("a heartbeat sent before a control transition cannot overwrite the confirmed result", async () => {
  const f = fixture();
  await f.session.connect({ isCurrent: () => true });
  let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const heartbeat = f.session.heartbeat();
  await f.session.control(true);
  resolve({ controlling: false });
  expect(await heartbeat).toEqual({ controlling: true });
});
it("an uncertain release blocks takeover until a heartbeat reconciles and releases host input", async () => {
  const f = fixture();
  await f.session.connect({ isCurrent: () => true });
  await f.session.control(true);
  f.request.mockRejectedValueOnce(new Error("INVOKE_TIMEOUT"));
  await expect(f.session.control(false)).rejects.toThrow("INVOKE_TIMEOUT");
  await expect(f.session.control(true)).rejects.toThrow("DESKTOP_INPUT_BUSY");
  f.request
    .mockResolvedValueOnce({ controlling: true })
    .mockResolvedValueOnce({ controlling: false });
  expect(await f.session.heartbeat()).toEqual({ controlling: false });
  expect(f.request.mock.calls.at(-1)?.[0]).toEqual({
    op: "control",
    lease: "lease",
    enabled: false,
  });
});
it("stop cancels a pending start and cleans up the returned lease without reopening", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  const started = deferred<void>();
  f.request.mockResolvedValueOnce(caps).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started.resolve();
      }),
  );
  const connection = f.session.connect({ isCurrent: () => true });
  await started.promise;
  const stopping = f.session.stop();
  finish({ lease: "late" });
  await expect(connection).rejects.toThrow("DESKTOP_VIDEO_STOPPED");
  await stopping;
  expect(f.request.mock.calls.at(-1)?.[0]).toEqual({
    op: "stop",
    lease: "late",
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("does not mark a capabilities failure as a start attempt on an older host", async () => {
  const current = fixture();
  const onStart = vi.fn();
  current.request.mockRejectedValueOnce(new Error("INVOKE_TIMEOUT"));
  await expect(
    current.session.connect({ isCurrent: () => true, onStart }),
  ).rejects.toThrow("INVOKE_TIMEOUT");
  expect(onStart).not.toHaveBeenCalled();
  current.request.mockResolvedValueOnce({
    ...caps,
    automaticReconnect: undefined,
  });
  await current.session.connect({ isCurrent: () => true, onStart });
  expect(onStart).toHaveBeenCalledOnce();
  expect(
    current.request.mock.calls.filter(([request]) => request.op === "start"),
  ).toHaveLength(1);
});

it("waits for late-start cleanup and skips superseded display choices", async () => {
  const firstStart = deferred<unknown>();
  const firstStarted = deferred<void>();
  const cleanup = deferred<unknown>();
  const cleaning = deferred<void>();
  const request = vi.fn(async (operation: RemoteDesktopRequest) => {
    if (operation.op === "capabilities")
      return {
        ...caps,
        displays: [{ id: "one" }, { id: "two" }, { id: "three" }],
      };
    if (operation.op === "start") {
      if (operation.displayId === "one") {
        firstStarted.resolve();
        return firstStart.promise;
      }
      return {
        lease: operation.displayId,
        display: { id: operation.displayId },
        controlling: false,
      };
    }
    if (operation.op === "stop" && operation.lease === "late") {
      cleaning.resolve();
      return cleanup.promise;
    }
    return {};
  });
  const session = new RemoteDesktopViewerSession(
    request as DesktopViewerRequest,
  );
  const first = session
    .connect({ isCurrent: () => true, displayId: "one" })
    .catch((error) => error.message);
  await firstStarted.promise;
  const firstStop = session.stop();
  const second = session
    .connect({ isCurrent: () => true, displayId: "two" })
    .catch((error) => error.message);
  const secondStop = session.stop();
  const latest = session.connect({ isCurrent: () => true, displayId: "three" });
  firstStart.resolve({
    lease: "late",
    display: { id: "one" },
    controlling: false,
  });
  await cleaning.promise;
  expect(
    request.mock.calls.filter(([operation]) => operation.op === "start"),
  ).toHaveLength(1);
  cleanup.resolve({});
  await expect(first).resolves.toBe("DESKTOP_VIDEO_STOPPED");
  await expect(second).resolves.toBe("DESKTOP_VIDEO_STOPPED");
  await Promise.all([firstStop, secondStop]);
  await expect(latest).resolves.toMatchObject({ lease: { lease: "three" } });
  expect(
    request.mock.calls
      .filter(([operation]) => operation.op === "start")
      .map(([operation]) => operation),
  ).toEqual([
    { op: "start", displayId: "one" },
    { op: "start", displayId: "three" },
  ]);
});

it("keeps another peer responsive while one viewer stops an unacknowledged start", async () => {
  const blocked = deferred<unknown>();
  const started = deferred<void>();
  const transport = vi.fn(
    async (peer: string, operation: RemoteDesktopRequest) => {
      if (operation.op === "capabilities") return caps;
      if (operation.op === "start" && peer === "paused") {
        started.resolve();
        return blocked.promise;
      }
      if (operation.op === "start")
        return {
          lease: "other-lease",
          controlling: false,
          display: { id: "screen" },
        };
      return { controlling: true };
    },
  );
  const paused = new RemoteDesktopViewerSession(((request) =>
    transport("paused", request)) as DesktopViewerRequest);
  const other = new RemoteDesktopViewerSession(((request) =>
    transport("other", request)) as DesktopViewerRequest);
  const pending = paused
    .connect({ isCurrent: () => true })
    .catch((error) => error.message);
  await started.promise;
  const stopped = paused.stop();
  await other.connect({ isCurrent: () => true });
  await other.control(true);
  await expect(other.heartbeat()).resolves.toEqual({ controlling: true });
  blocked.reject(new Error("DESKTOP_BUSY"));
  await pending;
  await stopped;
  await expect(other.heartbeat()).resolves.toEqual({ controlling: true });
  expect(other.lease?.lease).toBe("other-lease");
  expect(
    transport.mock.calls.some(
      ([peer, request]) => peer === "other" && request.op === "stop",
    ),
  ).toBe(false);
});

it("keeps confirmed control when an older heartbeat omits its projection", async () => {
  const f = fixture();
  await f.session.connect({ isCurrent: () => true });
  await f.session.control(true);
  f.request.mockResolvedValueOnce({});
  expect(await f.session.heartbeat()).toEqual({ controlling: true });
});
