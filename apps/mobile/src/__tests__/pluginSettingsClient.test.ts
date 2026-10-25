import { describe, expect, it, vi } from "vitest";
import type { PluginOauthRequest } from "@cindy/device-link";
import {
  openPluginSettingsClient,
  isPluginSettingsFetch,
  parsePluginSettingsDocument,
} from "../plugins/pluginSettingsClient";
import { readPluginSettingsAsset } from "../plugins/pluginSettingsAssets";

/* 测试价值
 * 生产入口与可观察结果：openPluginSettingsClient/readPluginSettingsAsset，目标绑定、原页KV回显和未知保存不重放。
 * Bug／规则依据：plugin-mobile-implementation「配置与授权」；protocol-compatibility「同账号远程插件管理」。
 * 现有覆盖缺口：remotePluginSettings 测Desktop Main；pluginPage 测普通页面，不经过手机专用settings client。
 * 最小失败输入：跨实例文档、轮换中的并发请求、已提交但丢失回执、资源截短、读取中换账号。
 * tier：unit；内存transport/clock，不使用网络、原生应用或真实密钥。
 * 实测耗时：单文件墙钟 2.32s。
 */
const document = {
  pageId: "page",
  pluginId: "_ns__example__test",
  manifestId: "test",
  name: "Original",
  entry: "ui/settings.html",
  controllerAuthorization: true,
  files: [{ path: "ui/settings.html", size: 1, mime: "text/html" }],
};
function fixture() {
  let time = 0,
    valid = true;
  const request = vi.fn(
    async (_request: PluginOauthRequest): Promise<unknown> => ({
      status: 200,
      base64: Buffer.from('{"enabled":true}').toString("base64"),
      mime: "application/json",
    }),
  );
  const dispose = vi.fn();
  const openSession = vi.fn(async () => ({ request, dispose }));
  const invokeTarget = vi.fn(async () => ({ result: document }));
  return {
    request,
    openSession,
    dispose,
    invokeTarget,
    advance: () => {
      time += 240_000;
    },
    invalidate: () => {
      valid = false;
    },
    options: {
      identity: {
        deviceId: "computer",
        instanceId: document.pluginId,
        expectedInstalledApproval: "approval",
      },
      invokeTarget,
      openSession,
      assertCurrent: () => {
        if (!valid) throw new Error("STALE_OWNER");
      },
      now: () => time,
    },
  };
}
describe("dedicated mobile original settings client", () => {
  // Real Host ghostFileMime includes charset; the bare-MIME fixture missed this contract.
  it("accepts the Host UTF-8 document and preserves MIME for exact asset verification", () => {
    const hostDocument = {
      ...document,
      files: [{ ...document.files[0], mime: "text/html; charset=utf-8" }],
    };
    expect(
      parsePluginSettingsDocument(hostDocument, document.pluginId).files[0]
        .mime,
    ).toBe("text/html; charset=utf-8");
    for (const mime of [
      "text/html\r\nX-Test: value",
      "text/html-invalid",
      "text/html; charset=utf-8\r\n",
    ]) {
      expect(() =>
        parsePluginSettingsDocument(
          { ...hostDocument, files: [{ ...hostDocument.files[0], mime }] },
          document.pluginId,
        ),
      ).toThrow();
    }
  });
  it("releases a hidden page with the captured cleanup guard while refusing further page writes", async () => {
    const f = fixture();
    let visible = true;
    const client = await openPluginSettingsClient({
      ...f.options,
      assertCurrent: () => {
        f.options.assertCurrent();
        if (!visible) throw new Error("PAGE_HIDDEN");
      },
      assertCleanupCurrent: f.options.assertCurrent,
    });
    visible = false;
    await expect(client.fetch("/kv", "PUT", "{}")).rejects.toThrow(
      "PAGE_HIDDEN",
    );
    await client.close();
    expect(f.request).toHaveBeenLastCalledWith({
      op: "settings",
      id: "page",
      command: { kind: "close" },
    });
    expect(f.openSession).toHaveBeenCalledTimes(1);
  });
  it("binds the physical instance/approval and uses only the signed settings session for configuration", async () => {
    const f = fixture(),
      client = await openPluginSettingsClient(f.options);
    expect(f.invokeTarget.mock.calls[0]).toMatchObject([
      expect.any(String),
      [
        {
          resourceRef: { id: document.pluginId },
          input: { expectedInstalledApproval: "approval" },
        },
      ],
    ]);
    expect(f.openSession).toHaveBeenCalledWith({
      actionId: "settings-page",
      requestId: "page",
      expectedRevision: 0,
    });
    expect(await client.fetch("/kv", "PUT", '{"enabled":true}')).toMatchObject({
      status: 200,
    });
    expect(f.request).toHaveBeenCalledWith({
      op: "settings",
      id: "page",
      command: {
        kind: "fetch",
        path: "/kv",
        method: "PUT",
        body: '{"enabled":true}',
      },
    });
    expect(f.invokeTarget).toHaveBeenCalledTimes(1);
    await expect(client.fetch("/secrets/key", "GET")).rejects.toThrow(
      "ENDPOINT_BLOCKED",
    );
    await expect(client.fetch("https://example.invalid/kv")).rejects.toThrow(
      "ENDPOINT_BLOCKED",
    );
    await client.close();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("submits new credentials only in the dedicated exchange and reuses the original OAuth HTTP result", async () => {
    const f = fixture();
    const authorize = vi.fn(async () => {});
    const client = await openPluginSettingsClient({
      ...f.options,
      onAuthorize: authorize,
    });
    await client.fetch(
      "/secrets/key",
      "PUT",
      '{"value":"invalid-fixture-key"}',
    );
    expect(f.request).toHaveBeenLastCalledWith({
      op: "settings",
      id: "page",
      command: {
        kind: "fetch",
        path: "/secrets/key",
        method: "PUT",
        body: '{"value":"invalid-fixture-key"}',
      },
    });
    f.request.mockImplementation(async (request) =>
      request.op === "settings" && request.command.kind === "authorize"
        ? {
            requestId: "oauth-ticket",
            actionId: "settings-oauth",
            expectedRevision: 0,
          }
        : {
            status: 200,
            mime: "application/json",
            base64: Buffer.from(
              '{"accounts":[{"id":"test-account"}]}',
            ).toString("base64"),
          },
    );
    expect(
      await client.fetch("/oauth/provider/connect", "POST", "{}"),
    ).toMatchObject({
      base64: Buffer.from('{"accounts":[{"id":"test-account"}]}').toString(
        "base64",
      ),
    });
    expect(authorize).toHaveBeenCalledWith({
      requestId: "oauth-ticket",
      actionId: "settings-oauth",
      expectedRevision: 0,
    });
    expect(f.request).toHaveBeenLastCalledWith({
      op: "settings",
      id: "page",
      command: { kind: "authorization-result", requestId: "oauth-ticket" },
    });
    expect(f.invokeTarget).toHaveBeenCalledTimes(1);
    await client.close();
  });
  it.each([undefined, false, "true"])("refuses OAuth on a Host without settings routing (%s) before creating an action", async (controllerAuthorization) => {
    const f = fixture();
    f.invokeTarget.mockResolvedValue({ result: { ...document, controllerAuthorization } } as any);
    const onAuthorize = vi.fn();
    const client = await openPluginSettingsClient({ ...f.options, onAuthorize });
    await expect(client.fetch("/oauth/provider/connect", "POST", "{}")).rejects.toThrow("PLUGIN_SETTINGS_HOST_UPDATE_REQUIRED");
    expect(f.request).not.toHaveBeenCalled();
    expect(onAuthorize).not.toHaveBeenCalled();
    // Existing configuration reads and writes remain available on older computers.
    await expect(client.fetch("/kv")).resolves.toMatchObject({ status: 200 });
    await client.close();
  });
  it("reports an unavailable loopback result without pretending browser dismissal completed authorization", async () => {
    const f = fixture();
    const client = await openPluginSettingsClient({
      ...f.options,
      onAuthorize: async () => {
        throw new Error("PLUGIN_AUTHORIZATION_COMPUTER_CALLBACK");
      },
    });
    f.request.mockImplementation(async (request) => {
      if (request.op === "settings" && request.command.kind === "authorize")
        return {
          requestId: "oauth-ticket",
          actionId: "settings-oauth",
          expectedRevision: 0,
        };
      throw new Error("NO_RESULT");
    });
    await expect(
      client.fetch("/oauth/provider/connect", "POST"),
    ).rejects.toThrow("PLUGIN_AUTHORIZATION_COMPUTER_CALLBACK");
    await client.close();
  });
  it("renews once for concurrent reads and never replays a write whose response was lost", async () => {
    const f = fixture(),
      client = await openPluginSettingsClient(f.options);
    f.advance();
    await Promise.all([client.fetch("/kv"), client.fetch("/agent-models")]);
    expect(f.openSession).toHaveBeenCalledTimes(2);
    f.request.mockRejectedValueOnce(new Error("RESPONSE_LOST"));
    await expect(client.fetch("/kv", "PUT", "{}")).rejects.toMatchObject({
      message: "RESPONSE_LOST",
      settingsOutcome: "unknown",
    });
    f.request.mockRejectedValueOnce(new Error("READ_LOST"));
    await expect(client.fetch("/kv")).rejects.not.toHaveProperty(
      "settingsOutcome",
    );
    await expect(
      client.fetch("https://invalid.example/kv", "PUT", "{}"),
    ).rejects.not.toHaveProperty("settingsOutcome");
    expect(
      f.request.mock.calls.filter(
        ([value]) =>
          value.op === "settings" &&
          value.command.kind === "fetch" &&
          value.command.method === "PUT",
      ),
    ).toHaveLength(1);
    await client.close();
  });
  it("rejects late responses after an owner change and does not open a new cleanup session", async () => {
    const f = fixture(),
      client = await openPluginSettingsClient(f.options);
    let answer!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const work = client.fetch("/kv");
    f.invalidate();
    answer({ status: 200 });
    await expect(work).rejects.toThrow("STALE_OWNER");
    await client.close();
    expect(f.openSession).toHaveBeenCalledTimes(1);
    await expect(client.fetch("/kv")).rejects.toThrow("UNAVAILABLE");
  });
  it("rejects a different instance or unsafe/duplicate package declaration", () => {
    for (const changed of [
      { pageId: undefined },
      { manifestId: undefined },
      { pluginId: "other" },
      { entry: "../settings.html" },
      { files: [...document.files, ...document.files] },
    ])
      expect(() =>
        parsePluginSettingsDocument(
          { ...document, ...changed },
          document.pluginId,
        ),
      ).toThrow("UNAVAILABLE");
  });
  it("assembles the final unaligned chunk and refuses truncated bytes or a stale source", async () => {
    const bytes = Buffer.alloc(48 * 1024 + 13, 194);
    const file = {
      path: "ui/settings.js",
      mime: "application/javascript",
      size: bytes.length,
    };
    const read = vi.fn(async (_path: string, offset: number) => ({
      mime: file.mime,
      base64: bytes.subarray(offset, offset + 48 * 1024).toString("base64"),
    }));
    expect(await readPluginSettingsAsset(file, read, () => {})).toEqual(
      new Uint8Array(bytes),
    );
    await expect(
      readPluginSettingsAsset(
        { ...file, size: 3 },
        async () => ({ mime: file.mime, base64: "YQ==" }),
        () => {},
      ),
    ).rejects.toThrow("ASSET_INVALID");
    const stale = vi.fn(() => {
      throw new Error("STALE_OWNER");
    });
    await expect(readPluginSettingsAsset(file, read, stale)).rejects.toThrow(
      "STALE_OWNER",
    );
  });
});

it('routes only the fixed credential check through encrypted settings and never replays it', async () => {
  expect(isPluginSettingsFetch('/secrets/key/check', 'POST')).toBe(true);
  for (const method of ['GET', 'PUT', 'DELETE']) expect(isPluginSettingsFetch('/secrets/key/check', method)).toBe(false);
  expect(isPluginSettingsFetch('/secrets/key/other', 'POST')).toBe(false);
  const f = fixture();
  const client = await openPluginSettingsClient(f.options);
  await client.fetch('/secrets/key/check', 'POST', '{"value":"fake-check-key"}');
  expect(f.request).toHaveBeenCalledTimes(1);
  await client.close();
});

it('negotiates document isolation only from an explicit Host capability', () => {
  expect(parsePluginSettingsDocument(document, document.pluginId).documentIsolation).toBeUndefined();
  expect(parsePluginSettingsDocument({ ...document, documentIsolation: true }, document.pluginId).documentIsolation).toBe(true);
  expect(parsePluginSettingsDocument({ ...document, documentIsolation: 'true' }, document.pluginId).documentIsolation).toBeUndefined();
});
