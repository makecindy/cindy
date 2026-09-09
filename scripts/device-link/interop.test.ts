import { expect, it, vi } from "vitest";
import {
  createClient,
  createHost,
  createMobileRecovery,
} from "./clientHarness";

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
  const timing = {
    requestTimeoutMs: 10_000,
    pingIntervalMs: 5_000,
    transportRetryIntervalMs: 1_000,
    reconnectBaseMs: 500,
    reconnectMaxMs: 2_000,
  };
  const host = createClient(url, "interop-host", true, {
    token: hostToken,
    timing,
  });
  const controller = createClient(url, "interop-controller", false, {
    token: controllerToken,
    timing,
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
    recovery = createMobileRecovery(controller.client, hostId);
    controller.client.start();
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
  } finally {
    recovery?.close();
    data.close();
    controller.close();
    host.close();
  }
}, 40_000);
