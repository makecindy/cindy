import { encodeInvokeResultTransfer } from '../../packages/device-link/src/invokeTransfer';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { McpAppSdkCache } from '../../packages/maker-shared/src/mcpApps';
import { handleMcpAppOperation } from '../../apps/desktop/src/main/mcp-apps/operations';
import type { McpAppsHost } from '../../apps/desktop/src/main/mcp-apps/host';
import type { McpAppDocument } from '../../packages/maker-shared/src/mcpApps';
import type { InvokePayload } from '../../packages/device-link/src/protocol';
import { expect, it, vi } from "vitest";
import { nodeRelayAuthCrypto } from "../../packages/device-link/src/nodeRelayCrypto";
import { RelayFrameAuthenticator } from "../../packages/device-link/src/selfHostedRelayAuth";
import { PLUGIN_SYNC_CHANNEL } from "../../packages/device-link/src/pluginSyncProtocol";
import { deflateRawBase64Sync, inflateRawBase64TextBounded } from "../../packages/device-link/src/nodeCompression";
import {
  createClient,
  createHost,
  createMobileRecovery,
} from "./clientHarness";

interface FrameAuthSpec {
  relayId: string;
  ownerPublicKey: string;
  certs: unknown[];
  host: { deviceId: string; seed: string };
  controller: { deviceId: string; seed: string };
  observer?: { deviceId: string; seed: string };
}

/**
 * 自建中转的设备签名(可选,由 run-interop 提供测试密钥):主机与控制端都核对全部对端帧,
 * 与 Desktop / Mobile 一致。任何绕过签名的发送路径都会让接收端丢帧、恢复流程超时。
 */
function frameAuthFor(spec: FrameAuthSpec, role: "host" | "controller" | "observer", rejected: string[]) {
  const auth = new RelayFrameAuthenticator({
    crypto: nodeRelayAuthCrypto,
    relayId: spec.relayId,
    deviceId: spec[role]!.deviceId,
    seed: spec[role]!.seed,
    ownerPublicKey: spec.ownerPublicKey,
  });
  auth.setCertificates(spec.certs);
  return () => ({
    peerChallenge: { session: auth, state: (deviceId: string) => auth.peerChallenge(deviceId) },
    sign: (frame: Parameters<RelayFrameAuthenticator["sign"]>[0]) => auth.sign(frame),
    verify: (frame: Readonly<Record<string, unknown>>) => {
      const verdict = auth.verify(frame);
      if (verdict !== "ok") rejected.push(`${String(frame.kind)}:${verdict}`);
      return verdict === "ok";
    },
  });
}

