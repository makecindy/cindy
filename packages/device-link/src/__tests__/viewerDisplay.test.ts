import { describe, expect, it, vi } from "vitest";
import { parseRemoteDesktopRequest } from "../remoteDesktop.js";
import {
  RemoteDesktopViewerSession,
  viewerDisplaySize,
  type DesktopViewerRequest,
} from "../remoteDesktopViewerSession.js";

describe("viewer display dimensions", () => {
  it.each([
    [390, 844, 888, 1920],
    [844, 390, 1920, 888],
    [1000, 1000, 1920, 1920],
  ])(
    "preserves the ratio of %d x %d within an even 1920-pixel bound",
    (width, height, w, h) => {
      expect(viewerDisplaySize(width, height)).toEqual({ width: w, height: h });
    },
  );
  it.each([0, -1, NaN, Infinity, 0.01])(
    "rejects unusable viewport dimensions: %s",
    (width) => {
      expect(viewerDisplaySize(width, 800)).toBeNull();
    },
  );
  it.each([319, 2561, 900.5, NaN, Infinity, "900"])(
    "rejects invalid wire dimensions: %s",
    (width) => {
      expect(() =>
        parseRemoteDesktopRequest({
          op: "viewerDisplay",
          lease: "lease",
          width,
          height: 1600,
        }),
      ).toThrow("INVALID_REQUEST");
    },
  );
  it("accepts authenticated restore requests without a mode identifier", () => {
    expect(
      parseRemoteDesktopRequest({ op: "restoreViewerDisplay", lease: "lease" }),
    ).toEqual({ op: "restoreViewerDisplay", lease: "lease" });
    expect(() =>
      parseRemoteDesktopRequest({ op: "restoreViewerDisplay" }),
    ).toThrow();
  });
  it("accepts a bounded independent width/height without changing mode-ID requests", () => {
    expect(
      parseRemoteDesktopRequest({
        op: "viewerDisplay",
        lease: "lease",
        width: 900,
        height: 1600,
      }),
    ).toEqual({
      op: "viewerDisplay",
      lease: "lease",
      width: 900,
      height: 1600,
    });
    expect(
      parseRemoteDesktopRequest({
        op: "resolution",
        lease: "lease",
        modeId: "123",
      }),
    ).toEqual({ op: "resolution", lease: "lease", modeId: "123" });
  });
  it("validates the opt-in flag without changing legacy resolution requests", () => {
    expect(
      parseRemoteDesktopRequest({
        op: "resolution",
        lease: "lease",
        modeId: "1",
        temporary: true,
      }),
    ).toEqual({
      op: "resolution",
      lease: "lease",
      modeId: "1",
      temporary: true,
    });
    expect(() =>
      parseRemoteDesktopRequest({
        op: "resolution",
        lease: "lease",
        modeId: "1",
        temporary: "true",
      }),
    ).toThrow("INVALID_REQUEST");
  });
  it("updates the existing viewer lease and starts control on the new display", async () => {
    const request = vi.fn(async (value) => {
      if (value.op === "capabilities")
        return { version: 1, enabled: true, displays: [{ id: "1" }] };
      if (value.op === "start")
        return {
          lease: "lease",
          display: { id: "1", width: 1920, height: 1080 },
          controlling: false,
        };
      if (value.op === "control") return { controlling: value.enabled };
      if (value.op === "restoreViewerDisplay")
        return {
          lease: "lease",
          display: { id: "1", width: 2560, height: 1440 },
          controlling: false,
        };
      if (value.op === "viewerDisplay")
        return {
          lease: "lease",
          display: { id: "2", width: value.width, height: value.height },
          controlling: false,
        };
      if (value.op === "resolution")
        return {
          lease: "lease",
          display: { id: "1", width: 3840, height: 2160 },
          controlling: false,
        };
      return {};
    });
    const session = new RemoteDesktopViewerSession(
      request as DesktopViewerRequest,
    );
    await session.connect({ isCurrent: () => true });
    await session.control(true);
    const previous = session.lease;
    await session.fitDisplay(900, 1600);
    expect(session.lease).toBe(previous);
    expect(session.lease?.display.id).toBe("2");
    expect(session.lease?.controlling).toBe(false);
    await session.control(true);
    expect(session.lease?.controlling).toBe(true);
    await session.fitDisplay(900, 1600, true);
    expect(request).toHaveBeenLastCalledWith(
      { op: "restoreViewerDisplay", lease: "lease" },
      expect.any(Function),
    );
    expect(session.lease).toBe(previous);
    expect(session.lease?.display).toEqual({
      id: "1",
      width: 2560,
      height: 1440,
    });
    expect(session.lease?.controlling).toBe(false);
    await session.control(true);
    await session.fitDisplay(3840, 2160, false, "123");
    expect(request).toHaveBeenLastCalledWith(
      { op: "resolution", lease: "lease", modeId: "123", temporary: true },
      expect.any(Function),
    );
    expect(session.lease).toBe(previous);
    expect(session.lease?.display.width).toBe(3840);
  });
});

