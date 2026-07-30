import { describe, expect, it, vi } from "vitest";
import { TencentIlinkTransport, WechatIlinkError } from "../index.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

describe("QR authorization", () => {
  it("follows a Tencent redirect and returns credentials without persisting them", async () => {
    const urls: string[] = [];
    const responses = [
      { qrcode: "qr-secret", qrcode_img_content: "https://weixin.qq.com/qr" },
      { status: "scaned_but_redirect", redirect_host: "edge.weixin.qq.com" },
      {
        status: "confirmed",
        bot_token: "fake-token",
        ilink_bot_id: "bot-id",
        ilink_user_id: "user-id",
        baseurl: "https://edge.weixin.qq.com",
      },
    ];
    const fetchMock = vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      return jsonResponse(responses.shift());
    });
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botAgent: "Cindy/1.0.0",
      fetch: fetchMock,
    });

    const challenge = await transport.beginAuthorization(
      new AbortController().signal,
    );
    expect(challenge).not.toHaveProperty("qrCode");
    expect(challenge).not.toHaveProperty("pollBaseUrl");
    const credentials = await transport.waitAuthorization(
      challenge,
      new AbortController().signal,
    );

    expect(credentials).toEqual({
      token: "fake-token",
      botId: "bot-id",
      userId: "user-id",
      baseUrl: "https://edge.weixin.qq.com",
    });
    expect(urls[2]).toContain("https://edge.weixin.qq.com/");
  });

  it("refreshes an expired QR and reuses only the in-memory local token list", async () => {
    const requestBodies: string[] = [];
    const events: string[] = [];
    const responses = [
      { qrcode: "qr-1", qrcode_img_content: "https://weixin.qq.com/qr-1" },
      { status: "expired" },
      { qrcode: "qr-2", qrcode_img_content: "https://weixin.qq.com/qr-2" },
      {
        status: "confirmed",
        bot_token: "fake-token-2",
        ilink_bot_id: "bot-2",
        ilink_user_id: "user-2",
        baseurl: "https://ilinkai.weixin.qq.com",
      },
    ];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botAgent: "Cindy/1.0.0",
      localTokens: async () => ["old-fake-token"],
      authorizationObserver: {
        onEvent: (event) => {
          events.push(event.status);
        },
      },
      fetch: async (_input, init) => {
        if (typeof init?.body === "string") requestBodies.push(init.body);
        return jsonResponse(responses.shift());
      },
    });

    const challenge = await transport.beginAuthorization(
      new AbortController().signal,
    );
    await expect(
      transport.waitAuthorization(challenge, new AbortController().signal),
    ).resolves.toMatchObject({ botId: "bot-2" });
    expect(events).toContain("qr-refreshed");
    expect(
      requestBodies.filter((body) => body.includes("old-fake-token")),
    ).toHaveLength(2);
  });

  it("rejects non-Tencent or credential-bearing base URLs", () => {
    for (const baseUrl of [
      "http://ilinkai.weixin.qq.com",
      "https://user:pass@ilinkai.weixin.qq.com",
      "https://attacker.invalid",
      "https://ilinkai.weixin.qq.com/unexpected-path",
    ]) {
      expect(
        () =>
          new TencentIlinkTransport({
            baseUrl,
            botAgent: "Cindy/1.0.0",
            fetch: async () => jsonResponse({}),
          }),
      ).toThrowError(WechatIlinkError);
    }
  });

  it("surfaces an unknown status as a stable protocol error", async () => {
    const responses = [
      { qrcode: "qr", qrcode_img_content: "https://weixin.qq.com/qr" },
      { status: "surprise" },
    ];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botAgent: "Cindy/1.0.0",
      fetch: async () => jsonResponse(responses.shift()),
    });
    const challenge = await transport.beginAuthorization(
      new AbortController().signal,
    );
    await expect(
      transport.waitAuthorization(challenge, new AbortController().signal),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("rejects malformed verification codes before they enter a request URL", async () => {
    const responses = [
      { qrcode: "qr", qrcode_img_content: "https://weixin.qq.com/qr" },
      { status: "need_verifycode" },
    ];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botAgent: "Cindy/1.0.0",
      authorizationObserver: {
        requestVerificationCode: async () => "not-a-number",
      },
      fetch: async () => jsonResponse(responses.shift()),
    });
    const challenge = await transport.beginAuthorization(
      new AbortController().signal,
    );
    await expect(
      transport.waitAuthorization(challenge, new AbortController().signal),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});
