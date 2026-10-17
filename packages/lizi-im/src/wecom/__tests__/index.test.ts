import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { IMHost, IMMessageEvent } from "../../types.js";
import { decodeWecomLane } from "../codec.js";
import { WecomIM } from "../index.js";

type Handler = (payload?: unknown) => void;
type IpcHandler = (payload?: unknown) => Promise<unknown> | unknown;

class FakeClient {
  readonly handlers = new Map<string, Handler[]>();
  readonly sendMessage = vi.fn(async () => ({}));
  readonly sendMediaMessage = vi.fn(async () => ({}));
  readonly replyStream = vi.fn<
    (
      frame: unknown,
      streamId: string,
      content: string,
      finish: boolean,
    ) => Promise<Record<string, never>>
  >(async () => ({}));
  readonly replyMedia = vi.fn(async () => ({}));
  readonly uploadMedia = vi.fn(
    async (buffer: Buffer, options: { type: string; filename: string }) => {
      void buffer;
      void options;
      return { media_id: "media-1" };
    },
  );
  readonly downloadFile = vi.fn(async () => ({
    buffer: Buffer.from("image"),
    filename: "photo.jpg",
  }));
  isConnected = false;
  connectError: Error | null = null;

  on(event: string, handler: Handler) {
    const entries = this.handlers.get(event) ?? [];
    entries.push(handler);
    this.handlers.set(event, entries);
    return this;
  }

  connect() {
    if (this.connectError) throw this.connectError;
    this.isConnected = true;
    this.emit("authenticated");
    return this;
  }

  disconnect() {
    this.isConnected = false;
  }

  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

function createHost() {
  const secrets = new Map<string, string>([
    ["wecom-bot-id", "bot-1"],
    ["wecom-bot-secret", "secret-1"],
  ]);
  const broadcasts: unknown[] = [];
  const ipcHandlers = new Map<string, IpcHandler>();
  const host: IMHost = {
    secrets: {
      read: (name) => secrets.get(name) ?? null,
      write: (name, value) => {
        secrets.set(name, value);
        return true;
      },
      remove: (name) => void secrets.delete(name),
      isAvailable: () => true,
    },
    ipc: {
      throwIpcError: (code, message) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: (channel, handler) => void ipcHandlers.set(channel, handler),
      broadcast: (_channel, payload) => broadcasts.push(payload),
    },
    paths: {
      feishuMediaDir: "unused",
      wecomMediaDir: "unused",
    },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets, broadcasts, ipcHandlers };
}

function message(args: {
  id: string;
  sender: string;
  text: string;
  chatId?: string;
}) {
  return {
    body: {
      msgid: args.id,
      aibotid: "bot-1",
      chattype: args.chatId ? "group" : "single",
      ...(args.chatId ? { chatid: args.chatId } : {}),
      from: { userid: args.sender },
      msgtype: "text",
      text: { content: args.text },
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WecomIM routing and ownership", () => {
  it("keeps a quote-only invocation empty and does not claim quoted media was delivered", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();
    const frame = message({ id: "quote-only", sender: "owner", text: "", chatId: "group-1" });
    client.emit("message.text", {
      ...frame,
      body: { ...frame.body, quote: { msgtype: "image", image: { url: "https://example.com/image" } } },
    });
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      text: "", invoked: true, attachments: [],
      replyContext: { unavailableAttachments: ["引用消息的 1 个附件未提供文件内容"] },
    });
    expect(received[0].replyContext?.attachmentCount).toBeUndefined();
    expect(client.downloadFile).not.toHaveBeenCalled();
    await im.dispose();
  });

  it("TOFU-binds the first DM sender and only accepts that owner afterwards", async () => {
    const { host, secrets } = createHost();
    const client = new FakeClient();
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
    });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit(
      "message.text",
      message({ id: "m1", sender: "owner", text: "hello" }),
    );
    client.emit(
      "message.text",
      message({ id: "m2", sender: "other", text: "blocked" }),
    );
    await flush();

