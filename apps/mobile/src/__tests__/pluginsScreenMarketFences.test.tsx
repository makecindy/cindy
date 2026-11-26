// @vitest-environment jsdom
import { fixture, root, element, row, openDetail, transportSend, marketWire, type MarketWireRequest, marketItem, demoConsent, demoGhost, approveOnPhone, marketPage, settle, openMarket, shownMarket, hostError, attributed, managementSnapshot } from "./pluginsScreenHarness";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import * as expoCrypto from "expo-crypto";
import PluginsScreen from "@/plugins/PluginsScreen";
import { __retainedForTests, retryPluginCheckReadback, usePluginCheckConclusions, usePluginManagement, usePluginPendingChecks } from "@/plugins/usePluginManagement";
import { PluginPendingChecksSheet } from "@/plugins/PluginPendingChecksSheet";
import { PluginUiEnablePrompt } from "@/plugins/PluginUiEnablePrompt";
import { PluginManagementConfirmation } from "@/plugins/PluginManagementConfirmation";
import { pluginManagementSlotFor, pluginOperationHold } from "@/plugins/pluginManagementSlot";
/**
 * Proven as this install: concluded as done from the computer's facts. Nothing opens a result's instance:
 * the list of checks says how it ended and leads to the installed list ("Go to Installed").
 */
const provenDemo = () => __retainedForTests.conclusions().some((conclusion) => (conclusion.result === "succeeded" || conclusion.result === "installed")
  && conclusion.readback === "verified");
// The plugins page's market read fences and lost-receipt facts (the order matrices); the rest of the page's cases are in
// pluginsScreen.test.tsx, and the success-read cases in pluginsScreenSuccessRead.test.tsx. Split to keep each file within
// the unit budget; all share pluginsScreenHarness.tsx.

/* 测试价值（PR #12684 第五轮评审：读取围栏统一与回执过期后的判定绑定，2026-11-25）
 * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client/controller；观察真正离开设备互联的请求、
 *   能力探测状态、行内状态与是否打开已装实例。
 * - 依据：维护者 03:10 第 1 条（NOT_FOUND 后只用本次新读到的快照与实例，核对市场详情读取代次）；Codex：卸载后的发送围栏、
 *   同 scope 能力探测代次、搜索未稳定时的滚动续页；server-channel-review.md 无消费者的请求不发。
 * - 缺口：此前回包落地有围栏，排队中的请求在发出前没有；探测只比较 scope；loadMore 不看未去抖的搜索词；
 *   NOT_FOUND 后可用旧快照结束核实。
 * - 最小失败输入：排队中卸载；A 的第一次探测在第二次成功后才超时；去抖期间滚动；NOT_FOUND 后新快照挂起；旧详情晚到。
 * - tier: unit（jsdom，内存 Host）。
 */
