import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { DESKTOP_TRANSFORM_SCRIPT } from "../geometry";
import { remoteDesktopViewerHtml } from "../viewerHtml";

const desktopTransform = vm.runInNewContext(
  `(${DESKTOP_TRANSFORM_SCRIPT})`,
) as (
  vw: number,
  vh: number,
  dw: number,
  dh: number,
  zoom: number,
  fx: number,
  fy: number,
  fillHeight?: boolean,
) => { x: number; y: number; width: number; height: number; scale: number };

function viewer(rtc = false, frameCallback = true, nativeMedia = false) {
  const messages: Array<{
    type: string;
    epoch: string;
    sequence: number;
    events?: Array<{ kind: string; code?: string }>;
  }> = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const documentListeners: Record<string, (event: unknown) => void> = {};
  const windowListeners: Record<string, (event: unknown) => void> = {};
  const elements = Object.fromEntries(
    [
      "stage",
      "keyboard-input",
      "image",
      "video",
      "bg",
      "bg-canvas",
      "network-status",
      "cursor",
      "cursor-image",
      "mouse-buttons",
      "mouse-left",
      "mouse-right",
      "mouse-middle",
      "mouse-wheel",
      "mouse-wheel-grip",
      "mouse-up",
      "mouse-down",
    ].map((id) => [
      id,
      {
        id,
        clientWidth: 400,
        clientHeight: 600,
        style: {} as Record<string, string>,
        addEventListener: (name: string, handler: (e: unknown) => void) => {
          listeners[`${id}:${name}`] = handler;
        },
        textContent: "",
        value: "",
        focus() {},
        blur() {},
        setSelectionRange() {},
        setAttribute() {},
        setPointerCapture() {},
        removeAttribute() {},
        play: async () => {},
      },
    ]),
  );
  const bgDraws: unknown[][] = [];
  const bgContext = {
    setTransform() {},
    clearRect: vi.fn(),
    drawImage: (...args: unknown[]) => {
      bgDraws.push(args);
    },
  };
  (
    elements as unknown as Record<
      string,
      {
        getContext?: () => unknown;
        naturalWidth?: number;
        naturalHeight?: number;
      }
    >
  )["bg-canvas"].getContext = () => bgContext;
  (
    elements as unknown as Record<
      string,
      {
        getContext?: () => unknown;
        naturalWidth?: number;
        naturalHeight?: number;
      }
    >
  )["image"].naturalWidth = 1920;
  (
    elements as unknown as Record<
      string,
      {
        getContext?: () => unknown;
        naturalWidth?: number;
        naturalHeight?: number;
      }
    >
  )["image"].naturalHeight = 1080;
  Object.assign(elements.image, { complete: true });
  const intervals: Array<() => void> = [];
  const frames = new Map<number, () => void>();
  const videoFrames = new Map<number, () => void>();
  let id = 0;
  const video = Object.assign(elements.video, {
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: 2,
    onplaying: null as null | (() => void),
    requestVideoFrameCallback: frameCallback
      ? (fn: () => void) => {
          videoFrames.set(++id, fn);
          return id;
        }
      : undefined,
    cancelVideoFrameCallback: (key: number) => videoFrames.delete(key),
  });
  class Peer {
    localDescription = { sdp: "offer" };
    createDataChannel() {
      return { close() {} };
    }
    addTransceiver() {}
    async createOffer() {
      return { sdp: "offer" };
    }
    async setLocalDescription() {}
    close() {}
  }
  let now = 0;
  let orientation: number | undefined;
  const source = remoteDesktopViewerHtml("#fff", "#111", nativeMedia).match(
    /<script>([\s\S]*)<\/script>/,
  )![1];
  vm.runInNewContext(source, {
    RTCPeerConnection: Peer,
    Date: { now: () => now },
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    document: {
      getElementById: (key: string) => elements[key],
      addEventListener: (key: string, fn: (e: unknown) => void) => {
        documentListeners[key] = fn;
      },
      body: { style: {} },
      documentElement: { style: { setProperty() {} } },
    },
    window: {
      RTCPeerConnection: rtc ? Peer : undefined,
      get orientation() {
        return orientation;
      },
      ReactNativeWebView: {
        postMessage: (text: string) => messages.push(JSON.parse(text)),
      },
      addEventListener: (key: string, fn: (e: unknown) => void) => {
        windowListeners[key] = fn;
      },
    },
    ResizeObserver: class {
      observe() {}
    },
    setInterval: (fn: () => void) => intervals.push(fn),
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: (fn: () => void) => {
      frames.set(++id, fn);
      return id;
    },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  });
  return {
    messages,
    elements,
    bgDraws,
    bgClear: bgContext.clearRect,
    videoFrames,
    playVideo: () => {
      const config = messages.findLast((m) => m.type === "iceConfig");
      windowListeners.message({
        data: JSON.stringify({ ...config, iceServers: [] }),
      });
      video.onplaying!();
    },
    videoFrame: () => {
      const pending = [...videoFrames.values()];
      videoFrames.clear();
      pending.forEach((fn) => fn());
    },
    timeupdate: () => listeners["video:timeupdate"]({}),
    send: (message: object) =>
      windowListeners.message({ data: JSON.stringify(message) }),
    flush: () => intervals.forEach((fn) => fn()),
    frame: (elapsed = 16) => {
      now += elapsed;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((fn) => fn());
    },
    pointer: (type: string, pointerId: number, x: number, y: number) =>
      listeners[`stage:${type}`]({
        type,
        pointerId,
        clientX: x,
        clientY: y,
        preventDefault() {},
      }),
    mouse: (name: string, type: string, y = 0, target = `mouse-${name}`) =>
      listeners[`mouse-${name}:${type}`]({
        type,
        pointerId: 9,
        clientY: y,
        target: { id: target },
        detail: 1,
        preventDefault() {},
      }),
    ack: () => {
      const last = messages.filter((m) => m.type === "input").at(-1);
      if (last)
        windowListeners.message({
          data: JSON.stringify({
            type: "ack",
            epoch: last.epoch,
            sequence: last.sequence,
          }),
        });
    },
    rotate: (angle: number) => {
      orientation = angle;
      windowListeners.orientationchange({});
    },
    blur: () => windowListeners.blur({}),
    key: (type: string, code: string) =>
      documentListeners[type]({ code, preventDefault() {} }),
  };
}

