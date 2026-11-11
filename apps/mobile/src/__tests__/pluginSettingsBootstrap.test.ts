import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
import {
  prepareSettingsHtml,
  settingsBridgeAsset,
} from "../plugins/pluginSettingsHtml";

/* 测试价值
 * 生产入口与可观察结果：settingsBridgeAsset 的实际预编译脚本；原页fetch/XHR、动态频道、主题和离页取消。
 * Bug／规则依据：plugin-mobile-implementation「入口与页面」；protocol-compatibility「同账号远程插件管理」。
 * 现有覆盖缺口：pluginPage只支持声明频道/Blob资源，不承载存量settingsHtml的独立同源桥。
 * 最小失败输入：嵌套页面相对XHR、运行时频道、换主题时保留输入、超时后迟到回执。
 * tier：unit；只有DOM执行需要JSDOM，不创建socket或原生WebView。
 * 实测耗时：单文件墙钟 2.42s。
 */
const document = {
  pageId: "settings",
  pluginId: "_ns__example__test",
  manifestId: "test",
  name: "Original",
  entry: "ui/settings.html",
  files: [
    { path: "ui/settings.html", mime: "text/html", size: 0 },
    { path: "ui/data.json", mime: "application/json", size: 2 },
  ],
};
const theme = {
  dark: false,
  colors: { "panel-bg": "ivory", "text-primary": "black" },
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});
function fixture(body = '<input id="field">') {
  const messages: any[] = [];
  const localFetch = vi.fn(
    async () =>
      new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body>" + body + "</body></html>",
    {
      url: "http://127.0.0.1:42300/ui/settings.html",
      runScripts: "dangerously",
      beforeParse(window: Window & typeof globalThis) {
        Object.assign(window, {
          Request,
          Response,
          Blob,
          TextEncoder,
          TextDecoder,
          fetch: localFetch,
          ReactNativeWebView: {
            postMessage: (raw: string) => messages.push(JSON.parse(raw)),
          },
        });
      },
    },
  );
  cleanup.push(() => {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    dom.window.close();
  });
  const bridge = settingsBridgeAsset(document, theme);
  dom.window.eval(bridge.text);
  const reply = (id: number, value: unknown, ok = true) =>
    dom.window.__cindySettingsReceive({ kind: "reply", id, ok, value });
  return { dom, window: dom.window, messages, reply, localFetch };
}
describe("original settings generated bridge", () => {
  // 用户实测：13px原页输入框聚焦触发iOS自动zoom并裁切卡片；现有主题测试不覆盖字号。
  // unit最小输入：继承13px的文本控件、大字号/非文本控件，以及DOM-ready后新增子树。
  it("raises only small editable control fonts while preserving drafts and disconnecting on close", async () => {
    const f = fixture(`<style>body{font-size:13px}.input{font:inherit}</style>
      <input id="small" class="input" value="unsaved draft">
      <textarea id="area" style="font-size:12px">draft</textarea>
      <select id="select" style="font-size:14px"><option>Choice</option></select>
      <input id="large" style="font-size:22px">
      <input id="check" type="checkbox" style="font-size:12px">`);
    await new Promise<void>((resolve) =>
      f.window.document.addEventListener("DOMContentLoaded", () => resolve(), {
        once: true,
      }),
    );
    const get = (id: string) => f.window.document.getElementById(id);
    for (const id of ["small", "area", "select"])
      expect(get(id).style.fontSize).toBe("16px");
    expect(get("large").style.fontSize).toBe("22px");
    expect(get("check").style.fontSize).toBe("12px");
    expect(get("small").value).toBe("unsaved draft");
    expect(get("area").value).toBe("draft");
    const subtree = f.window.document.createElement("div");
    subtree.innerHTML =
      '<input id="dynamic" style="font-size:13px"><textarea id="dynamicLarge" style="font-size:20px"></textarea>';
    f.window.document.body.append(subtree);
    await Promise.resolve();
    expect(get("dynamic").style.fontSize).toBe("16px");
    expect(get("dynamicLarge").style.fontSize).toBe("20px");
    f.window.dispatchEvent(new f.window.Event("pagehide"));
    const later = f.window.document.createElement("input");
    later.style.fontSize = "13px";
    f.window.document.body.append(later);
    await Promise.resolve();
    expect(later.style.fontSize).toBe("13px");
  });
  it("keeps the original OAuth request pending through browser interaction without replaying it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const work = f.window.fetch("/oauth/provider/connect", {
      method: "POST",
      body: "{}",
    });
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBe(false);
    const requests = f.messages.filter(
      (message) => message.command?.kind === "fetch",
    );
    expect(requests).toHaveLength(1);
    f.reply(requests[0].id, {
      status: 200,
      mime: "application/json",
      base64: Buffer.from('{"accounts":["test"]}').toString("base64"),
    });
    expect(await (await work).json()).toEqual({ accounts: ["test"] });
  });
  it("routes fetch and asynchronous XHR through one settings request and preserves original HTTP results", async () => {
    const f = fixture();
    const fetchWork = f.window.fetch("cindy-ghost://test/kv", {
      method: "PUT",
      body: '{"mode":"manual"}',
    });
    expect(f.messages.at(-1).command).toEqual({
      kind: "fetch",
      path: "/kv",
      method: "PUT",
      body: '{"mode":"manual"}',
    });
    f.reply(f.messages.at(-1).id, {
      status: 204,
      base64: "",
      mime: "application/json",
    });
    expect((await fetchWork).status).toBe(204);
    const xhr = new f.window.XMLHttpRequest();
    xhr.open("GET", "../kv");
    xhr.responseType = "json";
    const loaded = new Promise<void>((resolve) => {
      xhr.onload = resolve;
    });
    xhr.send();
    f.reply(f.messages.at(-1).id, {
      status: 200,
      base64: Buffer.from('{"fields":["中文","b"]}').toString("base64"),
      mime: "application/json",
    });
    await loaded;
    expect(xhr.response).toEqual({ fields: ["中文", "b"] });
    expect(xhr.readyState).toBe(4);
    expect(f.localFetch).not.toHaveBeenCalled();
  });
  it("keeps package fetches relative and denies network escape without issuing a native command", async () => {
    const f = fixture();
    await f.window.fetch("./data.json");
    expect(f.localFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:42300/ui/data.json",
      undefined,
    );
    await expect(f.window.fetch("https://example.invalid/kv")).rejects.toThrow(
      "NETWORK_BLOCKED",
    );
    await expect(f.window.fetch("/not-in-package.js")).rejects.toThrow(
      "NETWORK_BLOCKED",
    );
    expect(f.messages.filter((message) => message.command)).toEqual([]);
  });
  it("subscribes dynamically, posts only after registration and delivers the original result event", async () => {
    const f = fixture(),
      channel = new f.window.BroadcastChannel("original-runtime-channel");
    await vi.waitFor(() =>
      expect(
        f.messages.find((message) => message.command?.kind === "subscribe"),
      ).toBeDefined(),
    );
    channel.postMessage({ kind: "connect", fields: { region: "test" } });
    expect(
      f.messages.filter((message) => message.command?.kind === "post"),
    ).toHaveLength(0);
    f.reply(
      f.messages.find((message) => message.command?.kind === "subscribe").id,
      {},
    );
    await vi.waitFor(() =>
      expect(
        f.messages.find((message) => message.command?.kind === "post"),
      ).toBeDefined(),
    );
    const received = vi.fn();
    channel.onmessage = received;
    f.window.__cindySettingsReceive({
      kind: "events",
      events: [
        {
          sequence: 1,
          channel: channel.name,
          data: { accounts: ["Test account"] },
        },
      ],
    });
    expect(received.mock.calls[0][0].data).toEqual({
      accounts: ["Test account"],
    });
    f.reply(
      f.messages.find((message) => message.command?.kind === "post").id,
      {},
    );
    channel.close();
    await vi.waitFor(() =>
      expect(
        f.messages.find((message) => message.command?.kind === "unsubscribe"),
      ).toBeDefined(),
    );
    f.reply(
      f.messages.find((message) => message.command?.kind === "unsubscribe").id,
      {},
    );
  });
  it("updates theme without replacing the original fields and rejects outstanding work on page hide", async () => {
    const f = fixture(),
      field = f.window.document.getElementById("field");
    field.value = "unsaved non-secret";
    f.window.__cindySettingsTheme({
      dark: true,
      colors: { "panel-bg": "charcoal" },
    });
    expect(f.window.document.documentElement.classList.contains("dark")).toBe(
      true,
    );
    expect(
      f.window.document.documentElement.style.getPropertyValue("--panel-bg"),
    ).toBe("charcoal");
    expect(field.value).toBe("unsaved non-secret");
    const work = f.window.fetch("/kv");
    f.window.dispatchEvent(new f.window.Event("pagehide"));
    await expect(work).rejects.toThrow("CLOSED");
    expect(field.value).toBe("");
    f.reply(f.messages.at(-1).id, { status: 200, base64: "e30=" });
    await expect(f.window.fetch("/kv")).rejects.toThrow("CLOSED");
  });
  it("injects a separate first script while preserving the original HTML and author viewport", () => {
    const html =
      '<html><head><meta name="viewport" content="width=700"><script type="module" src="./settings.js"></script></head><body class="author">Original</body></html>';
    const prepared = prepareSettingsHtml(html, "__bridge.js");
    expect(prepared).toContain(
      '<head><script src="/__bridge.js"></script><style>',
    );
    expect(prepared).toContain(
      '<script type="module" src="./settings.js"></script>',
    );
    expect(prepared).toContain('<body class="author">Original</body>');
    expect(prepared.match(/name="viewport"/g)).toHaveLength(1);
  });
  it("keeps fresh credential submission off BC/storage and clears the input on leaving", async () => {
    const f = fixture(),
      field = f.window.document.getElementById("field");
    field.type = "password";
    field.value = "invalid-fixture-secret";
    expect(() => f.window.localStorage.setItem("new-key", field.value)).toThrow(
      "storage disabled",
    );
    expect(f.window.indexedDB).toBeUndefined();
    expect(f.window.Worker).toBeUndefined();
    const channel = new f.window.BroadcastChannel("original-settings");
    expect(() => channel.postMessage({ credential: field.value })).toThrow(
      "cannot use BroadcastChannel",
    );
    const work = f.window.fetch("/secrets/key", {
      method: "PUT",
      body: JSON.stringify({ value: field.value }),
    });
    const request = f.messages.find(
      (message) => message.command?.kind === "fetch",
    );
    expect(request.command.path).toBe("/secrets/key");
    f.reply(request.id, { status: 204, base64: "", mime: "application/json" });
    await work;
    expect(
      f.messages.filter((message) => message.command?.kind === "post"),
    ).toHaveLength(0);
    f.window.dispatchEvent(new f.window.Event("pagehide"));
    expect(field.value).toBe("");
  });
});
