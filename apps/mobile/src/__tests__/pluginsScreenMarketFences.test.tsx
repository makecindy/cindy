// @vitest-environment jsdom
import { fixture, root, transportSend, marketItem, demoConsent, approveOnPhone, marketPage, settle, openMarket, shownMarket, hostError, attributed, managementSnapshot } from "./pluginsScreenHarness";
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import PluginsScreen from "@/plugins/PluginsScreen";
// The plugins page's market read fences and lost-receipt facts (the order matrices); the rest of the page's cases are in
// pluginsScreen.test.tsx. Split to keep each file within the unit budget; both share pluginsScreenHarness.tsx.

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
      // The read-back after the install fails, so there is no instance to open (the case with no instanceKey).
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
    expect(shownMarket().detail).toBeNull();
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
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
  });
  // Maintainer review 03:54 #1: tapping "Check result" again starts a new round before its operation query returns.
  it("does not let the first round's detail settle while the second round's operation query is in flight", async () => {
    let verifying = false, round = 0;
    const firstDetail = deferred(), secondQuery = deferred();
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(verifying);
        case "management:market-detail": return { ...item, installState: verifying ? "installed" : "not-installed", ...(verifying ? { installedOperationId: "screen-operation", installedOperationAttribution: "self" } : {}), manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": verifying = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (request === "manifest") return undefined;
      if (verifying && request.actionId === "management:market-detail" && round === 1) return firstDetail.promise;
      if (request.actionId === "management:operation" && ++round === 2) return secondQuery.promise;
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(6);
    // The first round's detail would say "installed"; the second round's query has not returned yet.
    await act(async () => { firstDetail.release(); });
    await settle(10);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" });
    await act(async () => { secondQuery.release(); });
    await settle(14);
    // The second round reads its own facts and settles: the plugin is installed from this release.
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(true);
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
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(true);
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
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    // C lands with the plugin installed: the result follows the newest facts.
    await act(async () => { readC.release(); });
    await settle(14);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(true);
  });
  // Maintainer review 04:20: a newer installed snapshot replaces the facts, so a market detail read on the older
  // facts must not settle the result.
  it("drops a market detail read on facts that a newer installed snapshot replaced", async () => {
    const heldDetail = deferred();
    let began = false, present = true, holdDetail = false;
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
      if (holdDetail && request !== "manifest" && request.actionId === "management:market-detail") {
        holdDetail = false;
        return heldDetail.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    holdDetail = true;
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    // The facts after NOT_FOUND showed the same-id instance; its market detail is in flight. Then the instance
    // is removed and a plugin-change refresh lands with the newer facts.
    expect(holdDetail).toBe(false);
    present = false;
    await act(async () => { await fixture.props.get("confirmation").controller.refresh(); });
    await settle(14);
    await act(async () => { heldDetail.release(); });
    await settle(14);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
  });
  // Maintainer review 05:04: facts settle a result only while they come from the newest installed read issued.
  // Instead of hand-picked orders, run every order of: A (read after NOT_FOUND) returns, a plugin-change refresh B
  // is sent, the market detail read on the facts returns, B returns (B is always sent before it returns).
  // A shows the same-id instance; the detail always says "installed" (a stale detail is the dangerous case).
  const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
    : items.flatMap((first, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
  type Step = "releaseA" | "sendB" | "releaseDetail" | "releaseB";
  const orders = permutations<Step>(["releaseA", "sendB", "releaseDetail", "releaseB"])
    .filter((order) => order.indexOf("sendB") < order.indexOf("releaseB"));
  describe.each([["B still shows the instance", true], ["B shows it removed", false]])("every reply order when %s", (_case, bPresent) => {
    it.each(orders.map((order) => [order.join(" → "), order] as const))("settles only on the newest installed read: %s", async (_label, order) => {
      const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
      const gate = (label: string) => {
        if (!gates.has(label)) { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); gates.set(label, { promise, release }); }
        return gates.get(label)!;
      };
      let began = false, checking = false, sentA = false, sentB = false, sentDetail = false, bIssued = false, bReturned = false;
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
        if (request.actionId === "management:market-detail" && !sentDetail) { sentDetail = true; return gate("detail").promise; }
        return undefined;
      });
      await openMarket();
      await act(async () => shownMarket().install(shownMarket().items[0]));
      await settle(14);
      await approveOnPhone();
      checking = true;
      await act(async () => { void shownMarket().checkResult(item); });
      await settle(14);
      const opened = () => fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");
      let openedBeforeB = false;
      for (const step of order) {
        if (step === "sendB") { bIssued = true; await act(async () => { void fixture.props.get("confirmation").controller.refresh(); }); }
        else gate(step === "releaseA" ? "A" : step === "releaseB" ? "B" : "detail").release();
        await settle(14);
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
   * - 剪枝：A 的回包固定在最前（维护者 05:04 点名的顺序即以它开头）；其余事件 B 发出 / 回包、C 发出 / 回包、按 A 的
   *   事实发起的市场详情回包、再次点核实的全部合法先后顺序（发出先于回包，C 在 B 之后发出）都在集合里，共 90 种 × 两种
   *   内容。对应关系：05:04「B 挂起时先放行旧详情」= A → 发 B → 详情 → B 回包；03:54 #1「第一轮详情在途时再次核实」=
   *   A → 核实 → 详情……。tier: unit。
   * - 每一步之后断言：结论第一次出现时，最新发出的已装读取已回包且结论与它的内容一致；最新读取在途时仍待确认。
   *   全部回包后有结论，且等于最新一次读取的内容。
   */
  describe("every order with a third installed read and a second check", () => {
    type Step = "sendB" | "releaseB" | "sendC" | "releaseC" | "releaseDetail" | "check";
    const perms = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
      : items.flatMap((first, index) => perms([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [first, ...rest]));
    const legal = (order: Step[]) => order.indexOf("sendB") < order.indexOf("releaseB") && order.indexOf("sendC") < order.indexOf("releaseC")
      && order.indexOf("sendB") < order.indexOf("sendC");
    const core = perms<Step>(["sendB", "releaseB", "sendC", "releaseC", "releaseDetail"]).filter(legal);
    const all = core.flatMap((order) => Array.from({ length: order.length + 1 }, (_, at) => [...order.slice(0, at), "check" as Step, ...order.slice(at)]));
    it("has the orders the maintainer named among them", () => {
      expect(all).toHaveLength(90);
      expect(all.some((order) => order.join() === "sendB,releaseDetail,releaseB,sendC,releaseC,check")).toBe(true);
      expect(all.some((order) => order.join() === "check,releaseDetail,sendB,releaseB,sendC,releaseC")).toBe(true);
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
          let began = false, checking = false, wanted: "B" | "C" | null = null, sentDetail = false;
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
            if (request.actionId === "management:market-detail" && !sentDetail) { sentDetail = true; return gate("detail").promise; }
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
          const opened = () => fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");
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
            } else gate(step === "releaseB" ? "B" : step === "releaseC" ? "C" : "detail").release();
            await settle(14);
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
    const opened = () => fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo");

    // Group 1 (03:54 #1): round 1's market detail D1 ("installed") is in flight when "Check result" starts round 2,
    // whose operation query Q2 is held. Round 2's facts either still show the plugin or show it gone.
    describe.each([["round 2 still finds the plugin", true], ["round 2 finds it gone", false]])("check result twice: %s", (_c, presentInRound2) => {
      it.each(orderings(["D1", "Q2"]).map((order) => [order.join(" → "), order] as const))("%s", async (_label, order) => {
        const g = gates();
        let began = false, round = 0, queries = 0, details = 0;
        queuedWire((request) => {
          switch (request.actionId) {
            case "management:snapshot":
              if (request.input?.read === "capabilities") return { catalogPaging: true };
              if (request.input?.read === "catalog") return marketPage([item]);
              return managementSnapshot(began && (round < 2 || presentInRound2));
            case "management:market-detail": return { ...item, installState: began ? "installed" : "not-installed", ...(began ? { installedOperationId: "screen-operation", installedOperationAttribution: "self" } : {}), manifest: demoManifest };
            case "management:begin": return demoConsent(request);
            case "management:answer": began = true; throw new Error("[TIMEOUT] remote invoke timed out");
            case "management:operation": throw hostError("NOT_FOUND");
            default: throw new Error("unexpected " + request.actionId);
          }
        }, (request) => {
          if (request === "manifest" || !began) return undefined;
          if (request.actionId === "management:operation" && ++queries === 2) return g.hold("Q2");
          if (request.actionId === "management:market-detail" && ++details === 1) return g.hold("D1");
          return undefined;
        });
        await openMarket();
        await act(async () => shownMarket().install(shownMarket().items[0]));
        await settle(14);
        await approveOnPhone();
        round = 1;
        await act(async () => { void shownMarket().checkResult(item); });
        await settle(14);
        round = 2;
        await act(async () => { void shownMarket().checkResult(item); });
        await settle(6);
        let q2Returned = false;
        for (const step of order) {
          g.release(step);
          if (step === "Q2") q2Returned = true;
          await settle(14);
          // Invariant ①/②: until round 2 has its own facts, round 1's detail gives no result.
          if (!q2Returned) { expect(opened()).toBe(false); expect(shownMarket().rowState(item)).toEqual({ kind: "unknown" }); }
        }
        if (presentInRound2) expect(opened()).toBe(true);
        else {
          expect(opened()).toBe(false);
          expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedNotInstalled" });
        }
      });
    });

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
            return managementSnapshot(present);
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
            return managementSnapshot(present);
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
    // result and published. Two orders the maintainer reproduced, through the page: (1) the computer goes offline while
    // the row waits for its read, which times out, and comes back (the row must end, and the reconnect read take over:
    // the record's read opens the instance it proves); (2) a plugin-change refresh is sent while the row's read is out
    // and its reply is held: the row's read lands without being published, and must not settle on the snapshot from
    // before the install. Only reads go out after Allow; begin and Allow once each. Both failed on c6efda5691 (stuck
    // "installing"; "not on this computer now"). Tier: unit/jsdom.
    describe("a success read again around a disconnect or a plugin-change refresh (maintainer review 03:52)", () => {
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
        expect(shownMarket().installBusy).toBe(true);
        fixture.online = false;
        await act(async () => root.render(createElement(PluginsScreen)));
        g.release("reads");
        await settle(14);
        // The row ended (another market install may start); nothing was opened on facts it did not read.
        expect(held.length).toBeGreaterThan(0);
        expect(shownMarket().installBusy).toBe(false);
        expect(opened()).toBe(false);
        offline = false;
        fixture.online = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await settle(20);
        // A read after the reconnect proves this install (V2.10 ①): its instance opens.
        expect(opened()).toBe(true);
        expect(writes(sent)).toEqual(["management:begin", "management:answer"]);
      });
      it("a plugin-change refresh is sent while the row's read is out, and only that refresh's reply is held", async () => {
        const g = gates();
        const sent = successWire((label) => g.hold(label), () => false);
        await openMarket();
        await act(async () => shownMarket().install(shownMarket().items[0]));
        await settle(14);
        await act(async () => { void fixture.props.get("confirmation").controller.answer(true); });
        await settle(14);
        await act(async () => { fixture.resourceListeners.forEach((listener) => listener("mac", { collectionId: "plugins" })); });
        await settle(14);
        // Every read written so far answers (the row's own read among them, with the installed plugin) except the newest:
        // the plugin-change refresh, written last.
        const newest = sent.written();
        for (let read = 1; read < newest; read++) g.release(`installed-${read}`);
        await settle(40);
        // Nothing settles on the snapshot from before the install while the newer read is out.
        expect(shownMarket().installBusy).toBe(true);
        expect(opened()).toBe(false);
        expect(fixture.alert).not.toHaveBeenCalled();
        g.release(`installed-${newest}`);
        await settle(20);
        expect(opened()).toBe(true);
        expect(fixture.alert).not.toHaveBeenCalled();
        expect(writes(sent)).toEqual(["management:begin", "management:answer"]);
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
  it("ignores a market detail from an earlier verification that arrives late", async () => {
    let verifying = false;
    const details: Array<{ release: () => void; promise: Promise<void> }> = [];
    queuedWire((request) => {
      switch (request.actionId) {
        case "management:snapshot":
          if (request.input?.read === "capabilities") return { catalogPaging: true };
          if (request.input?.read === "catalog") return marketPage([item]);
          return managementSnapshot(verifying);
        case "management:market-detail":
          // The first verification's facts said "installed"; the second (newer) says "conflict".
          if (!verifying) return { ...item, manifest: demoManifest };
          return { ...item, installState: (request as any).verification === 1 ? "installed" : "conflict", manifest: demoManifest };
        case "management:begin": return demoConsent(request);
        case "management:answer": verifying = true; throw new Error("[TIMEOUT] remote invoke timed out");
        case "management:operation": throw hostError("NOT_FOUND");
        default: throw new Error("unexpected " + request.actionId);
      }
    }, (request) => {
      if (verifying && request !== "manifest" && request.actionId === "management:market-detail") {
        const gate = deferred();
        details.push(gate);
        (request as any).verification = details.length;
        return gate.promise;
      }
      return undefined;
    });
    await openMarket();
    await act(async () => shownMarket().install(shownMarket().items[0]));
    await settle(14);
    await approveOnPhone();
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    await act(async () => { void shownMarket().checkResult(item); });
    await settle(14);
    expect(details).toHaveLength(2);
    await act(async () => { details[0]!.release(); });
    await settle(10);
    await act(async () => { details[1]!.release(); });
    await settle(10);
    expect(fixture.read.mock.calls.some((call: any[]) => call[2]?.id === "_root__demo")).toBe(false);
    expect(shownMarket().rowState(item)).toEqual({ kind: "failed", messageKey: "plugins.market.unconfirmedMismatch" });
  });
});