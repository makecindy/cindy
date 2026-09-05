import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  IlinkApiClient,
  TencentIlinkTransport,
  WechatIlinkError,
  aes128EcbPaddedSize,
  chunkWechatText,
  decodeInboundMessage,
  downloadWechatMedia,
  decryptAes128Ecb,
  encryptAes128Ecb,
  filterWechatMarkdown,
  prepareWechatUpload,
} from "../index.js";

const signal = () => new AbortController().signal;

describe("pure protocol utilities", () => {
  it("round-trips AES-128-ECB and validates padded sizes", () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index);
    const input = Buffer.from("Cindy WeChat");
    const encrypted = encryptAes128Ecb(input, key);
    expect(Buffer.from(decryptAes128Ecb(encrypted, key))).toEqual(input);
    expect(aes128EcbPaddedSize(0)).toBe(16);
    expect(aes128EcbPaddedSize(16)).toBe(32);
  });

  it("chunks by code point rather than splitting surrogate pairs", () => {
    expect(chunkWechatText("A😀B", 2)).toEqual(["A😀", "B"]);
    const softBoundary = chunkWechatText("abcd efgh", 6);
    expect(softBoundary).toEqual(["abcd ", "efgh"]);
    expect(softBoundary.join("")).toBe("abcd efgh");
    const fenced = chunkWechatText(
      "before\n```ts\nconst value = 1234567890;\n```\nafter",
      24,
    );
    expect(fenced.length).toBeGreaterThan(1);
    expect(fenced.every((chunk) => Array.from(chunk).length <= 24)).toBe(true);
    expect(fenced[0]).toMatch(/\n```$/);
    expect(fenced[1]).toMatch(/^```\n/);
  });

  it("filters unsupported markdown without changing code or bold", () => {
    expect(
      filterWechatMarkdown("##### 标题\n*中文* **保留** ![x](https://x)"),
    ).toBe("标题\n中文 **保留** ");
    expect(
      filterWechatMarkdown(
        "```\n##### untouched ![x](url)\n```\n`*中文*` *中文*",
      ),
    ).toBe("```\n##### untouched ![x](url)\n```\n`*中文*` 中文");
  });

  it("filters image syntax in linear time for adversarial incomplete input", () => {
    const repeatedOpen = "![".repeat(50_000);
    const repeatedDestination = "![](".repeat(50_000);
    expect(filterWechatMarkdown(repeatedOpen)).toBe(repeatedOpen);
    expect(filterWechatMarkdown(repeatedDestination)).toBe(
      repeatedDestination,
    );
    expect(
      filterWechatMarkdown("before ![broken] text ![ok](url) after"),
    ).toBe("before ![broken] text  after");
  });

  it("rejects incomplete inbound messages before they reach the host", () => {
    expect(decodeInboundMessage({ message_id: 1 })).toBeNull();
    expect(
      decodeInboundMessage({
        message_id: 1,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      }),
    ).toMatchObject({
      messageId: "message:1",
      senderId: "user",
      text: "hello",
    });
    expect(
      decodeInboundMessage({
        message_id: 2,
        message_type: 2,
        from_user_id: "bot",
        to_user_id: "user",
        context_token: "ctx",
      }),
    ).toBeNull();
    expect(
      decodeInboundMessage({
        message_id: 3,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [null] as never,
      }),
    ).toMatchObject({ messageId: "message:3", media: [] });
  });

  it("preserves a legitimate zero-byte file length", () => {
    expect(
      decodeInboundMessage({
        message_id: 4,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [
          {
            type: 4,
            file_item: {
              file_name: "empty.txt",
              len: "0",
            },
          },
        ],
      }),
    ).toMatchObject({
      media: [{ kind: "file", fileName: "empty.txt", byteLength: 0 }],
    });
  });

  it("decodes quoted text and media without inventing prior history", () => {
    expect(
      decodeInboundMessage({
        message_id: 4,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [
          {
            type: 1,
            text_item: { text: "继续分析" },
            ref_msg: {
              title: "Alice",
              message_item: {
                type: 2,
                image_item: {
                  media: {
                    full_url: "https://cdn.weixin.qq.com/quoted",
                    aes_key: Buffer.alloc(16, 1).toString("base64"),
                  },
                  mid_size: 32,
                },
              },
            },
          },
        ],
      }),
    ).toMatchObject({
      text: "继续分析",
      quote: {
        title: "Alice",
        media: [{ kind: "image", encryptedByteLength: 32 }],
      },
    });
  });

  it("decrypts bounded Tencent media and validates file metadata", async () => {
    const plaintext = Buffer.from("verified attachment");
    const key = Buffer.alloc(16, 7);
    const encrypted = encryptAes128Ecb(plaintext, key);
    const result = await downloadWechatMedia(
      {
        kind: "file",
        downloadUrl: "https://cdn.weixin.qq.com/c2c/download?id=1",
        aesKeyBase64: key.toString("base64"),
        byteLength: plaintext.byteLength,
        md5Hex: createHash("md5").update(plaintext).digest("hex"),
      },
      async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response(Buffer.from(encrypted));
      },
      signal(),
    );
    expect(Buffer.from(result)).toEqual(plaintext);
  });

  it("rejects untrusted media origins before issuing a request", async () => {
    const fetchMock = vi.fn();
    await expect(
      downloadWechatMedia(
        {
          kind: "image",
          downloadUrl: "https://example.com/file",
          aesKeyBase64: Buffer.alloc(16).toString("base64"),
        },
        fetchMock,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("iLink HTTP boundary", () => {
  it("notifies iLink when the channel starts and stops", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      clientVersion: "1.1.21",
      botAgent: "Cindy/1.1.21",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ ret: 0 }));
      },
    });

    await expect(transport.notifyStart(signal())).resolves.toBeUndefined();
    await expect(transport.notifyStop(signal())).resolves.toBeUndefined();

    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/ilink/bot/msg/notifystart",
      "/ilink/bot/msg/notifystop",
    ]);
    expect(
      calls.map(({ init }) => JSON.parse(String(init?.body))),
    ).toEqual([
      {
        base_info: {
          channel_version: "1.1.21",
          bot_agent: "Cindy/1.1.21",
        },
      },
      {
        base_info: {
          channel_version: "1.1.21",
          bot_agent: "Cindy/1.1.21",
        },
      },
    ]);
  });

  it("accepts inbound messages with an omitted recipient and a 64-bit identifier", () => {
    expect(
      decodeInboundMessage({
        message_id: 9_223_372_036_854_775_807,
        client_id: "stable-client-id",
        from_user_id: "user",
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      }),
    ).toMatchObject({
      messageId: "client:stable-client-id",
      senderId: "user",
      text: "hello",
    });
    expect(
      decodeInboundMessage({
        message_id: "9223372036854775807",
        from_user_id: "user",
        context_token: "ctx",
      }),
    ).toMatchObject({
      messageId: "message:9223372036854775807",
      senderId: "user",
    });
  });

  it("builds authenticated poll requests without exposing response bodies in errors", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer fake-token",
          AuthorizationType: "ilink_bot_token",
        });
        expect(init?.redirect).toBe("manual");
        return new Response(
          JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" }),
        );
      },
    );
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: fetchMock,
    });
    await expect(transport.poll("old", signal())).resolves.toEqual({
      cursor: "next",
      messages: [],
      suggestedTimeoutMs: undefined,
    });
  });

  it("maps HTTP failures to stable secret-free errors", async () => {
    const api = new IlinkApiClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "top-secret",
      botAgent: "Cindy/1.0.0",
      fetch: async () => new Response("token=top-secret", { status: 503 }),
    });
    await expect(api.getUpdates("", signal())).rejects.toMatchObject({
      code: "HTTP_ERROR",
      retryable: true,
    } satisfies Partial<WechatIlinkError>);
    await expect(api.getUpdates("", signal())).rejects.not.toThrow(
      /top-secret/,
    );
  });

  it("builds deterministic text messages and includes the declared client identity", async () => {
    let request: RequestInit | undefined;
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      clientVersion: "1.1.21",
      botAgent: "Cindy/1.1.21 invalid",
      fetch: async (_input, init) => {
        request = init;
        return new Response(JSON.stringify({ ret: 0 }));
      },
    });
    await expect(
      transport.sendMessage(
        {
          peerId: "peer",
          text: "hello",
          contextToken: "context",
          clientId: "stable-client-id",
          runId: "run",
        },
        signal(),
      ),
    ).resolves.toEqual({ clientId: "stable-client-id" });

    expect(request?.headers).toMatchObject({
      "iLink-App-ClientVersion": String((1 << 16) | (1 << 8) | 21),
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      msg: {
        to_user_id: "peer",
        client_id: "stable-client-id",
        context_token: "context",
      },
      base_info: {
        channel_version: "1.1.21",
        bot_agent: "Cindy/1.1.21",
      },
    });
  });

  it("uploads encrypted media and sends the returned CDN reference", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/ilink/bot/getuploadurl")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              upload_full_url: "https://cdn.weixin.qq.com/c2c/upload?id=1",
            }),
          );
        }
        if (url.startsWith("https://cdn.weixin.qq.com/")) {
          return new Response(null, {
            status: 200,
            headers: { "x-encrypted-param": "download-token" },
          });
        }
        return new Response(JSON.stringify({ ret: 0 }));
      },
    });
    const bytes = Buffer.from("image bytes");
    const uploaded = await transport.uploadMedia(
      { peerId: "peer", bytes, fileName: "image.png", kind: "image" },
      signal(),
    );
    expect(uploaded).toMatchObject({
      fileName: "image.png",
      ref: {
        kind: "image",
        encryptedQuery: "download-token",
        byteLength: bytes.byteLength,
      },
    });
    expect(uploaded.ref.encryptedByteLength).toBe(
      prepareWechatUpload(bytes).ciphertext.byteLength,
    );
    const decodedAesKey = Buffer.from(
      String(uploaded.ref.aesKeyBase64),
      "base64",
    );
    expect(decodedAesKey).toHaveLength(32);
    const uploadUrlRequest = calls.find(({ url }) =>
      url.endsWith("/ilink/bot/getuploadurl"),
    );
    const uploadBody = JSON.parse(String(uploadUrlRequest?.init?.body));
    expect(uploadBody).toMatchObject({
      aeskey: decodedAesKey.toString("ascii"),
    });

    await expect(
      transport.sendMedia(
        {
          peerId: "peer",
          contextToken: "context",
          clientId: "stable-media-id",
          uploaded,
        },
        signal(),
      ),
    ).resolves.toEqual({ clientId: "stable-media-id" });

    const uploadRequest = calls.find(({ url }) =>
      url.startsWith("https://cdn.weixin.qq.com/"),
    );
    expect(uploadRequest?.init?.body).toBeInstanceOf(Buffer);
    const sendRequest = calls.at(-1)?.init;
    expect(JSON.parse(String(sendRequest?.body))).toMatchObject({
      msg: {
        client_id: "stable-media-id",
        item_list: [
          {
            type: 2,
            image_item: {
              mid_size: uploaded.ref.encryptedByteLength,
              media: {
                encrypt_query_param: "download-token",
                aes_key: uploaded.ref.aesKeyBase64,
                encrypt_type: 1,
              },
            },
          },
        ],
      },
    });
  });

  it("maps generic send rejection to a retryable secret-free error", async () => {
    const api = new IlinkApiClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async () =>
        new Response(JSON.stringify({ ret: 1, detail: "top-secret-response" })),
    });
    await expect(
      api.sendText(
        {
          peerId: "peer",
          text: "hello",
          contextToken: "context",
          clientId: "rejected-text",
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "SEND_REJECTED", retryable: true });
    await expect(
      api.sendText(
        {
          peerId: "peer",
          text: "hello",
          contextToken: "context",
          clientId: "rejected-text-2",
        },
        signal(),
      ),
    ).rejects.not.toThrow(/top-secret-response/);
  });

  it("maps send-side stale credentials to a stable non-retryable error", async () => {
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async () => new Response(JSON.stringify({ ret: 1, errcode: -14 })),
    });
    await expect(
      transport.sendMessage(
        {
          peerId: "peer",
          text: "hello",
          contextToken: "context",
          clientId: "stale-text",
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "AUTH_REPLACED", retryable: false });
    await expect(
      transport.sendMedia(
        {
          peerId: "peer",
          contextToken: "context",
          clientId: "stale-media",
          uploaded: {
            fileName: "image.png",
            ref: {
              kind: "image",
              encryptedQuery: "download-token",
              aesKeyBase64: Buffer.alloc(16, 1).toString("base64"),
              byteLength: 1,
              encryptedByteLength: 16,
            },
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "AUTH_REPLACED", retryable: false });
  });

  it("maps upload-side stale credentials to a stable non-retryable error before any CDN upload", async () => {
    const calls: string[] = [];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ret: 1, errcode: -14 }));
      },
    });
    await expect(
      transport.uploadMedia(
        {
          peerId: "peer",
          bytes: Buffer.from("image bytes"),
          fileName: "image.png",
          kind: "image",
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "AUTH_REPLACED", retryable: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].endsWith("/ilink/bot/getuploadurl")).toBe(true);
    expect(
      calls.some((url) => url.startsWith("https://cdn.weixin.qq.com/")),
    ).toBe(false);
  });

  it("maps stale credentials and malformed message lists to stable errors", async () => {
    const responses = [
      { ret: 1, errcode: -14 },
      { ret: 0, msgs: "not-an-array" },
    ];
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async () => new Response(JSON.stringify(responses.shift())),
    });
    await expect(transport.poll("", signal())).rejects.toMatchObject({
      code: "AUTH_REPLACED",
      retryable: false,
    });
    await expect(transport.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });

  it("propagates host cancellation instead of treating it as a long-poll timeout", async () => {
    const controller = new AbortController();
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    const pending = transport.poll("", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects oversized responses and bounded poll collections", async () => {
    const oversized = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      maxResponseBytes: 16,
      fetch: async () =>
        new Response(JSON.stringify({ ret: 0, padding: "x".repeat(100) })),
    });
    await expect(oversized.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });

    const tooMany = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      maxPollMessages: 1,
      fetch: async () =>
        new Response(JSON.stringify({ ret: 0, msgs: [{}, {}] })),
    });
    await expect(tooMany.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });

    const tooManyItems = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      maxItemsPerMessage: 1,
      fetch: async () =>
        new Response(
          JSON.stringify({ ret: 0, msgs: [{ item_list: [{}, {}] }] }),
        ),
    });
    await expect(tooManyItems.poll("", signal())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
});
