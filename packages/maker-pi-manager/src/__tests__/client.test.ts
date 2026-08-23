/**
 * RpcClient unit tests — 7 self-review round 9 coverage items.
 *
 * Uses a custom Duplex so that:
 * - Writes from the client are captured (client→server direction).
 * - The test can push NDJSON lines into the readable side (server→client
 *   direction), which the client's `stream.on('data', …)` handler picks up.
 */

import { describe, it, expect } from "vitest";
import { Duplex } from "node:stream";
import { RpcClient, RpcClientError } from "../client.js";
import { PROTOCOL_VERSION } from "../protocol.js";

/* -------------------------------------------------------------------------- */
/*  Test harness                                                              */
/* -------------------------------------------------------------------------- */

interface CapturedRequest {
  id: number;
  method: string;
  params: unknown;
}

interface CapturedNotification {
  method: string;
  params: unknown;
}

function makeTestStream() {
  const requests: CapturedRequest[] = [];
  const clientNotifications: CapturedNotification[] = [];

  const stream = new Duplex({
    read() {
      // Data is pushed manually by the test — no underlying source to pull.
    },
    write(
      chunk: Buffer,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ) {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          const msg = JSON.parse(line) as {
            type: string;
            id?: number;
            method: string;
            params: unknown;
          };
          if (msg.type === "request") {
            requests.push({ id: msg.id!, method: msg.method, params: msg.params });
          } else if (msg.type === "notification") {
            clientNotifications.push({ method: msg.method, params: msg.params });
          }
        } catch {
          // Corrupt lines are silently ignored in the test harness.
        }
      }
      callback();
    },
  });

  return {
    stream,
    /** All captured client→server request messages, in order. */
    requests,
    /** All captured client→server notification messages, in order. */
    clientNotifications,
    /** The most recently captured request, or undefined. */
    lastRequest: (): CapturedRequest | undefined =>
      requests[requests.length - 1],

    /**
     * Push a successful NDJSON response line into the readable side.
     * The client receives it via the `data` event.
     */
    respond(id: number, result: unknown) {
      stream.push(
        JSON.stringify({ type: "response", id, result }) + "\n",
      );
    },

    /**
     * Push an error NDJSON response line into the readable side.
     */
    respondError(
      id: number,
      code: string,
      message: string,
      data?: unknown,
    ) {
      const error: Record<string, unknown> = { code, message };
      if (data !== undefined) error.data = data;
      stream.push(
        JSON.stringify({ type: "response", id, error }) + "\n",
      );
    },

    /**
     * Push a server→client NDJSON notification line into the readable side.
     */
    pushNotification(method: string, params: unknown) {
      stream.push(
        JSON.stringify({ type: "notification", method, params }) + "\n",
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe("RpcClient", () => {
  /* ---------------------------------------------------------------------- */
  /*  1. hello 前置：hello 前 request → reject "must call hello()"           */
  /* ---------------------------------------------------------------------- */

  it("rejects non-hello requests before hello with 'must call hello()'", async () => {
    const { stream } = makeTestStream();
    const client = new RpcClient(stream);

    await expect(
      client.request("pi/list" as Parameters<typeof client.request>[0], {}),
    ).rejects.toThrow("must call hello() before other requests");

    await expect(
      client.request("pi/ensure" as Parameters<typeof client.request>[0], {}),
    ).rejects.toThrow("must call hello() before other requests");
  });

  /* ---------------------------------------------------------------------- */
  /*  2. hello + 后续请求：hello 通过后 request 正常 resolve                 */
  /* ---------------------------------------------------------------------- */

  it("completes hello and allows subsequent requests", async () => {
    const { stream, respond, lastRequest } = makeTestStream();
    const client = new RpcClient(stream);

    // --- hello ---
    const helloPromise = client.hello();

    const helloReq = lastRequest()!;
    expect(helloReq).toBeDefined();
    expect(helloReq.method).toBe("protocol/hello");
    expect(helloReq.params).toEqual({ protocolVersion: PROTOCOL_VERSION });

    respond(helloReq.id, { protocolVersion: 1, managerVersion: "0.1.0" });

    const helloResult = await helloPromise;
    expect(helloResult).toEqual({
      protocolVersion: 1,
      managerVersion: "0.1.0",
    });

    // --- subsequent request ---
    const listPromise = client.request(
      "pi/list" as Parameters<typeof client.request>[0],
      {},
    );

    const listReq = lastRequest()!;
    expect(listReq.id).toBeGreaterThan(helloReq.id);
    expect(listReq.method).toBe("pi/list");

    respond(listReq.id, { sessions: [] });

    await expect(listPromise).resolves.toEqual({ sessions: [] });
  });

  /* ---------------------------------------------------------------------- */
  /*  3. pending 超时：50ms 超时无响应 → reject                               */
  /* ---------------------------------------------------------------------- */

  it(
    "rejects a pending request after timeout (50ms)",
    async () => {
      const { stream, respond, lastRequest } = makeTestStream();
      const client = new RpcClient(stream, { requestTimeoutMs: 50 });

      // Complete hello first.
      const helloPromise = client.hello();
      respond(lastRequest()!.id, { protocolVersion: 1 });
      await helloPromise;

      // Make a request and never respond — it should time out.
      const promise = client.request(
        "pi/list" as Parameters<typeof client.request>[0],
        {},
      );

      await expect(promise).rejects.toThrow(/timed out after 50ms/);
    },
    10_000, // generous timeout to avoid flakiness on slow CI
  );

  /* ---------------------------------------------------------------------- */
  /*  4. stream close reject 全部 pending                                    */
  /* ---------------------------------------------------------------------- */

  it("rejects all in-flight requests when the stream closes", async () => {
    const { stream, respond, lastRequest } = makeTestStream();
    // Use a long requestTimeout so timers never beat the close handler.
    const client = new RpcClient(stream, { requestTimeoutMs: 30_000 });

    // Complete hello.
    const helloPromise = client.hello();
    respond(lastRequest()!.id, { protocolVersion: 1 });
    await helloPromise;

    // Fire 3 in-flight requests — do NOT respond.
    const p1 = client.request(
      "pi/list" as Parameters<typeof client.request>[0],
      {},
    );
    const p2 = client.request(
      "pi/list" as Parameters<typeof client.request>[0],
      {},
    );
    const p3 = client.request(
      "pi/list" as Parameters<typeof client.request>[0],
      {},
    );

    // Destroy the stream — the close handler must reject all three.
    stream.destroy();

    await expect(p1).rejects.toThrow("pi-manager stream closed");
    await expect(p2).rejects.toThrow("pi-manager stream closed");
    await expect(p3).rejects.toThrow("pi-manager stream closed");
  });

  it("timeoutMs<=0 disables the timer — request waits for response (round 14 GAP-1)", async () => {
    const { stream, respond, lastRequest } = makeTestStream();
    const client = new RpcClient(stream, { requestTimeoutMs: 30_000 });

    const helloPromise = client.hello();
    respond(lastRequest()!.id, { protocolVersion: 1 });
    await helloPromise;

    // timeoutMs: 0 = 不设超时。请求应挂起直到响应, 不会立刻超时。
    const promise = client.request(
      "pi/list" as Parameters<typeof client.request>[0],
      {},
      { timeoutMs: 0 },
    );

    // 不给响应, 等一个 tick —— 若 timeoutMs=0 被当成 0ms 超时, 这里就 reject 了
    await new Promise((resolve) => setImmediate(resolve));

    // 仍未 settle —— 手动响应
    respond(lastRequest()!.id, { sessions: [] });
    await expect(promise).resolves.toEqual({ sessions: [] });
  });

  it("rejects in-flight requests on remote half-close (end without close) — round 3 #1", async () => {
    // Duplex 默认 allowHalfOpen=true:对端干净关闭读方向只发 end 不发 close。
    // 修复前 pending 挂到超时;修复后 end 立即 reject + destroy。
    const { stream, respond, lastRequest } = makeTestStream();
    const client = new RpcClient(stream, { requestTimeoutMs: 60_000 });

    const helloPromise = client.hello();
    respond(lastRequest()!.id, { protocolVersion: 1 });
    await helloPromise;

    const p1 = client.request(
      "pi/list" as Parameters<typeof client.request>[0],
      {},
    );

    // 模拟对端 FIN:push(null) 触发 'end'(不触发 'close')。
    stream.push(null);

    await expect(p1).rejects.toThrow(/stream ended/);
    // end handler 会 destroy 流, close 兜底也跑过(幂等)。
    expect(stream.destroyed).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /*  5. dispose 幂等：调两次不抛                                            */
  /* ---------------------------------------------------------------------- */

  it("is idempotent — calling dispose() twice does not throw", () => {
    const { stream } = makeTestStream();
    const client = new RpcClient(stream);

    expect(() => client.dispose()).not.toThrow();
    expect(() => client.dispose()).not.toThrow();
  });

  /* ---------------------------------------------------------------------- */
  /*  6. 通知分发：handler 收到 method + params                               */
  /* ---------------------------------------------------------------------- */

  it("dispatches server notifications to subscribed handlers", async () => {
    const { stream, pushNotification } = makeTestStream();
    const client = new RpcClient(stream);

    const received: Array<{ method: string; params: unknown }> = [];
    const unsubscribe = client.subscribe((method, params) => {
      received.push({ method, params });
    });

    // Push a notification from "server".
    pushNotification("session/closed", {
      sessionId: "abc-123",
      reason: "completed",
    });

    // give Node stream flowing mode a microtask to deliver
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      method: "session/closed",
      params: { sessionId: "abc-123", reason: "completed" },
    });

    // Unsubscribe and push another — should not be received.
    unsubscribe();

    pushNotification("session/closed", {
      sessionId: "xyz-999",
      reason: "killed",
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(1); // still 1 — unsubscribed
  });

  /* ---------------------------------------------------------------------- */
  /*  7. RpcClientError：错误响应 → reject 带 code/data                      */
  /* ---------------------------------------------------------------------- */

  it("rejects with RpcClientError when server sends an error response", async () => {
    const { stream, respond, respondError, lastRequest } = makeTestStream();
    const client = new RpcClient(stream);

    // Complete hello.
    const helloPromise = client.hello();
    respond(lastRequest()!.id, { protocolVersion: 1 });
    await helloPromise;

    // Make a request.
    const promise = client.request(
      "pi/ensure" as Parameters<typeof client.request>[0],
      { sessionId: "no-such-session" },
    );

    const req = lastRequest()!;
    respondError(
      req.id,
      "SESSION_NOT_FOUND",
      "Session no-such-session not found",
      { detail: "no such session on this host" },
    );

    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RpcClientError);
    const err = caught as RpcClientError;
    expect(err.code).toBe("SESSION_NOT_FOUND");
    expect(err.message).toContain("SESSION_NOT_FOUND");
    expect(err.message).toContain("Session no-such-session not found");
    expect(err.data).toEqual({ detail: "no such session on this host" });
  });
});

/* -------------------------------------------------------------------------- */
/*  Bonus: additional edge cases                                              */
/* -------------------------------------------------------------------------- */

describe("RpcClient — edge cases", () => {
  it("rejects request immediately when stream is already destroyed", async () => {
    const { stream } = makeTestStream();
    const client = new RpcClient(stream);

    stream.destroy();

    await expect(
      client.request("pi/list" as Parameters<typeof client.request>[0], {}),
    ).rejects.toThrow("client stream is destroyed");
  });

  it("writes client→server notifications to the stream", () => {
    const { stream, clientNotifications } = makeTestStream();
    const client = new RpcClient(stream);

    client.notify("session/closed", {
      sessionId: "test",
      reason: "completed",
    } as Parameters<typeof client.notify>[1]);

    expect(clientNotifications).toHaveLength(1);
    expect(clientNotifications[0]).toMatchObject({
      method: "session/closed",
      params: { sessionId: "test", reason: "completed" },
    });
  });

  it("does not write notifications when stream is destroyed", () => {
    const { stream, clientNotifications } = makeTestStream();
    const client = new RpcClient(stream);

    stream.destroy();
    client.notify("session/closed", {
      sessionId: "test",
      reason: "completed",
    } as Parameters<typeof client.notify>[1]);

    expect(clientNotifications).toHaveLength(0);
  });

  it("emits closeHandlers when stream closes", async () => {
    const { stream, respond, lastRequest } = makeTestStream();
    const client = new RpcClient(stream);

    let closed = false;
    const unsub = client.subscribeClose(() => {
      closed = true;
    });

    // Complete hello so pending map is empty — close handler still fires.
    const helloP = client.hello();
    respond(lastRequest()!.id, { protocolVersion: 1 });
    await helloP;

    stream.destroy();

    // close event is emitted on process.nextTick
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(true);

    // Unsubscribe works.
    unsub();
    // Second destroy is idempotent — closeHandler already removed, ok.
  });

  it("forwards clientId in hello params", () => {
    const { stream, requests } = makeTestStream();
    new RpcClient(stream, { clientId: "desktop-1" });

    // Hello hasn't been called yet — the param is set inside hello().
    // We just verify the option is stored. Actually call hello to verify.
    const client = new RpcClient(stream, { clientId: "desktop-1" });
    client.hello();

    expect(requests[0]).toBeDefined();
    expect(requests[0].params).toMatchObject({ clientId: "desktop-1" });
  });

  it("does not include clientId in hello params when not configured", () => {
    const { stream, requests } = makeTestStream();
    const client = new RpcClient(stream);
    client.hello();

    expect(requests[0]).toBeDefined();
    expect(requests[0].params).toEqual({ protocolVersion: PROTOCOL_VERSION });
    expect(requests[0].params).not.toHaveProperty("clientId");
  });
});
