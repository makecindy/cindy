// @vitest-environment jsdom
import { fixture, row, root, element, openDetail, transportSend, type MarketWireRequest, marketWire, marketItem, demoConsent, approveOnPhone, marketPage, settle, openMarket, shownMarket, hostError, demoGhost, attributed, managementSnapshot, managedScreen, realManagementHost } from "./pluginsScreenHarness";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginUiEnablePrompt } from "@/plugins/PluginUiEnablePrompt";
import { sharedTaskHostPeer, providerShareHostPeer } from "@cindy/device-link";
import PluginsScreen from "@/plugins/PluginsScreen";
import { pluginConsentPresentation } from "@/plugins/pluginConsentPresentation";
import { usePluginManagement, __retainedForTests } from "@/plugins/usePluginManagement";
import { __testing as slotTesting, pluginManagementSlotFor } from "@/plugins/pluginManagementSlot";
import { createPluginPromptReads } from "@/plugins/pluginPromptReads";
import { CONTRACT_SAMPLES, HOST_INSTALL_SITUATIONS, hostInstallFacts, secondShapes, type HostInstallSituation } from "./hostPluginInstallFacts";

// The page's one management slot across every entry, moved unchanged out of pluginsScreen.test.tsx (same describe
// name) to keep each file within the per-file unit budget (engineering-conventions §3.2); both share
// pluginsScreenHarness.tsx. Tier: unit (jsdom, in-memory Host).
/* 测试价值（维护者 15:37 复审第 1、2 条；调度要求的结构性收口）
 * - 生产入口与可观察结果：真实 PluginsScreen、真实 PluginTaskSettings 表单、真实 usePluginMarket 与管理
 *   client / controller，只替换设备互联的传输；观察写向 Host 的请求（market-detail、begin、开关、task-settings:set）
 *   与各入口显示是否可用。
 * - 依据：页面只有一个同步占用（pluginManagementSlot.ts）：按下即 tryAcquire，只有持有者的凭据能释放，卸载 / 重新
 *   挂载不释放也不重置；各入口的「不可用」只是它的投影。
 * - 缺口：入口各自用渲染态、ref 或表单本地锁判断；同一次渲染的两个回调、重新挂载的表单都能再写一次。
 * - 最小失败输入：任务设置保存挂起时换详情再保存（第二笔写出）；同一个 act 里先后交付市场安装与页面批准（两条
 *   begin）。tier: unit；每个用例只渲染一次页面，传输为同步替身。
 */
