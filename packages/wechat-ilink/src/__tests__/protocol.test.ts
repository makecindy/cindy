import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  IlinkApiClient,
  TencentIlinkTransport,
  WechatIlinkError,
  aes128EcbPaddedSize,
  chunkWechatText,
  decodeInboundMessage,
  decodeInboundMessageWithReason,
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

  // 测试价值
  // - 生产入口与可观察结果：decodeInboundMessageWithReason 把入站丢弃原因交给
  //   transport/host 记录；#10899 前这些丢弃完全静默，无法与“服务器未下发”区分。
  // - Bug／规则依据：#10899。
  // - 现有覆盖缺口：已有用例只断言 decodeInboundMessage 返回 null，不含原因。
  // - 最小失败输入：缺 sender / 缺 messageId / 缺 context_token / message_type≠USER。
  // - tier：unit。
  it("reports the drop reason for rejected inbound messages", () => {
    expect(decodeInboundMessageWithReason({ message_id: 1 })).toEqual({
      message: null,
      dropReason: "missing-sender",
    });
    expect(
      decodeInboundMessageWithReason({
        message_id: 2,
        from_user_id: "user",
        to_user_id: "bot",
      }),
    ).toEqual({ message: null, dropReason: "missing-context-token" });
    expect(
      decodeInboundMessageWithReason({
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
      }),
    ).toEqual({ message: null, dropReason: "missing-message-id" });
    expect(
      decodeInboundMessageWithReason({
        message_id: 3,
        message_type: 2,
        from_user_id: "bot",
        to_user_id: "user",
        context_token: "ctx",
      }),
    ).toEqual({ message: null, dropReason: "not-user-message" });
    expect(
      decodeInboundMessageWithReason({
        message_id: 4,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      }),
    ).toMatchObject({ dropReason: null, message: { text: "hello" } });
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

  // 测试价值
  // - 生产入口与可观察结果：TencentIlinkTransport.poll 把解码丢弃原因带回 host，
  //   WechatIM 依赖它输出丢弃计数日志；缺失时丢弃再次不可观测。非法同步条目
  //   （null/字符串/数组）在 messagesFrom 过滤前也要计入，否则仍静默消失。
  // - Bug／规则依据：#10899。
  // - 现有覆盖缺口：已有 poll 用例只覆盖空列表与正常消息，无混合丢弃场景。
  // - 最小失败输入：同一 poll 响应同时含非法条目、bot 消息与用户消息。
  // - tier：unit。
  it("surfaces decoder drop reasons alongside decoded poll messages", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ret: 0,
          get_updates_buf: "next",
          msgs: [
            null,
            "junk",
            {
              message_id: 7,
              message_type: 2,
              from_user_id: "bot",
              to_user_id: "user",
              context_token: "ctx",
            },
            {
              message_id: 8,
              from_user_id: "user",
              to_user_id: "bot",
              context_token: "ctx",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            },
          ],
        }),
      ),
    );
    const transport = new TencentIlinkTransport({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "fake-token",
      botAgent: "Cindy/1.0.0",
      fetch: fetchMock,
    });
    const result = await transport.poll("old", signal());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ messageId: "message:8", text: "hi" });
    expect(result.droppedMessageReasons).toEqual([
      "malformed-message",
      "malformed-message",
      "not-user-message",
    ]);
  });

  // 测试价值
  // - 生产入口与可观察结果：IlinkApiClient.getUpdates 的长轮询超时必须作为
  //   retryable TIMEOUT 交给 WechatIM，触发已有重连循环，而不是伪造成功空轮询。
  // - Bug／规则依据：#8763；TCP 假活时旧实现吞掉 TIMEOUT，轮询游标和连接状态会静默停摆。
  // - 现有覆盖缺口：已有测试只覆盖正常空响应与主动取消，没有覆盖请求级长轮询超时。
  // - 最小失败输入：getUpdates 请求在 longPollTimeoutMs 到期时仍未返回；tier：unit。
  it("propagates long-poll timeouts so the host can reconnect", async () => {
    vi.useFakeTimers();
    try {
      const api = new IlinkApiClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "fake-token",
        botAgent: "Cindy/1.0.0",
        longPollTimeoutMs: 5,
        fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        }),
      });
      const pending = api.getUpdates("cursor", signal());
      const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
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