describe("native media overlay", () => {
  it("leaves RTC negotiation to native and shares the exact input geometry", () => {
    const v = viewer(true, true, true);
    v.send({ type: "init", epoch: "native", width: 1920, height: 1080 });
    expect(v.messages.some((m) => m.type === "iceConfig")).toBe(false);
    const viewport = v.messages.findLast(
      (m) => m.type === "nativeViewport",
    ) as unknown as { x: number; y: number; width: number; height: number };
    expect(v.elements.image.style.left).toBe(viewport.x + "px");
    expect(v.elements.image.style.top).toBe(viewport.y + "px");
    expect(v.elements.image.style.width).toBe(viewport.width + "px");
    expect(v.elements.image.style.height).toBe(viewport.height + "px");
    v.send({ type: "videoSettings", audio: true });
    expect(v.messages.some((m) => m.type === "iceConfig")).toBe(false);
  });

  it("shares backdrop fit policy across native video and orientation changes", () => {
    const v = viewer(false, true, true);
    v.send({ type: "init", epoch: "native", width: 1920, height: 1080 });
    const viewport = () =>
      v.messages.findLast((m) => m.type === "nativeViewport");
    expect(viewport()).toMatchObject({ fillHeight: false });
    v.send({ type: "nativeVideo", epoch: "native", active: true });
    v.send({ type: "viewport", fillHeight: true });
    expect(viewport()).toMatchObject({ fillHeight: true });
    v.send({ type: "fit" });
    expect(viewport()).toMatchObject({ fillHeight: true });
    expect(v.elements.bg.style.display).toBe("none");
    v.send({ type: "viewport", fillHeight: false });
    expect(viewport()).toMatchObject({ fillHeight: false });
  });

  it("keeps browser pixels out of native video and restores JPEG after stop/reconnect", () => {
    const v = viewer(false, true, true);
    v.send({ type: "init", epoch: "first", width: 1920, height: 1080 });
    v.send({ type: "nativeVideo", epoch: "first", active: true });
    v.send({ type: "fit" });
    v.frame();
    expect(v.elements.image.style.visibility).toBe("hidden");
    expect(v.elements.bg.style.display).toBe("none");
    v.send({ type: "stop" });
    expect(v.elements.image.style.visibility).toBe("visible");
    v.send({ type: "init", epoch: "next", width: 1920, height: 1080 });
    v.send({ type: "nativeVideo", epoch: "first", active: true });
    expect(v.elements.image.style.visibility).toBe("visible");
    v.send({ type: "nativeVideo", epoch: "next", active: true });
    v.send({ type: "nativeVideo", epoch: "next", active: false });
    expect(v.elements.image.style.visibility).toBe("visible");
  });
});