    expect(secrets.get("wecom-owner-user-id")).toBe("owner");
    expect(received.map((event) => event.text)).toEqual(["hello"]);
  });

  it("routes owner group messages through an encoded lane and active fallback uses chatid", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit(
      "message.text",
      message({
        id: "m-group",
        sender: "owner",
        text: "group task",
        chatId: "chat-123",
      }),
    );
    await flush();

    const lane = received[0]!.senderId;
    expect(decodeWecomLane(lane)).toEqual({
      kind: "group",
      targetId: "chat-123",
    });
    await im.sendMarkdownText(lane, "**ack**");
    expect(client.replyStream).toHaveBeenCalledOnce();

    await im.sendMarkdownText(lane, "**active**");
    expect(client.sendMessage).toHaveBeenCalledWith("chat-123", {
      msgtype: "markdown",
      markdown: { content: "**active**" },
    });
  });

  it("starts a passive stream before the turn and finalizes the same stream", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
      now: () => 1_000,
    });

    await im.init();
    const frame = message({ id: "m-stream", sender: "owner", text: "task" });
    client.emit("message.text", frame);
    await flush();

    await im.beginReply("owner");
    const streamId = client.replyStream.mock.calls[0]?.[1];
    expect(client.replyStream).toHaveBeenNthCalledWith(
      1,
      frame,
      expect.any(String),
      " ",
      false,
    );

    await im.commitFinal({
      userId: "owner",
      text: "final answer",
      terminal: "done",
    });

    expect(client.replyStream).toHaveBeenNthCalledWith(
      2,
      frame,
      streamId,
      "final answer",
      true,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])('empty final does not send a placeholder (passive=%s)', async (passive) => {
    const { host, secrets } = createHost();
    secrets.set('wecom-owner-user-id', 'owner');
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never, now: () => 1_000 });
    await im.init();
    const frame = message({ id: 'm-empty', sender: 'owner', text: 'task' });
    client.emit('message.text', frame);
    await flush();
    if (passive) await im.beginReply('owner');
    await im.commitFinal({ userId: 'owner', text: ' \n ', terminal: 'done' });
    expect(client.sendMessage).not.toHaveBeenCalled();
    if (passive) expect(client.replyStream).toHaveBeenLastCalledWith(frame, expect.any(String), ' ', true);
    else expect(client.replyStream).not.toHaveBeenCalled();
    await im.dispose();
  });

  it("keeps later inbound frames available while terminal attachments use active send", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const mediaDir = join(tmpdir(), `cindy-wecom-frame-${randomUUID()}`);
    const filePath = join(mediaDir, "report.txt");
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await mkdir(mediaDir, { recursive: true });
    await writeFile(filePath, "report");
    try {
      await im.init();
      const firstFrame = message({
        id: "m-first",
        sender: "owner",
        text: "first",
      });
      const secondFrame = message({
        id: "m-second",
        sender: "owner",
        text: "second",
      });
      client.emit("message.text", firstFrame);
      await flush();
      await im.beginReply("owner");
      client.uploadMedia.mockImplementationOnce(async () => {
        client.emit("message.text", secondFrame);
        await flush();
        return { media_id: "media-2" };
      });

      const fileUrl = `xdt-file:///${encodeURI(filePath.replaceAll("\\", "/"))}`;
      await im.commitFinal({
        userId: "owner",
        text: `done\n[report](${fileUrl})`,
        terminal: "done",
        allowedFileRoots: [mediaDir],
      });

      expect(client.replyMedia).not.toHaveBeenCalled();
      expect(client.sendMediaMessage).toHaveBeenCalledWith(
        "owner",
        "file",
        "media-2",
      );
      await im.sendMarkdownText("owner", "second reply");
      expect(client.replyStream).toHaveBeenLastCalledWith(
        secondFrame,
        expect.any(String),
        "second reply",
        true,
      );
    } finally {
      await im.dispose();
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it("falls back to active send after the passive stream safety window", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    let now = 1_000;
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
      now: () => now,
    });

    await im.init();
    client.emit(
      "message.text",
      message({ id: "m-timeout", sender: "owner", text: "long task" }),
    );
    await flush();
    await im.beginReply("owner");
    now += 3 * 60_000;

    await im.commitFinal({
      userId: "owner",
      text: "late answer",
      terminal: "done",
    });

    expect(client.replyStream).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith("owner", {
      msgtype: "markdown",
      markdown: { content: "late answer" },
    });
  });

  it("delivers terminal file and managed-image links without leaking local URLs", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const mediaDir = join(tmpdir(), `cindy-wecom-outbound-${randomUUID()}`);
    const filePath = join(mediaDir, "report.txt");
    const imagePath = join(mediaDir, "chart.png");
    const imageUrl = "cindy-media://blobs/chart.png";
    host.media = {
      getCachedImage: async () => null,
      cacheImage: async () => ({ absPath: imagePath, url: imageUrl }),
      resolveMediaUrl: vi.fn((url) => (url === imageUrl ? imagePath : null)),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await mkdir(mediaDir, { recursive: true });
    await Promise.all([
      writeFile(filePath, "report"),
      writeFile(imagePath, "image"),
    ]);
    try {
      await im.init();
      const fileUrl = `xdt-file:///${encodeURI(filePath.replaceAll("\\", "/"))}`;
      await im.commitFinal({
        userId: "owner",
        text: `done\n[report.txt](${fileUrl})\n![chart](${imageUrl})`,
        terminal: "done",
        mediaAbsPaths: [imagePath],
        allowedFileRoots: [mediaDir],
      });

      expect(client.sendMessage).toHaveBeenCalledWith("owner", {
        msgtype: "markdown",
        markdown: { content: "done" },
      });
      expect(JSON.stringify(client.sendMessage.mock.calls)).not.toContain("xdt-file://");
      expect(JSON.stringify(client.sendMessage.mock.calls)).not.toContain("cindy-media://");
      expect(client.uploadMedia).toHaveBeenCalledTimes(2);
      expect(client.sendMediaMessage).toHaveBeenCalledTimes(2);
      expect(host.media.resolveMediaUrl).toHaveBeenCalledWith(imageUrl);
    } finally {
      await im.dispose();
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it("reports managed images that cannot be resolved before removing their links", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const imageUrl = "cindy-media://blobs/missing.png";
    host.media = {
      getCachedImage: async () => null,
      cacheImage: async () => ({ absPath: "unused", url: imageUrl }),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    await im.commitFinal({
      userId: "owner",
      text: `done\n![missing](${imageUrl})`,
      terminal: "done",
    });

    expect(client.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith("owner", {
      msgtype: "markdown",
      markdown: {
        content: "done\n\n⚠️ 有 1 张图片未发送（图片已不存在或无法读取）。",
      },
    });
  });

  it("does not upload model-authored xdt-file links outside allowed roots", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const allowedDir = join(tmpdir(), `cindy-wecom-allowed-${randomUUID()}`);
    const outsideDir = join(tmpdir(), `cindy-wecom-outside-${randomUUID()}`);
    const allowedPath = join(allowedDir, "report.txt");
    const outsidePath = join(outsideDir, "secret.txt");
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await Promise.all([
      mkdir(allowedDir, { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(allowedPath, "report"),
      writeFile(outsidePath, "secret"),
    ]);
    try {
      await im.init();
      const allowedUrl = `xdt-file:///${encodeURI(allowedPath.replaceAll("\\", "/"))}`;
      const outsideUrl = `xdt-file:///${encodeURI(outsidePath.replaceAll("\\", "/"))}`;
      await im.commitFinal({
        userId: "owner",
        text: `done\n[report](${allowedUrl})\n[secret](${outsideUrl})`,
        terminal: "done",
        allowedFileRoots: [allowedDir],
      });

      expect(client.uploadMedia).toHaveBeenCalledOnce();
      expect(client.uploadMedia.mock.calls[0]?.[0]).toEqual(Buffer.from("report"));
      expect(JSON.stringify(client.uploadMedia.mock.calls)).not.toContain("secret");
      expect(client.sendMessage).toHaveBeenCalledWith("owner", {
        msgtype: "markdown",
        markdown: {
          content:
            "done\n\n⚠️ 有 1 个文件附件未发送（不在当前工作目录内或无法验证）。",
        },
      });
    } finally {
      await im.dispose();
      await Promise.all([
        rm(allowedDir, { recursive: true, force: true }),
        rm(outsideDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports attachments omitted by the outbound safety cap", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const sendFile = vi
      .spyOn(im, "sendFile")
      .mockResolvedValue({ ok: true, messageId: "attachment" });

    await im.init();
    await im.commitFinal({
      userId: "owner",
      text: "done",
      terminal: "done",
      mediaAbsPaths: ["one", "two", "three", "four", "five"],
    });

    expect(sendFile).toHaveBeenCalledTimes(4);
    expect(client.sendMessage).toHaveBeenCalledWith("owner", {
      msgtype: "markdown",
      markdown: {
        content: "done\n\n⚠️ 另有 1 个附件未发送（企业微信单次最多发送 4 个）。",
      },
    });
  });

  it("notifies the recipient when a terminal attachment fails to send", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const nextFrame = message({ id: "m-next", sender: "owner", text: "next" });
    vi.spyOn(im, "sendFile").mockImplementation(async () => {
      client.emit("message.text", nextFrame);
      await flush();
      return { ok: false, reason: "UPLOAD_FAIL" };
    });

    await im.init();
    await im.commitFinal({
      userId: "owner",
      text: "done",
      terminal: "done",
      mediaAbsPaths: ["missing"],
    });

    expect(client.sendMessage).toHaveBeenNthCalledWith(1, "owner", {
      msgtype: "markdown",
      markdown: { content: "done" },
    });
    expect(client.sendMessage).toHaveBeenNthCalledWith(2, "owner", {
      msgtype: "markdown",
      markdown: { content: "⚠️ 有 1 个附件发送失败，请稍后重试。" },
    });

    await im.sendMarkdownText("owner", "next reply");
    expect(client.replyStream).toHaveBeenLastCalledWith(
      nextFrame,
      expect.any(String),
      "next reply",
      true,
    );
  });

  it("deduplicates repeated callback message ids", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received = vi.fn();
    im.onMessage(received);

    await im.init();
    const frame = message({ id: "same", sender: "owner", text: "once" });
    client.emit("message.text", frame);
    client.emit("message.text", frame);
    await flush();

    expect(received).toHaveBeenCalledOnce();
  });

  it("surfaces a synchronous SDK startup failure instead of staying connecting", async () => {
    const { host } = createHost();
    const client = new FakeClient();
    client.connectError = new Error("invalid credentials");
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await expect(im.init()).resolves.toBeUndefined();

    expect(im.getStatus()).toEqual({
      kind: "error",
      reason: "invalid credentials",
    });
  });

  it("preserves the concrete authentication failure after retries are exhausted", async () => {
    const { host } = createHost();
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    client.emit(
      "error",
      new Error("Authentication failed: invalid secret (code: 40001)"),
    );
    client.emit(
      "error",
      Object.assign(new Error("Max auth failure attempts exceeded (3)"), {
        code: "WS_AUTH_FAILURE_EXHAUSTED",
      }),
    );

    expect(im.getStatus()).toEqual({
      kind: "error",
      reason: "企业微信鉴权失败：invalid secret (code: 40001)",
    });
  });

  it("preserves conflict status when the SDK follows a server kick with disconnected", async () => {
    const { host } = createHost();
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    client.emit("event.disconnected_event");
    client.emit("disconnected", "another connection took over");

    expect(im.getStatus()).toEqual({ kind: "conflict", appId: "bot-1" });
  });

  it("keeps ordinary disconnects in the reconnecting state", async () => {
    const { host } = createHost();
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    client.emit("disconnected", "network unavailable");

    expect(im.getStatus()).toEqual({ kind: "connecting" });
  });

  it.each([
    {
      channel: "wecomBot:set-config",
      payload: { botId: "bot-2", secret: "secret-2" },
    },
    { channel: "wecomBot:reconnect", payload: undefined },
    { channel: "wecomBot:disconnect", payload: undefined },
  ])(
    "does not mutate transport through $channel after the account generation changes",
    async ({ channel, payload }) => {
      const { host, secrets, ipcHandlers } = createHost();
      const gate = deferred<void>();
      let active = true;
      let accountToken = 1;
      const accountRun = vi.fn();
      host.accountScope = {
        capture: () => (active ? accountToken : null),
        isCurrent: (token) => active && token === accountToken,
        async run<T>(
          token: unknown,
          operation: () => Promise<T>,
        ): Promise<T> {
          accountRun(token);
          await gate.promise;
          if (!active || token !== accountToken) {
            throw new Error("[IM_NOT_READY] stale account generation");
          }
          return operation();
        },
      };
      const clientFactory = vi.fn(() => new FakeClient() as never);
      const im = new WecomIM(host, { clientFactory });
      im.registerIpc();

      const invoke = ipcHandlers.get(channel);
      expect(invoke).toBeDefined();
      const operation = Promise.resolve(invoke?.(payload));
      await vi.waitFor(() => expect(accountRun).toHaveBeenCalledWith(1));

      active = false;
      accountToken += 1;
      gate.resolve();

      await expect(operation).rejects.toThrow("[IM_NOT_READY]");
      expect(clientFactory).not.toHaveBeenCalled();
      expect(secrets.get("wecom-bot-id")).toBe("bot-1");
      expect(secrets.get("wecom-bot-secret")).toBe("secret-1");
    },
  );

  it("preserves arrival order when media download is slower than a following text message", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    let releaseDownload!: () => void;
    client.downloadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDownload = () =>
            resolve({ buffer: Buffer.from("image"), filename: "photo.jpg" });
        }),
    );
    host.media = {
      getCachedImage: async () => null,
      cacheImage: async () => ({
        absPath: "C:\\managed\\photo.jpg",
        url: "cindy-media://image",
      }),
      resolveMediaUrl: () => null,
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: string[] = [];
    im.onMessage((event) =>
      received.push(event.text || event.attachments[0]?.kind || "empty"),
    );

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "image-first",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });
    client.emit(
      "message.text",
      message({ id: "text-second", sender: "owner", text: "second" }),
    );
    await flush();
    expect(received).toEqual([]);

    releaseDownload();
    await flush();
    await flush();
    expect(received).toEqual(["image", "second"]);
  });

  it("does not cache an inbound image after the transport generation changes", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const download = deferred<Awaited<ReturnType<FakeClient["downloadFile"]>>>();
    client.downloadFile.mockImplementationOnce(() => download.promise);
    const cacheImage = vi.fn(async () => ({
      absPath: "C:\\managed\\photo.jpg",
      url: "cindy-media://image",
    }));
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage,
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "stale-image",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });
    await vi.waitFor(() => expect(client.downloadFile).toHaveBeenCalledOnce());

    await im.dispose();
    download.resolve({ buffer: Buffer.from("image"), filename: "photo.jpg" });
    await flush();
    await flush();

    expect(cacheImage).not.toHaveBeenCalled();
  });

  it("discards image staging when the owning account closes during the write", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const accountToken = { id: 1 };
    let accountActive = true;
    host.accountScope = {
      capture: () => (accountActive ? accountToken : null),
      isCurrent: (token) => accountActive && token === accountToken,
      run: async (_token, operation) => operation(),
    };
    const client = new FakeClient();
    const staged = deferred<{
      absPath: string;
      url: string;
      discard: () => Promise<void>;
    }>();
    const discard = vi.fn(async () => {});
    const cacheImage = vi.fn(() => staged.promise);
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage,
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "stale-staged-image",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });
    await vi.waitFor(() => expect(cacheImage).toHaveBeenCalledOnce());
    expect(cacheImage).toHaveBeenCalledWith(
      expect.objectContaining({ staging: true }),
    );

    accountActive = false;
    staged.resolve({
      absPath: "C:\\managed\\photo.jpg",
      url: "cindy-media://image",
      discard,
    });
    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());

    expect(received).toEqual([]);
  });

  it("carries image staging rollback through the final account ownership check", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const accountToken = { id: 1 };
    let accountActive = true;
    host.accountScope = {
      capture: () => (accountActive ? accountToken : null),
      isCurrent: (token) => accountActive && token === accountToken,
      run: async (_token, operation) => operation(),
    };
    const client = new FakeClient();
    const discard = vi.fn(async () => {});
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage: vi.fn(async () => ({
        absPath: "C:\\managed\\photo.jpg",
        get url() {
          accountActive = false;
          return "cindy-media://image";
        },
        discard,
      })),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "stale-normalized-image",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });

    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(received).toEqual([]);
  });

  it("does not pin or download a cached image after the owning account boundary closes", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const accountToken = { id: 1 };
    let accountActive = true;
    host.accountScope = {
      capture: () => (accountActive ? accountToken : null),
      isCurrent: (token) => accountActive && token === accountToken,
      run: async (_token, operation) => operation(),
    };
    const client = new FakeClient();
    const lookup = deferred<{
      absPath: string;
      url: string;
      mimeType: string;
    }>();
    const pinCachedImage = vi.fn();
    const getCachedImage = vi.fn(
      async (
        _integration: "wecom",
        _token: string,
        options?: { shouldReuse?: () => boolean },
      ) => {
        const cached = await lookup.promise;
        if (options?.shouldReuse?.() === false) return null;
        pinCachedImage();
        return cached;
      },
    );
    host.media = {
      getCachedImage,
      cacheImage: vi.fn(),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "closed-account-cached-image",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });
    await vi.waitFor(() => expect(getCachedImage).toHaveBeenCalledOnce());

    accountActive = false;
    lookup.resolve({
      absPath: "C:\\managed\\photo.jpg",
      url: "cindy-media://image",
      mimeType: "image/jpeg",
    });
    await flush();
    await flush();

    expect(pinCachedImage).not.toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
  });

  it("does not stage an inbound file after the transport generation changes", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const legacyDir = join(tmpdir(), `cindy-wecom-stale-${randomUUID()}`);
    host.paths.wecomMediaDir = legacyDir;
    const stage = vi.fn(async () => ({
      absPath: "C:\\staged\\report.txt",
      discard: vi.fn(async () => {}),
    }));
    host.files = { stage };
    const client = new FakeClient();
    const download = deferred<Awaited<ReturnType<FakeClient["downloadFile"]>>>();
    client.downloadFile.mockImplementationOnce(() => download.promise);
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    try {
      await im.init();
      client.emit("message.file", {
        body: {
          msgid: "stale-file",
          aibotid: "bot-1",
          chattype: "single",
          from: { userid: "owner" },
          msgtype: "file",
          file: { url: "https://example.invalid/file" },
        },
      });
      await vi.waitFor(() => expect(client.downloadFile).toHaveBeenCalledOnce());

      await im.dispose();
      download.resolve({ buffer: Buffer.from("file"), filename: "report.txt" });
      await flush();
      await flush();

      expect(stage).not.toHaveBeenCalled();
      expect(received).toEqual([]);
      expect(existsSync(legacyDir)).toBe(false);
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it("stages inbound files through host.files instead of the legacy media dir", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const legacyDir = join(tmpdir(), `cindy-wecom-legacy-${randomUUID()}`);
    host.paths.wecomMediaDir = legacyDir;
    const discard = vi.fn(async () => {});
    const stage = vi.fn(async () => ({ absPath: "C:\\staged\\report.txt", discard }));
    host.files = { stage };
    const client = new FakeClient();
    client.downloadFile.mockResolvedValueOnce({
      buffer: Buffer.from("file"),
      filename: "../report.txt",
    });
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    try {
      await im.init();
      client.emit("message.file", {
        body: {
          msgid: "file-1",
          aibotid: "bot-1",
          chattype: "single",
          from: { userid: "owner" },
          msgtype: "file",
          file: { url: "https://example.invalid/file" },
        },
      });
      await vi.waitFor(() => expect(received).toHaveLength(1));

      expect(stage).toHaveBeenCalledWith({
        integration: "wecom",
        buffer: Buffer.from("file"),
        fileName: "report.txt",
      });
      expect(received[0]?.attachments).toEqual([
        {
          kind: "file",
          absPath: "C:\\staged\\report.txt",
          originalName: "report.txt",
          mimeType: "text/plain",
        },
      ]);
      expect(received[0]?.unsupported).toEqual([]);
      expect(discard).not.toHaveBeenCalled();
      expect(existsSync(legacyDir)).toBe(false);
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it("discards file staging when the owning account closes during the write", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const accountToken = { id: 1 };
    let accountActive = true;
    host.accountScope = {
      capture: () => (accountActive ? accountToken : null),
      isCurrent: (token) => accountActive && token === accountToken,
      run: async (_token, operation) => operation(),
    };
    const client = new FakeClient();
    client.downloadFile.mockResolvedValueOnce({
      buffer: Buffer.from("file"),
      filename: "report.txt",
    });
    const staged = deferred<{ absPath: string; discard: () => Promise<void> }>();
    const discard = vi.fn(async () => {});
    const stage = vi.fn(() => staged.promise);
    host.files = { stage };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.file", {
      body: {
        msgid: "stale-staged-file",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "file",
        file: { url: "https://example.invalid/file" },
      },
    });
    await vi.waitFor(() => expect(stage).toHaveBeenCalledOnce());

    accountActive = false;
    staged.resolve({ absPath: "C:\\staged\\report.txt", discard });
    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
    await flush();

    expect(received).toEqual([]);
  });

  it("reports inbound files unsupported without downloading when host.files is missing", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.file", {
      body: {
        msgid: "no-staging-file",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "file",
        file: { url: "https://example.invalid/file" },
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(received[0]?.attachments).toEqual([]);
    expect(received[0]?.unsupported).toEqual([
      { type: "file:unsupported", label: "文件暂不支持" },
    ]);
  });

  it.each([
    { event: "message.image", msgtype: "image", body: { image: { url: "https://example.invalid/i" } }, filename: "image", mime: "image/jpeg", store: "cacheImage" },
    { event: "message.video", msgtype: "video", body: { video: { url: "https://example.invalid/v" } }, filename: "clip", mime: "video/mp4", store: "cacheMedia" },
  ])("uses the native $msgtype default MIME when the downloaded name has no extension", async ({ event, msgtype, body, filename, mime, store }) => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const cacheImage = vi.fn(async () => ({ absPath: "/blobs/x", url: "cindy-media://blobs/x", discard: vi.fn(async () => {}) }));
    const cacheMedia = vi.fn(async ({ mimeType }: { mimeType: string }) => ({
      absPath: "/blobs/x",
      url: "cindy-media://blobs/x",
      mimeType,
      discard: vi.fn(async () => {}),
    }));
    host.files = { stage: vi.fn() };
    host.media = { cacheImage, cacheMedia, getCachedImage: vi.fn(async () => null), resolveMediaUrl: () => null } as never;
    const client = new FakeClient();
    client.downloadFile.mockImplementationOnce(async () => ({ buffer: Buffer.from("x"), filename }));
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((e) => received.push(e));

    await im.init();
    client.emit(event, {
      body: { msgid: `native-${msgtype}`, aibotid: "bot-1", chattype: "single", from: { userid: "owner" }, msgtype, ...body },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const spy = store === "cacheImage" ? cacheImage : cacheMedia;
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ mimeType: mime }));
    expect(received[0]?.attachments).toHaveLength(1);
  });

  it("applies the 50MB inbound cap to file messages routed to the media store", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const cacheMedia = vi.fn();
    host.files = { stage: vi.fn() };
    host.media = { cacheImage: vi.fn(), cacheMedia, getCachedImage: vi.fn(async () => null), resolveMediaUrl: () => null } as never;
    const client = new FakeClient();
    client.downloadFile.mockImplementationOnce(async () => ({
      buffer: Buffer.alloc(50 * 1024 * 1024 + 1),
      filename: "big.mp4",
    }));
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((e) => received.push(e));

    await im.init();
    client.emit("message.file", {
      body: { msgid: "big-av", aibotid: "bot-1", chattype: "single", from: { userid: "owner" }, msgtype: "file", file: { url: "https://example.invalid/f" } },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(cacheMedia).not.toHaveBeenCalled();
    expect(received[0]?.unsupported).toEqual([{ type: "file:oversize", label: "文件超过大小上限：big.mp4" }]);
  });

  it("routes an inbound image file message to the media store as a staged image", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const stage = vi.fn();
    const cacheImage = vi.fn(async () => ({ absPath: "/blobs/p.png", url: "cindy-media://blobs/p.png", discard: vi.fn(async () => {}) }));
    host.files = { stage };
    host.media = { cacheImage, getCachedImage: vi.fn(async () => null), resolveMediaUrl: () => null } as never;
    const client = new FakeClient();
    client.downloadFile.mockImplementationOnce(async () => ({ buffer: Buffer.from("p"), filename: "scan.PNG" }));
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.file", {
      body: {
        msgid: "img-file",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "file",
        file: { url: "https://example.invalid/file" },
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(stage).not.toHaveBeenCalled();
    expect(cacheImage).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png", staging: true }));
    expect(received[0]?.attachments).toEqual([expect.objectContaining({ kind: "image", originalName: "scan.PNG" })]);
  });

  it.each([
    { name: "clip.mp4", accepted: true },
    { name: "clip.mkv", accepted: false },
  ])("routes an inbound $name file message to the media store only", async ({ name, accepted }) => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const stage = vi.fn();
    const cacheMedia = vi.fn(async ({ mimeType }: { mimeType: string }) => {
      if (!accepted) throw new Error("unsupported mime type");
      return { absPath: "/blobs/v.mp4", url: "cindy-media://blobs/v.mp4", mimeType, discard: vi.fn(async () => {}) };
    });
    host.files = { stage };
    host.media = {
      cacheImage: vi.fn(),
      cacheMedia,
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: () => null,
    } as never;
    const client = new FakeClient();
    client.downloadFile.mockImplementationOnce(async () => ({ buffer: Buffer.from("v"), filename: name }));
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.file", {
      body: {
        msgid: `av-file-${name}`,
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "file",
        file: { url: "https://example.invalid/file" },
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(stage).not.toHaveBeenCalled();
    expect(cacheMedia).toHaveBeenCalledTimes(1);
    if (accepted) {
      expect(received[0]?.attachments).toEqual([
        { kind: "file", absPath: "/blobs/v.mp4", originalName: name, mimeType: "video/mp4", url: "cindy-media://blobs/v.mp4" },
      ]);
    } else {
      expect(received[0]?.attachments).toEqual([]);
      expect(received[0]?.unsupported).toEqual([
        { type: "file:unsupported-media", label: `媒体格式暂不支持：${name}` },
      ]);
    }
  });

  it("does not download an inbound image when host.media is missing", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    host.files = { stage: vi.fn() };
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "no-media-image",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(host.files.stage).not.toHaveBeenCalled();
    expect(received[0]?.attachments).toEqual([]);
    expect(received[0]?.unsupported).toEqual([
      { type: "image:download-failed", label: "图片下载失败" },
    ]);
  });

  it("does not cache an inbound video after the transport generation changes", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const download = deferred<Awaited<ReturnType<FakeClient["downloadFile"]>>>();
    client.downloadFile.mockImplementationOnce(() => download.promise);
    const cacheMedia = vi.fn(async () => ({
      absPath: "C:\\managed\\clip.mp4",
      url: `cindy-media://blobs/${"a".repeat(64)}.mp4`,
      mimeType: "video/mp4",
    }));
    host.media = {
      cacheImage: vi.fn(),
      cacheMedia,
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    client.emit("message.video", {
      body: {
        msgid: "stale-video",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "video",
        video: { url: "https://example.invalid/video" },
      },
    });
    await vi.waitFor(() => expect(client.downloadFile).toHaveBeenCalledOnce());

    await im.dispose();
    download.resolve({ buffer: Buffer.from("video"), filename: "clip.mp4" });
    await flush();
    await flush();

    expect(cacheMedia).not.toHaveBeenCalled();
  });

  it("does not stage inbound media after the owning account boundary closes", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const accountToken = { id: 1 };
    let accountActive = true;
    host.accountScope = {
      capture: () => (accountActive ? accountToken : null),
      isCurrent: (token) => accountActive && token === accountToken,
      run: async (_token, operation) => operation(),
    };
    const client = new FakeClient();
    const cacheMedia = vi.fn(async () => ({
      absPath: "C:\\managed\\clip.mp4",
      url: `cindy-media://blobs/${"a".repeat(64)}.mp4`,
      mimeType: "video/mp4",
    }));
    host.media = {
      cacheImage: vi.fn(),
      cacheMedia,
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    accountActive = false;
    client.emit("message.video", {
      body: {
        msgid: "closed-account-video",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "video",
        video: { url: "https://example.invalid/video" },
      },
    });
    await flush();

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(cacheMedia).not.toHaveBeenCalled();
  });

  it("discards video staging when the owning account closes during the write", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const accountToken = { id: 1 };
    let accountActive = true;
    host.accountScope = {
      capture: () => (accountActive ? accountToken : null),
      isCurrent: (token) => accountActive && token === accountToken,
      run: async (_token, operation) => operation(),
    };
    const client = new FakeClient();
    client.downloadFile.mockResolvedValueOnce({
      buffer: Buffer.from("video"),
      filename: "clip.mp4",
    });
    const staged = deferred<{
      absPath: string;
      url: string;
      mimeType: string;
      discard: () => Promise<void>;
    }>();
    const discard = vi.fn(async () => {});
    const cacheMedia = vi.fn(() => staged.promise);
    host.media = {
      cacheImage: vi.fn(),
      cacheMedia,
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.video", {
      body: {
        msgid: "stale-staged-video",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "video",
        video: { url: "https://example.invalid/video" },
      },
    });
    await vi.waitFor(() => expect(cacheMedia).toHaveBeenCalledOnce());

    accountActive = false;
    staged.resolve({
      absPath: "C:\\managed\\clip.mp4",
      url: `cindy-media://blobs/${"a".repeat(64)}.mp4`,
      mimeType: "video/mp4",
      discard,
    });
    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());

    expect(received).toEqual([]);
  });

  it("routes inbound video bytes through the host media ledger", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    client.downloadFile.mockResolvedValueOnce({
      buffer: Buffer.from("video"),
      filename: "clip.mp4",
    });
    const cacheMedia = vi.fn(async () => ({
      absPath: "C:\\managed\\clip.mp4",
      url: `cindy-media://blobs/${"a".repeat(64)}.mp4`,
      mimeType: "video/mp4",
    }));
    host.media = {
      cacheImage: vi.fn(),
      cacheMedia,
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.video", {
      body: {
        msgid: "video-1",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "video",
        video: { url: "https://example.invalid/video" },
      },
    });
    await flush();
    await flush();

    expect(cacheMedia).toHaveBeenCalledWith({
      integration: "wecom",
      token: "video-1:video",
      buffer: Buffer.from("video"),
      mimeType: "video/mp4",
    });
    expect(received[0]?.attachments).toEqual([
      {
        kind: "file",
        absPath: "C:\\managed\\clip.mp4",
        originalName: "clip.mp4",
        mimeType: "video/mp4",
        url: `cindy-media://blobs/${"a".repeat(64)}.mp4`,
      },
    ]);
  });

  it("keeps a prefixed, IPC-less instance on its own credential keys and off the settings channels", async () => {
    const { host, secrets, broadcasts, ipcHandlers } = createHost();
    secrets.clear();
    secrets.set("bot-im-abc-wecom-bot-id", "bot-2");
    secrets.set("bot-im-abc-wecom-bot-secret", "secret-2");
    const client = new FakeClient();
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
      secretKeyPrefix: "bot-im-abc-",
      ipc: false,
    });
    im.registerIpc();
    expect(ipcHandlers.size).toBe(0);
    await im.init();
    expect(im.getStatus()).toEqual({ kind: "connected", appId: "bot-2" });
    expect(broadcasts).toEqual([]);
    const state = await im.setConfig({ botId: "bot-3", secret: "secret-3" });
    expect(state.botId).toBe("bot-3");
    expect(secrets.get("bot-im-abc-wecom-bot-id")).toBe("bot-3");
    expect(secrets.has("wecom-bot-id")).toBe(false);
    await im.clearCredentials();
    expect([...secrets.keys()]).toEqual([]);
    expect(im.getStatus()).toEqual({ kind: "idle" });
    expect(broadcasts).toEqual([]);
  });
});
