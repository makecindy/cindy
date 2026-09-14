import { describe, expect, it, vi } from "vitest";

import { WdaClient } from "./client.js";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("WdaClient", () => {
  it("rejects non-loopback and authenticated URLs", () => {
    expect(
      () => new WdaClient({ controlUrl: "http://192.168.1.10:8100" }),
    ).toThrow("loopback HTTP URL");
    expect(() => new WdaClient({ mjpegUrl: "https://localhost:9100" })).toThrow(
      "loopback HTTP URL",
    );
    expect(
      () => new WdaClient({ controlUrl: "http://user@localhost:8100" }),
    ).toThrow("loopback HTTP URL");
  });

  it("maps status fields and creates/deletes sessions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          value: {
            ready: true,
            message: "ready",
            os: { name: "iOS", version: "26.1", sdkVersion: "26.4" },
            build: {},
            ios: { ip: "127.0.0.1" },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: {
            sessionId: "SESSION-1",
            capabilities: { platformName: "iOS" },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ value: null }));
    const client = new WdaClient({ fetch });

    await expect(client.probe()).resolves.toMatchObject({
      ready: true,
      osName: "iOS",
      osVersion: "26.1",
      sdkVersion: "26.4",
    });
    const session = await client.createSession();
    expect(session).toMatchObject({
      id: "SESSION-1",
      capabilities: { platformName: "iOS" },
    });
    await client.deleteSession(session.id);
    expect(String(fetch.mock.calls[2]?.[0])).toBe(
      "http://127.0.0.1:8100/session/SESSION-1",
    );
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("normalizes a W3C error envelope and bounds JSON responses", async () => {
    const protocolClient = new WdaClient({
      fetch: vi.fn(async () =>
        jsonResponse(
          { value: { error: "invalid argument", message: "bad capabilities" } },
          { status: 400 },
        ),
      ),
    });
    await expect(protocolClient.createSession()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      statusCode: 400,
    });

    const boundedClient = new WdaClient({
      maxJsonBytes: 8,
      fetch: vi.fn(async () => jsonResponse({ value: { ready: true } })),
    });
    await expect(boundedClient.probe()).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("sends driver mutations through session-scoped W3C routes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ value: null }));
    const client = new WdaClient({ fetch });

    await client.tap("SESSION-1", { x: 10, y: 20 });
    await client.swipe("SESSION-1", { x: 1, y: 2 }, { x: 3, y: 4 }, 250);
    await client.typeText("SESSION-1", "Hi");
    await client.home("SESSION-1");
    await client.lock("SESSION-1");
    await client.unlock("SESSION-1");
    await client.configureStream("SESSION-1", {
      framesPerSecond: 10,
      jpegQuality: 50,
      scalingPercent: 75,
    });

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:8100/session/SESSION-1/actions",
      "http://127.0.0.1:8100/session/SESSION-1/actions",
      "http://127.0.0.1:8100/session/SESSION-1/wda/keys",
      "http://127.0.0.1:8100/session/SESSION-1/wda/pressButton",
      "http://127.0.0.1:8100/session/SESSION-1/wda/lock",
      "http://127.0.0.1:8100/session/SESSION-1/wda/unlock",
      "http://127.0.0.1:8100/session/SESSION-1/appium/settings",
    ]);
    const typeBody = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(typeBody).toEqual({ value: ["H", "i"] });
    const homeBody = JSON.parse(String(fetch.mock.calls[3]?.[1]?.body));
    expect(homeBody).toEqual({ name: "home" });
  });

  it("classifies an app-level rotation refusal without marking WDA unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          value: {
            error: "unknown error",
            message: "Unable To Rotate Device",
          },
        },
        { status: 500 },
      ),
    );
    const client = new WdaClient({ fetch });

    await expect(
      client.setOrientation("LANDSCAPE", "SESSION-1"),
    ).rejects.toMatchObject({
      code: "ORIENTATION_UNSUPPORTED",
      statusCode: 500,
      message: "The foreground app does not support the requested orientation.",
    });
  });

  it("rejects unbounded gesture and text inputs before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new WdaClient({ fetch });

    await expect(
      client.tap("SESSION-1", { x: Number.NaN, y: 1 }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    await expect(
      client.swipe("SESSION-1", { x: 1, y: 2 }, { x: 3, y: 4 }, 60_001),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(
      client.typeText("SESSION-1", "x".repeat(10_001)),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps accessibility format in the URL query string", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse({ value: { type: "XCUIElementTypeApplication" } }),
      );
    const client = new WdaClient({ fetch });

    await client.getAccessibilityTree("SESSION-1");

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8100/session/SESSION-1/source?format=json",
    );
  });

  it("reads and validates the session viewport size", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ value: { width: 393, height: 852 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ value: { width: 0, height: 852 } }),
      );
    const client = new WdaClient({ fetch });

    await expect(client.getWindowSize("SESSION-1")).resolves.toEqual({
      width: 393,
      height: 852,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8100/session/SESSION-1/window/size",
    );
    await expect(client.getWindowSize("SESSION-1")).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });
  });

  it("streams bounded MJPEG frames and stops at maxFrames", async () => {
    const boundary = "frame";
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const header = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    );
    const body = new Uint8Array(header.length + jpeg.length + 2);
    body.set(header);
    body.set(jpeg, header.length);
    body.set([13, 10], header.length + jpeg.length);
    const fetch = vi.fn(
      async () =>
        new Response(body, {
          headers: {
            "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
          },
        }),
    );
    const frames: Uint8Array[] = [];
    const stats = await new WdaClient({ fetch }).streamFrames({
      maxFrames: 1,
      onFrame: (frame) => {
        frames.push(frame.bytes);
      },
    });

    expect(frames).toEqual([jpeg]);
    expect(stats).toMatchObject({
      frameCount: 1,
      byteCount: jpeg.length,
      endReason: "max-frames",
    });
    expect(stats.firstFrameAt).not.toBeNull();
  });

  it("returns collected stream stats when the caller aborts", async () => {
    const boundary = "frame";
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const header = new TextEncoder().encode(
      `--${boundary}\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    );
    const body = new Uint8Array(header.length + jpeg.length + 2);
    body.set(header);
    body.set(jpeg, header.length);
    body.set([13, 10], header.length + jpeg.length);
    const abortController = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          signal?.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
        },
      });
    });

    const stats = await new WdaClient({ fetch }).streamFrames({
      signal: abortController.signal,
      onFrame() {
        abortController.abort();
      },
    });

    expect(stats).toMatchObject({
      frameCount: 1,
      byteCount: jpeg.length,
      endReason: "aborted",
    });
  });

  it("reports a server-side clean EOF distinctly", async () => {
    const boundary = "frame";
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array(), {
          headers: {
            "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
          },
        }),
    );

    const stats = await new WdaClient({ fetch }).streamFrames({
      onFrame() {},
    });

    expect(stats).toMatchObject({ frameCount: 0, endReason: "eof" });
  });
});
