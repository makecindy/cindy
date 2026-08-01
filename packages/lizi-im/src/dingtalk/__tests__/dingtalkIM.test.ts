import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { DWClientDownStream } from "dingtalk-stream";

import type { IMHost, IMMessageEvent } from "../../types.js";
import { DingTalkIM, type DingTalkStreamClient } from "../index.js";

class FakeClient implements DingTalkStreamClient {
  connected = false;
  registered = false;
  config = { autoReconnect: true };
  callback: ((message: DWClientDownStream) => void) | null = null;
  acknowledgements: Array<{ messageId: string; result: unknown }> = [];

  registerCallbackListener(
    _topic: string,
    callback: (message: DWClientDownStream) => void,
  ): DingTalkStreamClient {
    this.callback = callback;
    return this;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.registered = true;
  }

  disconnect(): void {
    this.connected = false;
    this.registered = false;
  }

  socketCallBackResponse(messageId: string, result: unknown): void {
    this.acknowledgements.push({ messageId, result });
  }

  emit(payload: Record<string, unknown>, callbackId = "callback-1"): void {
    this.callback?.({
      headers: { messageId: callbackId },
      data: JSON.stringify(payload),
    } as DWClientDownStream);
  }
}

function makeHost() {
  const secrets = new Map<string, string>([
    ["dingtalk-bot-app-key", "app-key"],
    ["dingtalk-bot-app-secret", "app-secret"],
  ]);
  const handlers = new Map<string, (payload?: unknown) => unknown>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const host: IMHost = {
    secrets: {
      write: (key, value) => {
        secrets.set(key, value);
        return true;
      },
      read: (key) => secrets.get(key) ?? null,
      remove: (key) => void secrets.delete(key),
      isAvailable: () => true,
    },
    ipc: {
      handle: (channel, handler) => void handlers.set(channel, handler),
      broadcast: (channel, payload) =>
        void broadcasts.push({ channel, payload }),
    },
    paths: { feishuMediaDir: "/unused" },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets, handlers, broadcasts };
}

function validCredentialFetcher() {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ accessToken: "test-token", expireIn: 7200 }),
      ),
  );
}

function outboundImageFetcher() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "https://api.dingtalk.com/v1.0/oauth2/accessToken") {
      return new Response(
        JSON.stringify({ accessToken: "api-token", expireIn: 7200 }),
      );
    }
    if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
      return new Response(
        JSON.stringify({
          errcode: 0,
          access_token: "oapi-token",
          expires_in: 7200,
        }),
      );
    }
    if (url.startsWith("https://oapi.dingtalk.com/media/upload")) {
      return new Response(JSON.stringify({ errcode: 0, media_id: "@media-1" }));
    }
    if (url === "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend") {
      return new Response(JSON.stringify({}));
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

function directMessage(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: "direct-chat",
    conversationType: "1",
    msgId: "message-1",
    msgtype: "text",
    robotCode: "app-key",
    senderId: "sender-id",
    senderStaffId: "owner-1",
    senderNick: "Owner",
    text: { content: "hello" },
    ...overrides,
  };
}

