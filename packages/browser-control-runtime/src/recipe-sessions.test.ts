import { describe, expect, it, vi } from "vitest";
import { RecipeBrowserSessions } from "./recipe-sessions.js";

describe("recipe browser sessions", () => {
  // #6826 / 4353868431: real capture API, unit tier. The old small-response
  // tests never crossed the count/payload bounds with an older in-flight request.
  it.each(['count', 'payload'] as const)('keeps unfinished requests across the %s cap', async cap => {
    const sessions = new RecipeBrowserSessions();
    let event = (_method: string, _params: Record<string, unknown>) => {};
    const id = sessions.begin('target', {
      send: async () => ({ body: cap === 'payload' ? 'x'.repeat(1_000_000) : 'done' }),
      subscribe: listener => { event = listener; return () => {}; }, dispose: () => {},
    });
    const start = (requestId: string) => event('Network.requestWillBeSent', {
      requestId, request: { url: 'https://example.test/api' },
    });
    try {
      await sessions.call('target', id, 'Cindy.captureStart');
      start('unfinished');
      for (let i = 0; i < (cap === 'count' ? 101 : 9); i++) {
        start(`complete-${i}`);
        event('Network.loadingFinished', { requestId: `complete-${i}` });
        await Promise.resolve();
      }
      const read = await sessions.call('target', id, 'Cindy.captureRead') as { entries: Array<Record<string, unknown>> };
      expect(read.entries).toContainEqual(expect.objectContaining({ requestId: 'unfinished', captureComplete: false }));
      expect(read.entries.length).toBeLessThanOrEqual(100);
      expect(read.entries.reduce((sum, entry) => sum + String(entry.responsePreview ?? '').length, 0)).toBeLessThanOrEqual(8_000_000);
      expect(await sessions.call('target', id, 'Cindy.captureRead')).toMatchObject({ entries: [{ requestId: 'unfinished' }] });
    } finally { sessions.dispose(); }
  });

  // Review #6826: a valid large response must be distinguishable from malformed
  // JSON. Public session capture/read entry; unit tier. Existing small-body
  // coverage did not cross the one-million-character boundary or cover base64.
  it.each([[999_999, false], [1_000_000, false], [1_000_001, false], [1_000_001, true]] as const)(
    'reports truncation for body length %s (base64=%s)', async (length, base64Encoded) => {
      const sessions = new RecipeBrowserSessions();
      let event = (_method: string, _params: Record<string, unknown>) => {};
      const body = 'x'.repeat(length);
      const id = sessions.begin('target', {
        send: async () => ({ body, base64Encoded }),
        subscribe: listener => { event = listener; return () => {}; },
        dispose: () => {},
      });
      try {
        await sessions.call('target', id, 'Cindy.captureStart');
        event('Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://example.test/api' } });
        event('Network.loadingFinished', { requestId: 'r' });
        await Promise.resolve();
        const result = await sessions.call('target', id, 'Cindy.captureRead') as { entries: Array<Record<string, unknown>> };
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({
          captureComplete: true, responseBodyFullSize: length,
          responseBodyTruncated: length > 1_000_000,
          responsePreview: `${base64Encoded ? 'base64:' : ''}${body.slice(0, 1_000_000)}`,
        });
      } finally { sessions.dispose(); }
    },
  );

  it("captures and drains responses across navigation without losing unfinished requests", async () => {
    const sessions = new RecipeBrowserSessions();
    let event: (
      method: string,
      params: Record<string, unknown>,
    ) => void = () => {};
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    let complete: (value: unknown) => void = () => {};
    const send = vi.fn(async (method: string) =>
      method === "Network.getResponseBody"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : {},
    );
    const id = sessions.begin("tab-one", {
      send,
      subscribe: (listener) => {
        event = listener;
        return unsubscribe;
      },
      dispose,
    });
    await sessions.call("tab-one", id, "Cindy.captureStart", {
      pattern: "/api/,/other/",
    });
    event("Network.requestWillBeSent", {
      requestId: "r",
      request: {
        url: "https://example.test/api/list",
        method: "POST",
        postData: "test",
      },
    });
    event("Network.responseReceived", {
      requestId: "r",
      response: { status: 200 },
    });
    event("Network.loadingFinished", { requestId: "r" });
    expect(
      await sessions.call("tab-one", id, "Cindy.captureRead"),
    ).toMatchObject({
      entries: [{ requestId: "r", responseStatus: 200, requestBody: "test" }],
    });
    complete({ body: '{"items":[1]}' });
    await vi.waitFor(async () => {
      expect(
        await sessions.call("tab-one", id, "Cindy.captureRead"),
      ).toMatchObject({
        entries: [{ captureComplete: true, responsePreview: '{"items":[1]}' }],
      });
    });
    expect(await sessions.call("tab-one", id, "Cindy.captureRead")).toEqual({
      entries: [],
    });
    await sessions.call("tab-one", id, "Cindy.end");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refuses cross-target access and commands that bypass navigation/upload policy", async () => {
    const sessions = new RecipeBrowserSessions();
    const send = vi.fn(async () => ({}));
    const id = sessions.begin("profile-a/tab-a", {
      send,
      subscribe: () => () => {},
      dispose: () => {},
    });
    try {
      await expect(
        sessions.call("profile-b/tab-b", id, "DOM.getDocument"),
      ).rejects.toThrow("unavailable");
      await expect(
        sessions.call("profile-a/tab-a", id, "DOM.setFileInputFiles"),
      ).rejects.toThrow("Unsupported");
      await expect(
        sessions.call("profile-a/tab-a", id, "Page.navigate"),
      ).rejects.toThrow("Unsupported");
      expect(send).not.toHaveBeenCalled();
    } finally {
      sessions.dispose();
    }
  });
});
