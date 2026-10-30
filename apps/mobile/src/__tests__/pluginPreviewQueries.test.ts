import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
import {
  PLUGIN_PREVIEW_QUERY_SCRIPT,
  pluginPreviewQueryTarget,
} from "../plugins/pluginPreviewQueries";

describe("computer preview query resource paths", () => {
  it("preserves browser GET and XHR query strings through the existing native resource server", async () => {
    const calls: string[] = [],
      xhr: string[] = [];
    const dom = new JSDOM(PLUGIN_PREVIEW_QUERY_SCRIPT, {
      url: "http://127.0.0.1:8080/page",
      runScripts: "dangerously",
      beforeParse(window: Window & typeof globalThis) {
        Object.assign(window, {
          Request,
          fetch: async (url: string) => {
            calls.push(String(url));
            return new Response("{}");
          },
        });
        window.XMLHttpRequest.prototype.open = ((
          _method: string,
          url: string,
        ) => {
          xhr.push(String(url));
        }) as typeof window.XMLHttpRequest.prototype.open;
      },
    });
    try {
      await dom.window.fetch("/api?topic=%E4%B8%AD%E6%96%87&v=2");
      const request = new dom.window.XMLHttpRequest();
      request.open("GET", "/api?next=3");
      const resource = new URL(calls[0]).pathname.slice(1);
      expect(pluginPreviewQueryTarget(resource, "http://localhost:1234")).toBe(
        "http://localhost:1234/api?topic=%E4%B8%AD%E6%96%87&v=2",
      );
      expect(
        pluginPreviewQueryTarget(
          new URL(xhr[0]).pathname.slice(1),
          "http://localhost:1234",
        ),
      ).toBe("http://localhost:1234/api?next=3");
      const foreign =
        "__cindy_plugin_query/" +
        Buffer.from("https://other.invalid/private").toString("hex");
      expect(() =>
        pluginPreviewQueryTarget(foreign, "http://localhost:1234"),
      ).toThrow("INVALID_PREVIEW_QUERY");
    } finally {
      dom.window.close();
    }
  });
});
