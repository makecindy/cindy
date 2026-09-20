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
