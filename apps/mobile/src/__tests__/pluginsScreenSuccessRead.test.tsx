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
 * Proven as this install: concluded as done with its instance read from the computer. The page never opens a result by
 * itself; the person opens it from the list of checks ("Open plugin"), which the tests of that list cover.
 */
const provenDemo = () => __retainedForTests.conclusions().some((conclusion) => (conclusion.result === "succeeded" || conclusion.result === "installed")
  && conclusion.readback === "verified" && conclusion.instanceKey === "_root__demo");
// The plugins page's market read fences and lost-receipt facts (the order matrices); the rest of the page's cases are in
// The plugins page's "a market install's success: one read of the computer" cases, moved unchanged out of
// pluginsScreenMarketFences.test.tsx (same describe path) to keep each file within the per-file unit budget
// (engineering-conventions §3.2); both share pluginsScreenHarness.tsx. Tier: unit (jsdom, in-memory Host).
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

  const item = marketItem("demo", "Demo");
  const demoManifest = { schemaVersion: 3, id: "demo", name: "Demo", version: "1" };
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

    /* 测试价值（推送前自查，2026-11-26：成功之后只由记录自己的那一次读取收口）
     * - 生产入口与可观察结果：真实 PluginsScreen（市场行、确认面板、顶部提示、记录面板都是真实组件，点真实控件）+ 生产
     *   client / controller / 记录存储，只替换传输；观察写出的请求、提示、顶部提示、记录面板的按钮，以及打开了哪台电脑的哪个实例。
     * - 依据：维护者 03:52（成功后的回读要能收口、只打开核实过的实例）；控制端规则 ④（同一响应判定）；自查在 1a11e7bf18 上
     *   复现的问题：成功后市场行与记录各读一次、各下结论（一处说没能读取、另一处能打开；先核实的结论被后到的失败覆盖）；
     *   进后台、连续两次变更通知会把读到了的安装判成没能读取；整页重开后核实出的实例无处可开；③ 恢复后没有任何提示；
     *   重连先于读取超时、或电脑在页面失焦时回来，不再自动重读；电脑不在列表时记录无法放弃；响应里没有市场记录时说
     *   「电脑上现在没有这个插件」；安装前的条目不带 namespace 时永远不给打开；「打开」沿用旧读取。
     * - 现有覆盖缺口：原用例用 hook 函数发起安装、只扣住一种读取，没有同时观察市场行、顶部提示与记录面板。
     * - 最小失败输入：见各用例名（每条一个事件顺序或一种电脑返回的形状）；除两条对照外在 1a11e7bf18 上都失败。
     * - tier: unit（jsdom，内存 Host）。
     */
    describe("a market install's success: one read of the computer, shown the same everywhere (the page's own controls)", () => {
      const demo = marketItem("demo", "Demo"), notes = marketItem("notes", "Notes");
      const manifestOf = (id: string, name: string) => ({ schemaVersion: 3, id, name, version: "1" });
      const notesGhost = { ...demoGhost, instanceKey: "_root__notes", manifest: manifestOf("notes", "Notes") };
      const byId = (id: string) => element.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
      async function click(id: string) {
        const control = byId(id);
        expect(control, `${id} is on screen`).not.toBeNull();
        expect(control!.disabled, `${id} is available`).toBe(false);
        await act(async () => control!.click());
        await settle(14);
      }
      const holds = () => {
        const map = new Map<string, { promise: Promise<boolean>; release: (ok: boolean) => void }>();
        const get = (label: string) => {
          if (!map.has(label)) { let release!: (ok: boolean) => void; const promise = new Promise<boolean>((resolve) => { release = resolve; }); map.set(label, { promise, release }); }
          return map.get(label)!;
        };
        return { wait: (label: string) => get(label).promise, release: (label: string, ok = true) => get(label).release(ok) };
      };
      type World = {
        items: any[];
        /** ghostId → the operation that installed it. */
        installed: Map<string, string>;
        installedReads: number;
        /**
         * begin ("begin:<ghostId>"), Allow ("answer") and each installed read written once something is installed ("installed-N", in the order
         * written: the first is the success's own read): undefined answers at once; a promise holds the reply (the request
         * left the phone) and resolves to answered (true) or timed out (false).
         */
        hold: (label: string) => Promise<boolean> | undefined;
        /** What an installed read answers instead of the computer's usual snapshot (decided when it is written). */
        reply?: (snapshot: any) => unknown;
        /** begin answers with this final phase instead of a consent (per ghostId). */
        beginEnds?: (ghostId: string) => string | undefined;
        /** What a lookup of an operation answers (default: its consent again). */
        operation?: (operationId: string) => unknown;
        /** begin's / Allow's reply is lost (the write itself reached the computer). */
        loseBegin?: boolean; loseAnswer?: boolean;
        /** Allow reaches a computer that no longer has the operation and installs nothing (it restarted). */
        answerInstallsNothing?: boolean;
      };
      const fresh = (): World => ({ items: [demo, notes], installed: new Map(), installedReads: 0, hold: () => undefined });
      /** Every installed read times out (Allow answers). */
      const timesOut = (label: string) => label.startsWith("installed-") ? Promise.resolve(false) : undefined;
      const timeout = () => new Error("[TIMEOUT] remote invoke timed out");
      const consentFor = (operationId: string, entry: any) => ({ operationId, phase: "confirmation", consent: { requestId: "consent-" + operationId, initiator: "user", origin: "market",
        facts: { kind: "install", ghostId: entry.ghostId, name: entry.name, version: "1", permissions: [] } } });
      function wire(world: World) {
        const requests: MarketWireRequest[] = [];
        const operations = new Map<string, string>();
        fixture.realManagement = true;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => transportSend(options, async () => {
          if (channel.endsWith(":manifest")) return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
          const envelope = args?.[0] ?? {};
          const request = { device, actionId: envelope.actionId, input: envelope.input, resourceRef: envelope.resourceRef };
          requests.push(request);
          const result = await (async () => {
            switch (request.actionId) {
              case "management:snapshot": {
                if (request.input?.read === "capabilities") return { catalogPaging: true };
                // Like the computer with excludeInstalled: an installed plugin is not in the catalog.
                if (request.input?.read === "catalog") return marketPage(world.items.filter((entry) => !world.installed.has(entry.ghostId)));
                if (!world.installed.size) return managementSnapshot(false);
                // As the computer answers the phone that ran the install: the instance, and beside it the plugin's market
                // record with the namespace of the install and this phone's operation (contract V2.10 ①).
                const snapshot = { ...managementSnapshot(false),
                  ghosts: [demoGhost, notesGhost].filter((ghost) => world.installed.has(ghost.manifest.id)),
                  market: { ...managementSnapshot(false).market, items: world.items.filter((entry) => world.installed.has(entry.ghostId))
                    .map((entry) => ({ ...entry, namespace: null, installState: "installed", ...attributed(true, world.installed.get(entry.ghostId)) })) } };
                const reply = world.reply ? world.reply(snapshot) : snapshot;
                if ((await world.hold(`installed-${++world.installedReads}`)) === false) throw timeout();
                return reply;
              }
              case "management:market-detail": {
                const entry = world.items.find((candidate) => candidate.pluginId === request.input.pluginId)!;
                return { ...entry, installState: world.installed.has(entry.ghostId) ? "installed" : "not-installed", manifest: manifestOf(entry.ghostId, entry.name) };
              }
              case "management:begin": {
                const entry = world.items.find((candidate) => candidate.pluginId === request.input.pluginId)!;
                operations.set(request.input.operationId, entry.ghostId);
                // The write reached the computer; its reply can be held ("begin:<ghostId>": true answered, false timed out).
                if ((await world.hold(`begin:${entry.ghostId}`)) === false) throw timeout();
                if (world.loseBegin) throw timeout();
                const ends = world.beginEnds?.(entry.ghostId);
                if (ends) return { operationId: request.input.operationId, phase: ends, ...(ends === "failed" ? { errorCode: "PLUGIN_INSTALL_CHANGED" } : {}) };
                return consentFor(request.input.operationId, entry);
              }
              // Looked up while its consent waits (the app came back to the foreground): the same consent again.
              case "management:operation": {
                if (world.operation) return world.operation(request.input.operationId);
                const entry = world.items.find((candidate) => candidate.ghostId === operations.get(request.input.operationId))!;
                return consentFor(request.input.operationId, entry);
              }
              case "management:cancel": return { operationId: request.input.operationId, phase: "cancelled" };
              case "management:answer":
                if (request.input.confirmed === false) return { operationId: request.input.operationId, phase: "cancelled" };
                if (!world.answerInstallsNothing) world.installed.set(operations.get(request.input.operationId)!, request.input.operationId);
                if (world.loseAnswer) throw timeout();
                if ((await world.hold("answer")) === false) throw timeout();
                return { operationId: request.input.operationId, phase: "succeeded" };
              default: throw new Error("unexpected " + request.actionId);
            }
          })();
          return { effects: [], result };
        }));
        return requests;
      }
      /** Everything written about an operation, in order (the reads are counted by `world.installedReads`). */
      const writes = (requests: MarketWireRequest[]) => requests
        .filter((request) => ["management:begin", "management:answer", "management:cancel", "management:operation"].includes(request.actionId!))
        .map((request) => request.actionId!.replace("management:", "") + ":" + request.input?.operationId);
      const ONCE = ["begin:screen-operation", "answer:screen-operation"];
      /** Light installed reads written (the success's read and the market's own; an opened detail reads the full snapshot). */
      const lightReads = (requests: MarketWireRequest[]) => requests.filter((request) => request.actionId === "management:snapshot" && request.input?.read === "installed").length;
      /** Installed details the page opened, as "<computer>:<instance>". */
      const openedIds = () => fixture.read.mock.calls.map((call: any[]) => `${call[1]?.deviceId}:${call[2]?.id}`);
      const openedDemo = () => openedIds().includes("mac:_root__demo");
      const prompts = () => fixture.alert.mock.calls.map((call) => call[1]);
      const UNREAD = "plugins.checks.result.succeededUnread";
      const told = () => __retainedForTests.conclusions().map((item: any) => ({ readback: item.readback, told: !!item.told }));
      /** The one conclusion so far says "done, but could not be read". */
      const unreadLine = () => __retainedForTests.conclusions().map((item) => item.readback).join() === "failed";
      const banner = () => byId("plugins.slotHolder")?.textContent ?? "";
      const sheet = () => byId("plugins.checks")?.textContent ?? "";
      /** Real controls: the market segment, the row's Install, the consent sheet's Allow. */
      async function installAndAllow(pluginId = demo.pluginId) {
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${pluginId}`);
        await click("plugins.management.allow");
        await settle(14);
      }
      async function rerender() { await act(async () => root.render(createElement(PluginsScreen))); await settle(20); }
      async function leavePage() { await act(async () => root.render(createElement("div"))); await settle(6); }
      const changeNotification = async () => { await act(async () => { fixture.resourceListeners.forEach((listener) => listener("mac", { collectionId: "plugins" })); }); await settle(14); };
      const appState = async (next: string) => { await act(async () => { fixture.appStateListeners.forEach((listener) => listener(next)); }); await settle(14); };
      /** The install ended as "done, but could not be read": the row's prompt, and the success listed at the top. */
      async function installUnread(world: World) {
        world.hold = timesOut;
        await installAndAllow();
        // Nothing is prompted and nothing opens: the success is listed at the top as needing a check.
        expect({ prompts: prompts(), opened: openedIds(), sheet: unreadLine() }).toEqual({ prompts: [], opened: [], sheet: true });
        expect(banner()).toContain("plugins.checks.waitingOne");
        world.hold = () => undefined;
      }

      it("only the success's own read decides: other reads (the page's, two plugin-change refreshes) answering first settle nothing, and never \"could not read\"", async () => {
        const hold = holds();
        const world = { ...fresh(), hold: (label: string) => label.startsWith("installed-") ? hold.wait(label) : undefined };
        const requests = wire(world);
        await installAndAllow();
        expect(world.installedReads).toBe(2);       // the success's own read (#1) and the page's controller read (#2)
        await changeNotification();
        await changeNotification();
        for (let read = 2; read <= world.installedReads; read++) hold.release(`installed-${read}`);
        await settle(30);
        expect({ opened: openedDemo(), prompts: prompts() }).toEqual({ opened: false, prompts: [] });
        world.hold = () => undefined;
        hold.release("installed-1");
        await settle(20);
        expect({ proven: provenDemo(), opened: openedIds(), prompts: prompts(), banner: banner(), writes: writes(requests) })
          .toEqual({ proven: true, opened: [], prompts: [], banner: expect.stringContaining("plugins.checks.settledOne"), writes: ONCE });
      });
      it("Allow's reply arrives while the app is in the background: the reads answer, the proven install is listed, nothing says \"could not read\"", async () => {
        const hold = holds();
        const world = { ...fresh(), hold: (label: string) => label === "answer" ? hold.wait(label) : undefined };
        const requests = wire(world);
        await installAndAllow();
        await appState("background");
        hold.release("answer");
        await settle(30);
        await appState("active");
        await settle(20);
        expect({ proven: provenDemo(), opened: openedIds(), prompts: prompts(), banner: banner(), writes: writes(requests) })
          .toEqual({ proven: true, opened: [], prompts: [], banner: expect.stringContaining("plugins.checks.settledOne"), writes: ONCE });
      });
      it("the computer goes offline while the success's read is out and comes back before that read times out: the read ends at once, is read again on return, once, and the proven install is listed", async () => {
        const hold = holds();
        const world = { ...fresh(), hold: (label: string) => label.startsWith("installed-") ? hold.wait(label) : undefined };
        const requests = wire(world);
        await installAndAllow();
        const before = lightReads(requests);
        // Offline: the read that is out will not come back in time, so it ends now (the success needs a check).
        fixture.online = false; await rerender();
        expect(told()).toEqual([{ readback: "failed", told: false }]);
        world.hold = () => undefined;
        // Back online: read again by itself; the earlier read's late timeout changes nothing.
        fixture.online = true; await rerender();
        hold.release("installed-1", false); hold.release("installed-2", false);
        await settle(30);
        expect({ readAgain: lightReads(requests) > before, proven: provenDemo(), opened: openedIds(), prompts: prompts(), writes: writes(requests) })
          .toEqual({ readAgain: true, proven: true, opened: [], prompts: [], writes: ONCE });
        // Read again once for that reconnect, not in a loop.
        const settled = world.installedReads;
        await settle(30);
        expect(world.installedReads).toBe(settled);
      });
      it("could not be read; the computer comes back while another screen is in front: read again on returning to the page, listed, opened from the list", async () => {
        const world = fresh();
        const requests = wire(world);
        await installUnread(world);
        fixture.online = false; await rerender();
        fixture.focused = false; await rerender();
        const before = lightReads(requests);
        fixture.online = true; await rerender();
        // Not while the page is not in front.
        expect({ reads: lightReads(requests) - before, opened: openedDemo() }).toEqual({ reads: 0, opened: false });
        fixture.focused = true; await rerender();
        // Read again and proven; the page does not move by itself: listed as having a result, opened from the list.
        expect({ readAgain: lightReads(requests) > before, opened: openedDemo(), banner: banner() })
          .toEqual({ readAgain: true, opened: false, banner: expect.stringContaining("plugins.checks.settledOne") });
        await click("plugins.slotHolder.show");
        await click("plugins.checks.open");
        expect({ opened: openedDemo(), banner: banner(), writes: writes(requests) }).toEqual({ opened: true, banner: "", writes: ONCE });
      });
      it("could not be read; offline; the whole page is left and reopened; back online: read again, listed, and the proven instance opens from the list", async () => {
        const world = fresh();
        const requests = wire(world);
        await installUnread(world);
        fixture.online = false; await rerender();
        await leavePage();
        await rerender();
        expect(banner()).toContain("plugins.checks.waitingOne");      // the success survived the remount, still to be read
        fixture.online = true; await rerender();
        expect({ opened: openedDemo(), banner: banner() }).toEqual({ opened: false, banner: expect.stringContaining("plugins.checks.settledOne") });
        await click("plugins.slotHolder.show");
        await click("plugins.checks.open");
        expect({ opened: openedDemo(), banner: banner(), writes: writes(requests) }).toEqual({ opened: true, banner: "", writes: ONCE });
      });
      it.each([
        ["still this install's", undefined, { opened: true, sheet: "" }],
        // Replaced on the computer after it was proven (the computer now says someone else's install).
        ["replaced since", (snapshot: any) => ({ ...snapshot, market: { ...snapshot.market,
          items: snapshot.market.items.map(({ installedOperationId: _id, ...entry }: any) => ({ ...entry, installedOperationAttribution: "unattributed" })) } }),
          { opened: false, sheet: "plugins.checks.result.unconfirmed" }],
      ] as const)("proven while the page was away: listed, not opened by itself; the list reads once more as it opens, and \"Open plugin\" opens at once only what that read proves (%s)", async (_name, later, expected) => {
        const world = fresh();
        const requests = wire(world);
        await provenWhileAway(world, false);
        expect(__retainedForTests.conclusions()).toEqual([expect.objectContaining({ readback: "verified", instanceKey: "_root__demo" })]);
        world.reply = later;
        const reads = lightReads(requests);
        await click("plugins.slotHolder.show");
        expect(lightReads(requests) - reads).toBe(1);
        if (expected.opened) {
          await click("plugins.checks.open");
          // The press reads nothing and waits for nothing: the instance is opened in it.
          expect({ reads: lightReads(requests) - reads, opened: openedIds(), sheet: sheet() }).toEqual({ reads: 1, opened: ["mac:_root__demo"], sheet: "" });
        } else expect({ opened: openedIds(), says: sheet().includes(expected.sheet), open: !!byId("plugins.checks.open") }).toEqual({ opened: [], says: true, open: false });
        expect(writes(requests)).toEqual(ONCE);
      });
      it("could not be read; read again by itself to an older computer's facts (③): listed until seen, with the sentence and \"Go to Installed\"", async () => {
        const world: World = { ...fresh(), reply: (snapshot) => ({ ...snapshot, market: { ...snapshot.market,
          items: snapshot.market.items.map(({ installedOperationId: _id, installedOperationAttribution: _by, ...entry }: any) => entry) } }) };
        wire(world);
        await installUnread(world);
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        expect({ opened: openedDemo(), banner: banner() }).toEqual({ opened: false, banner: expect.stringContaining("plugins.checks.settledOne") });
        await click("plugins.slotHolder.show");
        expect(sheet()).toContain("plugins.checks.result.legacyHost");
        await click("plugins.checks.showInstalled");
        expect({ sheet: byId("plugins.checks"), segment: fixture.props.get("segment").value, banner: banner() }).toEqual({ sheet: null, segment: "installed", banner: "" });
      });
      it.each([
        // The response says its market part is incomplete (contract V2.10: one of three markers): the instance is there
        // and its record is not, which settles nothing.
        ["says its server catalog is unavailable", { unavailableReason: "fetch failed" }],
        ["says a custom source could not be read", { unavailableCustomSourceNames: ["Team"] }],
        ["says its organization catalog had an access error", { organizationAccessError: "forbidden" }],
      ] as const)("the instance is there but the response has no installed record of it and %s: nothing is concluded (never \"not on the computer now\"), and it can be read again", async (_name, marker) => {
        const world: World = { ...fresh(), reply: (snapshot) => ({ ...snapshot, market: { ...snapshot.market, items: [], ...marker } }) };
        const requests = wire(world);
        await installAndAllow();
        expect({ prompts: prompts(), opened: openedIds(), told: told(), banner: banner() })
          .toEqual({ prompts: [], opened: [], told: [{ readback: "failed", told: false }], banner: expect.stringContaining("plugins.checks.waitingOne") });
        // The record is there on the next read: "Read again" proves it, and it opens from the list.
        world.reply = undefined;
        await click("plugins.slotHolder.show");
        expect(sheet()).toContain(UNREAD);
        await click("plugins.checks.readAgain");
        await click("plugins.checks.open");
        expect({ opened: openedDemo(), writes: writes(requests) }).toEqual({ opened: true, writes: ONCE });
      });
      // Maintainer review 14:25 #2: a complete response (no marker) without the plugin's item means the computer lists no
      // such market item now (withdrawn, not visible, its market removed). Before: "could not read" for ever, only
      // "Stop tracking" ended it. Now ② (contract V2.10): done, cannot be confirmed as this install, no Open, nothing to
      // read again. Minimal failing input on 34a262c919: this test.
      it("the instance is there and a complete response has no item of it: done, cannot be confirmed as this install (②), no Open and nothing to read again", async () => {
        const world: World = { ...fresh(), reply: (snapshot) => ({ ...snapshot, market: { ...snapshot.market, items: [] } }) };
        const requests = wire(world);
        await installAndAllow();
        expect({ prompts: prompts(), opened: openedIds(), told: told() }).toEqual({ prompts: [], opened: [], told: [{ readback: "unconfirmed", told: false }] });
        await click("plugins.slotHolder.show");
        expect({ text: sheet().includes("plugins.checks.result.unconfirmed"), readAgain: byId("plugins.checks.readAgain"), open: byId("plugins.checks.open") })
          .toEqual({ text: true, readAgain: null, open: null });
        expect(writes(requests)).toEqual(ONCE);
      });
      it("the market item read before the install has no namespace (the computer fills it in once installed): the instance is proven", async () => {
        const { namespace: _omitted, ...summary } = demo;
        const world: World = { ...fresh(), items: [summary, notes] };
        const requests = wire(world);
        await installAndAllow();
        expect({ proven: provenDemo(), opened: openedIds(), prompts: prompts(), writes: writes(requests) }).toEqual({ proven: true, opened: [], prompts: [], writes: ONCE });
      });
      it("could not be read and its computer left the account's list: says why it cannot be read, and can be let go", async () => {
        const world = fresh();
        const requests = wire(world);
        await installUnread(world);
        fixture.removedDevices.add("mac");
        await rerender();
        await click("plugins.slotHolder.show");
        expect({ readAgain: byId("plugins.checks.readAgain")?.disabled, why: sheet().includes("plugins.checks.openUnavailable") }).toEqual({ readAgain: true, why: true });
        await click("plugins.checks.stop");
        expect(sheet()).toContain("plugins.checks.result.untracked");
        await click("plugins.checks.close");
        expect({ banner: banner(), writes: writes(requests) }).toEqual({ banner: "", writes: ONCE });
      });
      it("\"Go to Installed\" with a search typed shows the record's computer's installed list, not the search results", async () => {
        const world = fresh();
        wire(world);
        await installUnread(world);
        // Read again, an older computer answers (③): the list offers "Go to Installed".
        world.reply = (snapshot) => ({ ...snapshot, market: { ...snapshot.market,
          items: snapshot.market.items.map(({ installedOperationId: _id, installedOperationAttribution: _by, ...entry }: any) => entry) } });
        // iOS: the directory is its own view here, so its props say where the page is.
        fixture.platform = "ios";
        await rerender();
        await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "notes" } }));
        await settle(14);
        await click("plugins.slotHolder.show");
        await click("plugins.checks.readAgain");
        expect(sheet()).toContain("plugins.checks.result.legacyHost");
        await click("plugins.checks.showInstalled");
        await settle(6);
        const directory = fixture.props.get("directory");
        expect({ deviceId: directory.deviceId, segment: directory.segment, query: directory.query }).toEqual({ deviceId: "mac", segment: "installed", query: "" });
      });
      it("a second install after the first could not be read; the first is read again and opened from the list: the second is untouched", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try {
          const world = fresh();
          const requests = wire(world);
          world.hold = timesOut;
          await installAndAllow(demo.pluginId);
          expect(told()).toEqual([{ readback: "failed", told: false }]);
          world.hold = () => undefined;
          await click(`plugins.market.install.${notes.pluginId}`);
          const first = ["begin:operation-0001", "answer:operation-0001", "begin:operation-0002"];
          expect(writes(requests)).toEqual(first);
          await click("plugins.slotHolder.show");
          await click("plugins.checks.readAgain");
          await click("plugins.checks.open");
          expect({ opened: openedDemo(), writes: writes(requests) }).toEqual({ opened: true, writes: first });
          // The harness draws every consent sheet's content whether or not it is visible: the market's is the last one.
          const allows = [...element.querySelectorAll('[data-testid="plugins.management.allow"]')] as HTMLButtonElement[];
          expect(allows.at(-1)!.disabled).toBe(false);
          await act(async () => allows.at(-1)!.click());
          await settle(20);
          expect(writes(requests)).toEqual([...first, "answer:operation-0002"]);
          // The person is on the first plugin's detail now, not on the market: the second install's result does not pull
          // the page away; it is listed, and opens from the list.
          expect({ last: openedIds().at(-1), banner: banner() }).toEqual({ last: "mac:_root__demo", banner: expect.stringContaining("plugins.checks.settledOne") });
          await click("plugins.slotHolder.show");
          await click("plugins.checks.open");
          expect(openedIds().at(-1)).toBe("mac:_root__notes");
          expect(byId("plugins.slotHolder")).toBeNull();
        } finally { spy.mockRestore(); }
      });
      it("a pending check ends succeeded but its read fails: the market row does not offer Install while the list says it is done", async () => {
        // begin's reply is lost, the row's "Check result" hits a protocol error (the attempt goes to its pending check),
        // then the list's "Check result" finds succeeded, and the read of the computer fails.
        const state = { operation: (): unknown => ({ operationId: "screen-operation", phase: "running" }), installed: false, unreadable: false };
        const requests = marketWire((request) => {
          switch (request.actionId) {
            case "management:snapshot":
              if (request.input?.read === "capabilities") return { catalogPaging: true };
              if (state.unreadable) throw hostError("TIMEOUT");
              if (request.input?.read === "catalog") return marketPage(state.installed ? [] : [demo]);
              return managementSnapshot(state.installed, { ...demo, installState: state.installed ? "installed" : "not-installed", ...attributed(state.installed, "screen-operation") });
            case "management:market-detail": return { ...demo, installState: state.installed ? "installed" : "not-installed", manifest: manifestOf("demo", "Demo") };
            case "management:begin": throw timeout();
            case "management:operation": return state.operation();
            default: throw new Error("unexpected " + request.actionId);
          }
        });
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
        state.operation = () => { throw hostError("INVALID_RESPONSE"); };
        await click(`plugins.market.install.${demo.pluginId}`);              // the row's "Check result"
        await click("plugins.slotHolder.show");
        state.operation = () => ({ operationId: "screen-operation", phase: "succeeded" });
        state.installed = true;
        state.unreadable = true;
        await click("plugins.checks.verify");
        expect(sheet()).toContain(UNREAD);
        await click("plugins.checks.close");
        await settle(20);
        const button = byId(`plugins.market.install.${demo.pluginId}`);
        expect({ banner: banner(), rowButton: button ? { text: button.textContent, disabled: button.disabled } : null,
          begins: requests.filter((request) => request.actionId === "management:begin").length })
          .toEqual({ banner: expect.stringContaining("plugins.checks.waitingOne"), rowButton: null, begins: 1 });
      });

      // Second pre-push round (2026-11-26), on the first version of this change: what the person is shown and when the
      // page moves. Each failed on that version (cefbf383b4) unless marked as a control.
      /** A success proven while the page was away, the page reopened: listed as having a result; the list is opened. */
      /** Proven while the page was away and listed at the top. `open`: the list of checks is opened (it reads once more). */
      async function provenWhileAway(world: World, open = true) {
        const hold = holds();
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait(label) : undefined;
        await installAndAllow();
        await leavePage();
        world.hold = () => undefined;
        hold.release("installed-1"); hold.release("installed-2");
        await settle(20);
        await rerender();
        expect({ opened: openedDemo(), banner: banner() }).toEqual({ opened: false, banner: expect.stringContaining("plugins.checks.settledOne") });
        if (open) await click("plugins.slotHolder.show");
      }
      it("the read the list starts as it opens fails: no \"Open plugin\"; the success is listed as not read, also after the list is closed", async () => {
        const world = fresh();
        const requests = wire(world);
        await provenWhileAway(world, false);
        world.hold = timesOut;
        await click("plugins.slotHolder.show");
        expect({ opened: openedIds(), open: !!byId("plugins.checks.open"), unread: sheet().includes(UNREAD), readAgain: !!byId("plugins.checks.readAgain") })
          .toEqual({ opened: [], open: false, unread: true, readAgain: true });
        await click("plugins.checks.close");
        expect({ banner: banner(), told: told(), writes: writes(requests) })
          .toEqual({ banner: expect.stringContaining("plugins.checks.waitingOne"), told: [{ readback: "failed", told: false }], writes: ONCE });
      });
      it("the list is closed while the read it started as it opened is out; the read proves the instance: nothing opens, and it stays listed", async () => {
        const world = fresh();
        wire(world);
        await provenWhileAway(world, false);
        const hold = holds();
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("open-read") : undefined;
        await click("plugins.slotHolder.show");
        // Being read: no "Open plugin" yet.
        expect({ reading: sheet().includes("plugins.checks.result.readingBack"), open: !!byId("plugins.checks.open") }).toEqual({ reading: true, open: false });
        await click("plugins.checks.close");
        expect(told()).toEqual([{ readback: "pending", told: false }]);
        world.hold = () => undefined;
        hold.release("open-read");
        await settle(30);
        expect({ opened: openedIds(), told: told(), banner: banner() })
          .toEqual({ opened: [], told: [{ readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("proven while the account's computers are not listed yet (the page was just reopened): not marked as shown, still listed once they are", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label.startsWith("installed-") ? hold.wait(label) : undefined };
        wire(world);
        await installAndAllow();
        await leavePage();
        fixture.removedDevices.add("mac");
        await rerender();
        world.hold = () => undefined;
        hold.release("installed-1"); hold.release("installed-2");
        await settle(20);
        fixture.removedDevices.delete("mac");
        await rerender();
        expect({ opened: openedDemo(), told: told(), banner: banner() })
          .toEqual({ opened: false, told: [{ readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("the list is open while the install ends: the page does not move behind it; the line offers \"Open plugin\", which opens it", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label.startsWith("installed-") ? hold.wait(label) : undefined };
        const requests = wire(world);
        await installAndAllow();
        await click("plugins.slotHolder.show");
        expect(sheet()).toContain("plugins.checks.result.readingBack");
        world.hold = () => undefined;
        hold.release("installed-1"); hold.release("installed-2");
        await settle(20);
        expect({ opened: openedIds(), told: told(), sheet: sheet().includes("plugins.checks.result.succeeded"), prompts: prompts() })
          .toEqual({ opened: [], told: [{ readback: "verified", told: false }], sheet: true, prompts: [] });
        await click("plugins.checks.open");
        expect({ opened: openedIds(), told: told(), writes: writes(requests) }).toEqual({ opened: ["mac:_root__demo"], told: [{ readback: "verified", told: true }], writes: ONCE });
      });
      it("the page never moves by itself for a result: read again and proven while another install's consent is up, it stays listed, and the consent is answered untouched", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try {
          const world = fresh();
          const requests = wire(world);
          world.hold = timesOut;
          await installAndAllow(demo.pluginId);
          expect(told()).toEqual([{ readback: "failed", told: false }]);
          world.hold = () => undefined;
          await click(`plugins.market.install.${notes.pluginId}`);          // Notes' consent is on screen
          await appState("background");
          await appState("active");                                          // reachable again: Demo's success is read again
          const first = () => __retainedForTests.conclusions().find((item: any) => item.operationId === "operation-0001") as any;
          expect({ readback: first().readback, told: !!first().told, opened: openedDemo() }).toEqual({ readback: "verified", told: false, opened: false });
          const begun = ["begin:operation-0001", "answer:operation-0001", "begin:operation-0002"];
          expect(writes(requests).filter((write) => !write.startsWith("operation:"))).toEqual(begun);
          // The consent is still the one on screen; rejecting it is the only thing written for it.
          const rejects = [...element.querySelectorAll('[data-testid="plugins.management.reject"]')] as HTMLButtonElement[];
          await act(async () => rejects.at(-1)!.click());
          await settle(30);
          expect(writes(requests).filter((write) => !write.startsWith("operation:"))).toEqual([...begun, "answer:operation-0002"]);
          expect({ opened: openedDemo(), told: !!first().told, banner: banner() }).toEqual({ opened: false, told: false, banner: expect.stringContaining("plugins.checks.settledOne") });
        } finally { spy.mockRestore(); }
      });
      it("the page is opened again with a success not read yet and the person types a search: it is read again, and the page stays where it is", async () => {
        const hold = holds();
        const world = fresh();
        wire(world);
        await installUnread(world);
        await leavePage();
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("again") : undefined;
        fixture.platform = "ios";
        await rerender();
        await act(async () => fixture.props.get("stack").headerSearchBarOptions.onChangeText({ nativeEvent: { text: "dem" } }));
        await settle(14);
        world.hold = () => undefined;
        hold.release("again");
        await settle(30);
        expect({ opened: openedDemo(), told: told(), query: fixture.props.get("directory").query }).toEqual({ opened: false, told: [{ readback: "verified", told: false }], query: "dem" });
      });
      it("read again on reconnect; the page is left and reopened while that read is out; it times out: read again once more", async () => {
        const hold = holds();
        const world = fresh();
        const requests = wire(world);
        await installUnread(world);
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("again") : undefined;
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        expect(told()).toEqual([{ readback: "pending", told: false }]);
        await leavePage();
        fixture.removedDevices.add("mac");
        await rerender();
        fixture.removedDevices.delete("mac");
        await rerender();
        world.hold = () => undefined;
        const before = lightReads(requests);
        hold.release("again", false);
        await settle(30);
        expect({ readAgain: lightReads(requests) - before, told: told() }).toEqual({ readAgain: 1, told: [{ readback: "verified", told: false }] });
      });
      it("a success not read yet stays listed while 20 other operations end (the cap of kept results)", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-${String(++n).padStart(4, "0")}` as any);
        try {
          const world = fresh();
          wire(world);
          world.hold = timesOut;
          await installAndAllow(demo.pluginId);
          expect(banner()).toContain("plugins.checks.waitingOne");
          world.hold = () => undefined;
          world.beginEnds = (ghostId) => ghostId === "notes" ? "failed" : undefined;
          for (let round = 0; round < 20; round++) await click(`plugins.market.install.${notes.pluginId}`);
          const kept = () => __retainedForTests.conclusions().map((item: any) => item.operationId);
          expect({ firstKept: kept().includes("operation-0001"), kept: kept().length, banner: banner() })
            .toEqual({ firstKept: true, kept: 21, banner: expect.stringContaining("plugins.checks.waitingOne") });
          // One more that is not listed: the oldest of those goes (the first failure), the listed one and the newest stay.
          await click(`plugins.market.install.${notes.pluginId}`);
          expect({ kept: kept().length, listedKept: kept().includes("operation-0001"), oldestFailure: kept().includes("operation-0002"), newest: kept().includes("operation-0022") })
            .toEqual({ kept: 21, listedKept: true, oldestFailure: false, newest: true });
        } finally { spy.mockRestore(); }
      });
      it("a second page instance that is not in front does not make a failed read loop", async () => {
        const world = fresh();
        const requests = wire(world);
        await installUnread(world);
        // Every read from now on fails at once; a loop would be cut after 12 more (the 13th never answers).
        const base = world.installedReads;
        world.hold = (label: string) => !label.startsWith("installed-") ? undefined
          : world.installedReads - base > 12 ? new Promise<boolean>(() => {}) : Promise.resolve(false);
        const before = lightReads(requests);
        const second = createRoot(document.createElement("div"));
        // It lists the computer, as the page does (a reporter that lists none reports nothing at all).
        const Behind = () => { usePluginPendingChecks(() => true, false, ["mac"]); return null; };
        await act(async () => second.render(createElement(Behind)));
        await settle(30);
        await rerender();
        await settle(40);
        const reads = lightReads(requests) - before;
        await act(async () => second.unmount());
        expect(reads).toBe(0);
      });
      it("two installs proven while the page was away: the notice says they have results, not that they are unfinished", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try {
          const hold = holds();
          const world: World = { ...fresh(), hold: (label: string) => label.startsWith("installed-") ? hold.wait("first") : undefined };
          wire(world);
          await installAndAllow(demo.pluginId);
          await leavePage();
          world.hold = () => undefined;
          hold.release("first");
          await settle(20);
          await rerender();
          await act(async () => fixture.props.get("segment").onChange("market"));
          await settle(14);
          await click(`plugins.market.install.${notes.pluginId}`);
          world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("second") : undefined;
          const allows = [...element.querySelectorAll('[data-testid="plugins.management.allow"]')] as HTMLButtonElement[];
          await act(async () => allows.at(-1)!.click());
          await settle(14);
          await leavePage();
          world.hold = () => undefined;
          hold.release("second");
          await settle(20);
          await rerender();
          expect(told()).toEqual([{ readback: "verified", told: false }, { readback: "verified", told: false }]);
          expect(fixture.props.get("plugins.slotHolder").title).toBe("plugins.checks.settledMany");
        } finally { spy.mockRestore(); }
      });
      it("receipt gone and the computer cannot read the plugin's market now: the list says so, \"Check result\" stays usable and settles it once readable", async () => {
        const state = { complete: false };
        const requests = marketWire((request) => {
          const began = requests.some((entry) => entry.actionId === "management:begin");
          switch (request.actionId) {
            case "management:snapshot":
              if (request.input?.read === "capabilities") return { catalogPaging: true };
              if (request.input?.read === "catalog") return marketPage([demo]);
              if (!began) return managementSnapshot(false);
              return state.complete ? managementSnapshot(true, { ...demo, installState: "installed", ...attributed(true, "screen-operation") })
                : { ...managementSnapshot(true), market: { ...managementSnapshot(false).market, items: [], unavailableReason: "fetch failed" } };
            case "management:market-detail": return { ...demo, installState: "not-installed", manifest: manifestOf("demo", "Demo") };
            case "management:begin": throw timeout();
            case "management:operation": throw hostError("NOT_FOUND");
            default: throw new Error("unexpected " + request.actionId);
          }
        });
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
        await settle(20);
        const lookups = () => requests.filter((request) => request.actionId === "management:operation").length;
        if (!lookups()) await click(`plugins.market.install.${demo.pluginId}`);   // the row's "Check result"
        await settle(20);
        await click("plugins.slotHolder.show");
        expect(sheet()).toContain("plugins.checks.status.recordMissing");
        const quiet = requests.length;
        await settle(40);
        expect(requests.length).toBe(quiet);                                       // nothing looks it up again by itself
        state.complete = true;
        await click("plugins.checks.verify");
        await settle(20);
        expect(__retainedForTests.conclusions()).toEqual([expect.objectContaining({ result: "installed", readback: "verified", instanceKey: "_root__demo" })]);
        expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
      });
      // Maintainer review 14:25 #2: receipt gone, the instance is there, and a complete response (no marker) has no
      // item of it (its market was removed). Before: "could not read its install record" for ever, "Check result" came
      // back to it each time. Now it settles as not confirmed (②), and only the original operation was looked up.
      it("receipt gone and a complete response has no item of the plugin: settled as not confirmed, only the original operation looked up, begin once", async () => {
        const requests = marketWire((request) => {
          const began = requests.some((entry) => entry.actionId === "management:begin");
          switch (request.actionId) {
            case "management:snapshot":
              if (request.input?.read === "capabilities") return { catalogPaging: true };
              if (request.input?.read === "catalog") return marketPage([demo]);
              if (!began) return managementSnapshot(false);
              return { ...managementSnapshot(true), market: { ...managementSnapshot(false).market, items: [] } };
            case "management:market-detail": return { ...demo, installState: "not-installed", manifest: manifestOf("demo", "Demo") };
            case "management:begin": throw timeout();
            case "management:operation": throw hostError("NOT_FOUND");
            default: throw new Error("unexpected " + request.actionId);
          }
        });
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
        await settle(20);
        const lookups = () => requests.filter((request) => request.actionId === "management:operation");
        if (!lookups().length) await click(`plugins.market.install.${demo.pluginId}`);   // the row's "Check result"
        await settle(20);
        expect(__retainedForTests.conclusions()).toEqual([expect.objectContaining({ result: "mismatch", readback: "none" })]);
        expect(__retainedForTests.checks()).toEqual([]);
        const begun = requests.find((request) => request.actionId === "management:begin")!.input?.operationId;
        expect({ begun: typeof begun, looked: [...new Set(lookups().map((request) => request.input?.operationId))] }).toEqual({ begun: "string", looked: [begun] });
        expect(requests.filter((request) => request.actionId === "management:begin")).toHaveLength(1);
      });
      // Third pre-push round (2026-11-26), on the second version of this change (d5ee5bc707): the page still moved by
      // itself. Each failed on that version.
      const sheetLines = () => [...element.querySelectorAll('[data-testid^="plugins.checks.item."]')].map((line) => line.textContent ?? "");
      /** begin's reply was lost and the row's "Check result" met a protocol error: the install is a pending check. */
      async function handedOver(world: World) {
        world.loseBegin = true;
        world.operation = () => { throw hostError("INVALID_RESPONSE"); };
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);              // Install: begin is written, its reply is lost
        await click(`plugins.market.install.${demo.pluginId}`);              // the row's "Check result": a protocol error
        expect(banner()).toContain("plugins.checks.waitingOne");
      }
      it("\"Check result\" on the row led nowhere; a later lookup by the page itself (back in the foreground) proves the install: listed, the page does not move", async () => {
        const world = fresh();
        const requests = wire(world);
        await handedOver(world);
        world.installed.set("demo", "screen-operation");
        world.operation = (id) => ({ operationId: id, phase: "succeeded" });
        await appState("background");
        await appState("active");
        await settle(30);
        expect({ opened: openedDemo(), told: told(), banner: banner(), writes: writes(requests).filter((write) => !write.startsWith("operation:")) })
          .toEqual({ opened: false, told: [{ readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne"), writes: ["begin:screen-operation"] });
      });
      it("\"Check result\" on a row that had ended proves the install: listed and opened from the list, the page does not move for it", async () => {
        const world = fresh();
        wire(world);
        await handedOver(world);
        world.installed.set("demo", "screen-operation");
        world.operation = (id) => ({ operationId: id, phase: "succeeded" });
        await click(`plugins.market.install.${demo.pluginId}`);              // "Check result" again: succeeded
        await settle(20);
        expect({ opened: openedDemo(), told: told(), banner: banner() })
          .toEqual({ opened: false, told: [{ readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
        await click("plugins.slotHolder.show");
        await click("plugins.checks.open");
        expect({ opened: openedDemo(), banner: banner() }).toEqual({ opened: true, banner: "" });
      });
      it("Allow's reply lost; the list's \"Check result\" finds succeeded while the row still waits: the list presents it, the page does not move behind it", async () => {
        const world = fresh();
        world.loseAnswer = true;
        const requests = wire(world);
        await installAndAllow();
        world.operation = (id) => ({ operationId: id, phase: "succeeded" });
        await click("plugins.slotHolder.show");
        await click("plugins.checks.verify");
        await settle(20);
        expect({ sheetOpen: !!byId("plugins.checks"), opened: openedIds(), openOffered: !!byId("plugins.checks.open"), writes: writes(requests).filter((write) => !write.startsWith("operation:")) })
          .toEqual({ sheetOpen: true, opened: [], openOffered: true, writes: ONCE });
      });
      it("the result is read while another screen is in front: nothing is opened or marked as shown; listed on return", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "answer" ? hold.wait(label) : undefined };
        wire(world);
        await installAndAllow();
        fixture.focused = false; await rerender();
        hold.release("answer");
        await settle(30);
        expect({ opened: openedIds(), told: told() }).toEqual({ opened: [], told: [{ readback: "verified", told: false }] });
        fixture.focused = true; await rerender();
        expect({ opened: openedIds(), banner: banner() }).toEqual({ opened: [], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("the whole page is left while the read the list started is out: nothing is read for a page that is gone, and the success is still listed on return", async () => {
        const world = fresh();
        wire(world);
        await provenWhileAway(world, false);
        const hold = holds();
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("open-read") : undefined;
        await click("plugins.slotHolder.show");
        await leavePage();
        fixture.read.mockClear();
        world.hold = () => undefined;
        hold.release("open-read");
        await settle(30);
        expect({ detailReads: openedIds(), told: told() }).toEqual({ detailReads: [], told: [{ readback: "verified", told: false }] });
        await rerender();
        expect(banner()).toContain("plugins.checks.settledOne");
      });
      it("\"Open plugin\" pressed twice before the list is drawn again: opened once, and the presses read nothing", async () => {
        const world = fresh();
        const requests = wire(world);
        await provenWhileAway(world);
        const before = lightReads(requests);
        const open = byId("plugins.checks.open")!;
        await act(async () => { open.click(); open.click(); });
        await settle(14);
        expect({ reads: lightReads(requests) - before, opened: openedIds(), told: told() })
          .toEqual({ reads: 0, opened: ["mac:_root__demo"], told: [{ readback: "verified", told: true }] });
      });
      it.each([
        ["Allow's reply arrives in the background; back in front while the success's read is out", async (release: () => void) => { await appState("background"); release(); await settle(30); await appState("active"); }],
        ["the page is left before Allow's reply; reopened while the success's read is out", async (release: () => void) => { await leavePage(); release(); await settle(30); await rerender(); }],
      ] as const)("%s; the read times out: read again by itself, once", async (_name, away) => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "answer" || label.startsWith("installed-") ? hold.wait(label) : undefined };
        const requests = wire(world);
        await installAndAllow();
        await away(() => hold.release("answer"));
        await settle(20);
        world.hold = () => undefined;
        const before = lightReads(requests);
        for (let read = 1; read <= world.installedReads; read++) hold.release(`installed-${read}`, false);
        await settle(40);
        expect({ readAgain: lightReads(requests) > before, readback: told().map((item) => item.readback) }).toEqual({ readAgain: true, readback: ["verified"] });
        const settled = lightReads(requests);
        await settle(30);
        expect(lightReads(requests)).toBe(settled);
      });
      it("install could not be read; the person opens that plugin's installed detail; the computer comes back and the read proves it: listed until the person has looked (in the list, or by a read of that detail)", async () => {
        const world = fresh();
        wire(world);
        await installUnread(world);
        const installed = { key: JSON.stringify(["mac", "plugins", "plugin", "_root__demo"]), host: { deviceId: "mac", deviceName: "Mac" },
          item: { ref: { collectionId: "plugins", kind: "plugin", id: "_root__demo" }, revision: "1", display: { title: "Demo" }, actions: [{ id: "disable", label: "Enabled" }] } };
        fixture.read.mockImplementation(async (_invoke: any, _host: any, ref: any) => ({ ...installed.item, ref, blocks: [] }));
        fixture.extraRows = [installed];
        fixture.platform = "ios";
        await rerender();
        await act(async () => fixture.props.get("directory").onDetail(installed));
        await settle(14);
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(20);
        // The page keeps no account of what the detail on screen shows: proven after that detail was read, it stays listed.
        expect({ told: told(), banner: banner() }).toEqual({ told: [{ readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
        // A read of that detail issued now (back to the list, and the person opens it again) is where they see it.
        await act(async () => fixture.props.get("header").onBack());
        await settle(10);
        await act(async () => fixture.props.get("directory").onDetail(installed));
        await settle(14);
        expect({ told: told(), banner: banner() }).toEqual({ told: [{ readback: "verified", told: true }], banner: "" });
      });
      it("two finished installs, one not read yet and one with a result: the notice says they need a look, not that they are unfinished", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try {
          const hold = holds();
          const world = fresh();
          wire(world);
          world.hold = timesOut;
          await installAndAllow(demo.pluginId);                              // Demo: done, could not be read
          world.hold = (label: string) => label.startsWith("installed-") && world.installed.has("notes") ? hold.wait("second") : undefined;
          await click(`plugins.market.install.${notes.pluginId}`);
          const allows = [...element.querySelectorAll('[data-testid="plugins.management.allow"]')] as HTMLButtonElement[];
          await act(async () => allows.at(-1)!.click());
          await settle(14);                                                  // Notes: done, its read is out
          await leavePage();
          world.hold = () => undefined;
          hold.release("second");                                            // Notes proven while the page is away
          await settle(20);
          world.hold = timesOut;                                             // Demo's read on reopening fails again
          await rerender();
          expect(told().map((item) => item.readback).sort()).toEqual(["failed", "verified"]);
          expect(fixture.props.get("plugins.slotHolder").title).toBe("plugins.checks.attentionMany");
        } finally { spy.mockRestore(); }
      });
      it("the list opened while an install is still getting ready: once it has begun there is one line for it, not a second one saying it ended", async () => {
        const hold = holds();
        const world = fresh();
        wire(world);
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          if (args?.[0]?.actionId === "management:market-detail") await hold.wait("detail");
          return original(device, channel, args, options);
        });
        await click(`plugins.market.install.${demo.pluginId}`);
        await click("plugins.slotHolder.show");
        expect(sheetLines()).toEqual([expect.stringContaining("plugins.checks.status.preparing")]);
        hold.release("detail");
        await settle(20);
        expect(sheetLines()).toEqual([expect.stringContaining("plugins.checks.status.confirmation")]);
      });

      /* 测试价值（推送前自查第四轮，2026-11-26：页面只在用户当场点按时换页，结果不自己打开也不弹提示）
       * - 生产入口与可观察结果：同本组（真实页面与控件，只替换传输）；观察打开了哪个实例、写出了什么、面板与市场详情上的
       *   按钮与文字。
       * - 依据：维护者 17:43 第 1 条（离开未答复的确认会取消它，必须受控）；自查第四轮在 a337ae955c 上复现：点「打开插件」
       *   后关掉面板，读取回来时页面仍被换走（那时用户已在做别的事，正开着的确认会被取消）；从市场详情发起的安装装完后
       *   详情仍给「安装」；读取中的成功没有「不再跟踪」。
       * - 现有覆盖缺口：只有「关掉面板后不打开」一条，没有关掉后又打开面板、关掉后另一项确认出现两种；市场详情上的安装
       *   与读取中的行没有用例。
       * - 最小失败输入：见各用例名。tier: unit（jsdom，内存 Host）。
       */
      /** Proven while the page was away; the market is the page; the list is opened and the read that starts is held. */
      async function listOpenedOverMarket(world: World) {
        await provenWhileAway(world, false);
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        const hold = holds();
        let held = false;
        world.hold = (label: string) => { if (!label.startsWith("installed-") || held) return undefined; held = true; return hold.wait("open-read"); };
        await click("plugins.slotHolder.show");
        expect({ reading: sheet().includes("plugins.checks.result.readingBack"), open: !!byId("plugins.checks.open") }).toEqual({ reading: true, open: false });
        return () => { world.hold = () => undefined; hold.release("open-read"); };
      }
      it("the list is closed and opened again while its read is out; the read proves it: nothing opens by itself; \"Open plugin\" then opens at once, without another read", async () => {
        const world = fresh();
        const requests = wire(world);
        const before = lightReads(requests);
        const answer = await listOpenedOverMarket(world);
        await click("plugins.checks.close");
        await click("plugins.slotHolder.show");
        answer();
        await settle(30);
        expect({ opened: openedIds(), open: !!byId("plugins.checks.open"), told: told() }).toEqual({ opened: [], open: true, told: [{ readback: "verified", told: false }] });
        const read = lightReads(requests);
        await click("plugins.checks.open");
        expect({ opened: openedIds(), pressRead: lightReads(requests) - read, writes: writes(requests) }).toEqual({ opened: ["mac:_root__demo"], pressRead: 0, writes: ONCE });
        expect(read - before).toBeGreaterThan(0);
      });
      it("the list's read is out; the list is closed; another install's consent comes up; the read proves the first: nothing opens, nothing is written for the consent", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try {
          const world = fresh();
          const requests = wire(world);
          const answer = await listOpenedOverMarket(world);
          await click("plugins.checks.close");
          await click(`plugins.market.install.${notes.pluginId}`);          // Notes' consent is on screen
          const begun = ["begin:operation-0001", "answer:operation-0001", "begin:operation-0002"];
          const written = () => writes(requests).filter((write) => !write.startsWith("operation:"));
          expect(written()).toEqual(begun);
          answer();
          await settle(30);
          expect({ opened: openedIds(), written: written(), consent: !!byId("plugins.management.allow") }).toEqual({ opened: [], written: begun, consent: true });
          // The consent is still the one on screen: Allow is the only thing written for it.
          const allows = [...element.querySelectorAll('[data-testid="plugins.management.allow"]')] as HTMLButtonElement[];
          await act(async () => allows.at(-1)!.click());
          await settle(30);
          expect({ opened: openedIds(), written: written() }).toEqual({ opened: [], written: [...begun, "answer:operation-0002"] });
        } finally { spy.mockRestore(); }
      });
      it("a success whose read is still out can be let go from the list (\"Stop tracking\"); its late read brings nothing back", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label.startsWith("installed-") ? hold.wait(label) : undefined };
        const requests = wire(world);
        await installAndAllow();
        await click("plugins.slotHolder.show");
        expect(sheet()).toContain("plugins.checks.result.readingBack");
        await click("plugins.checks.stop");
        expect(sheet()).toContain("plugins.checks.result.untracked");
        await click("plugins.checks.close");
        world.hold = () => undefined;
        for (let read = 1; read <= world.installedReads; read++) hold.release(`installed-${read}`);
        await settle(20);
        expect({ banner: banner(), opened: openedIds(), prompts: prompts(), writes: writes(requests) }).toEqual({ banner: "", opened: [], prompts: [], writes: ONCE });
      });
      it.each([["a result already read", true, "plugins.checks.open", "plugins.checks.openOffline"], ["a success not read yet", false, "plugins.checks.readAgain", "plugins.checks.status.offline"]] as const)(
        "the computer is not connected while the list shows %s: its button is unavailable and the line says what connecting is for", async (_name, proven, button, why) => {
          const world = fresh();
          wire(world);
          if (proven) await provenWhileAway(world); else await installUnread(world);
          fixture.online = false; await rerender();
          if (!proven) await click("plugins.slotHolder.show");
          // (The harness's Text drops test ids: the sentence is looked for in the list's text.)
          const other = why === "plugins.checks.openOffline" ? "plugins.checks.status.offline" : "plugins.checks.openOffline";
          expect({ disabled: byId(button)?.disabled, says: sheet().includes(why), other: sheet().includes(other) }).toEqual({ disabled: true, says: true, other: false });
        });
      it("installed from the market detail: the detail stays, is read again and no longer offers Install; the result is listed and opens from the list", async () => {
        const world = fresh();
        const requests = wire(world);
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.row.${demo.pluginId}`);
        await click("plugins.market.detailInstall");
        await click("plugins.management.allow");
        await settle(20);
        const detail = () => byId("plugins.market.detail")?.textContent ?? "";
        expect({ install: !!byId("plugins.market.detailInstall"), installed: detail().includes("plugins.market.alreadyInstalled"), opened: openedIds(), prompts: prompts() })
          .toEqual({ install: false, installed: true, opened: [], prompts: [] });
        expect(banner()).toContain("plugins.checks.settledOne");
        await click("plugins.slotHolder.show");
        await click("plugins.checks.open");
        expect({ opened: openedIds(), writes: writes(requests) }).toEqual({ opened: ["mac:_root__demo"], writes: ONCE });
      });

      /* 测试价值（推送前自查第五轮，2026-11-26：「打开插件」在点按里同步打开；「已看过」只在用户确实看着时记）
       * - 生产入口与可观察结果：同本组。
       * - 依据：维护者 17:43 第 1 条（离开未答复的确认必须受控）、03:52（只打开核实过的实例）；自查第五轮在 7951455227 上
       *   复现：点「打开插件」后先读再开，读取回来时另一项操作的确认已经出现、电脑已不在列表、App 已在后台，页面仍被换走
       *   （确认被取消）；读取被离线打断后按钮可点却没反应；市场详情重读失败或还没回来时仍给「安装」；详情上盖着确认、
       *   App 在后台时结果被记成已看过；有实例没记录的响应在电脑重新可达后不再读；保留上限把刚结束的结论挤掉；
       *   「允许」在途时回执过期，事实读到了却不下结论。
       * - 现有覆盖缺口：上一轮的用例只覆盖「关掉面板后不打开」。
       * - 最小失败输入：见各用例名。在 7951455227 上，除「读取在途时进后台」「读取在途时电脑离开列表」两条外都失败；这两条
       *   在那一版要先点「打开插件」才会出错（那时面板打开不读），按现在的操作顺序是对照。
       * - tier: unit（jsdom，内存 Host）。
       */
      it("the list's read is out; the computer goes offline (that read ends at once) and comes back; read again and proven: \"Open plugin\" is there and opens", async () => {
        const world = fresh();
        const requests = wire(world);
        await provenWhileAway(world, false);
        const hold = holds();
        let first = true;
        world.hold = (label: string) => { if (!label.startsWith("installed-") || !first) return undefined; first = false; return hold.wait("open-read"); };
        await click("plugins.slotHolder.show");
        expect(sheet()).toContain("plugins.checks.result.readingBack");
        fixture.online = false; await rerender();                              // offline: that read ends now as "could not read"
        expect(told()).toEqual([{ readback: "failed", told: false }]);
        fixture.online = true; await rerender();                               // back: read again by itself, proven
        expect({ told: told(), disabled: byId("plugins.checks.open")?.disabled }).toEqual({ told: [{ readback: "verified", told: false }], disabled: false });
        await click("plugins.checks.open");
        expect({ opened: openedIds(), writes: writes(requests) }).toEqual({ opened: ["mac:_root__demo"], writes: ONCE });
      });
      it("the list's read is out; the app goes to the background; the read proves it: nothing opens and it is not counted as seen", async () => {
        const world = fresh();
        wire(world);
        await provenWhileAway(world, false);
        const hold = holds();
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("open-read") : undefined;
        await click("plugins.slotHolder.show");
        await appState("background");
        world.hold = () => undefined;
        hold.release("open-read");
        await settle(30);
        expect({ opened: openedIds(), told: told() }).toEqual({ opened: [], told: [{ readback: "verified", told: false }] });
      });
      it("the list's read is out; the computer leaves the account's list; the read proves it: no \"Open plugin\" for a computer not listed, nothing opens", async () => {
        const world = fresh();
        const requests = wire(world);
        await provenWhileAway(world, false);
        const hold = holds();
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("open-read") : undefined;
        await click("plugins.slotHolder.show");
        fixture.removedDevices.add("mac"); await rerender();
        world.hold = () => undefined;
        hold.release("open-read");
        await settle(30);
        expect({ opened: openedIds(), open: !!byId("plugins.checks.open"), why: sheet().includes("plugins.checks.openUnavailable"), told: told().map((item) => item.told), writes: writes(requests) })
          .toEqual({ opened: [], open: false, why: true, told: [false], writes: ONCE });
      });
      it.each([["times out", false], ["is still out", true]] as const)(
        "installed from the market detail; the detail's read after the install %s: the detail does not offer Install for a plugin the top of the page says is done", async (_name, slow) => {
          const world = fresh();
          const requests = wire(world);
          fixture.platform = "android";
          fixture.realConfirmation = true;
          await act(async () => root.render(createElement(PluginsScreen)));
          await act(async () => fixture.props.get("segment").onChange("market"));
          await settle(14);
          await click(`plugins.market.row.${demo.pluginId}`);
          // Once Demo is installed, the market detail's read does not answer in time (the success's own read does).
          const original = fixture.wire.getMockImplementation()!;
          fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) =>
            args?.[0]?.actionId === "management:market-detail" && world.installed.has("demo")
              ? transportSend(options, async () => { if (slow) await new Promise(() => {}); throw timeout(); }) : original(device, channel, args, options));
          await click("plugins.market.detailInstall");
          await click("plugins.management.allow");
          await settle(30);
          expect({ banner: banner(), told: told(), writes: writes(requests), install: !!byId("plugins.market.detailInstall"),
            installed: (byId("plugins.market.detail")?.textContent ?? "").includes("plugins.market.alreadyInstalled") })
            .toEqual({ banner: expect.stringContaining("plugins.checks.settledOne"), told: [{ readback: "verified", told: false }], writes: ONCE, install: false, installed: true });
        });
      it("an install's instance detail is on screen; another install's consent comes up over it; the first is read again and proven: not counted as seen under the consent", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try {
          const world = fresh();
          wire(world);
          await installUnread(world);
          const installed = { key: JSON.stringify(["mac", "plugins", "plugin", "_root__demo"]), host: { deviceId: "mac", deviceName: "Mac" },
            item: { ref: { collectionId: "plugins", kind: "plugin", id: "_root__demo" }, revision: "1", display: { title: "Demo" }, actions: [{ id: "disable", label: "Enabled" }] } };
          fixture.read.mockImplementation(async (_invoke: any, _host: any, ref: any) => ({ ...installed.item, ref, blocks: [] }));
          fixture.extraRows = [installed];
          fixture.platform = "ios";
          fixture.width = 900;
          await rerender();
          await act(async () => fixture.props.get("directory").onDetail(installed));       // Demo's installed detail, right pane
          await settle(14);
          await act(async () => fixture.props.get("directory").onSegmentChange("market"));
          await settle(14);
          await act(async () => shownMarket().install(shownMarket().items.find((item: any) => item.pluginId === notes.pluginId)));
          await settle(20);                                                                // Notes' consent is on screen
          expect({ consent: !!byId("plugins.management.allow"), told: told() }).toEqual({ consent: true, told: [{ readback: "failed", told: false }] });
          await appState("background");
          await appState("active");                                                        // reachable again: Demo's success is read again
          await settle(30);
          const first = () => __retainedForTests.conclusions().find((item: any) => item.operationId === "operation-0001") as any;
          expect({ readback: first().readback, told: !!first().told, consent: !!byId("plugins.management.allow") }).toEqual({ readback: "verified", told: false, consent: true });
        } finally { spy.mockRestore(); }
      });
      it("the result arrives while another screen is in front; back on the page while its read is out; that read has the instance without its record: read again, and proven", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "answer" || label === "installed-1" ? hold.wait(label) : undefined };
        wire(world);
        await installAndAllow();
        fixture.focused = false; await rerender();
        // The success's own read (the first installed read written) is answered without the plugin's record.
        world.reply = (snapshot) => ({ ...snapshot, market: { ...snapshot.market, items: [], unavailableReason: "fetch failed" } });
        hold.release("answer");
        await settle(30);
        expect(told()).toEqual([{ readback: "pending", told: false }]);
        world.reply = undefined;                                                 // from now on the record is there
        fixture.focused = true; await rerender();                                // reachable again while that read is out
        hold.release("installed-1");
        await settle(30);
        expect({ told: told(), banner: banner() }).toEqual({ told: [{ readback: "verified", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("Allow is still on its way when the receipt is found gone and the computer has no instance; Allow then times out: settled from those facts without another press", async () => {
        const hold = holds();
        const world: World = { ...fresh(), answerInstallsNothing: true, hold: (label: string) => label === "answer" ? hold.wait(label) : undefined,
          operation: () => { throw new Error("[NOT_FOUND] no such operation"); } };
        const requests = wire(world);
        await installAndAllow();
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();                                 // back: the lookup says NOT_FOUND; the facts have no instance
        await settle(20);
        hold.release("answer", false);                                           // Allow's reply never came
        await settle(40);
        expect({ checks: __retainedForTests.checks().length, results: __retainedForTests.conclusions().map((item: any) => item.result),
          begins: requests.filter((request) => request.actionId === "management:begin").length })
          .toEqual({ checks: 0, results: ["notInstalled"], begins: 1 });
      });

      /* 测试价值（推送前自查第六轮，2026-11-26）
       * - 生产入口与可观察结果：同本组。
       * - 依据与在 84ddb5043c 上复现的问题：面板开着时它显示为已证实的结果可能已经过期（电脑断开又连上、页面或 App
       *   离开又回来、电脑发来插件变更通知），「打开插件」仍可点、点下去打开旧结论；begin 的回包还没回来时回执过期，
       *   事实读到了却不收口（上一轮只修了「允许」）；保留上限只把刚结束的那条保到下一次任何结论变化。
       * - 最小失败输入：见各用例名；标「control」的在改前也通过。tier: unit（jsdom，内存 Host）。
       */
      it("the list is open and its read proved the install; the plugin is replaced on the computer meanwhile: the list does not follow the computer while it stays open (the next opening reads: the next test)", async () => {
        const world = fresh();
        const requests = wire(world);
        await provenWhileAway(world);                       // the list is open; the read it started as it opened proved the install
        // Replaced on the computer since (the computer now says someone else's install), and it says its plugins changed.
        world.reply = (snapshot: any) => ({ ...snapshot, market: { ...snapshot.market,
          items: snapshot.market.items.map(({ installedOperationId: _id, ...entry }: any) => ({ ...entry, installedOperationAttribution: "unattributed" })) } });
        const before = __retainedForTests.conclusions().map((item: any) => item.readback).join();
        await changeNotification();
        await settle(30);
        // (The page's own lists read again on the notification; the result's read is not issued again.)
        expect({ record: __retainedForTests.conclusions().map((item: any) => item.readback).join(), offered: !!byId("plugins.checks.open") }).toEqual({ record: before, offered: true });
        expect(writes(requests)).toEqual(ONCE);
      });
      it("proven, the list opened and closed without a look at the line being possible (its read was still out); the plugin is replaced; opened again: read as it opens, no \"Open plugin\", the sentence says why", async () => {
        const world = fresh();
        const requests = wire(world);
        await provenWhileAway(world, false);
        world.reply = (snapshot: any) => ({ ...snapshot, market: { ...snapshot.market,
          items: snapshot.market.items.map(({ installedOperationId: _id, ...entry }: any) => ({ ...entry, installedOperationAttribution: "unattributed" })) } });
        const reads = lightReads(requests);
        await click("plugins.slotHolder.show");
        expect({ reads: lightReads(requests) - reads, offered: !!byId("plugins.checks.open"), says: sheet().includes("plugins.checks.result.unconfirmed"), opened: openedIds(), told: told() })
          .toEqual({ reads: 1, offered: false, says: true, opened: [], told: [{ readback: "unconfirmed", told: false }] });
      });
      it("control: begin times out, then the receipt is found gone and the computer has no instance: settled without a press", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "begin:demo" ? hold.wait(label) : undefined,
          operation: () => { throw new Error("[NOT_FOUND] no such operation"); } };
        const requests = wire(world);
        fixture.platform = "android"; fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
        hold.release("begin:demo", false);
        await settle(20);
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(40);
        expect({ checks: __retainedForTests.checks().length, results: __retainedForTests.conclusions().map((item: any) => item.result),
          begins: requests.filter((request) => request.actionId === "management:begin").length }).toEqual({ checks: 0, results: ["notInstalled"], begins: 1 });
      });
      it.each([
        ["the computer has no instance", false, "notInstalled"],
        ["the computer installed it without asking and its facts prove it (V2.10 ①)", true, "installed"],
      ] as const)("begin is still on its way when the receipt is found gone and %s; begin then times out: settled from those facts without another press", async (_name, installedMeanwhile, result) => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "begin:demo" ? hold.wait(label) : undefined,
          operation: () => { throw new Error("[NOT_FOUND] no such operation"); } };
        const requests = wire(world);
        fixture.platform = "android"; fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);                    // begin is written; its reply is out
        expect(writes(requests)).toEqual(["begin:screen-operation"]);
        if (installedMeanwhile) world.installed.set("demo", "screen-operation");   // the computer committed it, then restarted
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();                                   // the lookup says NOT_FOUND; the facts are read
        await settle(20);
        expect(writes(requests)).toEqual(["begin:screen-operation", "operation:screen-operation"]);
        hold.release("begin:demo", false);                                         // begin's reply never came
        await settle(40);
        expect({ checks: __retainedForTests.checks().length, results: __retainedForTests.conclusions().map((item: any) => item.result),
          begins: requests.filter((request) => request.actionId === "management:begin").length }).toEqual({ checks: 0, results: [result], begins: 1 });
      });
      it.each([["control: ", 3], ["", 20]] as const)("%s%i results wait to be looked at; an install fails while the page is away; a read of another result lands: the failure is said on its row on return", async (_control, listed) => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-${String(++n).padStart(4, "0")}` as any);
        try {
          const many = Array.from({ length: listed + 1 }, (_, index) => marketItem(`p${index}`, `P${index}`));
          const failing = many[listed];
          const hold = holds();
          let armed = false, heldFrom = -1;
          const world: World = { ...fresh(), items: many, beginEnds: (ghostId) => ghostId === failing.ghostId ? "failed" : undefined,
            hold: (label: string) => {
              // The two installed reads written right after the last install's Allow stay out; every other read answers.
              if (label === "answer" && armed) { heldFrom = world.installedReads; return undefined; }
              const read = label.startsWith("installed-") ? Number(label.slice(10)) : 0;
              return heldFrom >= 0 && (read === heldFrom + 1 || read === heldFrom + 2) ? hold.wait("last-read")
                : label === `begin:${failing.ghostId}` ? hold.wait("failing-begin") : undefined;
            } };
          wire(world);
          fixture.platform = "android"; fixture.realConfirmation = true;
          await act(async () => root.render(createElement(PluginsScreen)));
          await act(async () => fixture.props.get("segment").onChange("market"));
          await settle(14);
          for (let index = 0; index < listed; index++) {
            if (index === listed - 1) armed = true;                                // the last success's read stays out
            await click(`plugins.market.install.${many[index].pluginId}`);
            await click("plugins.management.allow");
          }
          const waiting = () => __retainedForTests.conclusions().filter((item: any) => item.result === "succeeded" && !item.told).length;
          expect({ waiting: waiting(), lastStillRead: __retainedForTests.conclusions().at(-1)?.readback }).toEqual({ waiting: listed, lastStillRead: "pending" });
          await click(`plugins.market.install.${failing.pluginId}`);               // begin is written; its reply is out
          await leavePage();
          hold.release("failing-begin");                                           // the computer answers: failed
          await settle(30);
          expect(__retainedForTests.conclusions().map((item: any) => item.result).filter((result: string) => result === "failed")).toEqual(["failed"]);
          hold.release("last-read");                                               // the read of the last success lands
          await settle(30);
          await rerender();
          await act(async () => fixture.props.get("segment").onChange("market"));
          await settle(20);
          // "plugins.retry" on a row that says its install failed, "plugins.market.install" on an idle one.
          expect({ kept: __retainedForTests.conclusions().some((item: any) => item.result === "failed"), row: byId(`plugins.market.install.${failing.pluginId}`)?.textContent })
            .toEqual({ kept: true, row: "plugins.retry" });
        } finally { spy.mockRestore(); }
      });

      /* 测试价值（推送前自查第七轮，2026-11-26）
       * - 生产入口与可观察结果：同本组。
       * - 依据与在 f8d1f490c4 上复现的问题：上一版让「写入在途时回执过期」在写入一结束就按事实收口，早于那次写入自己的
       *   结果被处理：回包其实到达（确认、成功）或确知没写出的，都被收成「电脑上现在没有」（前三条；回归，由上一版带入）。
       *   写入结束而状态没变时「不再跟踪」一直不可点（后两条；c6efda5691 就有）。面板在电脑回来的那一刻发出的读取
       *   失败后被再读一次（最后一条）。
       * - 最小失败输入：见各用例名。tier: unit（jsdom，内存 Host）。
       */
      const stateOfChecks = () => ({ checks: __retainedForTests.checks().map((check: any) => check.state.outcome),
        results: __retainedForTests.conclusions().map((item: any) => item.result) });
      async function installFromMarketRow() {
        fixture.platform = "android"; fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
      }
      it("begin is still on its way when its lookup says NOT_FOUND; begin then arrives and is answered (a consent): the operation is still followed, and the consent is shown", async () => {
        const hold = holds();
        let arrived = false;
        const world: World = { ...fresh(), hold: (label: string) => label === "begin:demo" ? hold.wait(label) : undefined,
          operation: (operationId: string) => { if (!arrived) throw new Error("[NOT_FOUND] no such operation"); return consentFor(operationId, demo); } };
        const requests = wire(world);
        await installFromMarketRow();                                   // begin is written; its reply is out
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();                        // the lookup says NOT_FOUND; the facts are read
        await settle(20);
        expect(writes(requests)).toEqual(["begin:screen-operation", "operation:screen-operation"]);
        expect(stateOfChecks()).toEqual({ checks: ["unknown"], results: [] });
        arrived = true;
        hold.release("begin:demo", true);                               // begin's reply arrives: the computer asks for consent
        await settle(40);
        expect({ ...stateOfChecks(), consentOnScreen: !!byId("plugins.management.allow") }).toEqual({ checks: ["confirmation"], results: [], consentOnScreen: true });
      });
      it("begin is still on its way when its lookup says NOT_FOUND; begin then arrives and is answered \"succeeded\": the result is the success", async () => {
        const hold = holds();
        const world: World = { ...fresh(), operation: () => { throw new Error("[NOT_FOUND] no such operation"); } };
        const requests = wire(world);
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          const request = args?.[0];
          if (request?.actionId !== "management:begin") return original(device, channel, args, options);
          return transportSend(options, async () => {
            requests.push({ device, actionId: request.actionId, input: request.input });
            await hold.wait("begin");
            world.installed.set("demo", request.input.operationId);
            return { effects: [], result: { operationId: request.input.operationId, phase: "succeeded" } };
          });
        });
        await installFromMarketRow();
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(20);
        hold.release("begin");
        await settle(40);
        expect(__retainedForTests.conclusions().map((item: any) => [item.result, item.readback, item.instanceKey]))
          .toEqual([["succeeded", "verified", "_root__demo"]]);
      });
      it("begin is still queued when its lookup says NOT_FOUND; it is then refused before the write (known not sent): a plain failure", async () => {
        let dequeue!: () => void;
        const queued = new Promise<void>((resolve) => { dequeue = resolve; });
        const world: World = { ...fresh(), operation: () => { throw new Error("[NOT_FOUND] no such operation"); } };
        const requests = wire(world);
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          if (args?.[0]?.actionId === "management:begin") { options?.preSend?.(); await queued; }   // waits in the link's queue
          return original(device, channel, args, options);
        });
        await installFromMarketRow();
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(20);
        expect(writes(requests)).toEqual(["operation:screen-operation"]);
        await act(async () => { dequeue(); });
        await settle(40);
        expect({ written: writes(requests), results: __retainedForTests.conclusions().map((item: any) => item.result) })
          .toEqual({ written: ["operation:screen-operation"], results: ["failed"] });
      });
      // Pre-push review, round 8 (failed on 251f7dd5fc: a reply that arrives but is older than what is shown was dropped
      // without a word, like a lost one before).
      it("begin's reply (running) is still out; the page is left; a lookup after a reconnect finds the consent; the late reply then arrives: \"Stop tracking\" is available", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "begin:demo" ? hold.wait(label) : undefined, beginEnds: () => "running" };
        const requests = wire(world);
        await installFromMarketRow();
        await leavePage();
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();                        // the lookup finds the consent
        await settle(20);
        expect(writes(requests)).toEqual(["begin:screen-operation", "operation:screen-operation"]);
        expect(stateOfChecks()).toEqual({ checks: ["confirmation"], results: [] });
        await click("plugins.slotHolder.show");
        expect(byId("plugins.checks.stop")?.disabled).toBe(true);
        hold.release("begin:demo", true);                               // begin's own reply arrives: "running"
        await settle(40);
        const check: any = __retainedForTests.checks()[0];
        expect({ idle: check.controller.idle(), canStop: check.canStop, stopDisabled: byId("plugins.checks.stop")?.disabled })
          .toEqual({ idle: true, canStop: true, stopDisabled: false });
      });
      it("begin's reply (running) is still out; a lookup showed the consent; a later lookup says NOT_FOUND, no instance; begin's reply then arrives: settled from those facts, not left hanging", async () => {
        const hold = holds();
        let lookups = 0;
        const world: World = { ...fresh(), hold: (label: string) => label === "begin:demo" ? hold.wait(label) : undefined, beginEnds: () => "running",
          operation: (operationId: string) => { if (++lookups === 1) return consentFor(operationId, demo); throw new Error("[NOT_FOUND] no such operation"); } };
        wire(world);
        await installFromMarketRow();
        await leavePage();
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();                        // lookup 1: the consent
        await settle(20);
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();                        // lookup 2: NOT_FOUND; the facts are read
        await settle(20);
        expect(stateOfChecks()).toEqual({ checks: ["unknown"], results: [] });
        hold.release("begin:demo", true);
        await settle(60);
        expect({ left: __retainedForTests.checks().length, results: __retainedForTests.conclusions().map((item: any) => item.result) })
          .toEqual({ left: 0, results: ["notInstalled"] });
      });
      it("begin is on its way; receipt gone; the facts have the instance without its record; begin then times out: \"Stop tracking\" becomes available", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "begin:demo" ? hold.wait(label) : undefined,
          operation: () => { throw new Error("[NOT_FOUND] no such operation"); },
          reply: (snapshot: any) => ({ ...snapshot, market: { ...snapshot.market, items: [], unavailableReason: "fetch failed" } }) };
        wire(world);
        await installFromMarketRow();
        world.installed.set("demo", "someone-else");
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(20);
        expect(__retainedForTests.checks().map((check: any) => [check.recordMissing, check.canStop, check.controller.idle()])).toEqual([[true, false, false]]);
        hold.release("begin:demo", false);                              // the write is over
        await settle(40);
        const check: any = __retainedForTests.checks()[0];
        expect({ idle: check.controller.idle(), canStop: check.canStop }).toEqual({ idle: true, canStop: true });
      });
      it("an uninstall's begin is on its way; receipt gone (only \"Stop tracking\" is offered); begin then times out: \"Stop tracking\" can be pressed", async () => {
        let releaseBegin!: (ok: boolean) => void;
        const beginHeld = new Promise<boolean>((resolve) => { releaseBegin = resolve; });
        fixture.realManagement = true;
        fixture.wire.mockImplementation(async (_device: string, channel: string, args?: any[], options?: any) => transportSend(options, async () => {
          if (channel.endsWith(":manifest")) return { protocolVersion: 1, collections: [{ id: "plugins", actions: [{ id: "management:snapshot", label: "Manage" }] }] };
          const request = args?.[0] ?? {};
          if (request.actionId === "management:snapshot") return { effects: [], result: managementSnapshot(true) };
          if (request.actionId === "management:begin") { if (!(await beginHeld)) throw timeout(); return { effects: [], result: { operationId: request.input.operationId, phase: "running" } }; }
          if (request.actionId === "management:operation") throw new Error("[NOT_FOUND] no such operation");
          throw new Error("unexpected " + request.actionId);
        }));
        let management: any;
        function Probe({ online }: { online: boolean }) {
          management = usePluginManagement("mac", online, true, "probe");
          const checks = usePluginPendingChecks(() => online, true, ["mac"]);
          const conclusions = usePluginCheckConclusions();
          return createElement(PluginPendingChecksSheet, { visible: true, conclusions, isOnline: () => online, canOpen: () => true,
            lines: checks.map((check) => ({ key: check.operationId, entry: check.entry, who: check.who, check })),
            onDecide: () => false, onClose: () => {}, onOpenChecked: () => {}, onShowInstalled: () => {} });
        }
        const render = async (online: boolean) => { await act(async () => root.render(createElement(Probe, { online }))); await settle(20); };
        await render(true);
        const slot = pluginManagementSlotFor();
        const token = slot.tryAcquire("uninstall", { name: "Demo", deviceId: "mac", deviceName: "Mac", instanceKey: demoGhost.instanceKey, ghostId: "demo" })!;
        await act(async () => { void management.controller.uninstall(demoGhost as any, pluginOperationHold(slot, token)); });
        await settle(20);
        await render(false);
        await render(true);                                             // NOT_FOUND; the facts are read
        expect({ status: (byId("plugins.checks")?.textContent ?? "").includes("plugins.checks.status.unprovable.uninstall.present"),
          verify: !!byId("plugins.checks.verify"), stopDisabled: byId("plugins.checks.stop")?.disabled }).toEqual({ status: true, verify: false, stopDisabled: true });
        await act(async () => { releaseBegin(false); });                // the write is over
        await settle(40);
        expect({ idle: management.controller.idle(), stopDisabled: byId("plugins.checks.stop")?.disabled }).toEqual({ idle: true, stopDisabled: false });
      });
      it("the list is opened on a proven install while its computer is not connected; the computer comes back and the read then times out: the result's read is issued once", async () => {
        const world = fresh();
        wire(world);
        await provenWhileAway(world, false);
        fixture.online = false; await rerender();
        await click("plugins.slotHolder.show");                         // not read yet: its computer cannot be read
        expect(__retainedForTests.conclusions().map((item: any) => item.readback)).toEqual(["verified"]);
        world.hold = (label: string) => label.startsWith("installed-") ? Promise.resolve(false) : undefined;
        // Each read of the result sets it to "pending" again.
        const seen: string[] = [];
        function Watch() { const all = usePluginCheckConclusions(); seen.push(all.map((item) => item.readback).join()); return null; }
        const second = createRoot(document.createElement("div"));
        await act(async () => second.render(createElement(Watch)));
        seen.length = 0;
        fixture.online = true; await rerender();
        await settle(40);
        await act(async () => second.unmount());
        expect(seen).toEqual(["pending", "failed"]);
      });

      /* 测试价值（推送前自查第八轮，2026-11-26）
       * - 生产入口与可观察结果：同本组。
       * - 依据与在 251f7dd5fc 上复现的问题：维护者 17:43 第 1 条、20:45 第 1 条（确认只由用户在面板里的点按答复或取消）：
       *   「查看并决定」打开的确认在屏幕上时电脑掉线或 App 进后台，页面自己关掉面板，重连后那个确认被取消（c6efda5691
       *   就有）。「已看过」用了按下那一刻的结论（开关写入结束后的重读漏记，或把之后读出的 ② 记掉）；电脑离线时点开
       *   详情没有读取也记了。
       * - 最小失败输入：见各用例名；标 control 的改前也通过。tier: unit（jsdom，内存 Host）。
       */
      async function consentFromViewAndDecide(world: World) {
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);             // begin's reply is lost
        await click(`plugins.market.install.${demo.pluginId}`);             // the row's "Check result": a protocol error, lookups stop
        world.operation = undefined;                                        // the computer shows the operation's consent
        await click("plugins.slotHolder.show");
        await click("plugins.checks.verify");
        expect(sheet()).toContain("plugins.checks.status.awaitingYou");
        await click("plugins.checks.decide");
        expect(!!byId("plugins.management.allow")).toBe(true);
      }
      it.each([
        ["the computer drops and comes back", async () => { fixture.online = false; await rerender(); fixture.online = true; await rerender(); }],
        ["the app goes to the background and comes back", async () => { await appState("background"); await appState("active"); }],
      ] as const)("a consent opened with \"View and decide\" is on screen; %s: nothing is written for it; found again, it waits in the list for \"View and decide\"", async (_name, happens) => {
        const world: World = { ...fresh(), loseBegin: true, operation: () => { throw hostError("INVALID_RESPONSE"); } };
        const requests = wire(world);
        await consentFromViewAndDecide(world);
        const before = writes(requests).length;
        const written = () => writes(requests).slice(before).filter((write) => !write.startsWith("operation"));
        await happens();
        await settle(40);
        // Not cancelled, and not put on screen by itself: read-only in the list until the person opens it.
        expect({ written: written(), consent: !!byId("plugins.management.allow"), waits: __retainedForTests.checks().map((check: any) => [check.state.outcome, check.awaitingYou]) })
          .toEqual({ written: [], consent: false, waits: [["confirmation", true]] });
        if (!byId("plugins.checks")) await click("plugins.slotHolder.show");
        await click("plugins.checks.decide");
        await click("plugins.management.allow");                         // still the person's to answer: one answer
        expect(written()).toEqual(["answer:screen-operation"]);
      });
      it("control: the market row's own consent is on screen; the computer drops and comes back: nothing is written, the consent is shown again", async () => {
        const world = fresh();
        const requests = wire(world);
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
        expect(!!byId("plugins.management.allow")).toBe(true);
        const before = writes(requests).length;
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(40);
        expect({ written: writes(requests).slice(before).filter((write) => !write.startsWith("operation")), consent: !!byId("plugins.management.allow") }).toEqual({ written: [], consent: true });
      });
      // Pre-push review, round 9 (each failed on 30ef70ed32). The rule behind them: a consent counts as shown only while
      // it stays on screen. Once its result is unknown for now (the computer dropped, the app was in the background,
      // lookups stopped) no sheet shows it; a view that goes away after that (the row ending by itself, the person going
      // back, another consent opened) did not leave a consent, so the same consent found again is not cancelled.
      it.each([
        ["the list's \"Check result\"", async () => { await click("plugins.slotHolder.show"); await click("plugins.checks.verify"); }],
        ["the computer drops and comes back", async () => { fixture.online = false; await rerender(); fixture.online = true; await rerender(); }],
      ] as const)("the market row's own consent is on screen; the app goes to the background and back, and the lookup on return is a protocol error (lookups stop, the row ends); then %s finds the consent again: nothing is written for it", async (_name, found) => {
        const world: World = fresh();
        const requests = wire(world);
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
        expect(!!byId("plugins.management.allow")).toBe(true);              // the row's own consent, on screen, unanswered
        world.operation = () => { throw hostError("INVALID_RESPONSE"); };
        await appState("background"); await appState("active");
        await settle(40);
        expect({ consent: !!byId("plugins.management.allow"), checks: __retainedForTests.checks().map((check: any) => [check.state.outcome, check.waiting]), banner: banner() })
          .toEqual({ consent: false, checks: [["unknown", true]], banner: expect.stringContaining("plugins.checks.waitingOne") });
        world.operation = undefined;                                        // the computer still shows the same consent
        const before = writes(requests).length;
        await found();
        await settle(40);
        expect({ written: writes(requests).slice(before).filter((write) => !write.startsWith("operation")), waits: __retainedForTests.checks().map((check: any) => [check.state.outcome, check.awaitingYou]) })
          .toEqual({ written: [], waits: [["confirmation", true]] });
      });
      it("two computers; Demo's consent on Mac is open from \"View and decide\"; Mac drops; the person opens Notes' consent on PC with \"View and decide\"; Mac comes back: nothing is written for Demo's consent", async () => {
        let n = 0;
        const spy = vi.spyOn(expoCrypto, "randomUUID").mockImplementation(() => `operation-000${++n}` as any);
        try {
          const world: World = { ...fresh(), loseBegin: true, operation: () => { throw hostError("INVALID_RESPONSE"); } };
          const requests = wire(world);
          fixture.platform = "android";
          fixture.realConfirmation = true;
          fixture.extraDevices = [{ deviceId: "pc", name: "PC", platform: "win32", remoteControlEnabled: true }];
          await act(async () => root.render(createElement(PluginsScreen)));
          await act(async () => fixture.props.get("segment").onChange("market"));
          await settle(14);
          await click(`plugins.market.install.${demo.pluginId}`);           // Mac: begin's reply is lost
          await click(`plugins.market.install.${demo.pluginId}`);           // "Check result": a protocol error, lookups stop
          await click("plugins.market.computer");
          await click("plugins.market.computer.pc");
          await click(`plugins.market.install.${notes.pluginId}`);          // PC: the same for Notes
          await click(`plugins.market.install.${notes.pluginId}`);
          expect(__retainedForTests.checks().map((check: any) => [check.operationId, check.who.deviceId, check.waiting]))
            .toEqual([["operation-0001", "mac", true], ["operation-0002", "pc", true]]);
          world.operation = undefined;                                      // both computers show their consent
          const inLine = (operationId: string, id: string) => element.querySelector(`[data-testid="plugins.checks.item.${operationId}"] [data-testid="${id}"]`) as HTMLButtonElement;
          const press = async (operationId: string, id: string) => { expect(inLine(operationId, id), `${id} of ${operationId}`).not.toBeNull(); expect(inLine(operationId, id).disabled).toBe(false);
            await act(async () => inLine(operationId, id).click()); await settle(20); };
          await click("plugins.slotHolder.show");
          await press("operation-0001", "plugins.checks.verify");
          await press("operation-0002", "plugins.checks.verify");
          await press("operation-0001", "plugins.checks.decide");           // Demo's consent (Mac) is on screen
          fixture.offlineDevices.add("mac"); await rerender();              // Mac drops: unknown for now
          if (!byId("plugins.checks")) await click("plugins.slotHolder.show");
          await press("operation-0002", "plugins.checks.decide");           // the person opens Notes' consent (PC)
          const before = writes(requests).length;
          fixture.offlineDevices.delete("mac"); await rerender();           // Mac is back: its consent is found again
          await settle(40);
          expect(writes(requests).slice(before).filter((write) => !write.startsWith("operation"))).toEqual([]);
        } finally { spy.mockRestore(); }
      });
      it("a consent opened with \"View and decide\" is on screen; Allow is pressed and its reply is lost; a later lookup finds a new consent (another request id): it waits for \"View and decide\", it is not put on screen by itself", async () => {
        const world: World = { ...fresh(), loseBegin: true, operation: () => { throw hostError("INVALID_RESPONSE"); } };
        const requests = wire(world);
        await consentFromViewAndDecide(world);
        world.loseAnswer = true; world.answerInstallsNothing = true;
        world.operation = (operationId: string) => ({ ...consentFor(operationId, demo), consent: { ...consentFor(operationId, demo).consent, requestId: "consent-2" } });
        const before = writes(requests).length;
        await click("plugins.management.allow");                             // the answer is written; its reply is lost
        expect(__retainedForTests.checks().map((check: any) => check.state.outcome)).toEqual(["unknown"]);
        fixture.online = false; await rerender(); fixture.online = true; await rerender();   // looked up again: a second consent
        await settle(40);
        const check: any = __retainedForTests.checks()[0];
        expect({ request: check.state.receipt?.consent?.requestId, written: writes(requests).slice(before).filter((write) => !write.startsWith("operation")),
          onScreenByItself: !!byId("plugins.management.allow"), waitsForViewAndDecide: check.controller.consentUnseen() })
          .toEqual({ request: "consent-2", written: ["answer:screen-operation"], onScreenByItself: false, waitsForViewAndDecide: true });
      });
      // Pre-push review, round 10 (failed on f2f5038007: the row said "Installing" while the list said the computer was
      // waiting for the person; nothing was being installed).
      it("the market row's own consent was on screen; background and back, lookups stop (the row ends); the list's \"Check result\" finds the consent again: the row says it waits for the person, as the list does", async () => {
        const world: World = fresh();
        wire(world);
        fixture.platform = "android";
        fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${demo.pluginId}`);
        world.operation = () => { throw hostError("INVALID_RESPONSE"); };
        await appState("background"); await appState("active");
        await settle(40);
        world.operation = undefined;
        await click("plugins.slotHolder.show"); await click("plugins.checks.verify");
        await settle(40);
        const rowText = [...element.querySelectorAll("span")].map((span) => span.textContent).filter((text) => /^plugins\.market\.(waiting|installing|resultUnknownDetail)$/.test(text ?? ""));
        expect({ list: sheet().includes("plugins.checks.status.awaitingYou"), rowText }).toEqual({ list: true, rowText: ["plugins.market.waiting"] });
      });
      // Dispatcher (2026-11-26; Host invariant: reading `'self'` implies the operation's receipt said succeeded). A
      // failed receipt this phone has seen is final: nothing read afterwards (the receipt gone, the computer's record
      // naming this phone's operation as `'self'`) turns it into a success. Only a result still unknown is settled
      // from the computer's facts. Tier: unit/jsdom.
      it.each([
        ["the row's own attempt", false],
        ["a pending check, through the list's \"Check result\"", true],
      ] as const)("%s sees the operation failed; the computer then restarts (receipt gone) and its record names this phone's operation: still failed, never opened", async (_name, viaCheck) => {
        const world: World = { ...fresh(), ...(viaCheck ? { loseAnswer: true } : {}) };
        const requests = wire(world);
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          const reply: any = await original(device, channel, args, options);
          // The computer committed the package and bound it to this phone, yet its receipt for this operation says failed
          // (a step after the package landed failed). The phone sees that receipt as the answer's reply or a lookup's.
          if (args?.[0]?.actionId === "management:answer" || (args?.[0]?.actionId === "management:operation" && world.installed.size))
            return { ...reply, result: { operationId: args![0].input.operationId, phase: "failed", errorCode: "PLUGIN_INSTALL_CHANGED" } };
          return reply;
        });
        await installAndAllow();
        if (viaCheck) {
          await click("plugins.slotHolder.show");
          await click("plugins.checks.verify");
        }
        await settle(30);
        expect(__retainedForTests.conclusions().map((item: any) => [item.result, item.readback])).toEqual([["failed", "none"]]);
        expect(world.installed.get("demo")).toBe("screen-operation");          // the computer's record: this phone's operation
        // The computer restarts: the receipt is gone. Back online, and the person looks again where they can.
        world.operation = () => { throw new Error("[NOT_FOUND] no such operation"); };
        const reads = lightReads(requests);
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(30);
        if (!byId("plugins.checks")) await click("plugins.slotHolder.show").catch(() => undefined);
        expect({ results: __retainedForTests.conclusions().map((item: any) => [item.result, item.readback]), checks: __retainedForTests.checks().length,
          readAfter: lightReads(requests) - reads, open: !!byId("plugins.checks.open"), opened: openedIds(),
          lookups: writes(requests).filter((write) => write.startsWith("operation")).length >= (viaCheck ? 1 : 0) })
          .toEqual({ results: [["failed", "none"]], checks: 0, readAfter: 0, open: false, opened: [], lookups: true });
      });
      // Self-review, path 3 (Host shapes): when this phone cancels a consent it left, the computer replies with the phase
      // still "confirmation" and no consent (the prompt's abort listener drops it; the phase moves on when the install
      // flow winds down), and lookups say the same until then. Read as malformed, the cancel became "result unknown"
      // with lookups stopped: a pending check after almost every leave. Minimal failing input on fd37378e31: that
      // reply. Tier: unit/jsdom.
      it("Notes' consent is on screen; the page is left; the computer answers the cancel with its withdrawn consent, then cancelled: not a malformed reply, lookups go on, the install ends cancelled", async () => {
        const world = fresh();
        const requests = wire(world);
        let lookups = 0;
        const original = fixture.wire.getMockImplementation()!;
        fixture.wire.mockImplementation(async (device: string, channel: string, args?: any[], options?: any) => {
          const id = args?.[0]?.actionId;
          if (id === "management:cancel" || id === "management:operation") {
            return transportSend(options, async () => {
              requests.push({ device, actionId: id, input: args![0].input });
              const operationId = args![0].input.operationId;
              // The cancel's reply: withdrawn, winding down. Lookups after it: cancelled (the flow ends right after the abort).
              if (id === "management:operation") lookups += 1;
              const withdrawn = id === "management:cancel";
              return { effects: [], result: withdrawn ? { operationId, phase: "confirmation" } : { operationId, phase: "cancelled" } };
            });
          }
          return original(device, channel, args, options);
        });
        fixture.platform = "android"; fixture.realConfirmation = true;
        await act(async () => root.render(createElement(PluginsScreen)));
        await act(async () => fixture.props.get("segment").onChange("market"));
        await settle(14);
        await click(`plugins.market.install.${notes.pluginId}`);
        expect(!!byId("plugins.management.allow")).toBe(true);
        await leavePage();                                                    // leaving the consent on screen cancels it
        await settle(30);
        expect(writes(requests).filter((write) => write.startsWith("cancel"))).toHaveLength(1);
        // Not a malformed reply: no protocol error, and automatic lookups go on (nothing waits for a press).
        expect(__retainedForTests.checks().map((check: any) => [check.state.errorCode ?? null, check.waiting])).toEqual([[null, false]]);
        await rerender();
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();                              // a lookup: cancelled
        await settle(40);
        expect({ checks: __retainedForTests.checks().length, results: __retainedForTests.conclusions().map((item: any) => item.result),
          cancels: writes(requests).filter((write) => write.startsWith("cancel")).length }).toEqual({ checks: 0, results: ["cancelled"], cancels: 1 });
      });
      const installedRow = () => ({ key: JSON.stringify(["mac", "plugins", "plugin", "_root__demo"]), host: { deviceId: "mac", deviceName: "Mac" },
        item: { ref: { collectionId: "plugins", kind: "plugin", id: "_root__demo" }, revision: "1", display: { title: "Demo" }, actions: [{ id: "disable", label: "Enabled" }] } });
      it("an install's read is still out; the person opens that plugin's installed detail and flips its switch; the read proves the install while the switch is written; the detail is read again after the write: seen", async () => {
        const hold = holds();
        const world: World = { ...fresh(), hold: (label: string) => label === "installed-1" ? hold.wait(label) : undefined };
        wire(world);
        await installAndAllow();
        expect(told()).toEqual([{ readback: "pending", told: false }]);
        const installed = installedRow();
        fixture.read.mockImplementation(async (_invoke: any, _host: any, ref: any) => ({ ...installed.item, ref, blocks: [] }));
        fixture.extraRows = [installed];
        fixture.platform = "ios";
        await rerender();
        await act(async () => fixture.props.get("directory").onDetail(installed));
        await settle(14);
        let written!: () => void;
        fixture.invoke.mockImplementation(() => new Promise<void>((resolve) => { written = resolve; }));
        await act(async () => fixture.props.get("detail").onEnabledChange(false));
        await settle(6);
        expect(fixture.invoke).toHaveBeenCalledTimes(1);
        hold.release("installed-1");                                      // the success's own read proves the install
        await settle(20);
        expect(told()).toEqual([{ readback: "verified", told: false }]);
        fixture.read.mockClear();
        await act(async () => { written(); });                            // the switch's write is back: the detail is read again
        await settle(20);
        expect({ reads: openedIds(), told: told(), banner: banner() }).toEqual({ reads: ["mac:_root__demo"], told: [{ readback: "verified", told: true }], banner: "" });
      });
      it("a proven install's detail is on screen; its switch is being written; the list is opened and closed while its read is out; that read says another install since (②); the switch's write is back: ② is still listed", async () => {
        const world = fresh();
        wire(world);
        await installUnread(world);
        const installed = installedRow();
        fixture.read.mockImplementation(async (_invoke: any, _host: any, ref: any) => ({ ...installed.item, ref, blocks: [] }));
        fixture.extraRows = [installed];
        fixture.platform = "ios";
        await rerender();
        await act(async () => fixture.props.get("directory").onDetail(installed));
        await settle(14);
        fixture.online = false; await rerender();
        fixture.online = true; await rerender();
        await settle(20);
        expect(told()).toEqual([{ readback: "verified", told: false }]);      // proven after the detail was opened: still listed
        let written!: () => void;
        fixture.invoke.mockImplementation(() => new Promise<void>((resolve) => { written = resolve; }));
        await act(async () => fixture.props.get("detail").onEnabledChange(false));
        await settle(6);
        expect(fixture.invoke).toHaveBeenCalledTimes(1);
        const hold = holds();
        world.hold = (label: string) => label.startsWith("installed-") ? hold.wait("open-read") : undefined;
        world.reply = (snapshot: any) => ({ ...snapshot, market: { ...snapshot.market, items: snapshot.market.items.map(({ installedOperationId: _id, ...entry }: any) => ({ ...entry, installedOperationAttribution: "unattributed" })) } });
        await click("plugins.slotHolder.show");                              // the list reads it again as it opens
        expect(sheet()).toContain("plugins.checks.result.readingBack");
        await click("plugins.checks.close");                                 // closed before that read is back: nothing seen
        expect(told()).toEqual([{ readback: "pending", told: false }]);
        hold.release("open-read");
        await settle(30);
        expect(told()).toEqual([{ readback: "unconfirmed", told: false }]);  // ②: listed, to be read in the list
        await act(async () => { written(); });
        await settle(20);
        expect({ told: told(), banner: banner() }).toEqual({ told: [{ readback: "unconfirmed", told: false }], banner: expect.stringContaining("plugins.checks.settledOne") });
      });
      it("proven while the page was away; its computer is not connected; the person taps that plugin in the installed list: no detail read is issued, so the result is not seen yet", async () => {
        const world = fresh();
        wire(world);
        await provenWhileAway(world, false);
        const installed = installedRow();
        fixture.read.mockImplementation(async (_invoke: any, _host: any, ref: any) => ({ ...installed.item, ref, blocks: [] }));
        fixture.extraRows = [installed];
        fixture.platform = "ios";
        fixture.online = false; await rerender();
        expect(told()).toEqual([{ readback: "verified", told: false }]);
        fixture.read.mockClear();
        await act(async () => fixture.props.get("directory").onOpen(installed));
        await settle(14);
        expect({ reads: openedIds(), told: told() }).toEqual({ reads: [], told: [{ readback: "verified", told: false }] });
      });
    });

  });
});
