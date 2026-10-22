import { describe, expect, it, vi } from "vitest";
import {
  isPreviewGrant,
  isPreviewInputEvent,
  isPreviewTabRef,
  isPreviewLeaseOp,
  isRemoteDesktopChannelRequest,
  parseRemoteDesktopChannelRequest,
  parseRemoteDesktopRequest,
  PREVIEW_LEASE_OPS,
  remoteDesktopPreviewTabCapability,
  type RemoteDesktopRequest,
} from "../remoteDesktop";
import {
  previewTabCapabilities,
  remoteDesktopFailureKey,
  RemoteDesktopViewerSession,
  type DesktopViewerRequest,
} from "../remoteDesktopViewerSession";

const grant = "A".repeat(43);
const touch = (phase: string, points: unknown[]) => ({
  kind: "touch",
  phase,
  points,
});
const point = (id: number, x = 0.5, y = 0.5) => ({ id, x, y });
const input = (events: unknown[], sequence = 1) => ({
  op: "previewInput",
  lease: "l",
  sequence,
  events,
});
const reject = (value: unknown, code = "INVALID_REQUEST") =>
  expect(() => parseRemoteDesktopRequest(value)).toThrow(code);

describe("preview tab wire parsing", () => {
  it("parses previewTabs without a lease and bounds sessionId", () => {
    expect(parseRemoteDesktopRequest({ op: "previewTabs" })).toEqual({
      op: "previewTabs",
    });
    expect(
      parseRemoteDesktopRequest({ op: "previewTabs", sessionId: "s", x: 1 }),
    ).toEqual({ op: "previewTabs", sessionId: "s" });
    for (const sessionId of ["", "x".repeat(129), 1, null, {}])
      reject({ op: "previewTabs", sessionId });
  });

  it("parses previewStart as just a grant and refuses anything naming a display", () => {
    expect(parseRemoteDesktopRequest({ op: "previewStart", grant })).toEqual({
      op: "previewStart",
      grant,
    });
    for (const g of [undefined, "", 1, null, "x".repeat(129)])
      reject({ op: "previewStart", grant: g });
    for (const extra of [
      { displayId: "1" },
      { takeover: true },
      { control: true },
      { lockOnExit: true },
      { handoff: "req" },
      { displayId: undefined },
    ])
      reject({ op: "previewStart", grant, ...extra });
    // Never mistaken for a display start.
    reject({ op: "previewStart", displayId: "1" });
  });

  it("lets previewStart carry the picture area, and refuses a size the host cannot lay out", () => {
    const viewport = { width: 402, height: 778 };
    expect(
      parseRemoteDesktopRequest({ op: "previewStart", grant, viewport }),
    ).toEqual({ op: "previewStart", grant, viewport });
    expect(
      parseRemoteDesktopRequest({
        op: "previewStart",
        grant,
        viewport: { width: 240, height: 4096, extra: 1 },
      }),
    ).toEqual({ op: "previewStart", grant, viewport: { width: 240, height: 4096 } });
    for (const bad of [
      { width: 239, height: 778 },
      { width: 2049, height: 778 },
      { width: 402, height: 239 },
      { width: 402, height: 4097 },
      { width: 402.5, height: 778 },
      { width: "402", height: 778 },
      { width: 402 },
      null,
      [],
      402,
    ])
      reject({ op: "previewStart", grant, viewport: bad });
  });

  it("parses previewViewport on a lease with the same bounds, over the media channel", () => {
    const request = { op: "previewViewport", lease: "l", width: 402, height: 778 };
    expect(parseRemoteDesktopRequest({ ...request, extra: 1 })).toEqual(request);
    expect(isRemoteDesktopChannelRequest(request as never)).toBe(true);
    expect(isPreviewLeaseOp("previewViewport")).toBe(true);
    reject({ ...request, width: 100 });
    reject({ ...request, height: 5000 });
    reject({ ...request, width: 402.5 });
    reject({ op: "previewViewport", lease: "l" });
    expect(() =>
      parseRemoteDesktopRequest({ op: "previewViewport", width: 402, height: 778 }),
    ).toThrow("INVALID_LEASE");
  });

  it("lets previewStart say it is an automatic resume, and nothing else", () => {
    expect(
      parseRemoteDesktopRequest({ op: "previewStart", grant, resume: true }),
    ).toEqual({ op: "previewStart", grant, resume: true });
    expect(
      parseRemoteDesktopRequest({ op: "previewStart", grant, resume: false }),
    ).toEqual({ op: "previewStart", grant, resume: false });
    for (const resume of [1, "true", null, {}])
      reject({ op: "previewStart", grant, resume });
    // Resume must not smuggle in anything that names or takes a display.
    reject({ op: "previewStart", grant, resume: true, takeover: true });
    reject({ op: "previewStart", grant, resume: true, displayId: "1" });
    reject({ op: "previewStart", grant, resume: true, handoff: "req" });
  });

  it("checks the grant shape separately so hosts can answer PREVIEW_GRANT_INVALID", () => {
    expect(isPreviewGrant(grant)).toBe(true);
    for (const g of ["", "short", "A".repeat(44), "A".repeat(42) + "=", 5, null])
      expect(isPreviewGrant(g)).toBe(false);
  });

  it("checks a tab's stable ref as 1..64 of A-Za-z0-9_-, which is not a credential", () => {
    for (const ref of ["a", "tab_1-B", "x".repeat(64), grant])
      expect(isPreviewTabRef(ref)).toBe(true);
    for (const ref of ["", "x".repeat(65), "a b", "a/b", "é", undefined, 5, null])
      expect(isPreviewTabRef(ref)).toBe(false);
  });

  it("previewTabs / previewStart carry no lease, so an older host rejects them at the lease check", () => {
    // Older parsers fall through to the lease check for every unknown op.
    for (const request of [{ op: "previewTabs" }, { op: "previewStart", grant }])
      expect("lease" in request).toBe(false);
  });

  it("accepts well-formed previewInput batches", () => {
    const events = [
      touch("start", [point(0)]),
      touch("move", [point(0, 0, 1), point(2147483647, 1, 0)]),
      touch("end", []),
      touch("cancel", [point(1)]),
      { kind: "key", code: "Enter", down: true },
      { kind: "text", text: "中文ABC" },
      { kind: "release" },
    ];
    expect(parseRemoteDesktopRequest(input(events, 7))).toEqual(input(events, 7));
  });

  it("rejects bad previewInput envelopes", () => {
    reject({ ...input([{ kind: "release" }]), lease: undefined }, "INVALID_LEASE");
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])
      reject(input([{ kind: "release" }], sequence as number));
    reject(input([]));
    reject(input(Array.from({ length: 65 }, () => ({ kind: "release" }))));
    expect(
      parseRemoteDesktopRequest(
        input(Array.from({ length: 64 }, () => ({ kind: "release" }))),
      ),
    ).toMatchObject({ op: "previewInput" });
    reject({ ...input([{ kind: "release" }]), events: "release" });
    // 64 events of 3 KiB of text each exceed the 16 KiB request budget.
    reject(
      input(Array.from({ length: 64 }, () => ({ kind: "text", text: "x".repeat(3000) }))),
    );
    reject(input([{ kind: "move", x: 0.1, y: 0.1 }]));
  });

  it("rejects invalid touch events", () => {
    const bad = [
      touch("start", [point(0, 1.01)]),
      touch("start", [point(0, -0.01)]),
      touch("start", [point(0, 0.5, Number.NaN)]),
      touch("start", [point(0, 0.5, Number.POSITIVE_INFINITY)]),
      touch("start", [point(-1)]),
      touch("start", [point(2147483648)]),
      touch("start", [point(1.5)]),
      touch("start", [{ id: "0", x: 0, y: 0 }]),
      touch("start", [point(3), point(3)]),
      touch("start", Array.from({ length: 11 }, (_, i) => point(i))),
      touch("start", []),
      touch("move", []),
      touch("hover", [point(0)]),
      touch("start", "none" as never),
      { kind: "touch", phase: "start" },
    ];
    for (const event of bad) {
      expect(isPreviewInputEvent(event)).toBe(false);
      reject(input([event]));
    }
    expect(
      isPreviewInputEvent(
        touch("start", Array.from({ length: 10 }, (_, i) => point(i))),
      ),
    ).toBe(true);
  });

  it("applies the host's advertised touch limit", () => {
    const two = touch("move", [point(0), point(1)]);
    expect(isPreviewInputEvent(two, 2)).toBe(true);
    expect(isPreviewInputEvent(two, 1)).toBe(false);
    expect(isPreviewInputEvent(touch("move", [point(0)]), 20)).toBe(true);
  });

  it("rejects invalid key and text events", () => {
    for (const event of [
      { kind: "key", code: "Power", down: true },
      { kind: "key", code: "Enter" },
      { kind: "key", code: "Enter", down: "yes" },
      { kind: "text", text: "" },
      { kind: "text", text: "x".repeat(4097) },
      { kind: "text", text: 5 },
      null,
      [],
    ])
      expect(isPreviewInputEvent(event)).toBe(false);
    expect(isPreviewInputEvent({ kind: "text", text: "x".repeat(4096) })).toBe(true);
  });

  it("sends previewInput over the media channel and nothing else new", () => {
    const request = parseRemoteDesktopRequest(input([{ kind: "release" }]));
    expect(isRemoteDesktopChannelRequest(request)).toBe(true);
    expect(
      parseRemoteDesktopChannelRequest({
        type: "request",
        id: "r1",
        request: input([{ kind: "release" }]),
      }),
    ).toMatchObject({ id: "r1", request: { op: "previewInput" } });
    for (const op of ["previewTabs", "previewStart"])
      expect(isRemoteDesktopChannelRequest({ op } as never)).toBe(false);
  });

  it("allows only the documented ops on a preview lease", () => {
    expect([...PREVIEW_LEASE_OPS].sort()).toEqual(
      [
        "frame",
        "heartbeat",
        "ice",
        "offer",
        "presentation",
        "previewInput",
        "previewViewport",
        "stop",
        "viewerHidden",
      ].sort(),
    );
    for (const op of [
      "control",
      "input",
      "clipboard",
      "clipboardContent",
      "clipboardSync",
      "clipboardVersion",
      "privacyScreen",
      "displayModes",
      "windowAction",
      "resolution",
      "viewerDisplay",
      "restoreViewerDisplay",
      "hostMute",
      "start",
      "previewStart",
      "previewTabs",
    ])
      expect(isPreviewLeaseOp(op)).toBe(false);
  });

  it("treats a missing or malformed previewTab capability as unsupported", () => {
    expect(remoteDesktopPreviewTabCapability({})).toBeNull();
    expect(remoteDesktopPreviewTabCapability(null)).toBeNull();
    for (const previewTab of [
      null,
      "yes",
      true,
      [],
      { version: 2, maxTouchPoints: 2 },
      { version: 1 },
      { version: 1, maxTouchPoints: 0 },
      { version: 1, maxTouchPoints: 11 },
      { version: 1, maxTouchPoints: 1.5 },
    ])
      expect(remoteDesktopPreviewTabCapability({ previewTab } as never)).toBeNull();
    expect(
      remoteDesktopPreviewTabCapability({
        previewTab: { version: 1, maxTouchPoints: 10 },
      }),
    ).toEqual({ version: 1, maxTouchPoints: 10 });
  });

  it("reads the viewport flag only when it is exactly true", () => {
    const cap = (viewport: unknown) =>
      remoteDesktopPreviewTabCapability({
        previewTab: { version: 1, maxTouchPoints: 2, viewport },
      } as never);
    expect(cap(true)).toEqual({ version: 1, maxTouchPoints: 2, viewport: true });
    for (const v of [false, 1, "true", undefined])
      expect(cap(v)).toEqual({ version: 1, maxTouchPoints: 2 });
  });

  it("maps the new error codes", () => {
    expect(remoteDesktopFailureKey("PREVIEW_GRANT_INVALID")).toBe("previewGrantInvalid");
    expect(remoteDesktopFailureKey("PREVIEW_SOURCE_ENDED")).toBe("previewEnded");
    expect(remoteDesktopFailureKey("PREVIEW_CAPTURE_UNAVAILABLE")).toBe(
      "previewCaptureUnavailable",
    );
    expect(remoteDesktopFailureKey("PREVIEW_INPUT_INVALID")).toBe("previewInputInvalid");
    expect(remoteDesktopFailureKey("DESKTOP_PREVIEW_ONLY")).toBe("previewOnly");
    expect(remoteDesktopFailureKey("DESKTOP_BUSY")).toBe("connectionBusy");
  });
});