it("interoperates with an explicitly provisioned isolated relay and automatically reconnects", async () => {
  const url = process.env.CINDY_TEST_RELAY_URL;
  const hostToken = process.env.CINDY_TEST_HOST_TOKEN;
  const controllerToken = process.env.CINDY_TEST_CONTROLLER_TOKEN;
  if (!url || !hostToken || !controllerToken || hostToken === controllerToken) {
    throw new Error(
      "Provide a test relay URL and distinct test-device tokens for the same test account.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Test relay URL must be a valid ws(s) URL.");
  }
  if (
    !["ws:", "wss:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Test relay URL must be ws(s), without credentials, query or fragment.",
    );
  }
  // 官方测试 relay 用账号 access token(Bearer);自建中转用加入时拿到的设备凭证(CindyRelay)。
  const scheme = process.env.CINDY_TEST_AUTH_SCHEME ?? "Bearer";
  if (scheme !== "Bearer" && scheme !== "CindyRelay") {
    throw new Error("CINDY_TEST_AUTH_SCHEME must be Bearer or CindyRelay.");
  }
  const timing = {
    requestTimeoutMs: 10_000,
    pingIntervalMs: 5_000,
    transportRetryIntervalMs: 1_000,
    reconnectBaseMs: 500,
    reconnectMaxMs: 2_000,
  };
  const frameAuthSpec = process.env.CINDY_TEST_FRAME_AUTH
    ? (JSON.parse(process.env.CINDY_TEST_FRAME_AUTH) as FrameAuthSpec)
    : null;
  const rejected: string[] = [];
  // push-deflate-v1：两端都注入与 Desktop 相同的 Node 编解码，压缩推送经真实中转（含设备签名）送达。
  const transferCodec = {
    deflateRawBase64: (text: string, dictionary: string) => deflateRawBase64Sync(text, 4, dictionary).compressed.toString("base64"),
    inflateRawBase64: inflateRawBase64TextBounded,
  };
  const host = createClient(url, "interop-host", true, {
    transferCodec,
    token: hostToken,
    authorizationScheme: scheme,
    timing,
    frameAuth: frameAuthSpec ? frameAuthFor(frameAuthSpec, "host", rejected) : undefined,
  });
  const controller = createClient(url, "interop-controller", false, {
    transferCodec,
    token: controllerToken,
    authorizationScheme: scheme,
    timing,
    frameAuth: frameAuthSpec ? frameAuthFor(frameAuthSpec, "controller", rejected) : undefined,
  });
  const data = createHost(host.client);
  let recovery: ReturnType<typeof createMobileRecovery> | undefined;
  try {
    host.client.start();
    await vi.waitFor(() => expect(host.client.getStatus()).toBe("online"), {
      timeout: 10_000,
    });
    const hostId = host.client.getSelfDeviceId();
    if (!hostId) throw new Error("Test relay did not assign host identity");
    controller.client.start();
    await vi.waitFor(() => expect(controller.client.getStatus()).toBe("online"), { timeout: 10_000 });
    if (frameAuthSpec) {
      // 首次认证以关闭远控的手机为目标；不能借用会被 relay 拦截的 link-open。
      const received: unknown[] = [];
      const off = controller.client.onFrame(frame => {
        if (frame.kind === "push") received.push(frame.payload);
      });
      try {
        host.client.sendPush(controller.client.getSelfDeviceId()!, PLUGIN_SYNC_CHANNEL, { version: 1, type: "snapshot" });
        await vi.waitFor(() => expect(received).toEqual([
          { channel: PLUGIN_SYNC_CHANNEL, payload: { version: 1, type: "snapshot" } },
        ]), { timeout: 10_000 });
        const listing = await controller.client.invoke(hostId, { channel: "local-db:sessions:list", args: [] });
        expect(listing.ok).toBe(true);
        expect(data.received.some(frame => frame.kind === "link-open")).toBe(false);
      } finally { off(); }
    }
    // Authorization requests and replies remain signed and deliverable with control off.
    // They do not open a link or make ordinary invokes admissible.
    const consentFrames: unknown[] = [];
    const stopConsent = controller.client.onFrame(frame => {
      if (frame.kind === "push") consentFrames.push(frame.payload);
    });
    try {
      const request = { version: 1, kind: "request", id: "12345678-1234-1234-1234-123456789abc", purpose: "Download source", ttlMs: 45_000 };
      host.client.sendPush(controller.client.getSelfDeviceId()!, "device-link:remote-control-consent", request);
      await vi.waitFor(() => expect(consentFrames).toContainEqual({ channel: "device-link:remote-control-consent", payload: request }));
      await expect(host.client.invoke(controller.client.getSelfDeviceId()!, { channel: "maker:machine:status", args: [] }))
        .rejects.toMatchObject({ code: "REMOTE_DISABLED" });
    } finally { stopConsent(); }
    recovery = createMobileRecovery(controller.client, hostId);
    recovery.foreground();
    await vi.waitFor(
      () => expect(recovery!.state.completed).toBeGreaterThan(0),
      { timeout: 10_000 },
    );
    expect(controller.client.getSelfDeviceId()).not.toBe(hostId);
    // 链路已建立：较大的事件批走压缩形状，中转原样转发，控制端交给业务前还原。
    const batch = { sessionId: "fixture-session", events: Array.from({ length: 8 }, (_, i) => ({
      sessionId: "fixture-session", event: { type: "text", data: { text: `弱网流式正文 ${i} ✓`, isFinal: false } },
    })) };
    const pushes: unknown[] = [];
    const stopPushes = controller.client.onFrame(frame => {
      if (frame.kind === "push" && (frame.payload as { channel?: string }).channel === "maker:event:batch") pushes.push(frame.payload);
    });
    const wire: string[] = [];
    const socket = controller.sockets.at(-1)!;
    const onWire = (data: unknown) => wire.push(String(data));
    socket.on("message", onWire);
    try {
      host.client.sendPush(controller.client.getSelfDeviceId()!, "maker:event:batch", batch);
      await vi.waitFor(() => expect(pushes).toEqual([{ channel: "maker:event:batch", payload: batch }]), { timeout: 10_000 });
      expect(wire.some(frame => frame.includes("deflateBase64"))).toBe(true);
    } finally { stopPushes(); socket.off("message", onWire); }
    const before = recovery.state.completed;
    data.addMessage("interop-gap");
    controller.sockets.at(-1)!.terminate();
    await vi.waitFor(
      () => expect(recovery!.state.completed).toBeGreaterThan(before),
      { timeout: 10_000 },
    );
    expect(recovery.state.messages.map((message) => message.id)).toEqual([
      "m1",
      "interop-gap",
    ]);
    expect(controller.sockets.length).toBeGreaterThan(1);
    expect(rejected).toEqual([]);
  } finally {
    recovery?.close();
    data.close();
    controller.close();
    host.close();
  }
}, 40_000);

