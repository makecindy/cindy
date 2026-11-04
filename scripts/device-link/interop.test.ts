import { expect, it, vi } from "vitest";
import { nodeRelayAuthCrypto } from "../../packages/device-link/src/nodeRelayCrypto";
import { RelayFrameAuthenticator } from "../../packages/device-link/src/selfHostedRelayAuth";
import { PLUGIN_SYNC_CHANNEL } from "../../packages/device-link/src/pluginSyncProtocol";
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
}

/**
 * 自建中转的设备签名(可选,由 run-interop 提供测试密钥):主机与控制端都核对全部对端帧,
 * 与 Desktop / Mobile 一致。任何绕过签名的发送路径都会让接收端丢帧、恢复流程超时。
 */
function frameAuthFor(spec: FrameAuthSpec, role: "host" | "controller", rejected: string[]) {
  const auth = new RelayFrameAuthenticator({
    crypto: nodeRelayAuthCrypto,
    relayId: spec.relayId,
    deviceId: spec[role].deviceId,
    seed: spec[role].seed,
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
  const host = createClient(url, "interop-host", true, {
    token: hostToken,
    authorizationScheme: scheme,
    timing,
    frameAuth: frameAuthSpec ? frameAuthFor(frameAuthSpec, "host", rejected) : undefined,
  });
  const controller = createClient(url, "interop-controller", false, {
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
    recovery = createMobileRecovery(controller.client, hostId);
    recovery.foreground();
    await vi.waitFor(
      () => expect(recovery!.state.completed).toBeGreaterThan(0),
      { timeout: 10_000 },
    );
    expect(controller.client.getSelfDeviceId()).not.toBe(hostId);
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
