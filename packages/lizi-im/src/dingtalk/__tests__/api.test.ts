import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { DingTalkApiClient } from "../api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("DingTalkApiClient", () => {
  it("uploads image bytes and sends a native direct image message", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return jsonResponse({
          errcode: 0,
          access_token: "oapi-token",
          expires_in: 7200,
        });
      }
      if (url.startsWith("https://oapi.dingtalk.com/media/upload")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(FormData);
        return jsonResponse({ errcode: 0, media_id: "@media-1" });
      }
      if (url === "https://api.dingtalk.com/v1.0/oauth2/accessToken") {
        return jsonResponse({ accessToken: "api-token", expireIn: 7200 });
      }
      if (url === "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend") {
        return jsonResponse({});
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await api.sendImage(
      {
        kind: "direct",
        id: "owner-1",
        sessionWebhook: null,
        sessionWebhookExpiresAt: null,
      },
      PNG_BYTES,
      "picture.png",
    );

    const sendCall = fetcher.mock.calls.find(
      ([url]) =>
        String(url) ===
        "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
    );
    expect(sendCall).toBeDefined();
    expect(JSON.parse(String(sendCall?.[1]?.body))).toEqual({
      robotCode: "app-key",
      userIds: ["owner-1"],
      msgKey: "sampleImageMsg",
      msgParam: JSON.stringify({ photoURL: "@media-1" }),
    });
  });

  it("uploads only the visible bytes from a Node Buffer view", async () => {
    const backing = Buffer.from([0xde, 0xad, ...PNG_BYTES, 0xbe, 0xef]);
    const imageView = backing.subarray(2, 2 + PNG_BYTES.byteLength);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return jsonResponse({
          errcode: 0,
          access_token: "oapi-token",
          expires_in: 7200,
        });
      }
      if (url.startsWith("https://oapi.dingtalk.com/media/upload")) {
        const form = init?.body as FormData;
        const media = form.get("media");
        expect(media).toBeInstanceOf(Blob);
        expect(
          Array.from(new Uint8Array(await (media as Blob).arrayBuffer())),
        ).toEqual(Array.from(PNG_BYTES));
        return jsonResponse({ errcode: 0, media_id: "@media-1" });
      }
      if (url === "https://api.dingtalk.com/v1.0/oauth2/accessToken") {
        return jsonResponse({ accessToken: "api-token", expireIn: 7200 });
      }
      if (url === "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend") {
        return jsonResponse({});
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await api.sendImage(
      {
        kind: "direct",
        id: "owner-1",
        sessionWebhook: null,
        sessionWebhookExpiresAt: null,
      },
      imageView,
      "picture.png",
    );
  });

  it("rejects non-image outbound bytes before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await expect(
      api.sendImage(
        {
          kind: "direct",
          id: "owner-1",
          sessionWebhook: null,
          sessionWebhookExpiresAt: null,
        },
        new TextEncoder().encode("<html>not an image</html>"),
      ),
    ).rejects.toThrow(/not an image/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never posts to an untrusted session webhook and falls back to the fixed API", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await api.sendText(
      {
        kind: "direct",
        id: "owner-1",
        sessionWebhook: "https://example.invalid/collect",
        sessionWebhookExpiresAt: Date.now() + 60_000,
      },
      "hello",
    );

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
    ]);
  });

  it("rejects media download URLs outside the expected service domains", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ downloadUrl: "https://127.0.0.1/internal-resource" }),
      );
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await expect(api.downloadImage("download-code")).rejects.toThrow(
      /untrusted URL/,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("delegates temporary media URLs to a host guarded downloader", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          downloadUrl:
            "http://wukong-file-im-zjk.oss-cn-zhangjiakou.aliyuncs.com/signed/image?signature=secret",
        }),
      );
    const guardedMediaFetcher = vi.fn(async () => ({
      buffer: PNG_BYTES,
      mimeType: "application/octet-stream",
    }));
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await expect(
      api.downloadImage("download-code", guardedMediaFetcher),
    ).resolves.toEqual({ buffer: PNG_BYTES, mimeType: "image/png" });
    expect(guardedMediaFetcher).toHaveBeenCalledWith(
      "https://wukong-file-im-zjk.oss-cn-zhangjiakou.aliyuncs.com/signed/image?signature=secret",
      20 * 1024 * 1024,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("validates media bytes returned by the host guarded downloader", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ downloadUrl: "https://cdn.example/image" }),
      );
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await expect(
      api.downloadImage("download-code", async () => ({
        buffer: new TextEncoder().encode("not an image"),
      })),
    ).rejects.toThrow(/not an image/);
  });

  it("follows a bounded redirect between trusted DingTalk media hosts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          downloadUrl: "https://media.dingtalk.com/temporary/image",
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://download.dingtalk.com/final/image.png",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(PNG_BYTES));
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await expect(api.downloadImage("download-code")).resolves.toEqual({
      buffer: PNG_BYTES,
      mimeType: "image/png",
    });
    expect(fetcher.mock.calls.slice(2).map(([url]) => String(url))).toEqual([
      "https://media.dingtalk.com/temporary/image",
      "https://download.dingtalk.com/final/image.png",
    ]);
  });

  it("rejects a trusted media URL that redirects outside the allowlist", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          downloadUrl: "https://media.dingtalk.com/temporary/image",
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/collect" },
        }),
      );
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await expect(api.downloadImage("download-code")).rejects.toThrow(
      /untrusted URL/,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