describe("remote desktop viewport", () => {
  it.each([0, 59])(
    "fits between the top safe area (%s) and toolbar with correct touch coordinates",
    (topInset) => {
      const v = viewer();
      v.send({ type: "init", epoch: "one", width: 1920, height: 1080 });
      v.send({ type: "mouseButtons", topInset, bottomInset: 100 });
      expect(
        v.messages.filter((m) => m.type === "viewportChanged").at(-1),
      ).toMatchObject({
        width: 400,
        height: 500 - topInset,
      });
      v.send({ type: "measureViewport" });
      expect(v.messages.find((m) => m.type === "viewportSize")).toMatchObject({
        width: 400,
        height: 500 - topInset,
      });
      v.send({
        type: "videoSettings",
        width: 800,
        height: (500 - topInset) * 2,
        audio: false,
      });
      expect(v.elements.video.style).toMatchObject({
        width: "400px",
        height: `${500 - topInset}px`,
        left: "0px",
        top: `${topInset}px`,
      });
      v.send({ type: "control", enabled: true });
      v.send({ type: "mode", mode: "touch" });
      v.pointer("pointerdown", 1, 200, (500 + topInset) / 2);
      v.pointer("pointerup", 1, 200, (500 + topInset) / 2);
      v.ack();
      v.flush();
      expect(
        v.messages
          .flatMap((m) => m.events ?? [])
          .filter((e) => e.kind === "button"),
      ).toEqual([
        { kind: "button", button: 0, down: true, x: 0.5, y: 0.5 },
        { kind: "button", button: 0, down: false, x: 0.5, y: 0.5 },
      ]);
    },
  );
  it.each([
    ["left", 0],
    ["right", 2],
  ] as const)(
    "holds and releases the virtual %s button without adding stage clicks",
    (name, button) => {
      const v = viewer();
      v.send({ type: "init", epoch: "one", width: 1920, height: 1080 });
      v.send({ type: "control", enabled: true });
      v.send({ type: "mouseButtons", enabled: true });
      v.mouse(name, "pointerdown");
      v.ack();
      v.pointer("pointerdown", 1, 200, 200);
      v.pointer("pointerup", 1, 200, 200);
      v.mouse(name, "pointerup");
      expect(
        v.messages
          .flatMap((m) => m.events ?? [])
          .filter((e) => e.kind === "button"),
      ).toEqual([
        { kind: "button", button, down: true, x: 0.5, y: 0.5 },
        { kind: "button", button, down: false, x: 0.5, y: 0.5 },
      ]);
    },
  );
  it.each(["pointercancel", "lostpointercapture"])(
    "releases held buttons on %s",
    (end) => {
      const v = viewer();
      v.send({ type: "control", enabled: true });
      v.send({ type: "mouseButtons", enabled: true });
      v.mouse("left", "pointerdown");
      v.ack();
      v.mouse("left", end);
      expect(v.messages.at(-1)?.events?.[0]).toMatchObject({
        kind: "button",
        button: 0,
        down: false,
      });
    },
  );
  it("releases when hidden and prevents input in view-only mode", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("right", "pointerdown");
    v.ack();
    v.send({ type: "mouseButtons", enabled: false });
    expect(v.messages.at(-1)?.events?.[0]).toMatchObject({
      kind: "button",
      button: 2,
      down: false,
    });
    expect(v.elements["mouse-buttons"].style.display).toBe("none");
    v.ack();
    v.send({ type: "control", enabled: false });
    v.send({ type: "mouseButtons", enabled: true });
    const count = v.messages.length;
    v.mouse("left", "pointerdown");
    v.mouse("wheel", "pointerdown", 100);
    v.mouse("wheel", "pointermove", 50);
    v.flush();
    expect(v.messages).toHaveLength(count);
    expect(v.elements["mouse-buttons"].style.display).toBe("none");
  });
  it("shares held-button and wheel input with native glass controls", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true, native: true });
    const input = (control: string, event: string, y = 100) =>
      v.send({ type: "nativeMouse", control, event, id: 0, y });
    expect(v.elements["mouse-buttons"].style.display).toBe("none");
    input("left", "pointerdown");
    v.ack();
    input("left", "pointercancel");
    v.ack();
    input("wheel", "pointerdown");
    input("wheel", "pointermove", 80);
    v.flush();
    v.ack();
    input("wheel", "pointercancel");
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "button", button: 0, down: true, x: 0.5, y: 0.5 },
      { kind: "button", button: 0, down: false, x: 0.5, y: 0.5 },
      { kind: "scroll", dx: 0, dy: -24 },
    ]);
  });
  it("scrolls by dragging the wheel and cancels without an extra step", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 100);
    v.frame(300);
    v.mouse("wheel", "pointermove", 80);
    v.flush();
    v.ack();
    v.mouse("wheel", "pointercancel", 80);
    v.mouse("wheel", "pointerup", 80);
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "scroll", dx: 0, dy: -24 },
    ]);
  });
  it("taps the combined wheel as middle click without scrolling", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 100);
    v.frame(100);
    v.mouse("wheel", "pointerup", 100);
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "button", button: 1, down: true, x: 0.5, y: 0.5 },
      { kind: "button", button: 1, down: false, x: 0.5, y: 0.5 },
    ]);
  });
  it("keeps scrolling while held, reverses direction and stops on release", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 100);
    v.mouse("wheel", "pointermove", 90);
    v.flush();
    v.ack();
    v.flush();
    v.ack(); // No new movement: still scrolls.
    v.mouse("wheel", "pointermove", 124);
    v.flush();
    v.ack();
    v.mouse("wheel", "pointermove", 100);
    v.flush(); // Center dead zone stops scrolling.
    v.mouse("wheel", "pointerup", 100);
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([
      { kind: "scroll", dx: 0, dy: -9 },
      { kind: "scroll", dx: 0, dy: -9 },
      { kind: "scroll", dx: 0, dy: 30 },
    ]);
    expect(v.elements["mouse-wheel-grip"].style.transform).toBe(
      "translateY(0px)",
    );
  });
  it("does not accumulate held wheel ticks while awaiting acknowledgement", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.send({ type: "mouseButtons", enabled: true });
    v.mouse("wheel", "pointerdown", 1000);
    v.mouse("wheel", "pointermove", 990);
    v.flush();
    for (let y = 989; y >= 890; y--) {
      v.mouse("wheel", "pointermove", y);
      v.flush();
    }
    expect(v.messages.some((message) => message.type === "inputOverflow")).toBe(
      false,
    );
    v.ack();
    v.flush();
    expect(v.messages.flatMap((message) => message.events ?? [])).toEqual([
      { kind: "scroll", dx: 0, dy: -9 },
      { kind: "scroll", dx: 0, dy: -30 },
    ]);
  });
  it("fills landscape height for wide desktops and restores portrait fitting", () => {
    const v = viewer();
    v.elements.stage.clientWidth = 678;
    v.elements.stage.clientHeight = 402;
    v.send({
      type: "init",
      epoch: "landscape",
      width: 2560,
      height: 1080,
      fillHeight: true,
    });
    for (const element of [v.elements.image, v.elements.video]) {
      expect(element.style.height).toBe("402px");
      expect(element.style.top).toBe("0px");
      expect(parseFloat(element.style.width)).toBeGreaterThan(678);
    }
    v.send({ type: "fit" });
    expect(v.elements.image.style.top).toBe("0px");
    v.elements.stage.clientWidth = 400;
    v.elements.stage.clientHeight = 700;
    v.send({ type: "viewport", fillHeight: false });
    expect(v.elements.image.style.width).toBe("400px");
    expect(parseFloat(v.elements.image.style.top)).toBeGreaterThan(0);
  });
  it.each([
    [1, 0.1],
    [1, 0.5],
    [1, 0.9],
    [2, 0.1],
    [2, 0.5],
    [2, 0.9],
  ])(
    "keeps landscape scale %sx with minimal horizontal movement for cursor %s",
    (scale, cursorX) => {
      const v = viewer();
      v.elements.stage.clientWidth = 800;
      v.elements.stage.clientHeight = 400;
      v.send({
        type: "init",
        epoch: "keyboard",
        width: 1920,
        height: 1080,
        fillHeight: true,
      });
      if (scale === 2) {
        v.pointer("pointerdown", 1, 200, 200);
        v.pointer("pointerdown", 2, 400, 200);
        v.pointer("pointermove", 1, 100, 200);
        v.pointer("pointermove", 2, 500, 200);
        v.frame();
        v.frame(40);
        v.pointer("pointerup", 1, 100, 200);
        v.pointer("pointerup", 2, 500, 200);
      }
      v.send({
        type: "frame",
        jpeg: "",
        cursor: {
          x: cursorX,
          y: 0.85,
          width: 18,
          height: 18,
          hotX: 9,
          hotY: 9,
          visible: true,
          png: "iVBORw0KGgo=",
        },
      });
      v.send({
        type: "mouseButtons",
        keyboardOpen: false,
        bottomInset: 0,
        leftInset: 50,
        rightInset: 80,
      });
      for (let i = 0; i < 30; i++) v.frame();
      const width = v.elements.image.style.width;
      expect(parseFloat(v.elements.image.style.height)).toBeCloseTo(
        400 * scale,
      );
      // Removing the toolbar before the keyboard has a measured height must not shift the image.
      const originalLeft = v.elements.image.style.left;
      v.send({
        type: "mouseButtons",
        keyboardOpen: true,
        bottomInset: 0,
        leftInset: 50,
        rightInset: 0,
      });
      expect(parseFloat(v.elements.image.style.left)).toBeCloseTo(
        parseFloat(originalLeft),
      );
      // Header, computer keyboard, phone keyboard, and closing the keyboard.
      for (const bottomInset of [60, 260, 300, 0]) {
        const previousLeft = parseFloat(v.elements.image.style.left);
        const previousCursorX = previousLeft + cursorX * parseFloat(width);
        const rightInset = bottomInset > 0 ? 0 : 80;
        const expectedCursorX = Math.max(
          67,
          Math.min(800 - rightInset - 17, previousCursorX),
        );
        v.send({
          type: "mouseButtons",
          keyboardOpen: bottomInset > 0,
          bottomInset,
          leftInset: 50,
          rightInset,
        });
        v.blur();
        for (let i = 0; i < 30; i++) v.frame();
        const image = v.elements.image.style;
        expect(image.width).toBe(width);
        expect(parseFloat(image.height)).toBeCloseTo(400 * scale);
        expect(
          parseFloat(image.left) + cursorX * parseFloat(image.width),
        ).toBeCloseTo(expectedCursorX);
        expect(parseFloat(image.left)).toBeCloseTo(
          previousLeft + expectedCursorX - previousCursorX,
        );
        expect(
          parseFloat(image.top) + 0.85 * parseFloat(image.height),
        ).toBeCloseTo((400 - bottomInset) / 2);
      }
    },
  );
  it("does not recenter portrait content for a keyboard overlay message", () => {
    const v = viewer();
    const before = { ...v.elements.image.style };
    v.send({ type: "mouseButtons", keyboardOpen: true, bottomInset: 260 });
    expect(v.elements.image.style).toEqual(before);
  });
  it("preserves horizontal position when the keyboard closes before measurement", () => {
    const v = viewer();
    v.elements.stage.clientWidth = 800;
    v.elements.stage.clientHeight = 400;
    v.send({
      type: "init",
      epoch: "quick-keyboard",
      width: 1920,
      height: 1080,
      fillHeight: true,
    });
    v.send({
      type: "mouseButtons",
      keyboardOpen: false,
      bottomInset: 0,
      leftInset: 50,
      rightInset: 80,
    });
    const before = { ...v.elements.image.style };
    for (let i = 0; i < 2; i++) {
      v.send({
        type: "mouseButtons",
        keyboardOpen: true,
        bottomInset: 0,
        leftInset: 50,
        rightInset: 0,
      });
      v.send({
        type: "mouseButtons",
        keyboardOpen: false,
        bottomInset: 0,
        leftInset: 50,
        rightInset: 80,
      });
      expect(v.elements.image.style).toEqual(before);
      v.blur();
      for (let j = 0; j < 30; j++) v.frame();
      expect(v.elements.image.style).toEqual(before);
    }
  });
  it("initializes when the native engine cannot serialize function source", () => {
    const stringify = vi
      .spyOn(Function.prototype, "toString")
      .mockReturnValue("function () { [native code] }");
    let result: ReturnType<typeof viewer>;
    try {
      result = viewer();
    } finally {
      stringify.mockRestore();
    }
    expect(result.messages[0]).toMatchObject({ type: "ready" });
    expect(result.elements.image.style.width).toBe("400px");
  });
  it("fits without cropping the computer in portrait and landscape", () => {
    for (const [w, h] of [
      [390, 650],
      [760, 300],
      [390, 260],
    ]) {
      const rect = desktopTransform(w, h, 1920, 1080, 1, 0.5, 0.5);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(w);
      expect(rect.y + rect.height).toBeLessThanOrEqual(h);
    }
  });
  it("preserves the focus at the viewport center across rotation and keyboard resize", () => {
    for (const [w, h] of [
      [390, 650],
      [760, 300],
      [390, 260],
    ]) {
      const rect = desktopTransform(w, h, 1920, 1080, 5, 0.6, 0.6);
      expect((w / 2 - rect.x) / rect.width).toBeCloseTo(0.6);
      expect((h / 2 - rect.y) / rect.height).toBeCloseTo(0.6);
    }
  });
  it("compiles the actual inline viewer and rejects HTML injection through theme values", () => {
    const html = remoteDesktopViewerHtml(
      "</style><script>alert(1)</script>",
      "#fff",
    );
    expect(html).not.toContain("alert(1)");
    const source = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(source).toBeTruthy();
    expect(() => new vm.Script(source!)).not.toThrow();
  });
  it("keeps ArrowRight and reconnects after a bridge input was left unacknowledged", () => {
    const v = viewer();
    v.send({ type: "init", epoch: "first", width: 1920, height: 1080 });
    v.send({ type: "control", enabled: true });
    v.key("keydown", "ArrowRight");
    v.flush();
    expect(v.messages.at(-1)?.events?.[0]).toEqual({
      kind: "key",
      code: "ArrowRight",
      down: true,
    });
    v.send({ type: "stop" });
    v.send({ type: "init", epoch: "second", width: 1920, height: 1080 });
    v.send({ type: "control", enabled: true });
    v.send({ type: "ack", epoch: "first", sequence: 1 });
    v.key("keydown", "KeyA");
    v.flush();
    expect(v.messages.at(-1)?.epoch).toBe("second");
    expect(v.messages.at(-1)?.events?.[0].code).toBe("KeyA");
  });
  it.each([false, true])(
    "recognizes a small pinch with control=%s",
    (control) => {
      const v = viewer();
      v.send({ type: "control", enabled: control });
      v.pointer("pointerdown", 1, 100, 200);
      v.pointer("pointerdown", 2, 300, 200);
      v.pointer("pointermove", 1, 95, 200);
      v.pointer("pointermove", 2, 305, 200);
      v.frame();
      v.frame(40);
      expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(420);
      v.flush();
      expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([]);
    },
  );
  it("allows one finger to lead a pinch instead of locking into scroll", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    v.pointer("pointermove", 1, 86, 200);
    v.frame();
    v.frame(40);
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(428);
    v.pointer("pointermove", 2, 320, 200);
    v.frame();
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(468);
  });
  it("can turn an initial scroll into a pinch without a zoom jump", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    v.pointer("pointermove", 1, 110, 200);
    v.pointer("pointermove", 2, 310, 200);
    v.frame();
    v.flush();
    expect(v.messages.at(-1)?.events?.[0].kind).toBe("scroll");
    v.pointer("pointermove", 1, 82, 200);
    v.pointer("pointermove", 2, 320, 200);
    v.frame();
    v.frame(40);
    expect(v.elements.image.style.width).toBe("400px");
    v.pointer("pointermove", 1, 72, 200);
    v.pointer("pointermove", 2, 330, 200);
    v.frame();
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(
      (400 * 258) / 238,
    );
  });
  it("does not mistake staggered parallel updates for a pinch", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    for (const delta of [10, 20, 30]) {
      v.pointer("pointermove", 1, 100 + delta, 200);
      v.frame();
      v.pointer("pointermove", 2, 300 + delta, 200);
      v.frame();
    }
    v.frame(60);
    v.flush();
    expect(v.elements.image.style.width).toBe("400px");
    expect(v.messages.at(-1)?.events?.every((e) => e.kind === "scroll")).toBe(
      true,
    );
  });
  it("applies the last pinch position before lifting a finger without clicking", () => {
    const v = viewer();
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 300, 200);
    v.pointer("pointermove", 1, 90, 200);
    v.pointer("pointermove", 2, 310, 200);
    v.frame();
    v.frame(40);
    v.pointer("pointermove", 1, 80, 200);
    v.pointer("pointerup", 2, 340, 200);
    expect(parseFloat(v.elements.image.style.width)).toBeCloseTo(520);
    v.pointer("pointerup", 1, 80, 200);
    v.frame();
    v.flush();
    expect(v.messages.flatMap((m) => m.events ?? [])).toEqual([]);
  });
  it("recognizes parallel two-finger movement as scrolling, not a pinch", () => {
    const v = viewer();
    v.send({ type: "init", epoch: "one", width: 1920, height: 1080 });
    v.send({ type: "control", enabled: true });
    v.pointer("pointerdown", 1, 100, 200);
    v.pointer("pointerdown", 2, 200, 200);
    v.pointer("pointermove", 1, 110, 200);
    v.pointer("pointermove", 2, 210, 200);
    v.frame();
    v.pointer("pointermove", 1, 120, 200);
    v.pointer("pointermove", 2, 220, 200);
    v.frame();
    v.flush();
    expect(v.elements.image.style.width).toBe("400px");
    expect(
      v.messages.at(-1)?.events?.every((event) => event.kind === "scroll"),
    ).toBe(true);
  });
});