describe("one page slot for every entry (real components, three ways of delivering the second press)", () => {
  const entries = ["market install", "update", "uninstall", "enable switch", "page approval", "task settings"] as const;
  type Entry = typeof entries[number];
  /** Which entry a request written to the Host belongs to. */
  const owner = (request: string): Entry => request === "market-detail:other" || request === "begin:install:market/other" ? "market install"
    : request === "market-detail:update" || request === "begin:install:market/demo" ? "update"
      : request === "begin:uninstall" ? "uninstall" : request === "begin:approve-ui" ? "page approval"
        : request === "switch" ? "enable switch" : "task settings";
  async function screen() {
    const { plugin, snapshot, market } = realManagementHost();
    Object.assign(plugin.manifest, { tools: [{ name: "open" }], mcpApps: { ui: { resources: [{ uri: "ui://form", file: "ui/form.html" }], tools: { open: { resourceUri: "ui://form" } } } } });
    Object.assign(snapshot, { uiCapabilityApproval: true });
    // A second installed plugin, to switch the detail away and back (remounting the detail, its form and controller).
    const second = { ...plugin, instanceKey: "demo-b", manifest: { ...plugin.manifest, id: "demo-b", name: "Demo B" } };
    snapshot.ghosts.push(second as any);
    fixture.extraRows = [{ ...row(), key: "mac:plugin-b", item: { ...row().item, ref: { collectionId: "plugins", kind: "plugin", id: "demo-b" }, display: { title: "Demo B" } } }];
    fixture.blocks = [{ id: "capabilities", primitive: "plugin-capabilities", data: { tasks: true } }];
    fixture.width = 900;
    const other = { ...marketItem("other", "Other"), pluginId: "market/other" };
    // Every first request of an entry waits here until `release`; afterwards operations end at once (cancelled).
    let holding = true;
    const gates: Array<() => void> = [];
    const held = () => holding ? new Promise<void>((resolve) => { gates.push(resolve); }) : Promise.resolve();
    const writes: string[] = [];
    const preferences = { revision: "tasks-1", config: {}, permissionModes: ["ask"], defaultPermissionMode: "ask" };
    fixture.wire.mockImplementation(async (_host: string, channel: string, args: any[], options: any) => {
      options?.preSend?.(); options?.onRequestWritten?.();
      if (channel.endsWith(":manifest")) return { collections: [{ id: "plugins", actions: [{ id: "management:snapshot" }] }] };
      const request = args[0];
      if (request.actionId === "management:snapshot") {
        if (request.input?.read === "capabilities") return { result: { catalogPaging: true } };
        if (request.input?.read === "catalog") return { result: marketPage([other]) };
        return { result: snapshot };
      }
      if (request.actionId === "management:market-detail") {
        const isOther = request.input?.pluginId === other.pluginId;
        writes.push(isOther ? "market-detail:other" : "market-detail:update");
        await held();
        return { result: isOther ? { ...other, manifest: { schemaVersion: 3, id: "other", name: "Other", version: "1" } } : market };
      }
      if (request.actionId === "management:begin") {
        writes.push(`begin:${request.input.kind}${request.input.kind === "install" ? ":" + request.input.pluginId : ""}`);
        await held();
        return { result: { operationId: request.input.operationId, phase: "cancelled" } };
      }
      if (request.actionId === "management:operation") return { result: { operationId: request.input.operationId, phase: "cancelled" } };
      if (request.actionId === "management:cancel") return { result: { operationId: request.input.operationId, phase: "cancelled" } };
      throw new Error("Unexpected action " + request.actionId);
    });
    fixture.invoke.mockImplementation(async (_invoke: unknown, _device: string, _plugin: string, action: string) => {
      if (action === "task-settings:get") return preferences;
      if (action === "task-settings:set") { writes.push("task-settings"); await held(); return preferences; }
      writes.push("switch"); await held(); return {};
    });
    const openOn = async (id: "demo" | "demo-b") => {
      const target = id === "demo" ? row() : fixture.extraRows[0];
      await act(async () => fixture.props.get("directory").onDetail(target));
      await settle(8);
    };
    await openDetail();
    await settle(8);
    await act(async () => fixture.props.get("directory").onSegmentChange("market"));
    await settle(14);
    const menu = (id: string) => fixture.props.get("header").rightToolbar.props.actions.find((action: any) => action.id === id);
    const approval = () => fixture.props.get("detail").uiApprovalNotice?.actions?.[0];
    const modelButton = () => [...element.querySelectorAll("button")].find((button) => button.textContent?.includes("plugins.taskModel"));
    const available: Record<Entry, () => boolean> = {
      "market install": () => shownMarket().canInstall === true,
      update: () => !!menu("update") && !menu("update").disabled,
      uninstall: () => !!menu("uninstall") && !menu("uninstall").disabled,
      "enable switch": () => fixture.props.get("detail").busy === false,
      "page approval": () => approval()?.disabled === false,
      "task settings": () => !!modelButton() && !(modelButton() as HTMLButtonElement).disabled,
    };
    const choice = { agent: "codex", providerId: "host-provider", modelId: "host-model", effort: "high", fast: false };
    /** What a press does, bound to the current render (it may be delivered later, from a stale render). */
    const press = async (entry: Entry): Promise<() => void> => {
      if (entry === "market install") { const m = shownMarket(); return () => { void m.install(m.items[0]); }; }
      if (entry === "update" || entry === "uninstall") {
        const toolbar = fixture.props.get("header").rightToolbar.props;
        return () => {
          const alerts = fixture.alert.mock.calls.length;
          void toolbar.onAction(entry);
          // The uninstall alert's destructive button, pressed right away.
          if (entry === "uninstall" && fixture.alert.mock.calls.length > alerts) void fixture.alert.mock.calls.at(-1)![2][1].onPress();
        };
      }
      if (entry === "enable switch") { const detail = fixture.props.get("detail"); return () => { void detail.onEnabledChange(false); }; }
      if (entry === "page approval") { const action = approval(); return () => { action?.onPress(); }; }
      // Task settings: open the model picker (sends nothing); choosing saves.
      const button = modelButton();
      if (!button) return () => {};
      await act(async () => button.click());
      const picker = fixture.props.get("taskModelPicker");
      return () => { void picker.unified.onSelect(choice, undefined); };
    };
    const release = async () => {
      holding = false;
      await act(async () => { gates.splice(0).forEach((open) => open()); });
      await settle(20);
    };
    /** The holder's views go away and come back: another plugin's detail and back, narrow and wide again. */
    const remount = async () => {
      await openOn("demo-b");
      fixture.width = 400;
      await act(async () => root.render(createElement(PluginsScreen)));
      fixture.width = 900;
      await act(async () => root.render(createElement(PluginsScreen)));
      await openOn("demo");
      await act(async () => fixture.props.get("directory").onSegmentChange("installed"));
      await act(async () => fixture.props.get("directory").onSegmentChange("market"));
      await settle(14);
    };
    /** The whole plugins page goes away and is opened again (no selection, the installed list). */
    const pageAgain = async () => {
      await act(async () => root.render(createElement("div")));
      await settle(6);
      fixture.props.delete("plugins.slotHolder");
      await act(async () => root.render(createElement(PluginsScreen)));
      await settle(14);
    };
    /** Lets only the oldest held request through (for example a preparation read, so the write behind it waits). */
    const step = async () => { await act(async () => { gates.shift()?.(); }); await settle(14); };
    return { available, press, release, remount, writes, openOn, pageAgain, step };
  }
  const pairs = entries.flatMap((first) => entries.map((second) => [first, second] as const));
  const third = (first: Entry, second: Entry) => entries.find((entry) => entry !== first && entry !== second)!;
  const ownersAfter = (writes: string[], from: number) => [...new Set(writes.slice(from).map(owner))];
  it.each(pairs.filter(([first, second]) => first !== second))(
    "① while %s is in flight, %s pressed (fresh or stale) sends nothing", async (first, second) => {
      const s = await screen();
      for (const entry of [first, second]) expect(s.available[entry](), `${entry} before`).toBe(true);
      const stale = await s.press(second);
      (await s.press(first))();
      await settle(10);
      expect(s.available[second](), `${second} while ${first}`).toBe(false);
      expect(s.available[third(first, second)](), `third entry while ${first}`).toBe(false);
      const sent = s.writes.length;
      await act(async () => stale());
      await act(async () => (await s.press(second))());
      await settle(10);
      expect(ownersAfter(s.writes, sent)).toEqual([]);
      expect(ownersAfter(s.writes, 0)).toEqual([first]);
      await s.release();
      expect(s.available[third(first, second)](), `third entry after ${first}`).toBe(true);
    });
  it.each(pairs)("② %s and %s pressed in the same act: only the first starts", async (first, second) => {
    const s = await screen();
    const a = await s.press(first), b = await s.press(second);
    await act(async () => { a(); b(); });
    await settle(10);
    expect(ownersAfter(s.writes, 0)).toEqual([first]);
    // Pressed twice: still one request of its own.
    if (first === second) expect(s.writes.filter((write) => owner(write) === first && !write.startsWith("market-detail")).length
      + s.writes.filter((write) => write.startsWith("market-detail")).length).toBe(1);
    await s.release();
  });
  it.each(pairs)("③ %s in flight, its views mounted again, then %s pressed: nothing sent", async (first, second) => {
    const s = await screen();
    (await s.press(first))();
    await settle(10);
    const sent = s.writes.length;
    await s.remount();
    expect(s.available[second](), `${second} after remounting`).toBe(false);
    await act(async () => (await s.press(second))());
    await settle(10);
    expect(ownersAfter(s.writes, sent)).toEqual([]);
    await s.release();
    expect(s.available[third(first, second === first ? third(first, first) : second)]()).toBe(true);
  });
  // Dispatcher request G: each of the six entries, with its request in flight, survives the whole page going away: the
  // page says which plugin on which computer holds the slot and goes to it; nothing is sent again; once the request
  // settles, the notice goes and the entries come back. (After the app process restarts, nothing is kept: the slot and
  // the operation are in memory only, and the installed state shows the result; see plugin-mobile-implementation.md.)
  it.each(entries.map((entry) => [entry] as const))("keeps %s findable and checkable after the whole page is opened again", async (entry) => {
    const s = await screen();
    (await s.press(entry))();
    await settle(10);
    // A market install's own detail read goes through: it is then handed to its controller and waits on begin.
    if (entry === "market install") await s.step();
    const sent = s.writes.length;
    await s.pageAgain();
    const notice = fixture.props.get("plugins.slotHolder");
    expect(notice, "a notice names the holder").toBeDefined();
    expect(notice.title).toBe("plugins.slot.holder");
    await act(async () => notice.actions[0].onPress());
    await settle(14);
    // Gone to it: the market (install) or the plugin's detail; nothing was sent again.
    if (entry === "market install") expect(shownMarket().installBusy).toBe(true);
    else expect(fixture.props.get("detail")?.row?.item?.ref?.id).toBe("demo");
    expect(s.writes.slice(sent)).toEqual([]);
    await s.release();
    fixture.props.delete("plugins.slotHolder");
    await act(async () => root.render(createElement(PluginsScreen)));
    expect(fixture.props.has("plugins.slotHolder")).toBe(false);
    expect((pluginManagementSlotFor().holders()[0] ?? null)).toBeNull();
  });
  // The maintainer's own steps: plugin A's task settings save is in flight; switch to plugin B and save there.
  it("keeps a second task settings save from another plugin's form while the first is in flight", async () => {
    const s = await screen();
    (await s.press("task settings"))();
    await settle(10);
    await s.openOn("demo-b");
    expect(s.available["task settings"]()).toBe(false);
    await act(async () => (await s.press("task settings"))());
    await settle(10);
    expect(s.writes.filter((write) => write === "task settings" || write === "task-settings")).toEqual(["task-settings"]);
    // The market stays unavailable until the first save is over, then comes back.
    expect(shownMarket().canInstall).toBe(false);
    await s.release();
    expect(shownMarket().canInstall).toBe(true);
  });
});