describe("market read fences and lost-receipt facts", () => {
  type Request = { device: string; actionId?: string; input?: any; resourceRef?: any };
  // Like the real link queue: the client's last check (preSend) runs only when the request actually leaves.
  function queuedWire(respond: (request: Request) => unknown, wait: (request: Request | "manifest", device: string) => Promise<void> | undefined) {
    const sent: Request[] = [];
    fixture.realManagement = true;
    fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
      if (channel.endsWith(":manifest")) return transportSend(options,
        () => ({ protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] }),
        () => wait("manifest", device));
      const envelope = args?.[0] ?? {};
      const request = { device, actionId: envelope.actionId, input: envelope.input, resourceRef: envelope.resourceRef };
      // `sent` records what passed the last check before the write (what actually reached the wire).
      return transportSend(options, async () => { sent.push(request); return { effects: [], result: await respond(request) }; },
        () => wait(request, device));
    });
    return sent;
  }
  const deferred = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };

  it("does not send queued catalog and count reads after the plugins page unmounts", async () => {
    const gate = deferred();
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : { ...marketPage([marketItem("demo", "Demo")]), counts: null },
    (request) => request !== "manifest" && request.input?.read === "catalog" ? gate.promise : undefined);
    await openMarket();
    await act(async () => root.render(null));
    await act(async () => { gate.release(); });
    await settle(10);
    expect(sent.filter((request) => request.input?.read === "catalog")).toEqual([]);
  });
  /* 测试价值（独立复核剩余项 1–5；自查发现的读取取消、卸载与重探问题）
   * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client / controller，只替换传输；观察发出的请求、
   *   探测与详情的状态、是否重新打开详情。
   * - 依据：读取围栏关闭（离开市场、失焦、电脑离开、进后台、卸载）造成的结束是取消，不是失败；页面卸载后安装路径不再
   *   发请求也不打开详情；电脑重新在线时重探一次；装好后旧详情回包不重新打开详情。
   * - 最小失败输入：每条一次。tier: unit。
   */
  it("treats a market detail read cancelled by leaving the screen as interrupted, and reads it again on return", async () => {
    fixture.width = 900; // the market list stays beside its detail
    const item = marketItem("demo", "Demo");
    const gate = deferred();
    let held = true;
    queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : request.actionId === "management:market-detail" ? { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }
        : marketPage([item]),
    (request) => request !== "manifest" && request.actionId === "management:market-detail" && held ? gate.promise : undefined);
    await openMarket();
    await act(async () => shownMarket().openDetail(item));
    await settle(6);
    // A notification or a deep link takes the screen away while the read is queued.
    fixture.focused = false;
    await act(async () => root.render(createElement(PluginsScreen)));
    held = false;
    await act(async () => { gate.release(); });
    await settle(10);
    expect(shownMarket().detail).toMatchObject({ failed: false });
    fixture.focused = true;
    await act(async () => root.render(createElement(PluginsScreen)));
    await settle(14);
    expect(shownMarket().detail).toMatchObject({ failed: false, loading: false, detail: expect.objectContaining({ pluginId: item.pluginId }) });
  });
  it("forgets a probe cancelled by leaving the screen instead of recording it as failed", async () => {
    fixture.width = 900;
    const gate = deferred();
    let held = true;
    queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([marketItem("demo", "Demo")]),
      (request) => request !== "manifest" && request.input?.read === "capabilities" && held ? gate.promise : undefined);
    await openMarket();
    fixture.focused = false;
    await act(async () => root.render(createElement(PluginsScreen)));
    held = false;
    await act(async () => { gate.release(); });
    await settle(10);
    fixture.focused = true;
    await act(async () => root.render(createElement(PluginsScreen)));
    await settle(14);
    expect(shownMarket().status).not.toBe("failed");
    expect(shownMarket().canInstall).toBe(true);
  });
  it("probes again when an outdated computer comes back online", async () => {
    let paging = false;
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: paging } : marketPage([marketItem("demo", "Demo")]), () => undefined);
    await openMarket();
    expect(shownMarket().canInstall).toBe(false);
    // The person updates Cindy on that computer; it restarts and comes back.
    paging = true;
    fixture.offlineDevices.add("mac");
    await act(async () => root.render(createElement(PluginsScreen)));
    fixture.offlineDevices.delete("mac");
    await act(async () => root.render(createElement(PluginsScreen)));
    await settle(14);
    expect(sent.filter((request) => request.input?.read === "capabilities").length).toBeGreaterThanOrEqual(2);
    expect(shownMarket().canInstall).toBe(true);
  });
  it("sends nothing for an install whose page was left while its detail read was queued", async () => {
    const item = marketItem("demo", "Demo");
    const gate = deferred();
    let hold = false;
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : request.actionId === "management:market-detail" ? { ...item, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } }
        : request.actionId === "management:snapshot" && request.input?.read === "installed" ? managementSnapshot(false) : marketPage([item]),
    (request) => request !== "manifest" && request.actionId === "management:market-detail" && hold ? gate.promise : undefined);
    await openMarket();
    hold = true;
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(10);
    const before = sent.length;
    await act(async () => root.render(null));
    await act(async () => { gate.release(); });
    await settle(14);
    expect(sent.slice(before).filter((request) => request.actionId === "management:market-detail" || request.actionId === "management:begin")).toEqual([]);
    expect(fixture.read).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ id: "_root__demo" }), expect.anything(), expect.anything());
  });
  it("does not reopen a market detail whose reply lands after the install completed", async () => {
    const item = marketItem("demo", "Demo");
    const gate = deferred();
    let holdDetail = false, installed = false, details = 0;
    queuedWire((request) => {
      if (request.input?.read === "capabilities") return { catalogPaging: true };
      if (request.actionId === "management:market-detail") return { ...item, installState: installed ? "installed" : "not-installed", ...attributed(installed), manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" } };
      // The read-back after the install fails, so the record cannot say it is done.
      if (request.actionId === "management:snapshot" && request.input?.read === "installed") {
        if (installed) throw new Error("[TIMEOUT] read-back timed out");
        return managementSnapshot(false);
      }
      if (request.actionId === "management:begin") { installed = true; return { operationId: request.input.operationId, phase: "succeeded" }; }
      return marketPage([item]);
    }, (request) => {
      if (request === "manifest" || request.actionId !== "management:market-detail") return undefined;
      // Only the detail the person opened is held; the install's own reads go through.
      details += 1;
      return holdDetail && details === 1 ? gate.promise : undefined;
    });
    fixture.width = 900;
    await openMarket();
    // The person opened the plugin's detail (its read still in flight), then installed from the row.
    holdDetail = true;
    await act(async () => shownMarket().openDetail(item));
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(30);
    expect(shownMarket().installBusy).toBe(false);
    await act(async () => { gate.release(); });
    await settle(20);
    // The detail the person opened stays theirs (nothing closes it for them). The read of it that was out before the
    // install is dropped: the detail was read again once the install was known, so it does not offer it again.
    expect(shownMarket().detail?.item.pluginId).toBe(item.pluginId);
    expect(details).toBeGreaterThan(1);
  });
  it("does not send the paging probe when the manifest read finishes after the page unmounted", async () => {
    const gate = deferred();
    const sent = queuedWire(() => ({ catalogPaging: true }), (request) => request === "manifest" ? gate.promise : undefined);
    await act(async () => root.render(createElement(PluginsScreen)));
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle();
    await act(async () => root.render(null));
    await act(async () => { gate.release(); });
    await settle(10);
    expect(sent.filter((request) => request.input?.read === "capabilities")).toEqual([]);
  });
  it("keeps a newer successful probe when an older probe for the same computer fails later", async () => {
    fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
    const firstMacProbe = deferred();
    let macManifests = 0;
    fixture.realManagement = true;
    fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
      if (channel.endsWith(":manifest")) {
        if (device === "mac" && ++macManifests === 1) { await firstMacProbe.promise; throw new Error("[TIMEOUT] remote invoke timed out"); }
        options?.preSend?.(); options?.onRequestWritten?.();
        return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
      }
      options?.preSend?.(); options?.onRequestWritten?.();
      const input = args?.[0]?.input;
      return { effects: [], result: input?.read === "capabilities" ? { catalogPaging: true } : marketPage([marketItem(`${device}-demo`, `${device} demo`)]) };
    });
    await openMarket();
    expect(shownMarket()).toMatchObject({ status: "loading", target: { deviceId: "mac" } });
    await act(async () => shownMarket().selectDevice("pc"));
    await settle();
    await act(async () => shownMarket().selectDevice("mac"));
    await settle(14);
    expect(shownMarket()).toMatchObject({ status: "ready", items: [expect.objectContaining({ name: "mac demo" })] });
    await act(async () => { firstMacProbe.release(); });
    await settle(10);
    expect(shownMarket().status).toBe("ready");
  });
  it("does not load the next page of the old search while the new search text is not debounced yet", async () => {
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : { ...marketPage([marketItem("demo", "Demo")]), nextCursor: "cursor-1", counts: null }, () => undefined);
    await openMarket();
    expect(shownMarket()).toMatchObject({ hasMore: true });
    await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "rota" } }));
    await act(async () => shownMarket().loadMore());
    await settle();
    expect(sent.filter((request) => request.input?.query?.cursor)).toEqual([]);
  });

  // Maintainer review 03:54 #3: a probe cancelled by leaving the market must not leave the market stuck at "failed".
  it("probes again when coming back after leaving the market while the probe was queued", async () => {
    const gate = deferred();
    let firstManifest = true;
    queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true } : marketPage([marketItem("demo", "Demo")]),
      (request) => {
        if (request === "manifest" && firstManifest) { firstManifest = false; return gate.promise; }
        return undefined;
      });
    await openMarket();
    await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
    await act(async () => { gate.release(); });
    await settle(10);
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle(14);
    expect(shownMarket()).toMatchObject({ status: "ready", items: [expect.objectContaining({ name: "Demo" })] });
  });
  // Maintainer review 03:54 #3: a next page queued by scrolling is checked again when it actually leaves.
  it("drops a queued next page when a new search is typed before it is sent", async () => {
    const gate = deferred();
    const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
      : { ...marketPage([marketItem("demo", "Demo")]), nextCursor: "cursor-1", counts: null },
    (request) => request !== "manifest" && request.input?.query?.cursor ? gate.promise : undefined);
    await openMarket();
    await act(async () => shownMarket().loadMore());
    await settle();
    await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "rota" } }));
    await act(async () => { gate.release(); });
    await settle(10);
    expect(sent.filter((request) => request.input?.query?.cursor)).toEqual([]);
  });

  // Codex review (3200468): search A's first page and its count read wait in the Device Link queue; the search
  // becomes B (debounced). The first page skipped the follow-up check and counts checked only their cache entry, so
  // both A reads still went out after B was shown.
  it("drops queued first-page and count reads of a search that was replaced before they were sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const gate = deferred();
      const sent = queuedWire((request) => request.input?.read === "capabilities" ? { catalogPaging: true }
        : { ...marketPage([marketItem("demo", "Demo")]), counts: null },
      (request) => request !== "manifest" && request.input?.read === "catalog" && request.input?.query?.query === "alpha" ? gate.promise : undefined);
      await openMarket();
      const type = async (text: string) => {
        await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await settle(10);
      };
      await type("alpha");
      await type("beta");
      expect(sent.some((request) => request.input?.query?.query === "beta")).toBe(true);
      await act(async () => { gate.release(); });
      await settle(10);
      expect(sent.filter((request) => request.input?.query?.query === "alpha")).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  // Maintainer review 03:10 #1: a snapshot read before NOT_FOUND must not settle the result, and a market
  // detail from an earlier verification must not open an instance.
  const item = marketItem("demo", "Demo");
  const demoManifest = { schemaVersion: 3, id: "demo", name: "Demo", version: "1" };
  it("waits for the snapshot read after NOT_FOUND instead of settling from an earlier one", async () => {
    let installed = false, receiptGone = false;
    const snapshotGate = deferred();
    let holdSnapshot = false;
    const sent = queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(installed);
        case "management:market-detail": return { ...item, installState: installed ? "conflict" : "not-installed", manifest: demoManifest };
        // The install is accepted and keeps running on the computer.
        case "management:begin": installed = true; return { operationId: request.input.operationId, phase: "running" };
        case "management:operation":
          if (receiptGone) throw hostError("NOT_FOUND");
          return { operationId: request.input.operationId, phase: "running" };
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (holdSnapshot && request !== "manifest" && request.actionId === "management:snapshot" && request.input?.read === "installed") {
        holdSnapshot = false;
        return snapshotGate.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    expect(fixture.props.get("confirmation").state.outcome).toBe("running");
    // While the operation runs, a plugin-change refresh puts the same-id instance into the controller's snapshot.
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle();
    expect(shownMarket()).toMatchObject({ installBusy: true });
    receiptGone = true;
    holdSnapshot = true;
    const detailsBefore = sent.filter((request) => request.actionId === "management:market-detail").length;
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    // NOT_FOUND arrived but the fresh snapshot is still being read: nothing is concluded yet.
    expect(shownMarket()).toMatchObject({ installBusy: true });
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    expect(sent.filter((request) => request.actionId === "management:market-detail")).toHaveLength(detailsBefore);
    // Meanwhile the instance was removed on the computer; the fresh facts decide.
    installed = false;
    await act(async () => { snapshotGate.release(); });
    await settle(14);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
    expect(provenDemo()).toBe(false);
  });
  // Maintainer review 03:54 #1 (a second "Check result" while the first round is out). Since controller rule ④ (contract
  // V2.10) a round settles only from its own installed snapshot, read inside that round's lookup (no market detail
  // after NOT_FOUND), so the round lasts until its facts land: a second tap meanwhile starts no parallel round (no
  // second lookup is sent), and the first round settles from its own facts, whatever they show. The earlier order
  // (round 1's detail landing after round 2 began) can no longer occur. Tier: unit/jsdom.
  it.each([["show the plugin", true], ["show it gone", false]] as const)("a second Check result while the first round's facts are out waits for that round: they %s", async (_name, present) => {
    let verifying = false, heldFirst = false;
    const firstFacts = deferred();
    const sent = queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(verifying && present);
        case "management:market-detail": return { ...item, installState: "not-installed", manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": verifying = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (request === "manifest" || !verifying || heldFirst) return undefined;
      if (request.actionId === "management:snapshot" && request.input?.read === "installed") { heldFirst = true; return firstFacts.promise; }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    const details = () => sent.filter((request) => request.actionId === "management:market-detail").length;
    const detailsBefore = details();
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    expect(heldFirst).toBe(true);
    const lookups = () => sent.filter((request) => request.actionId === "management:operation").length;
    const before = lookups();
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    // Still the first round: nothing settled, no second lookup sent.
    expect(lookups()).toBe(before);
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    await act(async () => { firstFacts.release(); });
    await settle(20);
    expect(provenDemo()).toBe(present);
    if (!present) expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
    // Settled from the installed snapshot alone (controller rule ④): no market detail is read after NOT_FOUND.
    expect(details()).toBe(detailsBefore);
    expect(sent.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
  });

  // Maintainer review 03:54 #2: the snapshot read after NOT_FOUND (A) is replaced by a later plugin-change read (B).
  it("settles from the newer snapshot when the read after NOT_FOUND is replaced and returns last", async () => {
    let instancePresent = false;
    const readA = deferred();
    let holdNext = false;
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          // A answers with the state at the time it was sent (before the instance appeared).
          return managementSnapshot(instancePresent && !(request as any).sentBeforeInstance);
        case "management:market-detail": return { ...item, installState: instancePresent ? "installed" : "not-installed", ...(instancePresent ? { installedOperationId: "screen-operation", installedOperationAttribution: "self" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (holdNext && request !== "manifest" && request.actionId === "management:snapshot" && request.input?.read === "installed") {
        holdNext = false;
        (request as any).sentBeforeInstance = true;
        return readA.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    holdNext = true;
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(6);
    // B: a plugin-change refresh starts after A and returns first, showing the plugin installed.
    instancePresent = true;
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle(6);
    await act(async () => { readA.release(); });
    await settle(14);
    expect(shownMarket().rowState(item)).not.toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
    expect(provenDemo()).toBe(true);
  });
  // Maintainer review 04:20: A (read after NOT_FOUND) is held; refresh B lands showing nothing; a newer refresh C is
  // still in flight when A returns. B was replaced by C, so it must not conclude "not on this computer".
  it("waits for the newest installed read when the facts after NOT_FOUND are replaced twice", async () => {
    const readA = deferred(), readC = deferred();
    let hold: "A" | "C" | null = null, began = false;
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          // A and B answer without the plugin; C answers with it installed.
          return managementSnapshot((request as any).read === "C");
        case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation", installedOperationAttribution: "self" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (hold && request !== "manifest" && request.actionId === "management:snapshot" && request.input?.read === "installed") {
        const which = hold;
        hold = null;
        (request as any).read = which;
        return which === "A" ? readA.promise : readC.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    hold = "A";
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(6);
    // B: a plugin-change refresh lands with an empty list.
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle(6);
    // C: a newer refresh is sent and stays in flight; then A returns.
    hold = "C";
    await act(async () => { void fixture.props.get("confirmation").controller.refresh(); });
    await settle(6);
    expect(hold).toBeNull();
    await act(async () => { readA.release(); });
    await settle(14);
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    expect(provenDemo()).toBe(false);
    // C lands with the plugin installed: the result follows the newest facts. This row had ended by then (its check
    // carried on), so the page does not move for it: it is proven and listed at the top.
    await act(async () => { readC.release(); });
    await settle(14);
    expect(__retainedForTests.conclusions()).toEqual([expect.objectContaining({ result: "installed", readback: "verified" })]);
  });
  // Maintainer review 04:20: a newer installed snapshot replaces the facts, so the older facts must not settle the result
  // (since controller rule ④ the facts are the installed snapshot itself; no market detail is read on them).
  it("drops facts read after NOT_FOUND that a newer installed snapshot replaced", async () => {
    const heldFacts = deferred();
    let began = false, present = true, holdFacts = false;
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(began && present);
        case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation", installedOperationAttribution: "self" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (holdFacts && request !== "manifest" && request.actionId === "management:snapshot" && request.input?.read === "installed") {
        holdFacts = false;
        return heldFacts.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    holdFacts = true;
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    // The read after NOT_FOUND (it shows the same-id instance, this phone's ①) is in flight. Then the instance is
    // removed and a plugin-change refresh lands with the newer facts.
    expect(holdFacts).toBe(false);
    present = false;
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle(14);
    await act(async () => { heldFacts.release(); });
    await settle(14);
    expect(provenDemo()).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
  });
  // Maintainer review 05:04: facts settle a result only while they come from the newest installed read issued.
  // Instead of hand-picked orders, run every order of: A (read after NOT_FOUND) returns, a plugin-change refresh B
  // is sent, B returns (B is always sent before it returns). A shows the same-id instance. The result is judged from
  // the installed read's own records, so no market detail is read for it (contract rule ④; asserted in every order):
  // the orders that used to interleave that detail's reply are the same runs now and are no longer listed.
  const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
    : items.flatMap((first, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
  type Step = "releaseA" | "sendB" | "releaseB";
  const orders = permutations<Step>(["releaseA", "sendB", "releaseB"])
    .filter((order) => order.indexOf("sendB") < order.indexOf("releaseB"));
  describe.each([["B still shows the instance", true], ["B shows it removed", false]])("every reply order when %s", (_case, bPresent) => {
    it.each(orders.map((order) => [order.join(" → "), order] as const))("settles only on the newest installed read: %s", async (_label, order) => {
      const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
      const gate = (label: string) => {
        if (!gates.has(label)) { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); gates.set(label, { promise, release }); }
        return gates.get(label)!;
      };
      let began = false, checking = false, sentA = false, sentB = false, detailReads = 0, bIssued = false, bReturned = false;
      queuedWire((request) => {
        switch (request.actionId) {
          case "management:snapshot": {
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") return marketPage([item]);
            const label = (request as any).label;
            if (label === "B") bReturned = true;
            return managementSnapshot(began && (label === "A" ? true : label === "B" || bReturned ? bPresent : true));
          }
          case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation", installedOperationAttribution: "self" } : {}), manifest: demoManifest };
          case "management:begin": return demoConsent(request);
          case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
          case "management:operation": throw hostError("NOT_FOUND");
          default: throw new Error("unexpected " + request.actionId);
        }
      }, (request) => {
        if (request === "manifest" || !checking) return undefined;
        if (request.actionId === "management:snapshot" && request.input?.read === "installed") {
          if (!sentA) { sentA = true; (request as any).label = "A"; return gate("A").promise; }
          if (bIssued && !sentB) { sentB = true; (request as any).label = "B"; return gate("B").promise; }
        }
        if (request.actionId === "management:market-detail") detailReads += 1;
        return undefined;
      });
      await openMarket();
      await act(async () => shownMarket().install(shownMarket().items[0]));
      await settle(14);
      await approveOnPhone();
      checking = true;
      await act(async () => { void shownMarket().checkResult(item); });
      await settle(14);
      // Proven as this install: concluded as installed from the facts read, and listed at the top (the page never moves
      // for it; "opened" below means proven, the only thing that can lead to an Open).
      const opened = () => provenDemo()
        || __retainedForTests.conclusions().some((conclusion) => conclusion.result === "installed" && conclusion.readback === "verified");
      let openedBeforeB = false;
      for (const step of order) {
        if (step === "sendB") { bIssued = true; await act(async () => { void fixture.props.get("confirmation").controller.refresh(); }); }
        else gate(step === "releaseA" ? "A" : "B").release();
        await settle(14);
        expect(detailReads, "no market detail is read to judge the result").toBe(0);
        if (!bIssued) { openedBeforeB = opened(); continue; }
        // Once B is sent, nothing may open an instance until B has returned showing it.
        if (!bReturned) expect(opened()).toBe(openedBeforeB);
        if (!bPresent) expect(opened()).toBe(openedBeforeB);
      }
      if (openedBeforeB) return; // A was the newest read and settled the result before B was sent: valid.
      if (bPresent) expect(opened()).toBe(true);
      else expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
    });
  });
  /* 测试价值（调度要求：扩到第三次已装读取与再次点「核实结果」，让下一个顺序先由测试跑到）
   * - 生产入口与可观察结果：真实 PluginsScreen + usePluginMarket + 管理 client / controller，只替换传输；观察是否打开
   *   实例、行的结论。
   * - 依据：核实事实只在它所依据的已装读取是最新发出的那次时有效（派生判断，单一出口 conclude）。
   * - 剪枝：A 的回包固定在最前（维护者 05:04 点名的顺序即以它开头）；其余事件 B 发出 / 回包、C 发出 / 回包、再次点
   *   核实的全部合法先后顺序（发出先于回包，C 在 B 之后发出）都在集合里，共 15 种 × 两种内容。结论只按已装读取同一次
   *   响应里的记录判断（契约规则 ④），不再为它读市场详情（每个顺序里都断言没有这次读取），所以原先穿插「市场详情
   *   回包」的顺序与这 15 种是同一次运行，不再重复列出。对应关系：05:04「B 挂起时先放行旧详情」= A → 发 B → B 回包；
   *   03:54 #1「第一轮详情在途时再次核实」= A → 核实……。tier: unit。
   * - 每一步之后断言：结论第一次出现时，最新发出的已装读取已回包且结论与它的内容一致；最新读取在途时仍待确认。
   *   全部回包后有结论，且等于最新一次读取的内容。
   */
  describe("every order with a third installed read and a second check", () => {
    type Step = "sendB" | "releaseB" | "sendC" | "releaseC" | "check";
    const perms = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
      : items.flatMap((first, index) => perms([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
    const legal = (order: Step[]) => order.indexOf("sendB") < order.indexOf("releaseB") && order.indexOf("sendC") < order.indexOf("releaseC")
      && order.indexOf("sendB") < order.indexOf("sendC");
    const core = perms<Step>(["sendB", "releaseB", "sendC", "releaseC"]).filter(legal);
    const all = core.flatMap((order) => Array.from({ length: order.length + 1 }, (_, at) => [...order.slice(0, at), "check" as Step, ...order.slice(at)]));
    it("has the orders the maintainer named among them", () => {
      expect(all).toHaveLength(15);
      expect(all.some((order) => order.join() === "sendB,releaseB,sendC,releaseC,check")).toBe(true);
      expect(all.some((order) => order.join() === "check,sendB,releaseB,sendC,releaseC")).toBe(true);
    });
    describe.each([["B shows the instance, C shows it removed", true, false], ["B shows it removed, C shows it again", false, true]])(
      "%s", (_case, bPresent, cPresent) => {
        it.each(all.map((order) => [order.join(" → "), order] as const))("A → %s", async (_label, order) => {
          const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
          const gate = (label: string) => {
            if (!gates.has(label)) { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); gates.set(label, { promise, release }); }
            return gates.get(label)!;
          };
          // Installed reads in the order they were sent, with what each shows and whether it came back.
          const reads: Array<{ label: string; present: boolean; returned: boolean }> = [];
          let began = false, checking = false, wanted: "B" | "C" | null = null, detailReads = 0;
          const truth = () => reads.length ? reads[reads.length - 1].present : true;
          queuedWire((request) => {
            switch (request.actionId) {
              case "management:snapshot": {
                if (request.input?.read === "capabilities") return { catalogPaging: true };
                if (request.input?.read === "catalog") return marketPage([item]);
                const read = (request as any).read as typeof reads[number] | undefined;
                if (read) { read.returned = true; return managementSnapshot(began && read.present); }
                return managementSnapshot(began && truth());
              }
              case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation", installedOperationAttribution: "self" } : {}), manifest: demoManifest };
              case "management:begin": return demoConsent(request);
              case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
              case "management:operation": throw hostError("NOT_FOUND");
              default: throw new Error("unexpected " + request.actionId);
            }
          }, (request) => {
            if (request === "manifest" || !checking) return undefined;
            if (request.actionId === "management:snapshot" && request.input?.read === "installed") {
              const label = reads.length === 0 ? "A" : wanted ?? `R${reads.length}`;
              const present = label === "A" ? true : label === "B" ? bPresent : label === "C" ? cPresent : truth();
              const read = { label, present, returned: false };
              reads.push(read);
              (request as any).read = read;
              if (label === "A" || label === "B" || label === "C") { if (wanted === label) wanted = null; return gate(label).promise; }
              return undefined;
            }
            if (request.actionId === "management:market-detail") detailReads += 1;
            return undefined;
          });
          await openMarket();
          await act(async () => shownMarket().install(shownMarket().items[0]));
          await settle(14);
          await approveOnPhone();
          checking = true;
          await act(async () => { void shownMarket().checkResult(item); });
          await settle(14);
          gate("A").release();
          await settle(14);
          const opened = () => provenDemo();
          const failed = () => shownMarket().rowState(item).kind === "failed";
          let concluded: boolean | null = opened() ? true : failed() ? false : null;
          // A was the newest read and settled the result right away: valid (it is what A showed).
          if (concluded !== null) expect(concluded).toBe(true);
          for (const step of order) {
            if (step === "sendB" || step === "sendC") {
              wanted = step === "sendB" ? "B" : "C";
              await act(async () => { void fixture.props.get("confirmation")?.controller.refresh(); });
            } else if (step === "check") {
              await act(async () => { void shownMarket().checkResult(item); });
            } else gate(step === "releaseB" ? "B" : "C").release();
            await settle(14);
            expect(detailReads, "no market detail is read to judge the result").toBe(0);
            const now = opened() ? true : failed() ? false : null;
            if (concluded === null && now !== null) {
              // The first conclusion rests on the newest installed read issued, which has returned and agrees with it.
              const newest = reads[reads.length - 1];
              expect(newest.returned, `${step}: concluded before the newest read (${newest.label}) returned`).toBe(true);
              expect(now, `${step}: conclusion against ${newest.label}`).toBe(newest.present);
              concluded = now;
            }
            if (concluded === null && reads.some((read) => !read.returned)) {
              expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
              // The attempt was handed to its pending check: the row still shows it as unconfirmed (above).
            }
          }
          // Every gate released (a read a newer one replaced may never be sent): never left waiting; the conclusion was
          // checked against the newest read when it appeared.
          expect(concluded, `still waiting: ${JSON.stringify(reads)}`).not.toBeNull();
        });
      });
  });
  // Shuffled release (dispatcher request after the 03:54 review): instead of hand-picked orders, each small scenario
  // holds 2–3 requests in flight and runs every order in which they could return, checking the invariants after each
  // step. The 03:54 orders are among them: second "Check result" while round 1's detail is in flight (#1), the probe
  // queued while leaving the market (#3), and a next page queued by scrolling before a new search (#3).
  describe("shuffled release of in-flight requests", () => {
    const orderings = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
      : items.flatMap((first, index) => orderings([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
    const gates = () => {
      const map = new Map<string, { promise: Promise<void>; release: () => void; released: boolean }>();
      const get = (label: string) => {
        if (!map.has(label)) { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; });
          map.set(label, { promise, release, released: false }); }
        return map.get(label)!;
      };
      return { hold: (label: string) => get(label).promise, release: (label: string) => { const g = get(label); g.released = true; g.release(); } };
    };
    const opened = () => provenDemo();

    // Group 2 (03:54 #3): the first probe P1 is held while the person leaves the market and comes back, which starts
    // probe P2 (held too). P1 either times out or succeeds late.
    describe.each([["the first probe times out", true], ["the first probe succeeds late", false]])("probe while leaving and returning: %s", (_c, p1Fails) => {
      it.each(orderings(["P1", "P2"]).map((order) => [order.join(" → "), order] as const))("%s", async (_label, order) => {
        const g = gates();
        let manifests = 0;
        const probeOf = new Map<unknown, string>();
        queuedWire((request) => {
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          return marketPage([marketItem("demo", "Demo")]);
        }, (request, device) => {
          if (request !== "manifest") return undefined;
          const label = ++manifests === 1 ? "P1" : manifests === 2 ? "P2" : null;
          if (!label) return undefined;
          return g.hold(label).then(() => { if (label === "P1" && p1Fails) throw new Error("[TIMEOUT] remote invoke timed out"); });
        });
        await openMarket();
        await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
        await settle(6);
        await act(async () => fixture.props.get("directory").onSegmentChange("market"));
        await settle(6);
        for (const step of order) {
          g.release(step);
          await settle(14);
          // Invariant ③: never "failed" on an online computer while the newer probe can still answer.
          if (!order.slice(0, order.indexOf(step) + 1).includes("P2")) expect(shownMarket().status).not.toBe("failed");
        }
        expect(shownMarket()).toMatchObject({ status: "ready", items: [expect.objectContaining({ name: "Demo" })] });
        void probeOf;
      });
    });

    // Group 4 (maintainer review 08:15): Allow is queued; before it leaves, either a plugin-change refresh puts the
    // same-id instance on the computer (the last send check then stops it) or Allow leaves first and its reply is lost.
    // Events: "allow queued", "allow stopped" or "allow sent", "allow reply lost"; then the receipt expires.
    // Only an Allow that actually left can confirm the result.
    it.each(orderings(["refresh", "releaseAllow"]).map((order) => [order.join(" → "), order] as const))("allow queued, then %s", async (_label, order) => {
      const g = gates();
      let present = false, holdAllow = false, receiptGone = false, ours = false;
      const sent = queuedWire((request) => {
        switch (request.actionId) {
          case "management:snapshot":
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") return marketPage([item]);
            // The same record as the market detail (V2.10: one install record behind both).
            return managementSnapshot(present, { ...item, installState: present ? "installed" : "not-installed",
              ...attributed(present, ours ? "screen-operation" : undefined) });
          case "management:market-detail": return { ...item, installState: present ? "installed" : "not-installed",
            ...attributed(present, ours ? "screen-operation" : undefined), manifest: demoManifest };
          case "management:begin": return demoConsent(request);
          case "management:answer": present = true; ours = true; throw new Error("[TIMEOUT] remote invoke timed out");
          case "management:operation":
            if (receiptGone) throw hostError("NOT_FOUND");
            return { operationId: request.input.operationId, phase: "running" };
          default: throw new Error("unexpected " + request.actionId);
        }
      }, (request) => request !== "manifest" && holdAllow && request.actionId === "management:answer" ? g.hold("allow") : undefined);
      await openMarket();
      await act(async () => shownMarket().install(shownMarket().items[0]));
      await settle(14);
      const controller = fixture.props.get("confirmation").controller;
      holdAllow = true;
      await act(async () => { void controller.answer(true); }); // "allow queued"
      await settle(6);
      for (const step of order) {
        if (step === "refresh") { present = true; await act(async () => { await controller.refresh(); }); }
        else g.release("allow");
        await settle(14);
      }
      const allowSent = sent.some((request) => request.actionId === "management:answer");
      expect(allowSent).toBe(order[0] === "releaseAllow");
      receiptGone = true;
      await act(async () => { await shownMarket().checkResult(item); });
      await settle(14);
      // Sent with the reply lost: the result is confirmed from the computer. Stopped before sending: unconfirmed.
      expect(opened()).toBe(allowSent);
      if (!allowSent) expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
      expect(sent.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
      expect(sent.filter((request) => request.actionId === "management:answer").length).toBeLessThanOrEqual(1);
    });
    // Group 4, disconnect path: Allow is queued, the computer goes offline before it leaves (stopped), comes back,
    // and the receipt has expired while the plugin is on the computer from elsewhere.
    it("allow queued, stopped by a disconnect, then the receipt expires", async () => {
      const g = gates();
      let present = false, holdAllow = false, receiptGone = false;
      const sent = queuedWire((request) => {
        switch (request.actionId) {
          case "management:snapshot":
            if (request.input?.read === "capabilities") return { catalogPaging: true };
            if (request.input?.read === "catalog") return marketPage([item]);
            return managementSnapshot(present, { ...item, installState: present ? "installed" : "not-installed", ...attributed(present) });
          case "management:market-detail": return { ...item, installState: present ? "installed" : "not-installed", ...attributed(present), manifest: demoManifest };
          case "management:begin": return demoConsent(request);
          case "management:answer": throw new Error("answer must not be sent");
          case "management:operation":
            if (receiptGone) throw hostError("NOT_FOUND");
            return { operationId: request.input.operationId, phase: "confirmation" };
          default: throw new Error("unexpected " + request.actionId);
        }
      }, (request) => request !== "manifest" && holdAllow && request.actionId === "management:answer" ? g.hold("allow") : undefined);
      await openMarket();
      await act(async () => shownMarket().install(shownMarket().items[0]));
      await settle(14);
      const controller = fixture.props.get("confirmation").controller;
      holdAllow = true;
      await act(async () => { void controller.answer(true); });
      await settle(6);
      await act(async () => controller.setOnline(false));
      g.release("allow");
      await settle(14);
      expect(sent.some((request) => request.actionId === "management:answer")).toBe(false);
      present = true; receiptGone = true;
      await act(async () => controller.setOnline(true));
      await settle(14);
      await act(async () => { await controller.reconcile(); });
      await settle(14);
      expect(opened()).toBe(false);
      expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
      expect(sent.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
    });

    // Maintainer review 03:52 of c6efda5691: after a success, the market row settles only on a snapshot read after the
    // result. The first order the maintainer reproduced, through the page: the computer goes offline while the row waits
    // for its read, which times out, and comes back (the row must end, and the reconnect read take over: the success's
    // read proves the instance, which is then listed at the top). The second (a plugin-change refresh sent while the read is out, its reply
    // held: nothing may settle on a snapshot from before the install) is the first case of the next group, where the
    // success's own read, issued after the result, is the only one that decides. Only reads go out after Allow; begin
    // and Allow once each. Both failed on c6efda5691 (stuck "installing"; "not on this computer now"). Tier: unit/jsdom.
    describe("a success read again around a disconnect (maintainer review 03:52)", () => {
      /**
       * `hold` / `fail` see each installed read written after Allow, labelled in the order written; a held read is
       * written (it left this phone) and only its reply waits, as when the computer answers late.
       */
      function successWire(hold: (label: string) => Promise<void> | undefined, fail: (label: string) => boolean) {
        let present = false, installedReads = 0;
        const sent = queuedWire(async (request) => {
          switch (request.actionId) {
            case "management:snapshot": {
              if (request.input?.read === "capabilities") return { catalogPaging: true };
              if (request.input?.read === "catalog") return marketPage([item]);
              if (!present) return managementSnapshot(false);
              const label = `installed-${++installedReads}`;
              const reply = managementSnapshot(true);
              await hold(label);
              if (fail(label)) throw new Error("[TIMEOUT] remote invoke timed out");
              return reply;
            }
            case "management:market-detail": return { ...item, installState: present ? "installed" : "not-installed",
              ...attributed(present, present ? "screen-operation" : undefined), manifest: demoManifest };
            case "management:begin": return demoConsent(request);
            case "management:answer": present = true; return { operationId: request.input.operationId, phase: "succeeded" };
            default: throw new Error("unexpected " + request.actionId);
          }
        }, () => undefined);
        return Object.assign(sent, { written: () => installedReads });
      }
      const writes = (sent: Array<{ actionId?: string }>) => sent.filter((request) => ["management:begin", "management:answer", "management:cancel"].includes(request.actionId ?? ""))
        .map((request) => request.actionId);
      it("offline while the row's reads are out, they time out, then back online", async () => {
        const g = gates();
        let offline = true;
        const held: string[] = [];
        const sent = successWire((label) => { if (!offline) return undefined; held.push(label); return g.hold("reads"); }, (label) => held.includes(label));
        await openMarket();
        await act(async () => shownMarket().install(shownMarket().items[0]));
        await settle(14);
        await act(async () => { void fixture.props.get("confirmation").controller.answer(true); });
        await settle(14);
        // The row ended with the result (another market install may start); the success's read is out.
        expect(shownMarket().installBusy).toBe(false);
        fixture.online = false;
        await act(async () => root.render(createElement(PluginsScreen)));
        g.release("reads");
        await settle(14);
        // Nothing is concluded on facts that were not read.
        expect(held.length).toBeGreaterThan(0);
        expect(opened()).toBe(false);
        const reallyOpened = () => fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");
        offline = false;
        fixture.online = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(20);
        // A read after the reconnect proves this install (V2.10 ①). The page does not move by itself for it: it is
        // listed at the top as having a result; the list says it is done and leads to the installed list, never to the
        // instance's detail.
        expect({ proven: opened(), opened: reallyOpened() }).toEqual({ proven: true, opened: false });
        const control = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;
        expect(control("plugins.slotHolder").textContent).toContain("plugins.checks.settledOne");
        await act(async () => control("plugins.slotHolder.show").click());
        await settle(10);
        expect(control("plugins.checks.showInstalled")).not.toBeNull();
        await act(async () => control("plugins.checks.showInstalled").click());
        await settle(20);
        expect(reallyOpened()).toBe(false);
        expect(writes(sent)).toEqual(["management:begin", "management:answer"]);
      });
    });

    /* 测试价值（推送前自查第三轮，2026-11-26：一笔安装装完时，页面不得把用户从别的确认面板前带走）
     * - 生产入口与可观察结果：真实 PluginsScreen，市场安装与已装详情的更新各走真实控件；观察写出的 begin / answer / cancel
     *   与页面打开了哪个实例。
     * - 依据：维护者 17:43 第 1 条（离开未答复确认会自动取消，必须受控）；自查第三轮在 d5ee5bc707 上复现：市场行等到结果
     *   后无条件打开已装详情，选择一变，另一项操作正开着的确认被取消（写出 management:cancel）。更早的版本同样如此。
     * - 现有覆盖缺口：互斥矩阵覆盖同一台电脑上的入口占用，没有覆盖「一项已答复、等读取」与「另一项正等答复」并存。
     * - 最小失败输入：见用例名；单机宽窄屏各一条、两台电脑一条。
     * - tier: unit（jsdom，内存 Host）。
     */
    describe("a market install ends while another operation's consent is on screen: the consent is left alone", () => {
      type Hold = (label: string, request: MarketWireRequest) => Promise<boolean> | undefined;
      const approval = { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" };
      /** Demo v1 is installed on "mac" (an update to v2 is offered); Notes is in every computer's market. */
      function computer() {
        const notes = marketItem("notes", "Notes");
        const demoPlugin: any = { instanceKey: "demo", namespace: null, enabled: true, manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" }, approval };
        const demoRecord: any = { pluginId: "market/demo", ghostId: "demo", namespace: null, name: "Demo", releaseId: "r2", version: "2",
          sourceType: "server", installState: "update-available", manifest: { ...demoPlugin.manifest, version: "2" },
          description: null, author: null, scope: "public", organizationId: null, defaultInstall: false, publishedAt: "", icon: null, enabled: true, sourceMarketName: null };
        const notesGhost: any = { instanceKey: "_root__notes", namespace: null, enabled: true, manifest: { schemaVersion: 3, id: "notes", name: "Notes", version: "1" }, approval };
        const world = { requests: [] as MarketWireRequest[], notesOn: new Map<string, string>(), hold: (() => undefined) as Hold,
          ops: new Map<string, { kind: "install" | "update"; phase: string }>(), notes };
        const timeout = () => new Error("[TIMEOUT] remote invoke timed out");
        const consent = (operationId: string, kind: "install" | "update") => ({ operationId, phase: "confirmation", consent: { requestId: "consent-" + operationId, initiator: "user", origin: "market",
          facts: kind === "install" ? { kind, ghostId: "notes", name: "Notes", version: "1", permissions: [] }
            : { kind, ghostId: "demo", name: "Demo", version: "2", previousVersion: "1", added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } });
        fixture.realManagement = true;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => transportSend(options, async () => {
          if (channel.endsWith(":manifest")) return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
          const envelope = args?.[0] ?? {};
          const request = { device, actionId: envelope.actionId, input: envelope.input, resourceRef: envelope.resourceRef };
          world.requests.push(request);
          const result = await (async () => {
            switch (request.actionId) {
              case "management:snapshot": {
                if (request.input?.read === "capabilities") return { catalogPaging: true };
                if (request.input?.read === "catalog") return marketPage(world.notesOn.has(device) ? [] : [notes]);
                const reply = JSON.parse(JSON.stringify({ version: 1, settingsPage: true, ghosts: [...(device === "mac" ? [demoPlugin] : []), ...(world.notesOn.has(device) ? [notesGhost] : [])],
                  market: { items: [...(device === "mac" ? [demoRecord] : []), ...(world.notesOn.has(device) ? [{ ...notes, namespace: null, installState: "installed", ...attributed(true, world.notesOn.get(device)) }] : [])],
                    unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] } }));
                if ((await world.hold(request.input?.read === "installed" ? "light" : "full", request)) === false) throw timeout();
                return reply;
              }
              case "management:market-detail":
                if (request.input.pluginId === notes.pluginId) return { ...notes, installState: world.notesOn.has(device) ? "installed" : "not-installed", manifest: notesGhost.manifest };
                return JSON.parse(JSON.stringify(demoRecord));
              case "management:begin": {
                const kind = request.resourceRef?.id ? "update" : "install";
                world.ops.set(request.input.operationId, { kind, phase: "confirmation" });
                return consent(request.input.operationId, kind);
              }
              case "management:operation": {
                const op = world.ops.get(request.input.operationId)!;
                return op.phase === "confirmation" ? consent(request.input.operationId, op.kind) : { operationId: request.input.operationId, phase: op.phase };
              }
              case "management:cancel": {
                world.ops.get(request.input.operationId)!.phase = "cancelled";
                return { operationId: request.input.operationId, phase: "cancelled" };
              }
              case "management:answer": {
                const op = world.ops.get(request.input.operationId)!;
                if (request.input.confirmed === false) { op.phase = "cancelled"; return { operationId: request.input.operationId, phase: "cancelled" }; }
                if ((await world.hold("answer-before", request)) === false) throw timeout();
                op.phase = "succeeded";
                if (op.kind === "install") world.notesOn.set(device, request.input.operationId);
                return { operationId: request.input.operationId, phase: "succeeded" };
              }
              default: throw new Error("unexpected " + request.actionId);
            }
          })();
          return { effects: [], result };
        }));
        return world;
      }
      const allById = (id: string) => [...element.querySelectorAll(`[data-testid="${id}"]`)] as HTMLButtonElement[];
      async function click(id: string) {
        const control = allById(id)[0];
        expect(control, `${id} is on screen`).toBeDefined();
        await act(async () => control.click());
        await settle(14);
      }
      const writes = (requests: MarketWireRequest[]) => requests
        .filter((request) => ["management:begin", "management:answer", "management:cancel"].includes(request.actionId!))
        .map((request) => request.actionId!.replace("management:", "") + ":" + request.input?.operationId);
      const openedIds = () => fixture.read.mock.calls.map((call: any[]) => `${call[1]?.deviceId}:${call[2]?.id}`);
      const gate = () => { let release!: (ok: boolean) => void; const promise = new Promise<boolean>((resolve) => { release = resolve; }); return { promise, release }; };
      const menu = () => fixture.props.get("header").right;
      const banner = () => allById("plugins.slotHolder")[0]?.textContent ?? "";
      async function numbered<T>(run: () => Promise<T>) {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try { return await run(); } finally { spy.mockRestore(); }
      }
      const BOTH = ["begin:operation-0001", "answer:operation-0001", "begin:operation-0002"];

      it.each([["wide", 900], ["narrow", 390]] as const)("%s: Notes is allowed and waits for its read; Demo's update shows its consent; Notes' read lands: nothing is written for the update, the page stays, Notes is listed", async (_name, width) => numbered(async () => {
        const world = computer();
        fixture.platform = "android";
        fixture.width = width;
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        const read = gate();
        world.hold = (label) => label === "light" && world.notesOn.size ? read.promise : undefined;
        await click(`plugins.market.install.${world.notes.pluginId}`);
        await act(async () => allById("plugins.management.allow").at(-1)!.click());
        await settle(14);
        // Notes succeeded; its read of the computer is out. The person goes to Installed and starts Demo's update.
        await act(async () => fixture.props.get("segment").onChange("installed"));
        await settle(14);
        await act(async () => fixture.props.get("pressable.plugins.detailsFor").onPress());
        await settle(20);
        await act(async () => { void menu().props.onAction("update"); });
        await settle(30);
        expect({ writes: writes(world.requests), update: world.ops.get("operation-0002")!.phase }).toEqual({ writes: BOTH, update: "confirmation" });
        world.hold = () => undefined;
        read.release(true);
        await settle(40);
        expect({ writes: writes(world.requests), opened: openedIds().at(-1), update: world.ops.get("operation-0002")!.phase })
          .toEqual({ writes: BOTH, opened: "mac:demo", update: "confirmation" });
      }));
      it("two computers, wide: Notes is being installed on PC; Demo's update on Mac shows its consent; PC's install ends: nothing is written for the update", async () => numbered(async () => {
        const world = computer();
        fixture.platform = "android"; fixture.width = 900; fixture.realConfirmation = true;
        fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("pressable.plugins.detailsFor").onPress());    // Demo's installed detail (Mac), right pane
        await settle(14);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click("plugins.market.computer");
        await click("plugins.market.computer.pc");
        const answer = gate();
        world.hold = (label, request) => label === "answer-before" && request.device === "pc" ? answer.promise : undefined;
        await click(`plugins.market.install.${world.notes.pluginId}`);
        await act(async () => allById("plugins.management.allow").filter((button) => !button.disabled).at(-1)!.click());
        await settle(14);                                                                       // PC is installing (Allow written)
        await act(async () => { void menu().props.onAction("update"); });
        await settle(30);
        expect({ writes: writes(world.requests), update: world.ops.get("operation-0002")!.phase }).toEqual({ writes: BOTH, update: "confirmation" });
        // Two operations, both still under way (one on each computer): the notice says so in those words.
        expect(banner()).toContain("plugins.checks.many");
        answer.release(true);                                                                   // PC's install ends
        await settle(40);
        // One has a result now and one is still under way: they need a look.
        expect({ writes: writes(world.requests), update: world.ops.get("operation-0002")!.phase, banner: banner() })
          .toEqual({ writes: BOTH, update: "confirmation", banner: expect.stringContaining("plugins.checks.attentionMany") });
      }));
      // Pre-push review, round 5 (failed on 7951455227 with "Open plugin", since removed, pressed for Notes before the
      // consent came up: its read landed after it, the page moved to Notes and the update's unanswered consent was
      // cancelled). Nothing opens when a read lands, and nothing is written for the update.
      it.each([["wide", 900], ["narrow", 390]] as const)("%s: the list is opened while Demo's update is getting ready; the update's consent comes up; Notes' read lands: nothing opens, nothing is written for the update", async (_name, width) => numbered(async () => {
        const world = computer();
        fixture.platform = "android";
        fixture.width = width;
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${world.notes.pluginId}`);
        await act(async () => allById("plugins.management.allow").at(-1)!.click());
        await settle(30);
        expect(banner()).toContain("plugins.checks.settledOne");                             // Notes: proven, listed
        await act(async () => fixture.props.get("segment").onChange("installed"));
        await settle(14);
        await act(async () => fixture.props.get("pressable.plugins.detailsFor").onPress());   // Demo's installed detail
        await settle(20);
        // The update's preparing read (the market detail) is slow.
        const preparing = gate();
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          if (args?.[0]?.actionId === "management:market-detail" && args[0].input?.pluginId === "market/demo") await preparing.promise;
          return original(device, channel, args, options);
        });
        await act(async () => { void menu().props.onAction("update"); });                     // Update: getting ready, nothing written yet
        await settle(14);
        expect(writes(world.requests)).toEqual(BOTH.slice(0, 2));
        const read = gate();
        world.hold = (label) => label === "light" ? read.promise : undefined;
        await click("plugins.slotHolder.show");                                              // the list of checks
        preparing.release(true);                                                             // the update goes on: begin, its consent
        await settle(30);
        expect({ writes: writes(world.requests), update: world.ops.get("operation-0002")?.phase, consent: allById("plugins.management.allow").length > 0 })
          .toEqual({ writes: BOTH, update: "confirmation", consent: true });
        const opened = fixture.read.mock.calls.length;
        world.hold = () => undefined;
        read.release(true);                                                                  // Notes' read proves it
        await settle(40);
        expect({ writes: writes(world.requests), update: world.ops.get("operation-0002")!.phase, opened: fixture.read.mock.calls.length - opened })
          .toEqual({ writes: BOTH, update: "confirmation", opened: 0 });
      }));
      // Pre-push review, round 5 (failed on 7951455227: the market jumped to the Mac and offered Install for Notes while
      // the top of the page said Notes on PC had a result).
      it("the market follows the Installed tab's computer (PC); Notes is installing there; the page is left and reopened; the install ends: the market stays on PC", async () => numbered(async () => {
        const world = computer();
        fixture.platform = "ios"; fixture.width = 390; fixture.realConfirmation = true;
        fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("directory").onDeviceChange("pc"));            // Installed: PC
        await act(async () => fixture.props.get("directory").onSegmentChange("market"));       // the market follows it
        await settle(20);
        expect(shownMarket().target.deviceId).toBe("pc");
        const answer = gate();
        world.hold = (label) => label === "answer-before" ? answer.promise : undefined;
        await act(async () => shownMarket().install(shownMarket().items[0]));
        await settle(20);
        await act(async () => allById("plugins.management.allow").filter((button) => !button.disabled).at(-1)!.click());
        await settle(14);                                                                     // Allow is written; PC is installing
        expect(writes(world.requests)).toEqual(["begin:operation-0001", "answer:operation-0001"]);
        await act(async () => root.render(createElement("div")));                             // the page is left
        await settle(6);
        await act(async () => root.render(createElement(PluginsScreen)));                     // and opened again
        await settle(20);
        await act(async () => fixture.props.get("directory").onSegmentChange("market"));
        await settle(20);
        expect({ on: shownMarket().target.deviceId, busy: shownMarket().installBusy }).toEqual({ on: "pc", busy: true });
        world.hold = () => undefined;
        answer.release(true);                                                                 // PC's install ends
        await settle(40);
        expect({ on: shownMarket().target.deviceId, offered: shownMarket().items.map((item: any) => `${item.name}:${shownMarket().rowState(item).kind}`), banner: banner() })
          .toEqual({ on: "pc", offered: [], banner: expect.stringContaining("plugins.checks.settledOne") });
      }));
      // Pre-push review, round 6 (the three after the control failed on 84ddb5043c: any attempt that ended made its
      // computer an explicit choice, so the market stayed on it, "not connected", on later visits). The computer of an
      // attempt is only this visit's automatic pick.
      async function twoComputersMarket() {
        const world = computer();
        fixture.platform = "ios"; fixture.width = 390; fixture.realConfirmation = true;
        fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("directory").onSegmentChange("market"));
        await settle(20);
        expect(shownMarket().target.deviceId).toBe("mac");                       // picked by itself (nothing chosen, nothing remembered)
        return world;
      }
      async function macGoesAwayAndTheMarketIsShownAgain() {
        fixture.offlineDevices.add("mac");
        await act(async () => root.render(createElement(PluginsScreen))); await settle(14);
        await act(async () => fixture.props.get("directory").onSegmentChange("installed")); await settle(14);
        await act(async () => fixture.props.get("directory").onSegmentChange("market")); await settle(30);
        return { on: shownMarket().target?.deviceId, status: shownMarket().status, remembered: fixture.storage.get("cindy.pluginMarketDevice.v1.demo") };
      }
      it("control: no install; Mac goes offline; the market is left and shown again: the automatic pick is the computer that is online", async () => numbered(async () => {
        await twoComputersMarket();
        expect(await macGoesAwayAndTheMarketIsShownAgain()).toEqual({ on: "pc", status: "ready", remembered: undefined });
      }));
      it.each([["is installed", "allow"], ["is refused in its consent", "reject"]] as const)("the market picked Mac by itself; Notes %s there; later Mac goes offline; the market is left and shown again: the automatic pick is the computer that is online", async (_name, answer) => numbered(async () => {
        const world = await twoComputersMarket();
        await act(async () => shownMarket().install(shownMarket().items[0]));
        await settle(20);
        await act(async () => allById("plugins.management." + answer).filter((button) => !button.disabled).at(-1)!.click());
        await settle(40);
        expect({ busy: shownMarket().installBusy, on: shownMarket().target.deviceId, writes: writes(world.requests) })
          .toEqual({ busy: false, on: "mac", writes: ["begin:operation-0001", "answer:operation-0001"] });
        expect(await macGoesAwayAndTheMarketIsShownAgain()).toEqual({ on: "pc", status: "ready", remembered: undefined });
      }));
      it("the market picked Mac by itself; Install is pressed and Mac is offline before anything is sent; the market is left and shown again: the automatic pick is the computer that is online", async () => numbered(async () => {
        const world = await twoComputersMarket();
        const item = shownMarket().items[0];
        const original = fixture.wire.getMockImplementation()!;
        let failing = true;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          if (failing && device === "mac") return transportSend(options, async () => { throw new Error("[DEVICE_OFFLINE] computer is offline"); });
          return original(device, channel, args, options);
        });
        await act(async () => shownMarket().install(item));
        await settle(40);
        failing = false;
        expect({ busy: shownMarket().installBusy, writes: writes(world.requests) }).toEqual({ busy: false, writes: [] });
        expect(await macGoesAwayAndTheMarketIsShownAgain()).toEqual({ on: "pc", status: "ready", remembered: undefined });
      }));
      // Pre-push review, round 7 (failed on f8d1f490c4: an attempt that ended while the market was not shown still made
      // its computer the pick of the next visit).
      it.each([
        ["the person goes to Installed", async () => { await act(async () => fixture.props.get("directory").onSegmentChange("installed")); await settle(14); }, async () => {}],
        ["another screen comes in front", async () => { fixture.focused = false; await act(async () => root.render(createElement(PluginsScreen))); await settle(14); }, async () => { fixture.focused = true; }],
      ] as const)("the market picked Mac by itself; Notes is being installed there; %s; the install ends; later Mac goes offline; the market is shown again: the automatic pick is the computer that is online", async (_name, leave, comeBack) => numbered(async () => {
        const world = await twoComputersMarket();
        const answer = gate();
        world.hold = (label) => label === "answer-before" ? answer.promise : undefined;
        await act(async () => shownMarket().install(shownMarket().items[0]));
        await settle(20);
        await act(async () => allById("plugins.management.allow").filter((button) => !button.disabled).at(-1)!.click());
        await settle(14);                                                                     // Allow is written; Mac is installing
        expect(writes(world.requests)).toEqual(["begin:operation-0001", "answer:operation-0001"]);
        await leave();                                                                        // the market is no longer what is shown
        world.hold = () => undefined;
        answer.release(true);                                                                 // the install ends meanwhile
        await settle(40);
        expect(__retainedForTests.conclusions().map((item: any) => item.result)).toEqual(["succeeded"]);
        fixture.offlineDevices.add("mac");                                                    // later Mac goes offline
        await comeBack();
        await act(async () => root.render(createElement(PluginsScreen))); await settle(14);
        await act(async () => fixture.props.get("directory").onSegmentChange("market")); await settle(30);   // a new visit of the market
        expect({ on: shownMarket().target?.deviceId, status: shownMarket().status, remembered: fixture.storage.get("cindy.pluginMarketDevice.v1.demo") })
          .toEqual({ on: "pc", status: "ready", remembered: undefined });
      }));
      // Pre-push review, round 8 (failed on 251f7dd5fc, where an attempt's computer was kept only while the market's list
      // was shown: with a market detail on the right and the list switched to Installed, the market moved to the other
      // computer and the detail on screen was dropped).
      it.each([["", true], ["control (Mac stays away): ", false]] as const)("%swide, two computers; the market picked PC while Mac was away, Mac is back; Notes is installed from its market detail; the list is switched to Installed; the install ends: the market detail on screen stays and says installed", async (_name, macBack) => numbered(async () => {
        const world = computer();
        fixture.platform = "android"; fixture.width = 900; fixture.realConfirmation = true;
        fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
        fixture.offlineDevices.add("mac");
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(20);
        if (macBack) fixture.offlineDevices.delete("mac");                                      // Mac is back; the market stays on PC for this visit
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(20);
        await click(`plugins.market.row.${world.notes.pluginId}`);
        const detailText = () => allById("plugins.market.detail")[0]?.textContent ?? null;
        expect(detailText()).not.toBeNull();
        const answer = gate();
        world.hold = (label, request) => label === "answer-before" && request.device === "pc" ? answer.promise : undefined;
        await click("plugins.market.detailInstall");
        await act(async () => allById("plugins.management.allow").filter((button) => !button.disabled).at(-1)!.click());
        await settle(14);                                                                       // Allow is written; PC is installing
        expect(world.requests.filter((request) => request.actionId === "management:begin").map((request) => request.device)).toEqual(["pc"]);
        await act(async () => fixture.props.get("segment").onChange("installed"));             // the list on the left shows Installed
        await settle(14);
        expect(detailText()).not.toBeNull();                                                    // the market detail is still on the right
        world.hold = () => undefined;
        answer.release(true);                                                                   // PC's install ends
        await settle(40);
        expect(__retainedForTests.conclusions().map((item: any) => item.result)).toEqual(["succeeded"]);
        expect({ detail: detailText() !== null, installed: (detailText() ?? "").includes("plugins.market.alreadyInstalled"), install: allById("plugins.market.detailInstall").length })
          .toEqual({ detail: true, installed: true, install: 0 });
      }));
      // Pre-push review, round 9 (the first row failed on 30ef70ed32: the consent was cancelled once the computer was
      // back, though no consent was on screen when the person went back).
      it.each([["goes back to the list", true], ["control: stays on the detail", false]] as const)("Demo's update shows its consent from the installed detail; the computer drops (no consent on screen now); the person %s; the computer comes back: nothing is written for it", async (_name, leaves) => numbered(async () => {
        const world = computer();
        fixture.platform = "android"; fixture.width = 390; fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("pressable.plugins.detailsFor").onPress());
        await settle(20);
        await act(async () => { void menu().props.onAction("update"); });
        await settle(30);
        expect({ writes: writes(world.requests), update: world.ops.get("operation-0001")!.phase }).toEqual({ writes: ["begin:operation-0001"], update: "confirmation" });
        fixture.online = false; await act(async () => root.render(createElement(PluginsScreen))); await settle(20);
        if (leaves) { await act(async () => fixture.props.get("header").onBack()); await settle(14); }
        fixture.online = true; await act(async () => root.render(createElement(PluginsScreen))); await settle(40);
        expect({ writes: writes(world.requests), update: world.ops.get("operation-0001")!.phase }).toEqual({ writes: ["begin:operation-0001"], update: "confirmation" });
      }));
      // Pre-push review, round 10. The market's pick for this visit was dropped as soon as its list was not shown, also
      // with a market detail still open: the market moved to the other computer and dropped that detail (the first
      // three rows and the next test's first row failed on f2f5038007).
      const rerenderPage = async () => { await act(async () => root.render(createElement(PluginsScreen))); await settle(20); };
      async function notesInstalledFromItsMarketDetailOnPc(width: number, macBack: boolean) {
        const world = computer();
        fixture.platform = "android"; fixture.width = width; fixture.realConfirmation = true;
        fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
        fixture.offlineDevices.add("mac");
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(20);
        if (macBack) fixture.offlineDevices.delete("mac");                                      // Mac is back; the market stays on PC for this visit
        await rerenderPage();
        await click(`plugins.market.row.${world.notes.pluginId}`);
        await click("plugins.market.detailInstall");
        await act(async () => allById("plugins.management.allow").filter((button) => !button.disabled).at(-1)!.click());
        await settle(40);
        const detail = () => { const text = allById("plugins.market.detail")[0]?.textContent ?? null; return { detail: text !== null, installed: (text ?? "").includes("plugins.market.alreadyInstalled") }; };
        expect(detail()).toEqual({ detail: true, installed: true });
        return detail;
      }
      it.each([["narrow", 390, true], ["wide", 900, true], ["control (Mac stays away): narrow", 390, false]] as const)("%s, two computers; the market picked PC while Mac was away, Mac is back; Notes is installed from its market detail and the install ends; another screen comes in front and the person comes back: the market detail is still there, on PC", async (_name, width, macBack) => numbered(async () => {
        const detail = await notesInstalledFromItsMarketDetailOnPc(width, macBack);
        fixture.focused = false; await rerenderPage();
        fixture.focused = true; await rerenderPage(); await settle(30);
        expect(detail()).toEqual({ detail: true, installed: true });
      }));
      it.each([["", true], ["control (Mac stays away): ", false]] as const)("%swide, two computers; the market picked PC while Mac was away, Mac is back; Notes is installed from its market detail and the install ends; then the list is switched to Installed: the market detail on screen stays", async (_name, macBack) => numbered(async () => {
        const detail = await notesInstalledFromItsMarketDetailOnPc(900, macBack);
        await act(async () => fixture.props.get("segment").onChange("installed"));
        await settle(30);
        expect(detail()).toEqual({ detail: true, installed: true });
      }));
      // Pre-push review, round 11 (failed on 346028ad97: the list said the computer was waiting for the person, the row
      // said "not confirmed, check the result", and checking changed nothing).
      it("Notes' consent is on screen; the page is left and the cancel for leaving is refused before it is written; back on the market: the row says it waits for the person, as the list does", async () => numbered(async () => {
        const world = computer();
        const original = fixture.wire.getMockImplementation()!;
        const asked: string[] = [];
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          if (args?.[0]?.actionId === "management:cancel") { asked.push("cancel"); options?.preSend?.(); options?.onNotSent?.(); throw new Error("[LINK_NOT_OPEN] refused before the first write"); }
          return original(device, channel, args, options);
        });
        fixture.platform = "android"; fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${world.notes.pluginId}`);
        await settle(20);
        expect(writes(world.requests)).toEqual(["begin:operation-0001"]);
        await act(async () => root.render(createElement("div")));
        await settle(30);
        expect({ asked, written: writes(world.requests).filter((write: string) => write.startsWith("cancel")) }).toEqual({ asked: ["cancel"], written: [] });
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(20);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(30);
        const rowText = [...element.querySelectorAll("span")].map((span) => span.textContent).filter((text) => /^plugins\.market\.(waiting|installing|resultUnknownDetail)$/.test(text ?? ""));
        await click("plugins.slotHolder.show");
        const list = allById("plugins.checks")[0]?.textContent ?? "";
        expect({ rowText, listAwaitingYou: list.includes("plugins.checks.status.awaitingYou"), decide: allById("plugins.checks.decide").length, phase: world.ops.get("operation-0001")!.phase })
          .toEqual({ rowText: ["plugins.market.waiting"], listAwaitingYou: true, decide: 1, phase: "confirmation" });
      }));
      // Pre-push review, round 10 (both failed on f2f5038007: the computer waited for an answer while the phone neither
      // showed the consent nor offered "View and decide" for it).
      const cancelsWritten = (world: any) => writes(world.requests).filter((write: string) => write.startsWith("cancel"));
      async function updateConsentOnScreen(width: number, platform: string) {
        const world = computer();
        fixture.platform = platform; fixture.width = width; fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(14);
        if (platform === "ios") await act(async () => fixture.props.get("directory").onDetail(row()));
        else await act(async () => fixture.props.get("pressable.plugins.detailsFor").onPress());
        await settle(20);
        const detailMenu = platform === "ios" ? fixture.props.get("header").rightToolbar : fixture.props.get("header").right;
        await act(async () => { void detailMenu.props.onAction("update"); });
        await settle(30);
        expect({ writes: writes(world.requests), consent: allById("plugins.management.allow").length > 0 }).toEqual({ writes: ["begin:operation-0001"], consent: true });
        return world;
      }
      it("wide: an update's consent was shown; Mac drops; the person opens another plugin; Mac returns (the consent waits for \"View and decide\"); the person taps Demo's row (its own page opens): the consent is still reachable from the list", async () => numbered(async () => {
        const world = await updateConsentOnScreen(900, "ios");
        fixture.online = false; await rerenderPage();
        const other = { ...row(), key: "mac:other", item: { ...row().item, ref: { collectionId: "plugins", kind: "plugin", id: "other" }, display: { title: "Other" } } };
        await act(async () => fixture.props.get("directory").onDetail(other));
        await settle(30);
        fixture.online = true; await rerenderPage(); await settle(40);
        expect({ cancels: cancelsWritten(world), waits: __retainedForTests.checks().map((check: any) => [check.state.outcome, check.awaitingYou]) }).toEqual({ cancels: [], waits: [["confirmation", true]] });
        const withPage = { ...row(), item: { ...row().item, actions: [{ id: "open:panel", label: "Open" }, { id: "disable", label: "Enabled" }] } };
        await act(async () => fixture.props.get("directory").onOpen(withPage));           // Demo's own page: its controller is attached again
        await settle(30);
        await click("plugins.slotHolder.show");
        expect({ cancels: cancelsWritten(world), phase: world.ops.get("operation-0001")!.phase, decide: allById("plugins.checks.decide").length })
          .toEqual({ cancels: [], phase: "confirmation", decide: 1 });
      }));
      it("narrow: the update's consent is allowed and the computer asks a second consent, shown in the same sheet; the person goes back: nothing is cancelled, and the list offers \"View and decide\" for it", async () => numbered(async () => {
        const world = await updateConsentOnScreen(390, "android");
        const original = fixture.wire.getMockImplementation()!;
        const second = (operationId: string) => ({ operationId, phase: "confirmation", consent: { requestId: "consent-2", initiator: "user", origin: "market",
          facts: { kind: "update", ghostId: "demo", name: "Demo", version: "2", previousVersion: "1", added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } });
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          const id = args?.[0]?.actionId;
          if (id === "management:answer" || id === "management:operation") {
            world.requests.push({ device, actionId: id, input: args![0].input });
            return transportSend(options, async () => ({ effects: [], result: second(args![0].input.operationId) }));
          }
          return original(device, channel, args, options);
        });
        await act(async () => allById("plugins.management.allow").filter((button) => !button.disabled).at(-1)!.click());
        await settle(30);
        expect(fixture.props.get("observedManagement").state.receipt.consent.requestId).toBe("consent-2");
        await act(async () => fixture.props.get("header").onBack());
        await settle(30);
        expect(writes(world.requests)).toEqual(["begin:operation-0001", "answer:operation-0001"]);
        await click("plugins.slotHolder.show");
        expect({ decide: allById("plugins.checks.decide").length, awaitingYou: __retainedForTests.checks().map((check: any) => check.awaitingYou) }).toEqual({ decide: 1, awaitingYou: [true] });
      }));
    });

    /* 测试价值（推送前自查第二轮，2026-11-26：已装详情里的更新与页面批准也只看那一次读取的结论；维护者 16:53 去掉
     *   「从记录打开」后，详情不再算看过，结果列在顶部直到在记录面板里看过，用例按此改写）
     * - 生产入口与可观察结果：真实 PluginsScreen 的已装详情（菜单的「更新」、页面批准提示、详情自己的「核实结果」），
     *   生产 client / controller / 记录存储；观察详情是否重读、顶部提示是否还列着、提示了哪句话。
     * - 依据：维护者 23:03 第 1、2 条与 01:21（更新走同一条只读核实路径、「打开」只按当前事实）；自查第二轮在本改动的
     *   第一版（cefbf383b4）上复现：详情已经显示结果而顶部提示一直挂着「操作有结果了」（重连重读、失焦期间读出、
     *   页面批准、回执过期后详情自己核实四种）；只有成功自己的那次读取失败时详情不再重读。
     * - 现有覆盖缺口：新增的页面层用例只覆盖市场安装。
     * - 最小失败输入：见各用例名；首条为对照（普通更新，改前改后都通过）。
     * - tier: unit（jsdom，内存 Host）。
     */
    describe("an update or a page approval from the installed detail: the detail is brought up to date, the result is listed until seen in the list", () => {
      type Hold = (label: string) => Promise<boolean> | undefined;
      function host(options: { ui?: boolean } = {}) {
        const plugin: any = { instanceKey: "demo", namespace: null, enabled: true,
          manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" },
          approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } };
        const market: any = { pluginId: "market/demo", ghostId: "demo", namespace: null, name: "Demo", releaseId: "r2", version: "2",
          sourceType: "server", installState: "update-available", manifest: { ...plugin.manifest, version: "2" },
          description: null, author: null, scope: "public", organizationId: null, defaultInstall: false, publishedAt: "", icon: null,
          enabled: true, sourceMarketName: null };
        const snapshot: any = { version: 1, settingsPage: true, ghosts: [plugin],
          market: { items: [market], unavailableCustomSourceNames: [], unavailableReason: null, customSourceNames: [] } };
        if (options.ui) {
          Object.assign(plugin.manifest, { tools: [{ name: "open" }], mcpApps: { ui: { resources: [{ uri: "ui://form", file: "ui/form.html" }], tools: { open: { resourceUri: "ui://form" } } } } });
          Object.assign(snapshot, { uiCapabilityApproval: true });
        }
        const world = { plugin, market, committed: false, reads: 0, operationId: "", hold: (() => undefined) as Hold,
          asked: [] as string[], loseBegin: false, operation: undefined as undefined | (() => unknown),
          /** How the computer attributes the committed update to this phone. */
          attribution: "self" as "self" | "unattributed" | "legacy" };
        const commit = (request: any) => {
          world.committed = true;
          if (/approve/.test(request.input?.kind ?? "")) { plugin.uiCapabilityApproved = true; return; }
          if (request.input?.kind === "uninstall") { snapshot.ghosts.splice(0); Object.assign(market, { installState: "not-installed" }); return; }
          plugin.manifest.version = "2";
          Object.assign(market, { installState: "installed" }, world.attribution === "self" ? { installedOperationId: world.operationId, installedOperationAttribution: "self" }
            : world.attribution === "unattributed" ? { installedOperationAttribution: "unattributed" } : {});
        };
        fixture.realManagement = true;
        fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], wireOptions: any) => transportSend(wireOptions, async () => {
          if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
          const request = args[0];
          world.asked.push(request.actionId);
          if (request.actionId === "management:snapshot") {
            if (request.input?.read === "capabilities") return { result: { catalogPaging: true } };
            if (request.input?.read === "catalog") return { result: marketPage([]) };
            const reply = JSON.parse(JSON.stringify(snapshot));
            if (world.committed && (await world.hold(`read-${++world.reads}`)) === false) throw new Error("[TIMEOUT] remote invoke timed out");
            return { result: reply };
          }
          if (request.actionId === "management:market-detail") return { result: market };
          if (request.actionId === "management:begin") {
            world.operationId = request.input.operationId;
            commit(request);
            if (world.loseBegin) { world.loseBegin = false; throw new Error("[TIMEOUT] remote invoke timed out"); }
            return { result: { operationId: request.input.operationId, phase: "succeeded" } };
          }
          if (request.actionId === "management:operation" && world.operation) return { result: await world.operation() };
          throw new Error("Unexpected action " + request.actionId);
        }));
        return world;
      }
      const byId = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
      async function click(id: string) {
        const control = byId(id);
        expect(control, `${id} is on screen`).not.toBeNull();
        await act(async () => control!.click());
        await settle(14);
      }
      const banner = () => byId("plugins.slotHolder")?.textContent ?? "";
      const prompts = () => fixture.alert.mock.calls.map((call) => call[1]).filter((text) => text !== undefined);
      const rerender = async () => { await act(async () => root.render(createElement(PluginsScreen))); await settle(20); };
      const menu = () => fixture.props.get("header").rightToolbar;
      const menuActions = () => menu().props.actions.map((action: any) => action.id);
      const update = async () => { await act(async () => { void menu().props.onAction("update"); }); await settle(20); };
      const detailReads = () => fixture.read.mock.calls.map((call: any[]) => `${call[1]?.deviceId}:${call[2]?.id}`);
      const results = () => __retainedForTests.conclusions().map(({ entry, result, readback, told }: any) => ({ entry, result, readback, told: !!told }));
      const timesOut: Hold = () => Promise.resolve(false);
      async function open(width = 900) { fixture.width = width; await openDetail(); await settle(8); }

      it("control: a plain update: the detail is read again, listed until seen in the list, nothing is prompted", async () => {
        const world = host();
        await open();
        fixture.alert.mockClear();
        await update();
        expect({ banner: banner(), prompts: prompts(), results: results(), actions: menuActions() })
          .toEqual({ banner: expect.stringContaining("plugins.checks.settledOne"), prompts: [], results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }], actions: ["uninstall"] });
        expect(world.asked.filter((id) => id === "management:begin")).toHaveLength(1);
      });
      it.each([["wide", 900], ["narrow", 390]] as const)("update; the reads after it time out; the computer goes away and comes back (%s): the detail shows the update and it is listed until seen in the list", async (_name, width) => {
        const world = host();
        world.hold = timesOut;
        await open(width);
        await update();
        expect(banner()).toContain("plugins.checks.waitingOne");
        fixture.online = false; await rerender();
        world.hold = () => undefined;
        fixture.read.mockClear();
        fixture.online = true; await rerender();
        await settle(30);
        expect({ results: results(), read: detailReads().includes("mac:demo"), actions: menuActions(), banner: banner() })
          .toEqual({ results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }], read: true, actions: ["uninstall"], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      // The success is read again from the list, by the person, and seen there. The page keeps no account of what the
      // detail on screen shows: that detail is left as it was (its own read after the update did not land) until it is
      // read again (a reconnect, pull to refresh, the computer's change notification, opening it), as on main.
      it("update; the reads after it time out; \"Read again\" in the list proves it and the list is closed: seen in the list, nothing stays listed, nothing is prompted", async () => {
        const world = host();
        world.hold = timesOut;
        await open(390);
        await update();
        expect(banner()).toContain("plugins.checks.waitingOne");
        world.hold = () => undefined;
        await click("plugins.slotHolder.show");
        await click("plugins.checks.readAgain");
        expect(byId("plugins.checks")!.textContent).toContain("plugins.checks.result.succeeded");
        await click("plugins.checks.close");
        await settle(30);
        expect({ results: results(), banner: banner(), prompts: prompts() })
          .toEqual({ results: [{ entry: "update", result: "succeeded", readback: "verified", told: true }], banner: "", prompts: [] });
      });
      it("page approval; the reads after it time out; the computer comes back: approved on screen and it is listed until seen in the list", async () => {
        const world = host({ ui: true });
        world.hold = timesOut;
        await open(390);
        await act(async () => { fixture.props.get("detail").uiApprovalNotice.actions[0].onPress(); });
        await settle(20);
        fixture.online = false; await rerender();
        world.hold = () => undefined;
        fixture.online = true; await rerender();
        await settle(30);
        expect({ approval: fixture.props.get("detail").uiApprovalNotice, banner: banner() }).toEqual({ approval: undefined, banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("update; begin's reply lost; receipt gone; the detail's own \"Check result\" proves it: listed as installed; seen in the list, with Go to Installed", async () => {
        const world = host();
        // The installed detail's own resource, as the computer has it at the time (the detail shows its version block).
        fixture.read.mockImplementation(async () => ({ ...row().item, blocks: [{ id: "version", fallbackMarkdown: world.plugin.manifest.version }] }));
        await open();
        world.loseBegin = true;
        world.operation = () => { throw new Error("[NOT_FOUND] no such operation"); };
        await update();
        expect(fixture.props.get("detail").managementNotice).toMatchObject({ title: "plugins.notice.title.resultUnknown" });
        await act(async () => { fixture.props.get("detail").managementNotice.actions[0].onPress(); });
        await settle(30);
        expect({ results: results(), notice: fixture.props.get("detail").managementNotice, banner: banner() })
          .toEqual({ results: [{ entry: "update", result: "installed", readback: "verified", told: false }], notice: undefined, banner: expect.stringContaining("plugins.checks.settledOne") });
        await click("plugins.slotHolder.show");
        expect(byId("plugins.checks.showInstalled")).not.toBeNull();
        await click("plugins.checks.close");
        expect({ results: results(), banner: banner() })
          .toEqual({ results: [{ entry: "update", result: "installed", readback: "verified", told: true }], banner: "" });
      });
      it("update; only the success's own read times out, the detail's own read answers: the detail is read again, and the success stays listed to be read", async () => {
        const world = host();
        world.hold = (label) => label === "read-1" ? Promise.resolve(false) : undefined;
        await open();
        fixture.read.mockClear();
        await update();
        expect({ actions: menuActions(), read: detailReads(), banner: banner() })
          .toEqual({ actions: ["uninstall"], read: ["mac:demo"], banner: expect.stringContaining("plugins.checks.waitingOne") });
      });
      it("update; the page is left before the read is back: nobody saw it, so it is listed as having a result; the list says done with \"Go to Installed\", closing it clears the notice", async () => {
        let release!: () => void;
        const gate = new Promise<boolean>((resolve) => { release = () => resolve(true); });
        const world = host();
        world.hold = () => gate;
        await open();
        await update();
        await act(async () => root.render(createElement("div")));
        await settle(6);
        world.hold = () => undefined;
        release();
        await settle(30);
        await rerender();
        expect(banner()).toContain("plugins.checks.settledOne");
        await click("plugins.slotHolder.show");
        expect({ done: (byId("plugins.checks")?.textContent ?? "").includes("plugins.checks.result.succeeded"), installed: !!byId("plugins.checks.showInstalled") }).toEqual({ done: true, installed: true });
        await click("plugins.checks.close");
        expect(banner()).toBe("");
      });
      // Third round (on d5ee5bc707): the detail's own effect pulled the person back from the plugin's page, read the
      // detail twice, and said nothing when its own "Check result" ended unconfirmed.
      it.each([["wide", 900], ["narrow", 390]] as const)("update could not be read; the person opens the plugin's own page; the computer comes back and the read proves it (%s): the plugin's page stays in front", async (_name, width) => {
        const world = host();
        world.hold = timesOut;
        fixture.read.mockImplementation(async () => ({ ...row().item, actions: [{ id: "disable", label: "Enabled" }, { id: "open:panel", label: "Open" }], blocks: [] }));
        await open(width);
        await update();
        expect(banner()).toContain("plugins.checks.waitingOne");
        await act(async () => fixture.props.get("detail").onOpen("panel"));
        await settle(10);
        // The plugin's own page is in front: the header offers "details", not the management menu.
        const onPluginPage = () => ({ menu: !!fixture.props.get("header").rightToolbar, detailsButton: fixture.props.get("header").right?.props?.accessibilityLabel });
        expect(onPluginPage()).toEqual({ menu: false, detailsButton: "plugins.details" });
        fixture.online = false; await rerender();
        // Back online only the first installed read written answers (the success's own, issued at once); the rest time out.
        const base = world.reads;
        world.hold = (label) => Number(label.slice(5)) === base + 1 ? undefined : Promise.resolve(false);
        fixture.read.mockClear();
        fixture.online = true; await rerender();
        await settle(30);
        expect(results()).toEqual([{ entry: "update", result: "succeeded", readback: "verified", told: false }]);
        // Still not shown to the person (it stays listed for when they are back on the directory).
        expect({ ...onPluginPage(), detailReads: detailReads() }).toEqual({ menu: false, detailsButton: "plugins.details", detailReads: [] });
      });
      it.each([["another install since (②)", "unattributed", "plugins.market.unconfirmedMismatch"], ["an older computer (③)", "legacy", "plugins.market.unconfirmedLegacy"]] as const)(
        "update; begin's reply lost; receipt gone; the detail's own \"Check result\" reads %s: how it ended is listed, not prompted", async (_name, attribution, said) => {
          const world = host();
          world.attribution = attribution;
          await open();
          world.loseBegin = true;
          world.operation = () => { throw new Error("[NOT_FOUND] no such operation"); };
          fixture.alert.mockClear();
          await update();
          await act(async () => { fixture.props.get("detail").managementNotice.actions[0].onPress(); });
          await settle(30);
          // Nothing is prompted; how it ended is listed at the top and said in the list of checks.
          expect({ prompts: prompts(), begins: world.asked.filter((id) => id === "management:begin").length, banner: banner() })
            .toEqual({ prompts: [], begins: 1, banner: expect.stringContaining("plugins.checks.settledOne") });
          await click("plugins.slotHolder.show");
          expect(byId("plugins.checks")!.textContent).toContain(said);
          await click("plugins.checks.close");
          expect(banner()).toBe("");
        });
      it("update could not be read; back to the list; the computer comes back; the person opens that detail again: it is read once, and the result is listed until seen in the list", async () => {
        const world = host();
        world.hold = timesOut;
        await open(390);
        await update();
        await act(async () => fixture.props.get("header").onBack());
        await settle(10);
        fixture.online = false; await rerender();
        world.hold = () => undefined;
        fixture.online = true; await rerender();
        await settle(30);
        expect(banner()).toContain("plugins.checks.settledOne");
        fixture.read.mockClear();
        await act(async () => fixture.props.get("directory").onDetail(row()));
        await settle(30);
        expect({ banner: banner(), reads: detailReads() }).toEqual({ banner: expect.stringContaining("plugins.checks.settledOne"), reads: ["mac:demo"] });
      });
      // Pre-push review, round 5; each failed on 7951455227.
      it.each([["wide", 900], ["narrow", 390]] as const)("%s: update started from the detail opened over the plugin's own page; back to the plugin's page while the computer installs; it ends: the plugin's page stays in front, and the detail is read when it is shown again", async (_name, width) => {
        const world = host();
        fixture.read.mockImplementation(async () => ({ ...row().item, actions: [{ id: "disable", label: "Enabled" }, { id: "open:panel", label: "Open" }], blocks: [] }));
        await open(width);
        await act(async () => fixture.props.get("detail").onOpen("panel"));                  // the plugin's own page
        await settle(10);
        const onPluginPage = () => ({ menu: !!fixture.props.get("header").rightToolbar, detailsButton: fixture.props.get("header").right?.props?.accessibilityLabel });
        expect(onPluginPage()).toEqual({ menu: false, detailsButton: "plugins.details" });
        await act(async () => fixture.props.get("header").right.props.onPress());            // its "details" button: the detail over the page
        await settle(14);
        expect(onPluginPage().menu).toBe(true);
        let release!: () => void;
        const installing = new Promise<void>((resolve) => { release = resolve; });
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args: any[], options: any) => {
          const reply = await original(device, channel, args, options);
          if (args?.[0]?.actionId === "management:begin") await installing;                  // the computer is installing: the result waits
          return reply;
        });
        await update();
        expect(world.asked.filter((id) => id === "management:begin")).toHaveLength(1);
        await act(async () => fixture.props.get("header").onBack());                         // back: the plugin's own page again
        await settle(10);
        expect(onPluginPage()).toEqual({ menu: false, detailsButton: "plugins.details" });
        release();                                                                           // the update ends
        await settle(40);
        expect({ ...onPluginPage(), results: results() }).toEqual({ menu: false, detailsButton: "plugins.details",
          results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }] });
        // The person opens the detail again: it is read then, and that is where they see the result.
        fixture.read.mockClear();
        await act(async () => fixture.props.get("header").right.props.onPress());
        await settle(30);
        expect({ menu: onPluginPage().menu, read: detailReads().includes("mac:demo"), results: results(), banner: banner() })
          .toEqual({ menu: true, read: true, results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("update could not be read; the computer comes back; the success's own read answers; the controller's read after the update and the detail's reads time out: nothing brought the detail up to date, so the result stays listed", async () => {
        const world = host();
        world.hold = timesOut;
        await open(390);
        await update();
        expect(banner()).toContain("plugins.checks.waitingOne");
        fixture.online = false; await rerender();
        const base = world.reads;
        world.hold = (label) => Number(label.slice(5)) === base + 1 ? undefined : Promise.resolve(false);
        fixture.read.mockImplementation(async () => { throw new Error("[TIMEOUT] remote invoke timed out"); });
        fixture.online = true; await rerender();
        await settle(40);
        expect({ detail: fixture.props.get("detail").model.status, results: results(), banner: banner() })
          .toEqual({ detail: "loadFailed", results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("update; the app goes to the background before the reads are back; they answer in the background, where this detail's own read does not land: listed until it does, back in front", async () => {
        let release!: () => void;
        const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
        const world = host();
        world.hold = () => held;
        await open(390);
        await update();
        await act(async () => { fixture.appStateListeners.forEach((listener) => listener("background")); });
        await settle(14);
        world.hold = () => undefined;
        release();
        await settle(30);
        expect(results()).toEqual([{ entry: "update", result: "succeeded", readback: "verified", told: false }]);
        await act(async () => { fixture.appStateListeners.forEach((listener) => listener("active")); });
        await settle(30);
        expect({ results: results(), banner: banner() }).toEqual({ results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      // Pre-push review, round 6; each failed on 84ddb5043c. Seen only on a detail read after the result was proven
      // (also when the reads after the update land in one commit); and a read the person's own press issued after the
      // result was proven is that read (nothing reads the detail a second time).
      const snapshots = (world: any) => world.asked.filter((id: string) => id === "management:snapshot").length;
      it.each([["wide", 900], ["narrow", 390]] as const)("%s: update from the detail over the plugin's own page; back to the page; it ends; the details button: the detail is read once, the computer is not read again", async (_name, width) => {
        const world = host();
        fixture.read.mockImplementation(async () => ({ ...row().item, actions: [{ id: "disable", label: "Enabled" }, { id: "open:panel", label: "Open" }], blocks: [] }));
        await open(width);
        await act(async () => fixture.props.get("detail").onOpen("panel"));
        await settle(10);
        await act(async () => fixture.props.get("header").right.props.onPress());
        await settle(14);
        let release!: () => void;
        const installing = new Promise<void>((resolve) => { release = resolve; });
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args: any[], options: any) => {
          const reply = await original(device, channel, args, options);
          if (args?.[0]?.actionId === "management:begin") await installing;
          return reply;
        });
        await update();
        await act(async () => fixture.props.get("header").onBack());
        await settle(10);
        release();
        await settle(40);
        fixture.read.mockClear();
        const before = snapshots(world);
        await act(async () => fixture.props.get("header").right.props.onPress());
        await settle(30);
        expect({ detailReads: detailReads(), snapshots: snapshots(world) - before, results: results() })
          .toEqual({ detailReads: ["mac:demo"], snapshots: 0, results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }] });
      });
      // Pre-push review, round 9 (the rows after each control failed from 8a456c9f59 on, and pass on c6efda5691): the
      // result comes with the write's own reply after the connection moved on meanwhile (the app left the foreground
      // for a moment while the computer worked). The read after the result answered, but was issued with the request's
      // old token and thrown away: the detail kept the old version and its Update; an uninstalled plugin's detail stayed.
      const whileTheComputerWorks = () => {
        let release!: () => void;
        const working = new Promise<void>((resolve) => { release = resolve; });
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args: any[], options: any) => {
          const reply = await original(device, channel, args, options);                   // begin is written and reaches the computer
          if (args?.[0]?.actionId === "management:begin") await working;                  // its reply comes when the computer is done
          return reply;
        });
        return release;
      };
      const blipInBackground = async () => {
        await act(async () => { fixture.appStateListeners.forEach((listener) => listener("background")); }); await settle(14);
        await act(async () => { fixture.appStateListeners.forEach((listener) => listener("active")); }); await settle(14);
      };
      it.each([["control: no blip", false], ["the app leaves the foreground for a moment while the computer updates", true]] as const)(
        "update from the installed detail; %s; begin's reply says succeeded and every read answers: the detail is brought up to date and it is listed until seen in the list", async (_name, blip) => {
          const world = host();
          fixture.read.mockImplementation(async () => ({ ...row().item, blocks: [{ id: "version", fallbackMarkdown: world.plugin.manifest.version }] }));
          world.operation = () => ({ operationId: world.operationId, phase: "running" });
          await open();
          const release = whileTheComputerWorks();
          await update();
          if (blip) await blipInBackground();
          fixture.read.mockClear();
          await act(async () => { release(); });
          await settle(40);
          expect({ actions: menuActions(), detailReadAgain: detailReads().length > 0, version: fixture.props.get("detail").model.version, results: results(), banner: banner() })
            .toEqual({ actions: ["uninstall"], detailReadAgain: true, version: "2", results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
        });
      it.each([["control: no blip", false], ["the app leaves the foreground for a moment while the computer uninstalls", true]] as const)(
        "uninstall from the installed detail; %s; begin's reply says succeeded and every read answers: the detail of the plugin that is gone closes", async (_name, blip) => {
          const world = host();
          world.operation = () => ({ operationId: world.operationId, phase: "running" });
          await open();
          const release = whileTheComputerWorks();
          fixture.alert.mockClear();
          await act(async () => { void menu().props.onAction("uninstall"); });
          await act(async () => fixture.alert.mock.calls.at(-1)![2][1].onPress());
          await settle(20);
          if (blip) await blipInBackground();
          await act(async () => { release(); });
          await settle(40);
          fixture.props.delete("detail");
          await rerender();
          expect({ results: results().map((item: any) => item.result), detailStillOpen: fixture.props.has("detail") }).toEqual({ results: ["succeeded"], detailStillOpen: false });
        });
      // Pre-push review, round 8 (failed on 251f7dd5fc: opening the plugin's own page moved the selection on without
      // reading the detail, and was taken for a detail read).
      it.each([["wide", 900], ["narrow", 390]] as const)("%s: update; the result is in and the reads after it are out; the person opens the plugin's own page; the reads land: no detail was read, so the result is not seen yet", async (_name, width) => {
        let release!: () => void;
        const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
        const world = host();
        world.hold = () => held;
        fixture.read.mockImplementation(async () => ({ ...row().item, actions: [{ id: "disable", label: "Enabled" }, { id: "open:panel", label: "Open" }], blocks: [] }));
        await open(width);
        await update();
        expect(results()).toEqual([{ entry: "update", result: "succeeded", readback: "pending", told: false }]);
        fixture.read.mockClear();
        await act(async () => fixture.props.get("detail").onOpen("panel"));
        await settle(10);
        const onPluginPage = () => ({ menu: !!fixture.props.get("header").rightToolbar, detailsButton: fixture.props.get("header").right?.props?.accessibilityLabel });
        expect(onPluginPage()).toEqual({ menu: false, detailsButton: "plugins.details" });
        world.hold = () => undefined;
        release();
        await settle(40);
        expect({ ...onPluginPage(), detailReads: detailReads(), results: results() }).toEqual({ menu: false, detailsButton: "plugins.details", detailReads: [],
          results: [{ entry: "update", result: "succeeded", readback: "verified", told: false }] });
      });
    });

    // Group 3 (03:54 #3): a next page N is queued by scrolling, then a new search is typed and settles; its first
    // page S and count C are held too. Every request that leaves must match the list and search on screen then.
    it.each(orderings(["N", "S", "C"]).map((order) => [order.join(" → "), order] as const))("scroll queued, then a new search: %s", async (_label, order) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const g = gates();
        let typed = "";
        const leftWith: Array<{ query: string; cursor: unknown; screen: string }> = [];
        queuedWire((request) => {
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          const query = request.input?.query?.query ?? "";
          leftWith.push({ query, cursor: request.input?.query?.cursor, screen: typed });
          return { ...marketPage([marketItem(query ? "found" : "demo", query ? "Found" : "Demo")]), nextCursor: query ? null : "cursor-1",
            counts: request.input?.query?.counts ? { public: 1, organization: 0, personal: 0, custom: 0, official: 1, community: 0, all: 1 } : null };
        }, (request) => {
          if (request === "manifest" || request.input?.read !== "catalog") return undefined;
          const q = request.input.query;
          if (q.cursor) return g.hold("N");
          if (q.query === "rota") return g.hold(q.counts ? "C" : "S");
          return undefined;
        });
        await openMarket();
        await act(async () => shownMarket().loadMore());
        await settle(6);
        typed = "rota";
        await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "rota" } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await settle(6);
        for (const step of order) { g.release(step); await settle(10); }
        // Invariant ④: nothing left for a list or search no longer on screen.
        for (const sent of leftWith.filter((entry) => entry.query || entry.cursor)) expect(sent.query).toBe(sent.screen);
        expect(leftWith.filter((entry) => entry.cursor)).toEqual([]);
        expect(shownMarket().items.map((row: any) => row.name)).toEqual(["Found"]);
      } finally { vi.useRealTimers(); }
    });
  });
});

/* 测试价值（推送前自查第九轮，2026-11-26：补上两条没有用例守着的规则）
 * - 生产入口与可观察结果：生产的 usePluginManagement / usePluginPendingChecks / 记录存储 + client / controller，只替换传输；
 *   观察这笔成功的结论。
 * - 依据：plugin-mobile-implementation.md「成功之后只有一个读取方 · 读取」：同一操作再读时只认最新发出的那次；电脑在读取
 *   还没回来时离线，这次读取当场按失败结束，它自己的回包后到也不算。
 * - 现有覆盖缺口：去掉 `readBack` 里「只认最新一次」的判断，全部插件用例仍然通过。
 * - 最小失败输入：见各用例名（现行实现通过；去掉上述判断后失败）。tier: unit（jsdom，内存 Host）。
 */
describe("the store's read of a success: only the newest read issued settles it", () => {
  const detail: any = { pluginId: "market/demo", ghostId: "demo", namespace: null, name: "Demo", releaseId: "r1", version: "1",
    sourceType: "server", installState: "not-installed", manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1" },
    description: null, author: null, scope: "public", organizationId: null, defaultInstall: false, publishedAt: "", icon: null,
    enabled: null, sourceMarketName: null };
  const ghost: any = { instanceKey: "_root__demo", namespace: null, enabled: true, manifest: detail.manifest,
    approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } };
  let management: any;
  function View() { management = usePluginManagement("mac", true, true, "probe", false, "installed"); return null; }
  function Page({ online, view }: { online: boolean; view: boolean }) {
    usePluginPendingChecks(() => online, true, ["mac"]);
    usePluginCheckConclusions();
    return view ? createElement(View) : null;
  }
  /** A computer that installs on begin; every installed read after it is held until the test answers it. */
  async function installed() {
    const host = { there: false };
    const reads: Array<(ok: boolean) => void> = [];
    let held = false;
    const facts = () => ({ version: 1, ghosts: host.there ? [ghost] : [],
      market: { items: host.there ? [{ ...detail, installState: "installed", installedOperationId: "screen-operation", installedOperationAttribution: "self" }] : [],
        unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] } });
    fixture.realManagement = true;
    fixture.wire.mockImplementation(async (_device: string, channel: string, args?: any[], options?: any) => transportSend(options, async () => {
      if (channel.endsWith(":manifest")) return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
      const request = args?.[0] ?? {};
      if (request.actionId === "management:snapshot") {
        if (!held) return { effects: [], result: facts() };
        return new Promise((resolve, reject) => { reads.push((ok) => ok ? resolve({ effects: [], result: facts() }) : reject(new Error("[TIMEOUT] remote invoke timed out"))); });
      }
      if (request.actionId === "management:market-detail") return { effects: [], result: detail };
      if (request.actionId === "management:begin") { held = true; host.there = true; return { effects: [], result: { operationId: request.input.operationId, phase: "succeeded" } }; }
      throw new Error("unexpected " + request.actionId);
    }));
    const page = { online: true, view: true };
    const render = async () => { await act(async () => root.render(createElement(Page, { ...page }))); await settle(10); };
    await render();
    const slot = pluginManagementSlotFor();
    const token = slot.tryAcquire("market-install", { name: "Demo", deviceId: "mac", deviceName: "Mac", pluginId: detail.pluginId, ghostId: "demo" })!;
    await act(async () => { void management.controller.install(detail, undefined, pluginOperationHold(slot, token)); });
    await settle(12);
    // reads[0] is the store's own read of the success, reads[1] the controller's; the view (and its controller) goes.
    expect(reads).toHaveLength(2);
    reads[1](true);
    page.view = false; await render();
    const answer = async (index: number, ok = true) => { await act(async () => { reads[index](ok); }); await settle(10); };
    const conclusion = () => { const [item]: any[] = __retainedForTests.conclusions(); return { result: item.result, readback: item.readback }; };
    return { host, reads, page, render, answer, conclusion };
  }
  it("\"Read again\" while the first read is out; the newer read says the plugin is gone; the first read's reply (still proving it) lands last: gone", async () => {
    const w = await installed();
    await act(async () => { void retryPluginCheckReadback("screen-operation"); });
    await settle(10);
    expect(w.reads).toHaveLength(3);
    w.host.there = false;
    await w.answer(2);                       // the newest read: uninstalled since
    expect(w.conclusion()).toEqual({ result: "succeeded", readback: "gone" });
    w.host.there = true;
    await w.answer(0);                       // the first read's reply lands last
    expect(w.conclusion()).toEqual({ result: "succeeded", readback: "gone" });
  });
  it("the computer goes offline while the read is out (it ends as not read); that read's own reply lands after all: still not read", async () => {
    const w = await installed();
    w.page.online = false; await w.render();
    expect(w.conclusion()).toEqual({ result: "succeeded", readback: "failed" });
    await w.answer(0);
    expect(w.conclusion()).toEqual({ result: "succeeded", readback: "failed" });
  });
});

/* 测试价值（推送前自查第十轮，2026-11-26）
 * - 生产入口与可观察结果：聊天里的页面批准提示（PluginUiEnablePrompt，生产 controller / client），只替换传输；观察写出的
 *   begin / cancel。
 * - 依据：聊天发起的操作不是插件页的待核实记录，视图走开后没有任何地方能再答复它，所以离开它展示过的确认仍要取消
 *   （主干在销毁时取消）。上一版把「结果暂时未知就不算展示过」用在了所有操作上，这个入口的确认会留在电脑上没人管。
 * - 最小失败输入：见用例名；对照行改前也通过，另一行在 f2f5038007 上失败。tier: unit（jsdom，内存 Host）。
 */
describe("the chat's page-approval prompt (an operation no entry of the plugins page started)", () => {
  const plugin: any = { instanceKey: "demo", namespace: null, enabled: true,
    manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1", tools: [{ name: "open" }], mcpApps: { ui: { resources: [{ uri: "ui://form", file: "ui/form.html" }], tools: { open: { resourceUri: "ui://form" } } } } },
    approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } };
  const snapshot = () => JSON.parse(JSON.stringify({ version: 1, settingsPage: true, uiCapabilityApproval: true, ghosts: [plugin],
    market: { items: [], unavailableCustomSourceNames: [], unavailableReason: null, customSourceNames: [] } }));
  const consent = (operationId: string) => ({ operationId, phase: "confirmation", consent: { requestId: "consent-1", initiator: "user", origin: "market",
    facts: { kind: "install", ghostId: "demo", name: "Demo", version: "1", permissions: [] } } });
  it.each([["control: nothing else happens", false], ["the app goes to the background and back, and the person leaves the chat while the lookup on return is still out", true]] as const)(
    "the consent is on screen; %s; the person leaves the chat: the consent is cancelled once", async (_name, blip) => {
      let lookup: Promise<void> | undefined, release = () => {};
      const requests = marketWire(async (request) => {
        switch (request.actionId) {
          case "management:snapshot": return snapshot();
          case "management:begin": return consent(request.input.operationId);
          case "management:operation": if (lookup) await lookup; return consent(request.input.operationId);
          case "management:cancel": return { operationId: request.input.operationId, phase: "cancelled" };
          default: throw new Error("unexpected " + request.actionId);
        }
      });
      fixture.platform = "android"; fixture.realConfirmation = true;
      const written = () => requests.filter((request) => /management:(begin|answer|cancel)/.test(request.actionId ?? "")).map((request) => request.actionId!.replace("management:", ""));
      await act(async () => root.render(createElement(PluginUiEnablePrompt, { deviceId: "mac", deviceName: "Mac", online: true, active: true })));
      await settle(20);
      await act(async () => { fixture.props.get("plugins.uiApproval").actions[0].onPress(); });
      await settle(30);
      const controller = fixture.props.get("observedManagement").controller;
      expect({ written: written(), outcome: controller.getState().outcome, shown: controller.mayCancel() }).toEqual({ written: ["begin"], outcome: "confirmation", shown: true });
      if (blip) {
        lookup = new Promise<void>((resolve) => { release = resolve; });
        await act(async () => { fixture.appStateListeners.forEach((listener) => listener("background")); }); await settle(14);
        await act(async () => { fixture.appStateListeners.forEach((listener) => listener("active")); }); await settle(14);
        expect(controller.getState()).toMatchObject({ outcome: "unknown", busy: true });
      }
      await act(async () => root.render(createElement("div")));
      await settle(14);
      release();
      await settle(40);
      expect({ written: written(), kept: __retainedForTests.size(), listed: __retainedForTests.checks().length })
        .toEqual({ written: ["begin", "cancel"], kept: 0, listed: 0 });
    });
});

/* 测试价值（推送前自查第十轮，2026-11-26：展示过、视图走开、又没被取消的确认）
 * - 生产入口与可观察结果：生产的记录存储 + controller + client + 记录面板与确认面板，只替换传输；观察写出的请求与面板上
 *   有没有「查看并决定」。
 * - 依据：plugin-mobile-implementation.md「记录面板」一条末尾：没有任何面板在显示的确认，在记录面板里只读等待
 *   「查看并决定」。
 * - 现有覆盖缺口与最小失败输入：三种走法在 c6efda5691 到 f2f5038007 上都停在「等待确认 / 核实结果」，面板不提供它：
 *   已答复后电脑要第二个确认；离开时的取消在写出前被拒；位置被别的操作占着、取消写不出去。tier: unit（jsdom，内存 Host）。
 */
describe("a consent that was shown, left, and not cancelled waits in the list for \"View and decide\"", () => {
  const detail = { ...marketItem("demo", "Demo"), manifest: { schemaVersion: 3, id: "demo", name: "Demo", version: "1", kind: "chip" } };
  const byId = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
  type Host = { begin?: (request: any) => unknown; answer?: (request: any) => unknown; operation?: (request: any) => unknown; refuseCancel?: boolean; loseBegin?: boolean };
  function wire(host: Host) {
    const written: string[] = [], asked: string[] = [];
    fixture.realManagement = true;
    fixture.wire.mockImplementation(async (_device: string, channel: string, args?: any[], options?: any) => {
      options?.preSend?.();
      if (channel.endsWith(":manifest")) { options?.onRequestWritten?.();
        return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] }; }
      const request = args?.[0] ?? {};
      const action = String(request.actionId).replace("management:", "");
      if (["begin", "answer", "cancel"].includes(action)) asked.push(action);
      if (action === "cancel" && host.refuseCancel) { options?.onNotSent?.(); throw new Error("[LINK_NOT_OPEN] refused before the first write"); }
      options?.onRequestWritten?.();
      if (["begin", "answer", "cancel"].includes(action)) written.push(action);
      if (action === "snapshot") return { effects: [], result: { version: 1, ghosts: [], market: { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] } } };
      if (action === "market-detail") return { effects: [], result: detail };
      if (action === "begin") { if (host.loseBegin) throw new Error("[TIMEOUT] remote invoke timed out"); return { effects: [], result: host.begin!(request) }; }
      if (action === "answer") return { effects: [], result: host.answer!(request) };
      if (action === "operation") return { effects: [], result: host.operation!(request) };
      if (action === "cancel") return { effects: [], result: { operationId: request.input.operationId, phase: "cancelled" } };
      throw new Error("unexpected " + action);
    });
    return { written, asked };
  }
  let management: ReturnType<typeof usePluginManagement>;
  /** What the page mounts for one operation: the hook and its confirmation sheet (which marks the consent it shows). */
  function View() {
    management = usePluginManagement("mac", true, true, "probe", false, "installed");
    return management.state && management.controller
      ? createElement(PluginManagementConfirmation, { state: management.state, controller: management.controller, deviceName: "Mac", active: true }) : null;
  }
  function Page({ view }: { view: boolean }) {
    const checks = usePluginPendingChecks(() => true, true, ["mac"]);
    const conclusions = usePluginCheckConclusions();
    return createElement("div", null, view ? createElement(View) : null,
      createElement(PluginPendingChecksSheet, { visible: true, conclusions, isOnline: () => true, listed: () => true,
        lines: checks.map((check) => ({ key: check.operationId, entry: check.entry, who: check.who, check })),
        onDecide: () => false, onClose: () => {}, onShowInstalled: () => {} }));
  }
  const render = async (view: boolean) => { await act(async () => root.render(createElement(Page, { view }))); await settle(20); };
  async function install() {
    await render(true);
    const slot = pluginManagementSlotFor();
    const token = slot.tryAcquire("market-install", { name: "Demo", deviceId: "mac", deviceName: "Mac", pluginId: "market/demo", ghostId: "demo" })!;
    await act(async () => { void management.controller!.install(detail as any, undefined, pluginOperationHold(slot, token)); });
    await settle(30);
  }
  const consent2 = (request: any) => ({ ...demoConsent(request), consent: { ...demoConsent(request).consent, requestId: "consent-2" } });
  const listed = () => { const check: any = __retainedForTests.checks()[0];
    return { outcome: check?.state.outcome, request: check?.state.receipt?.consent?.requestId, awaitingYou: check?.awaitingYou, decide: !!byId("plugins.checks.decide") }; };
  it("Allow is written, the computer asks again, that consent is shown, the view goes: not cancelled (it was answered once), and the list offers it", async () => {
    const sent = wire({ begin: demoConsent, answer: consent2, operation: consent2 });
    await install();
    await act(async () => { await management.controller!.answer(true); });
    await settle(20);
    expect(management.state).toMatchObject({ outcome: "confirmation", receipt: { consent: { requestId: "consent-2" } }, answerHeld: null });
    await render(false);                                             // the view goes; the page stays
    expect(sent.written).toEqual(["begin", "answer"]);
    expect(listed()).toEqual({ outcome: "confirmation", request: "consent-2", awaitingYou: true, decide: true });
  });
  it("the cancel for leaving is refused before its first write; \"Check result\" finds the same consent again: the list offers it", async () => {
    const sent = wire({ begin: demoConsent, operation: demoConsent, refuseCancel: true });
    await install();
    expect(management.state).toMatchObject({ outcome: "confirmation" });
    await render(false);
    expect({ asked: sent.asked, written: sent.written }).toEqual({ asked: ["begin", "cancel"], written: ["begin"] });
    await act(async () => { await __retainedForTests.checks()[0].verify(); });
    await settle(30);
    await render(false);
    expect(sent.asked).toEqual(["begin", "cancel"]);                 // never a second cancel
    expect(listed()).toMatchObject({ outcome: "confirmation", awaitingYou: true, decide: true });
  });
  it("another plugin took the computer's slot; \"Check result\" finds a consent, it is shown, the view goes: nothing can be cancelled, and the list offers it", async () => {
    const host: Host = { loseBegin: true, operation: () => ({ phase: "nonsense" }) };
    const sent = wire(host);
    await install();                                                 // begin is written, its reply lost
    expect(management.state).toMatchObject({ outcome: "unknown" });
    await act(async () => { await management.controller!.reconcile(); });   // a protocol error: lookups stop
    await settle(20);
    const slot = pluginManagementSlotFor();
    expect(slot.holder("mac")).toBeNull();
    expect(slot.tryAcquire("uninstall", { name: "Other", deviceId: "mac", deviceName: "Mac", instanceKey: "_root__other", ghostId: "other" })).not.toBeNull();
    host.operation = demoConsent;
    await act(async () => { await management.controller!.reconcile(); });   // "Check result": the computer waits for an answer
    await settle(20);
    expect(management.state).toMatchObject({ outcome: "confirmation" });
    expect(management.controller!.consentUnseen()).toBe(false);      // its view is showing it
    await render(false);
    await render(false);
    expect({ asked: sent.asked, written: sent.written }).toEqual({ asked: ["begin"], written: ["begin"] });
    expect(listed()).toMatchObject({ outcome: "confirmation", awaitingYou: true, decide: true });
  });
});