it("reports both landscape directions even when viewport dimensions stay identical", () => {
  const v = viewer();
  v.elements.stage.clientWidth = 874;
  v.elements.stage.clientHeight = 402;
  for (const angle of [90, -90, 90]) {
    v.rotate(angle);
    expect(v.messages.at(-1)).toMatchObject({ type: "orientation", angle });
  }
});

describe("portrait keyboard positioning", () => {
  it.each([48, 96, 128])(
    "centers below %s points of top controls and restores after closing",
    (topInset) => {
      const v = viewer();
      v.send({ type: "init", epoch: "keyboard", width: 1920, height: 1080 });
      v.frame();
      const originalTop = parseFloat(v.elements.image.style.top);
      const originalWidth = v.elements.image.style.width;
      v.send({ type: "mouseButtons", portraitKeyboardTopInset: topInset });
      for (let i = 0; i < 30; i++) v.frame(20);
      expect(parseFloat(v.elements.image.style.top)).toBeCloseTo(
        originalTop + topInset / 2,
      );
      expect(v.elements.image.style.width).toBe(originalWidth);
      v.send({ type: "mouseButtons", portraitKeyboardTopInset: 0 });
      for (let i = 0; i < 30; i++) v.frame(20);
      expect(parseFloat(v.elements.image.style.top)).toBeCloseTo(originalTop);
    },
  );
  it("limits the offset to available space below the desktop", () => {
    const v = viewer();
    v.elements.stage.clientHeight = 240;
    v.send({ type: "init", epoch: "keyboard", width: 1920, height: 1080 });
    v.send({ type: "mouseButtons", portraitKeyboardTopInset: 96 });
    for (let i = 0; i < 30; i++) v.frame(20);
    expect(
      parseFloat(v.elements.image.style.top) +
        parseFloat(v.elements.image.style.height),
    ).toBeCloseTo(240);
  });
});