const adjustedLease = {
  lease: "lease",
  controlling: false,
  display: { id: "virtual", width: 960, height: 710 },
  viewerDisplayRequest: { width: 1920, height: 1420 },
};
async function adjustedSession(result: unknown) {
  const session = new RemoteDesktopViewerSession((async (request) => {
    if (request.op === "capabilities")
      return { version: 1, enabled: true, displays: [{ id: "1" }] };
    if (request.op === "start")
      return {
        lease: "lease",
        controlling: false,
        display: { id: "1", width: 2560, height: 1440 },
      };
    if (request.op === "control") return { controlling: request.enabled };
    return result;
  }) as DesktopViewerRequest);
  await session.connect({ isCurrent: () => true });
  await session.control(true);
  return session;
}
it("accepts acknowledged OS logical geometry and releases control until reacquired", async () => {
  const session = await adjustedSession(adjustedLease);
  await expect(session.fitDisplay(1920, 1420)).resolves.toMatchObject({
    display: adjustedLease.display,
    controlling: false,
  });
  await session.control(true);
  expect(session.lease?.controlling).toBe(true);
});
it.each([
  { viewerDisplayRequest: undefined },
  { viewerDisplayRequest: { width: 1920, height: 1080 } },
  { display: { id: "virtual", width: 960, height: 540 } },
  { display: { id: "virtual", width: 960.5, height: 710 } },
  { display: { id: "", width: 960, height: 710 } },
  { display: { id: "virtual", width: 0, height: 0 } },
  { lease: "stale" },
  { controlling: true },
])(
  "rejects unacknowledged, invalid or stale adjusted geometry: %j",
  async (patch) => {
    const session = await adjustedSession({ ...adjustedLease, ...patch });
    await expect(session.fitDisplay(1920, 1420)).rejects.toThrow(
      "INVALID_RESPONSE",
    );
    expect(session.lease?.display.id).toBe("1");
  },
);
it("keeps explicit system modes exact even with a virtual-display acknowledgement", async () => {
  const session = await adjustedSession(adjustedLease);
  await expect(session.fitDisplay(1920, 1420, false, "mode")).rejects.toThrow(
    "INVALID_RESPONSE",
  );
});

describe("live display switch", () => {
  it("accepts keepVideo only as a boolean on the three display changes", () => {
    for (const request of [
      { op: "viewerDisplay", lease: "lease", width: 900, height: 1600 },
      { op: "restoreViewerDisplay", lease: "lease" },
      { op: "resolution", lease: "lease", modeId: "1", temporary: true },
    ]) {
      expect(
        parseRemoteDesktopRequest({ ...request, keepVideo: true }),
      ).toEqual({ ...request, keepVideo: true });
      // false is the legacy behaviour and stays off the wire.
      expect(
        parseRemoteDesktopRequest({ ...request, keepVideo: false }),
      ).toEqual(request);
      expect(() =>
        parseRemoteDesktopRequest({ ...request, keepVideo: "true" }),
      ).toThrow("INVALID_REQUEST");
    }
    // Other operations never read it.
    expect(
      parseRemoteDesktopRequest({
        op: "displayModes",
        lease: "lease",
        keepVideo: "ignored",
      }),
    ).toEqual({ op: "displayModes", lease: "lease" });
  });

  it("asks to keep video only when requested and reports only an acknowledged keep", async () => {
    let kept = true;
    const request = vi.fn(async (value) => {
      if (value.op === "capabilities")
        return { version: 1, enabled: true, displays: [{ id: "1" }] };
      if (value.op === "start")
        return {
          lease: "lease",
          display: { id: "1", width: 1920, height: 1080 },
          controlling: false,
        };
      if (value.op === "control") return { controlling: value.enabled };
      return {
        lease: "lease",
        display: { id: "1", width: 3840, height: 2160 },
        controlling: false,
        ...(kept ? { videoKept: true } : {}),
      };
    });
    const session = new RemoteDesktopViewerSession(
      request as DesktopViewerRequest,
    );
    await session.connect({ isCurrent: () => true });
    await session.control(true);
    const kept1 = await session.fitDisplay(3840, 2160, false, "4", true);
    expect(request).toHaveBeenLastCalledWith(
      {
        op: "resolution",
        lease: "lease",
        modeId: "4",
        temporary: true,
        keepVideo: true,
      },
      expect.any(Function),
    );
    expect(kept1.videoKept).toBe(true);
    // The shared lease itself never carries the per-change flag.
    expect(session.lease?.videoKept).toBeUndefined();
    await session.control(true);
    // Not requested: an unexpected acknowledgement is not surfaced.
    const legacy = await session.fitDisplay(3840, 2160, false, "4");
    expect(request.mock.calls.at(-1)?.[0]).not.toHaveProperty("keepVideo");
    expect(legacy.videoKept).toBeUndefined();
    await session.control(true);
    kept = false;
    const torn = await session.fitDisplay(3840, 2160, false, "4", true);
    expect(torn.videoKept).toBeUndefined();
  });
});