const baseCaps = {
  version: 1 as const,
  enabled: true,
  canControl: true,
  platform: "darwin",
  automaticReconnect: true,
  connectionTakeover: true,
  clipboardText: true,
  displayModes: true,
  privacyScreen: true,
  systemAudio: true,
  autoControl: true,
  channelRequests: true,
  displays: [{ id: "screen", name: "Screen", width: 1920, height: 1080 }],
};
const previewCaps = {
  ...baseCaps,
  previewTab: { version: 1 as const, maxTouchPoints: 2 },
};
const previewLease = {
  lease: "pl",
  display: { id: "preview:1", width: 390, height: 844 },
  controlling: false,
  preview: { pluginName: "Baguette", title: "Simulator" },
};

function fixture(caps: unknown, start: unknown = previewLease) {
  const request = vi.fn(async (r: RemoteDesktopRequest): Promise<unknown> =>
    r.op === "capabilities" ? caps : r.op === "previewStart" ? start : {},
  );
  return {
    request,
    session: new RemoteDesktopViewerSession(request as DesktopViewerRequest),
  };
}
const ops = (f: ReturnType<typeof fixture>) =>
  f.request.mock.calls.map((call) => (call[0] as RemoteDesktopRequest).op);

describe("preview tab viewer session", () => {
  it("runs capabilities, previewStart and verifies the reply before opening", async () => {
    const f = fixture(previewCaps);
    const seen = vi.fn();
    const { caps, lease } = await f.session.connect({
      isCurrent: () => true,
      preview: { grant },
      onCapabilities: seen,
    });
    expect(f.request.mock.calls.map((c) => c[0])).toEqual([
      { op: "capabilities" },
      { op: "previewStart", grant },
    ]);
    expect(lease.preview).toEqual({ pluginName: "Baguette", title: "Simulator" });
    expect(f.session.lease).toBe(lease);
    expect(seen).toHaveBeenCalledWith(caps);
    for (const key of [
      "clipboardText",
      "displayModes",
      "privacyScreen",
      "systemAudio",
      "connectionTakeover",
      "automaticReconnect",
      "autoControl",
    ])
      expect(caps).not.toHaveProperty(key);
    expect(caps).toMatchObject({
      canControl: false,
      channelRequests: true,
      previewTab: { version: 1, maxTouchPoints: 2 },
    });
    expect(previewTabCapabilities(previewCaps)).toEqual(caps);
  });

  it("sends the picture area only to a host that advertises viewport", async () => {
    const viewport = { width: 402, height: 778 };
    const withFlag = {
      ...previewCaps,
      previewTab: { version: 1 as const, maxTouchPoints: 2, viewport: true as const },
    };
    const supported = fixture(withFlag);
    await supported.session.connect({
      isCurrent: () => true,
      preview: { grant, viewport },
    });
    expect(supported.request.mock.calls[1][0]).toEqual({
      op: "previewStart",
      grant,
      viewport,
    });
    const plain = fixture(previewCaps);
    await plain.session.connect({
      isCurrent: () => true,
      preview: { grant, viewport },
    });
    expect(plain.request.mock.calls[1][0]).toEqual({ op: "previewStart", grant });
  });

  it("never sends previewStart when the host lacks the capability", async () => {
    for (const previewTab of [
      undefined,
      null,
      "yes",
      { version: 2, maxTouchPoints: 2 },
      { version: 1, maxTouchPoints: 99 },
    ]) {
      const f = fixture({ ...baseCaps, previewTab });
      await expect(
        f.session.connect({ isCurrent: () => true, preview: { grant } }),
      ).rejects.toThrow("CHANNEL_NOT_ALLOWED");
      expect(ops(f)).toEqual(["capabilities"]);
      expect(f.session.lease).toBeNull();
    }
  });

  it("stops a lease whose reply has no preview object and throws INVALID_RESPONSE", async () => {
    for (const preview of [undefined, null, "Baguette", []]) {
      const f = fixture(previewCaps, {
        lease: "whole",
        display: { id: "screen" },
        controlling: true,
        ...(preview === undefined ? {} : { preview }),
      });
      await expect(
        f.session.connect({ isCurrent: () => true, preview: { grant } }),
      ).rejects.toThrow("INVALID_RESPONSE");
      expect(f.request.mock.calls.at(-1)?.[0]).toEqual({ op: "stop", lease: "whole" });
      expect(f.session.lease).toBeNull();
    }
  });

  it("keeps a preview lease view-only whatever the host reports", async () => {
    const f = fixture(previewCaps, { ...previewLease, controlling: true });
    const { lease } = await f.session.connect({
      isCurrent: () => true,
      preview: { grant },
      control: true,
    });
    expect(lease.controlling).toBe(false);
    const before = f.request.mock.calls.length;
    await expect(f.session.control(true)).rejects.toThrow("DESKTOP_PREVIEW_ONLY");
    expect(f.request.mock.calls.length).toBe(before);
  });

  it("sends resume with previewStart only when the viewer asks for an automatic resume", async () => {
    const plain = fixture(previewCaps);
    await plain.session.connect({ isCurrent: () => true, preview: { grant } });
    expect(plain.request.mock.calls.map(([r]) => r)).toContainEqual({
      op: "previewStart",
      grant,
    });
    const resumed = fixture(previewCaps);
    await resumed.session.connect({
      isCurrent: () => true,
      preview: { grant },
      resume: true,
    });
    expect(resumed.request.mock.calls.map(([r]) => r)).toContainEqual({
      op: "previewStart",
      grant,
      resume: true,
    });
  });

  it("rejects preview together with handoff or takeover before any request", async () => {
    for (const extra of [{ handoff: "req1" }, { takeover: true }]) {
      const f = fixture(previewCaps);
      await expect(
        f.session.connect({ isCurrent: () => true, preview: { grant }, ...extra }),
      ).rejects.toThrow("INVALID_REQUEST");
      expect(f.request).not.toHaveBeenCalled();
    }
  });

  it("stops the lease when the connection was superseded during start", async () => {
    const f = fixture(previewCaps);
    let current = true;
    f.request.mockImplementation(async (r: RemoteDesktopRequest) => {
      if (r.op === "capabilities") return previewCaps;
      if (r.op === "previewStart") {
        current = false;
        return previewLease;
      }
      return {};
    });
    await expect(
      f.session.connect({ isCurrent: () => current, preview: { grant } }),
    ).rejects.toThrow("DESKTOP_VIDEO_STOPPED");
    expect(f.request.mock.calls.at(-1)?.[0]).toEqual({ op: "stop", lease: "pl" });
    expect(f.session.lease).toBeNull();
  });

  it("leaves non-preview connections unchanged", async () => {
    const f = fixture(previewCaps, { lease: "l", display: { id: "screen" } });
    f.request.mockImplementation(async (r: RemoteDesktopRequest) =>
      r.op === "capabilities"
        ? previewCaps
        : r.op === "start"
          ? { lease: "l", display: { id: "screen" }, controlling: false }
          : {},
    );
    await f.session.connect({ isCurrent: () => true });
    expect(f.request.mock.calls[1][0]).toEqual({ op: "start", displayId: "screen" });
    await expect(f.session.control(true)).resolves.toBeDefined();
  });
});