describe("remote desktop network status layer", () => {
  it("updates plain text and theme styling and clears when dismissed", () => {
    const v = viewer();
    v.send({
      type: "networkStatus",
      text: "Direct\n11 KB/s · 1 ms",
      top: 60,
      right: 8,
      fontSize: 12,
      color: "#737373",
    });
    const status = v.elements["network-status"];
    expect(status.textContent).toBe("Direct\n11 KB/s · 1 ms");
    expect(status.style).toMatchObject({
      display: "block",
      top: "60px",
      right: "8px",
      fontSize: "12px",
      color: "#737373",
    });
    v.send({ type: "networkStatus", text: "<img src=x>", color: "#a3a3a3" });
    expect(status.textContent).toBe("<img src=x>");
    expect(status.style.color).toBe("#a3a3a3");
    v.send({ type: "networkStatus", text: "" });
    expect(status.style.display).toBe("none");
  });

  it("places transparent status above the backdrop but below the desktop", () => {
    const html = remoteDesktopViewerHtml("#fff", "#111");
    const rule = html.match(/#network-status\{([^}]+)\}/)![1];
    expect(rule).toContain("z-index:1");
    expect(rule).toContain("pointer-events:none");
    expect(rule).not.toContain("background");
    expect(html).toContain("#image{z-index:2}");
    expect(html).toContain('id="network-status"');
  });
});

describe("remote desktop three-segment backdrop", () => {
  it.each([true, false])(
    "only repaints live video on media progress (frame callbacks: %s)",
    (callback) => {
      const v = viewer(true, callback);
      v.send({
        type: "init",
        epoch: "bg",
        width: 1920,
        height: 1080,
        trickleIce: true,
      });
      v.playVideo();
      v.videoFrame();
      v.frame();
      v.frame();
      v.frame();
      v.bgDraws.length = 0;
      for (let i = 0; i < 120; i++) v.frame();
      expect(v.bgDraws).toHaveLength(0);
      if (callback) v.videoFrame();
      else {
        v.timeupdate();
        v.frame();
      }
      expect(v.bgDraws).toHaveLength(3);
      expect(v.bgDraws[0][0]).toBe(v.elements.video);
      const stale = [...v.videoFrames.values()][0];
      v.send({ type: "stop" });
      v.frame();
      v.bgDraws.length = 0;
      stale?.();
      v.timeupdate();
      v.frame();
      expect(v.videoFrames.size).toBe(0);
      expect(v.bgDraws).toHaveLength(0);
    },
  );

  it("cancels hidden background callbacks and resumes after the stage changes", () => {
    const v = viewer(true);
    v.send({
      type: "init",
      epoch: "bg",
      width: 1920,
      height: 1080,
      trickleIce: true,
    });
    v.playVideo();
    v.videoFrame();
    v.frame();
    v.frame();
    v.frame();
    expect(v.videoFrames.size).toBe(1);
    const stale = [...v.videoFrames.values()][0];
    v.elements.stage.clientWidth = 1920;
    v.elements.stage.clientHeight = 1080;
    v.send({ type: "viewport", fillHeight: false });
    v.bgDraws.length = 0;
    stale();
    v.frame();
    expect(v.bgDraws).toHaveLength(0);
    expect(v.videoFrames.size).toBe(0);
    v.elements.stage.clientWidth = 400;
    v.send({ type: "viewport", fillHeight: false });
    v.frame();
    expect(v.bgDraws).toHaveLength(3);
    expect(v.videoFrames.size).toBe(1);
    v.send({ type: "stop" });
  });
  function landscapeViewer() {
    const v = viewer();
    v.elements.stage.clientWidth = 874;
    v.elements.stage.clientHeight = 402;
    v.send({ type: "init", epoch: "bg", width: 1920, height: 1080 });
    v.frame();
    return v;
  }
  type Draw = [
    unknown,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const drawsOf = (v: ReturnType<typeof viewer>) => v.bgDraws as Draw[];
  const expectDest = (
    draw: Draw,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    expect(draw[5]).toBeCloseTo(x, 6);
    expect(draw[6]).toBeCloseTo(y, 6);
    expect(draw[7]).toBeCloseTo(w, 6);
    expect(draw[8]).toBeCloseTo(h, 6);
  };
  const expectSrc = (
    draw: Draw,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    expect(draw[1]).toBeCloseTo(x, 6);
    expect(draw[2]).toBeCloseTo(y, 6);
    expect(draw[3]).toBeCloseTo(w, 6);
    expect(draw[4]).toBeCloseTo(h, 6);
  };
  const px = (id: string, prop: string, v: ReturnType<typeof viewer>) =>
    parseFloat(v.elements[id].style[prop]);

  it("fills side bars with stretched edges around an undistorted center", () => {
    const v = landscapeViewer();
    expect(v.elements.bg.style.display).toBe("block");
    const scale = 402 / 1080;
    const fitWidth = 1920 * scale;
    const centerW = fitWidth * 0.9;
    const side = 874 / 2 - centerW / 2;
    expect(px("image", "width", v)).toBeCloseTo(fitWidth, 2);
    expect(px("image", "left", v)).toBeCloseTo((874 - fitWidth) / 2, 2);
    expect(drawsOf(v)).toHaveLength(3);
    expectDest(drawsOf(v)[0], 0, 0, side, 402);
    expectSrc(drawsOf(v)[0], 0, 0, 96, 1080);
    expectDest(drawsOf(v)[1], side, 0, centerW, 402);
    expectSrc(drawsOf(v)[1], 96, 0, 1728, 1080);
    expectDest(drawsOf(v)[2], side + centerW, 0, side, 402);
    expectSrc(drawsOf(v)[2], 1824, 0, 96, 1080);
    expect(side + centerW + side).toBeCloseTo(874, 2);
  });

  it("fills both safe areas and the toolbar while the picture respects side insets", () => {
    const v = landscapeViewer();
    v.bgDraws.length = 0;
    v.send({ type: "viewport", fillHeight: true });
    v.send({
      type: "mouseButtons",
      enabled: true,
      leftInset: 56,
      rightInset: 68,
    });
    v.frame();
    const fitWidth = 1920 * (402 / 1080);
    const vw = 874 - 56 - 68;
    const centerW = fitWidth * 0.9;
    const side = 874 / 2 - centerW / 2;
    expect(px("image", "left", v)).toBeCloseTo(56 + (vw - fitWidth) / 2, 2);
    expect(drawsOf(v)).toHaveLength(3);
    expectDest(drawsOf(v)[0], 0, 0, side, 402);
    expectDest(drawsOf(v)[1], side, 0, centerW, 402);
    expect(drawsOf(v)[2][5]).toBeCloseTo(side + centerW, 6);
    expect(drawsOf(v)[2][8]).toBeCloseTo(402, 6);
    expect(side + centerW + side).toBeCloseTo(874, 2);
  });

  it("stretches top and bottom bars around an undistorted center in portrait", () => {
    const v = viewer();
    v.send({ type: "init", epoch: "bg", width: 1920, height: 1080 });
    v.frame();
    expect(v.elements.bg.style.display).toBe("block");
    const scale = 400 / 1920;
    const fitHeight = 1080 * scale;
    const centerH = fitHeight * 0.9;
    const side = 600 / 2 - centerH / 2;
    expect(px("image", "height", v)).toBeCloseTo(fitHeight, 2);
    expect(px("image", "top", v)).toBeCloseTo((600 - fitHeight) / 2, 2);
    expect(drawsOf(v)).toHaveLength(3);
    expectDest(drawsOf(v)[0], 0, 0, 400, side);
    expectSrc(drawsOf(v)[0], 0, 0, 1920, 54);
    expectDest(drawsOf(v)[1], 0, side, 400, centerH);
    expectSrc(drawsOf(v)[1], 0, 54, 1920, 972);
    expectDest(drawsOf(v)[2], 0, side + centerH, 400, side);
    expectSrc(drawsOf(v)[2], 0, 1026, 1920, 54);
    expect(side + centerH + side).toBeCloseTo(600, 2);
  });

  it("hides the backdrop when the fitted picture covers the whole stage", () => {
    const v = landscapeViewer();
    v.bgDraws.length = 0;
    v.send({ type: "init", epoch: "bg-wide", width: 2560, height: 1080 });
    v.send({ type: "viewport", fillHeight: true });
    v.frame();
    expect(v.elements.bg.style.display).toBe("none");
    expect(drawsOf(v)).toHaveLength(0);
  });

  it("draws JPEG fallback frames into the backdrop canvas", () => {
    const v = landscapeViewer();
    v.bgDraws.length = 0;
    v.send({ type: "frame", jpeg: "QUJD" });
    (v.elements.image as unknown as { onload?: () => void }).onload?.();
    v.frame();
    expect(v.messages.at(-1)?.type).toBe("framePresented");
    expect(drawsOf(v)).toHaveLength(3);
    for (const draw of drawsOf(v)) expect(draw[0]).toBe(v.elements.image);
  });

  it.each([
    { complete: false, naturalWidth: 0, naturalHeight: 0 },
    { complete: false, naturalWidth: 1920, naturalHeight: 1080 },
    { complete: true, naturalWidth: 0, naturalHeight: 0 },
  ])(
    "preserves the previous backdrop until a JPEG is drawable: %j",
    (pending) => {
      const v = landscapeViewer();
      expect(drawsOf(v)).toHaveLength(3);
      v.bgDraws.length = 0;
      v.bgClear.mockClear();
      // Receiving a frame schedules a cursor-driven repaint before JPEG load.
      v.send({ type: "frame", jpeg: "QUJD" });
      const image = Object.assign(v.elements.image, pending);
      v.frame();
      expect(v.bgClear).not.toHaveBeenCalled();
      expect(drawsOf(v)).toHaveLength(0);

      Object.assign(image, {
        complete: true,
        naturalWidth: 1920,
        naturalHeight: 1080,
      });
      (image as unknown as { onload: () => void }).onload();
      v.frame();
      expect(v.bgClear).toHaveBeenCalledTimes(1);
      expect(drawsOf(v)).toHaveLength(3);
      for (const draw of drawsOf(v)) expect(draw[0]).toBe(image);
    },
  );

  it("fills side bars for a portrait desktop on a landscape stage", () => {
    const v = viewer();
    v.elements.stage.clientWidth = 800;
    v.elements.stage.clientHeight = 400;
    v.send({ type: "init", epoch: "bg", width: 1080, height: 1920 });
    v.frame();
    const fitWidth = 1080 * (400 / 1920);
    const centerW = fitWidth * 0.9;
    const side = 800 / 2 - centerW / 2;
    expect(v.elements.bg.style.display).toBe("block");
    expect(drawsOf(v)).toHaveLength(3);
    expectDest(drawsOf(v)[1], side, 0, centerW, 400);
    expect(side + centerW + side).toBeCloseTo(800, 2);
  });
});