describe("automatic control on start and display changes", () => {
  it("parses an optional boolean control flag and drops it where it has no meaning", () => {
    expect(
      parseRemoteDesktopRequest({ op: "start", displayId: "1", control: true }),
    ).toEqual({ op: "start", displayId: "1", control: true });
    expect(
      parseRemoteDesktopRequest({ op: "start", displayId: "1", control: false }),
    ).toEqual({ op: "start", displayId: "1" });
    expect(
      parseRemoteDesktopRequest({ op: "restoreViewerDisplay", lease: "l", control: true }),
    ).toEqual({ op: "restoreViewerDisplay", lease: "l", control: true });
    expect(
      parseRemoteDesktopRequest({
        op: "viewerDisplay",
        lease: "l",
        width: 1280,
        height: 640,
        control: true,
      }),
    ).toMatchObject({ control: true });
    expect(
      parseRemoteDesktopRequest({
        op: "resolution",
        lease: "l",
        modeId: "2",
        temporary: true,
        control: true,
      }),
    ).toMatchObject({ temporary: true, control: true });
    // A persistent resolution ends the lease; there is nothing to control.
    expect(
      parseRemoteDesktopRequest({ op: "resolution", lease: "l", modeId: "2", control: true }),
    ).toEqual({ op: "resolution", lease: "l", modeId: "2" });
    expect(() =>
      parseRemoteDesktopRequest({ op: "start", displayId: "1", control: "yes" }),
    ).toThrow("INVALID_REQUEST");
  });

  function session(caps: Record<string, unknown>, startControlling: boolean) {
    const sent: Record<string, unknown>[] = [];
    const request = vi.fn(async (message: Record<string, unknown>) => {
      sent.push(message);
      if (message.op === "capabilities")
        return {
          version: 1,
          enabled: true,
          canControl: true,
          displays: [{ id: "1", name: "Main", width: 1920, height: 1080 }],
          ...caps,
        };
      if (message.op === "start")
        return {
          lease: "lease",
          display: { id: "1", width: 1920, height: 1080 },
          controlling: startControlling,
        };
      if (message.op === "viewerDisplay")
        return {
          lease: "lease",
          display: { id: "v", width: message.width, height: message.height },
          controlling: message.control === true,
        };
      return {};
    }) as unknown as DesktopViewerRequest;
    return { viewer: new RemoteDesktopViewerSession(request), sent };
  }

  it("asks for control with the lease only from hosts that advertise it", async () => {
    const supported = session({ autoControl: true }, true);
    const { lease } = await supported.viewer.connect({ control: true, isCurrent: () => true });
    expect(supported.sent.find((m) => m.op === "start")).toMatchObject({ control: true });
    expect(lease.controlling).toBe(true);
    const old = session({}, false);
    const result = await old.viewer.connect({ control: true, isCurrent: () => true });
    expect(old.sent.find((m) => m.op === "start")).not.toHaveProperty("control");
    expect(result.lease.controlling).toBe(false);
    const viewOnly = session({ autoControl: true, canControl: false }, false);
    await viewOnly.viewer.connect({ control: true, isCurrent: () => true });
    expect(viewOnly.sent.find((m) => m.op === "start")).not.toHaveProperty("control");
  });

  it("keeps control across a display change only when it asked for it", async () => {
    const { viewer, sent } = session({ autoControl: true }, true);
    await viewer.connect({ control: true, isCurrent: () => true });
    const kept = await viewer.fitDisplay(1280, 640, false, undefined, false, true);
    expect(sent.at(-1)).toMatchObject({ op: "viewerDisplay", control: true });
    expect(kept.controlling).toBe(true);
    expect(viewer.lease?.controlling).toBe(true);
    await expect(viewer.fitDisplay(1280, 640)).resolves.toMatchObject({ controlling: false });
  });

  it("rejects a grant nobody asked for", async () => {
    const request = vi.fn(async (message: Record<string, unknown>) =>
      message.op === "capabilities"
        ? { version: 1, enabled: true, canControl: true, displays: [{ id: "1", name: "M", width: 1, height: 1 }] }
        : message.op === "start"
          ? { lease: "lease", display: { id: "1", width: 1, height: 1 }, controlling: true }
          : { lease: "lease", display: { id: "v", width: 1280, height: 640 }, controlling: true },
    ) as unknown as DesktopViewerRequest;
    const viewer = new RemoteDesktopViewerSession(request);
    await viewer.connect({ isCurrent: () => true });
    await expect(viewer.fitDisplay(1280, 640)).rejects.toThrow("INVALID_RESPONSE");
  });
});