describe("DingTalkIM", () => {
  it("uploads remote Markdown images and sends native image messages", async () => {
    const { host } = makeHost();
    const fetchRemoteImage = vi.fn(async () => ({
      buffer: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimeType: "image/png",
    }));
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage: vi.fn(async () => ({
        absPath: "/media/image.png",
        url: "cindy-media://image.png",
      })),
      resolveMediaUrl: vi.fn(() => null),
      fetchRemoteImage,
    };
    const fetcher = outboundImageFetcher();
    const client = new FakeClient();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher,
    });
    await im.init();

    await im.commitFinal({
      userId: "owner-1",
      text: ["给你一张图：", "![测试图片](https://cdn.example/image.png)"].join(
        "\n",
      ),
      terminal: "done",
    });

    expect(fetchRemoteImage).toHaveBeenCalledWith(
      "https://cdn.example/image.png",
      20 * 1024 * 1024,
    );
    const outboundBodies = fetcher.mock.calls
      .filter(
        ([url]) =>
          String(url) ===
          "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      )
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(outboundBodies).toEqual([
      {
        robotCode: "app-key",
        userIds: ["owner-1"],
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content: "给你一张图：\n测试图片" }),
      },
      {
        robotCode: "app-key",
        userIds: ["owner-1"],
        msgKey: "sampleImageMsg",
        msgParam: JSON.stringify({ photoURL: "@media-1" }),
      },
    ]);
  });

  it("uploads managed local output images carried by commitFinal", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    const fetcher = outboundImageFetcher();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher,
    });
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "dingtalk-outbound-"),
    );
    const imagePath = path.join(tempDir, "generated.png");
    fs.writeFileSync(
      imagePath,
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    try {
      await im.init();
      await im.commitFinal({
        userId: "owner-1",
        text: "生成完成",
        terminal: "done",
        mediaAbsPaths: [imagePath],
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const outboundMessageTypes = fetcher.mock.calls
      .filter(
        ([url]) =>
          String(url) ===
          "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      )
      .map(([, init]) => {
        const body = JSON.parse(String(init?.body)) as { msgKey: string };
        return body.msgKey;
      });
    expect(outboundMessageTypes).toEqual(["sampleText", "sampleImageMsg"]);
  });

  it("claims the first direct sender, acknowledges immediately, and drops other direct users", async () => {
    const { host, secrets } = makeHost();
    const client = new FakeClient();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher: validCredentialFetcher(),
    });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();

    client.emit(directMessage());
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(client.acknowledgements).toEqual([
      { messageId: "callback-1", result: { success: true } },
    ]);
    expect(secrets.get("dingtalk-bot-owner-user-id")).toBe("owner-1");
    expect(received[0]).toMatchObject({
      channelName: "dingtalk",
      senderId: "owner-1",
      text: "hello",
    });

    client.emit(
      directMessage({
        msgId: "message-2",
        senderStaffId: "other-user",
        text: { content: "ignored" },
      }),
      "callback-2",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);
  });

  it("routes mentioned group messages to one lane with speaker metadata", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher: validCredentialFetcher(),
    });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();
    client.emit(directMessage());
    await vi.waitFor(() => expect(received).toHaveLength(1));

    client.emit(
      directMessage({
        conversationId: "group/a",
        conversationType: "2",
        msgId: "group-message-1",
        senderStaffId: "guest-1",
        senderNick: "Guest",
        isInAtList: true,
        text: { content: "group question" },
      }),
      "callback-2",
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({
      senderId: "g/group%2Fa",
      chatId: "group/a",
      text: "group question",
      speaker: { id: "guest-1", name: "Guest", isOwner: false },
    });
  });

  it("downloads inbound images through the host SSRF guard", async () => {
    const { host, secrets } = makeHost();
    secrets.set("dingtalk-bot-owner-user-id", "owner-1");
    const fetchRemoteImage = vi.fn(async () => ({
      buffer: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimeType: "application/octet-stream",
    }));
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage: vi.fn(async () => ({
        absPath: "/media/image.png",
        url: "cindy-media://image.png",
      })),
      resolveMediaUrl: vi.fn(() => null),
      fetchRemoteImage,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            downloadUrl: "https://temporary-media.example-cdn.net/signed/image",
          }),
        ),
      );
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client, fetcher });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();

    client.emit(
      directMessage({
        msgId: "picture-1",
        msgtype: "picture",
        content: { downloadCode: "download-1" },
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(fetchRemoteImage).toHaveBeenCalledWith(
      "https://temporary-media.example-cdn.net/signed/image",
      20 * 1024 * 1024,
    );
    expect(received[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        absPath: "/media/image.png",
        mimeType: "image/png",
      }),
    ]);
  });

  it("accepts an unmentioned owner reply for a pending group interaction", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher: validCredentialFetcher(),
    });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();
    client.emit(directMessage());
    await vi.waitFor(() => expect(received).toHaveLength(1));

    client.emit(
      directMessage({
        conversationId: "group/a",
        conversationType: "2",
        msgId: "group-message-1",
        senderStaffId: "guest-1",
        senderNick: "Guest",
        isInAtList: true,
        text: { content: "group question" },
      }),
      "callback-2",
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));

    const reply = im.requestTextReply(
      "g/group%2Fa",
      "请选择 1 或 2",
      (text) => (text === "1" ? "accepted" : null),
      1_000,
    );
    let settled = false;
    void reply.finally(() => {
      settled = true;
    });

    client.emit(
      directMessage({
        conversationId: "group/a",
        conversationType: "2",
        msgId: "group-message-2",
        senderStaffId: "guest-1",
        senderNick: "Guest",
        isInAtList: false,
        text: { content: "1" },
      }),
      "callback-3",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(received).toHaveLength(2);

    client.emit(
      directMessage({
        conversationId: "group/a",
        conversationType: "2",
        msgId: "group-message-3",
        senderStaffId: "owner-1",
        senderNick: "Owner",
        isInAtList: false,
        text: { content: "1" },
      }),
      "callback-4",
    );

    await expect(reply).resolves.toBe("accepted");
    expect(received).toHaveLength(2);

    client.emit(
      directMessage({
        conversationId: "group/a",
        conversationType: "2",
        msgId: "group-message-4",
        senderStaffId: "owner-1",
        senderNick: "Owner",
        isInAtList: false,
        text: { content: "ordinary message" },
      }),
      "callback-5",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(2);
  });

  it("does not expose the app secret through public state", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher: validCredentialFetcher(),
    });
    im.registerIpc();
    await im.init();
    const state = im.getPublicState();
    expect(state).toEqual({
      status: { kind: "connected", appId: "app-key" },
      appKey: "app-key",
      hasSecret: true,
      ownerUserId: null,
    });
    expect(state).not.toHaveProperty("appSecret");
  });

  it("accepts an open Stream socket without waiting for a REGISTERED system message", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    client.connect = vi.fn(async () => {
      client.connected = true;
      client.registered = false;
    });
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher: validCredentialFetcher(),
    });

    await im.init();

    expect(im.getPublicState().status).toEqual({
      kind: "connected",
      appId: "app-key",
    });
  });

  it("classifies rejected credentials before opening the Stream socket", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    client.connect = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ code: "InvalidParameter" }), {
          status: 401,
        }),
    );
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher,
    });

    await im.init();

    expect(client.connect).not.toHaveBeenCalled();
    expect(im.getPublicState().status).toEqual({
      kind: "error",
      reason: "DINGTALK_AUTH_FAILED",
    });
  });

  it("publishes an error status when manual reconnect fails", async () => {
    const { host, handlers, broadcasts } = makeHost();
    const client = new FakeClient();
    const fetcher = validCredentialFetcher();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher,
    });
    im.registerIpc();
    await im.init();
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "InvalidParameter" }), {
        status: 401,
      }),
    );
    const reconnect = handlers.get("dingtalkBot:reconnect");

    expect(reconnect).toBeTypeOf("function");
    await expect(Promise.resolve(reconnect?.())).rejects.toThrow(
      /DINGTALK_AUTH_FAILED/,
    );
    expect(im.getPublicState().status).toEqual({
      kind: "error",
      reason: "DINGTALK_AUTH_FAILED",
    });
    expect(broadcasts.at(-1)).toEqual({
      channel: "dingtalkBot:status-change",
      payload: {
        status: {
          kind: "error",
          reason: "DINGTALK_AUTH_FAILED",
        },
      },
    });
  });

  it("classifies a Stream socket that never opens", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    client.connect = vi.fn(async () => undefined);
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
      fetcher: validCredentialFetcher(),
    });

    await im.init();

    expect(im.getPublicState().status).toEqual({
      kind: "error",
      reason: "DINGTALK_STREAM_CONNECTION_FAILED",
    });
  });

  it("does not emit a slow media callback after the connection is disposed", async () => {
    const { host, secrets } = makeHost();
    secrets.set("dingtalk-bot-owner-user-id", "owner-1");
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage: vi.fn(async () => ({
        absPath: "/media/image.png",
        url: "cindy-media://image.png",
      })),
      resolveMediaUrl: vi.fn(() => null),
    };
    let releaseDownload!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            downloadUrl: "https://media.dingtalk.com/image.png",
          }),
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseDownload = resolve;
          }),
      );
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client, fetcher });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();

    client.emit(
      directMessage({
        msgId: "picture-1",
        msgtype: "picture",
        content: { downloadCode: "download-1" },
      }),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await im.dispose();
    releaseDownload(
      new Response(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(0);
  });

  it("preserves arrival order while an earlier image is downloading", async () => {
    const { host, secrets } = makeHost();
    secrets.set("dingtalk-bot-owner-user-id", "owner-1");
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage: vi.fn(async () => ({
        absPath: "/media/image.png",
        url: "cindy-media://image.png",
      })),
      resolveMediaUrl: vi.fn(() => null),
    };
    let releaseDownload!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            downloadUrl: "https://media.dingtalk.com/image.png",
          }),
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseDownload = resolve;
          }),
      );
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client, fetcher });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();

    client.emit(
      directMessage({
        msgId: "picture-1",
        msgtype: "picture",
        content: { downloadCode: "download-1" },
      }),
      "callback-picture",
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    client.emit(
      directMessage({
        msgId: "text-2",
        text: { content: "after image" },
      }),
      "callback-text",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);

    releaseDownload(
      new Response(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received.map((event) => event.messageId)).toEqual([
      "picture-1",
      "text-2",
    ]);
  });
});