// Network integration: production clients and MCP operation/cache entry points,
// against a real signed self-hosted relay. Legacy endpoints retain their v1
// request/response contract; no historical binary or GUI is emulated here.
it.skipIf(!process.env.CINDY_TEST_OBSERVER_TOKEN)('interoperates across the SDK version matrix and isolates a second controller from held App polls', async () => {
  const url = process.env.CINDY_TEST_RELAY_URL!;
  const spec = JSON.parse(process.env.CINDY_TEST_FRAME_AUTH ?? 'null') as FrameAuthSpec | null;
  const observerToken = process.env.CINDY_TEST_OBSERVER_TOKEN;
  if (!spec?.observer || !observerToken) throw new Error('This SDK interop case requires the provisioned two-controller self-hosted relay');
  const rejected: string[] = [];
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const codec = {
    contentTag: hash,
    gzipBase64: (text: string) => gzipSync(Buffer.from(text)).toString('base64'),
    gunzipBase64: (text: string, maxChars: number) => gunzipSync(Buffer.from(text, 'base64'), { maxOutputLength: maxChars }).toString(),
  };
  const opts = { authorizationScheme: 'CindyRelay' as const, transferCodec: codec, timing: { requestTimeoutMs: 10_000, pingIntervalMs: 5_000 } };
  const host = createClient(url, 'sdk-host', true, { ...opts, token: process.env.CINDY_TEST_HOST_TOKEN, frameAuth: frameAuthFor(spec, 'host', rejected) });
  const viewer = createClient(url, 'sdk-viewer', false, { ...opts, token: process.env.CINDY_TEST_CONTROLLER_TOKEN, frameAuth: frameAuthFor(spec, 'controller', rejected) });
  const other = createClient(url, 'sdk-other', false, { ...opts, token: observerToken, frameAuth: frameAuthFor(spec, 'observer', rejected) });
  const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  const sdk = { source: readFileSync(requireDesktop.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8') };
  let serial = 0;
  let modernHost = true;
  const active = new Map<string, string>();
  const polls = new Map<string, () => void>();
  const replies: McpAppDocument[] = [];
  const receivedActions: Array<{ caller: string; channel: string }> = [];
  const api = {
    open: async (caller: string, _session: string, _card: string, _context: unknown, _openId?: string, resolveSdkRef?: Parameters<McpAppsHost['open']>[5]) => {
      const viewId = `view-${++serial}`; active.set(viewId, caller);
      const sdkRef = resolveSdkRef?.(sdk);
      return { viewId, html: '<!doctype html><p>App', csp: "default-src 'none'", prefersBorder: true, ...(sdkRef ? { sdkRef } : { sdk }) };
    },
    teardown: async (caller: string, _session: string, viewId: string) => {
      if (active.get(viewId) !== caller) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
      polls.get(viewId)?.(); polls.delete(viewId); active.delete(viewId);
    },
    poll: async (caller: string, _session: string, viewId: string) => {
      if (active.get(viewId) !== caller) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
      return new Promise(resolve => polls.set(viewId, () => resolve([])));
    },
  } as unknown as McpAppsHost;
  // Frozen legacy open contract: normal z.object strips unknown optional fields.
  const legacyOpen = z.object({ op: z.literal('open'), clientId: z.string(), openId: z.string().optional(), context: z.record(z.string(), z.unknown()).default({}) });
  const off = host.client.onFrame(frame => {
    if (!frame.src || !frame.id) return;
    if (frame.kind === 'link-open') {
      host.client.sendLinkAccept(frame.src, frame.id, { appVersion: 'fixture', allowlistHash: 'fixture' }); return;
    }
    if (frame.kind !== 'invoke') return;
    const { channel, args } = frame.payload as InvokePayload;
    const caller = frame.src; const id = frame.id;
    void (async () => {
      try {
        let result: unknown;
        if (channel === 'maker:mcp-apps:v1') {
          let input = args[1] as Record<string, unknown>;
          if (!modernHost && input.op === 'open') input = legacyOpen.parse(input);
          result = await handleMcpAppOperation(api, caller, args[0] as string, input);
          if (input.op === 'open') replies.push(result as McpAppDocument);
        } else {
          receivedActions.push({ caller, channel }); result = { accepted: true };
        }
        host.client.sendInvokeResult(caller, id, { ok: true, result });
      } catch {
        host.client.sendInvokeResult(caller, id, { ok: false, error: { code: 'IPC_ERROR', message: 'fixture operation failed' } });
      }
    })();
  });
  try {
    for (const connection of [host, viewer, other]) connection.client.start();
    await vi.waitFor(() => { for (const connection of [host, viewer, other]) expect(connection.client.getStatus()).toBe('online'); }, { timeout: 10_000 });
    const hostId = host.client.getSelfDeviceId()!;
    for (const connection of [viewer, other]) await connection.client.openLink(hostId, { controllerName: 'Viewer', protocolVersion: 1, appVersion: 'fixture' });
    const send = async (input: Record<string, unknown>) => {
      const result = await viewer.client.invoke(hostId, { channel: 'maker:mcp-apps:v1', args: ['task', input] }, undefined, { noResultCache: input.op === 'open' || input.op === 'poll' });
      if (!result.ok) throw new Error(result.error.code);
      return result.result;
    };
    for (const executor of [false, true]) for (const control of [false, true]) {
      modernHost = executor;
      const cache = new McpAppSdkCache(hash);
      const owner = {};
      const start = replies.length;
      for (let i = 0; i < 2; i++) {
        const input = { op: 'open', clientId: 'card', openId: `attempt-${serial}`, context: {} };
        const doc = (control ? await cache.open(owner, hostId, input, send, () => {}) : await send(input)) as McpAppDocument;
        expect(doc.sdk).toEqual(sdk);
        await send({ op: 'teardown', viewId: doc.viewId });
      }
      const [cold, warm] = replies.slice(start);
      expect(cold.sdk).toEqual(sdk);
      expect(Boolean(warm.sdkRef)).toBe(executor && control);
      expect(Boolean(warm.sdk)).toBe(!(executor && control));
      const bytes = (doc: McpAppDocument) => ({ raw: Buffer.byteLength(JSON.stringify(doc)),
        encodedPayload: Buffer.byteLength(JSON.stringify(encodeInvokeResultTransfer({ gzip: 1 }, { ok: true, result: doc }, codec))) });
      console.log('[mcp-sdk-interop]', JSON.stringify({ executor: executor ? 'new' : 'legacy-contract', viewer: control ? 'new' : 'legacy-contract', cold: bytes(cold), warm: bytes(warm) }));
    }
    modernHost = true;
    for (const release of ['teardown', 'background']) {
      const views: string[] = [];
      const pending: Promise<unknown>[] = [];
      for (let i = 0; i < 4; i++) {
        const doc = await send({ op: 'open', clientId: `poll-${i}`, openId: `poll-${serial}`, context: {} }) as McpAppDocument;
        views.push(doc.viewId);
        pending.push(send({ op: 'poll', viewId: doc.viewId, after: 0 }).catch(error => error));
      }
      await vi.waitFor(() => expect(polls.size).toBe(4));
      const statuses = [...other.statuses];
      const hostSockets = host.sockets.length;
      const otherSockets = other.sockets.length;
      for (const channel of ['maker:send', 'maker:answer', 'maker:stop']) {
        await expect(other.client.invoke(hostId, { channel, args: ['other-task'] })).resolves.toMatchObject({ ok: true, result: { accepted: true } });
        expect(polls.size).toBe(4); // B completes while all A reads are still held.
      }
      if (release === 'teardown') for (const viewId of views) await send({ op: 'teardown', viewId });
      else { viewer.client.stop(); for (const resolve of polls.values()) resolve(); polls.clear(); }
      await Promise.all(pending);
      await expect(other.client.invoke(hostId, { channel: 'maker:send', args: ['other-task'] })).resolves.toMatchObject({ ok: true });
      expect(other.client.getStatus()).toBe('online');
      expect(other.statuses).toEqual(statuses);
      expect(host.sockets).toHaveLength(hostSockets);
      expect(other.sockets).toHaveLength(otherSockets);
    }
    expect(receivedActions).toHaveLength(8);
    expect(receivedActions.every(action => action.caller === other.client.getSelfDeviceId())).toBe(true);
    expect(rejected).toEqual([]);
  } finally {
    for (const resolve of polls.values()) resolve();
    off(); viewer.close(); other.close(); host.close();
  }
}, 40_000);
