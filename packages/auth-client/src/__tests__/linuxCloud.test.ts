// 测试价值
// - 生产入口与可观察结果：cloudGuestAuthorization（Linux 云主机首次开机报到），断言何时停止、何时继续重试，
//   以及 cloudGuestFailureReason 写进日志的原因与状态码。
// - Bug／规则依据：2026-11-27 正式服云主机报到失败后日志只有「Cloud guest sign-in did not complete」，
//   看不出原因；报到服务暂时不可用超过 10 分钟后，机器停在登录页直到重启。
// - 现有覆盖缺口：Desktop 的 authColdStartRecovery 测试把 cloudGuestAuthorization 整个替换掉，本模块此前没有测试。
// - 最小失败输入：报到接口持续返回 503 超过 10 分钟后恢复；或返回 403。
// - tier：unit（内存凭证存储、注入的 fetch、假时钟，不做真实网络或等待）。
// - 实测耗时：单独运行约 0.2 秒（4 条用例）。
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudGuestAuthorization, cloudGuestFailureReason } from "../linuxCloud.mjs";

const authBase = "https://auth.example.invalid/";

function setup(enroll: (call: number) => number) {
  // Without a protocol the guest proves itself with the instance metadata, which is fetched directly.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("metadata")));
  const guest = {
    requestId: randomUUID(),
    receipt: "r".repeat(43),
    membershipId: "member",
    organizationId: "org",
  };
  const saved = new Map<string, string>();
  const store = {
    read: (key: string) => saved.get(key) ?? null,
    write: (key: string, value: string) => void saved.set(key, value),
    remove: (key: string) => void saved.delete(key),
    withLock: <T,>(task: () => Promise<T>) => task(),
  };
  let calls = 0;
  const serviceFetch = vi.fn(async () => {
    const status = enroll(++calls);
    return status === 200
      ? Response.json({ membershipId: "member", organizationId: "org", code: "grant" })
      : new Response(null, { status });
  });
  // The verifier lookup touches the real file system first, so wait for the first request before moving the clock.
  const started = () => vi.waitFor(() => expect(calls).toBeGreaterThan(0));
  return { guest, store, serviceFetch: serviceFetch as unknown as typeof fetch, calls: () => calls, started };
}

describe("cloudGuestAuthorization", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops at once when the service refuses the guest and reports why", async () => {
    const h = setup(() => 403);
    const failure = cloudGuestAuthorization(h.guest, "device", authBase, h.store, h.serviceFetch, { persistent: true });
    const error = await failure.catch((e: unknown) => e);
    expect(cloudGuestFailureReason(error)).toEqual({ reason: "refused", status: 403 });
    expect(h.calls()).toBe(1);
  });

  it("gives up after the first-boot window unless asked to keep trying", async () => {
    const h = setup(() => 503);
    const failure = cloudGuestAuthorization(h.guest, "device", authBase, h.store, h.serviceFetch).catch((e: unknown) => e);
    await h.started();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cloudGuestFailureReason(await failure)).toEqual({ reason: "unavailable", status: 503 });
  });

  it("keeps a signed-out guest trying with a backoff once the service is back", async () => {
    // Down for 15 minutes: the 10-minute window passes, then the slower retries pick the service up again.
    let up = false;
    const h = setup(() => (up ? 200 : 503));
    const grant = cloudGuestAuthorization(h.guest, "device", authBase, h.store, h.serviceFetch, { persistent: true });
    await h.started();
    await vi.advanceTimersByTimeAsync(600_000);
    const inWindow = h.calls();
    await vi.advanceTimersByTimeAsync(300_000);
    // 30 s, 60 s, 120 s: three attempts in the next five minutes instead of sixty.
    expect(h.calls() - inWindow).toBeLessThanOrEqual(4);
    up = true;
    await vi.advanceTimersByTimeAsync(240_000);
    await expect(grant).resolves.toMatchObject({ code: "grant" });
  });

  it("ends a persistent retry when the caller no longer needs it", async () => {
    let stop = false;
    const h = setup(() => 503);
    const failure = cloudGuestAuthorization(h.guest, "device", authBase, h.store, h.serviceFetch, {
      persistent: true,
      stopped: () => stop,
    }).catch((e: unknown) => e);
    await h.started();
    await vi.advanceTimersByTimeAsync(700_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(cloudGuestFailureReason(await failure)).toEqual({ reason: "stopped" });
  });
});
