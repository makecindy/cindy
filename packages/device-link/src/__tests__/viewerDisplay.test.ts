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
  });
});
