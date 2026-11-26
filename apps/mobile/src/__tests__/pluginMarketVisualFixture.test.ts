import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ randomUUID: () => "visual-operation" }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, Platform: { OS: "ios" } }));
vi.mock("@/auth/AuthContext", () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock("@/device-link/DeviceLinkContext", () => ({ useDeviceLink: () => ({}) }));
vi.mock("@/device-link/revokedDevicesStore", () => ({ useRevokedDevices: () => null }));
/** `raceLookups`: a record is looked up as soon as it is adopted (the page's pending-check driver on a device, S-2). */
const driver = vi.hoisted(() => ({ raceLookups: false }));
vi.mock("@/plugins/usePluginManagement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/plugins/usePluginManagement")>();
  return { ...actual, __adoptPendingCheckForVisualMock: (...args: Parameters<typeof actual.__adoptPendingCheckForVisualMock>) => {
    actual.__adoptPendingCheckForVisualMock(...args);
    if (!driver.raceLookups) return;
    // Once its first lookup has left it unknown (it let go of the computer), it is looked up again right away.
    const controller = args[0];
    let again = true;
    controller.subscribe(() => {
      const state = controller.getState();
      if (again && state.outcome === "unknown" && !state.busy) { again = false; void controller.reconcile(); }
    });
  } };
});
import { PLUGIN_MARKET_VISUAL_SCENARIOS, pluginMarketVisualDemoIds, pluginMarketVisualManagement, resetPluginMarketVisualComputer,
  setPluginMarketVisualScenario } from "@/debug/pluginMarketVisualFixture";
import { isPluginMarketSourceIdentity, parsePluginManagementDetail, parsePluginManagementReceipt, parsePluginManagementSnapshot } from "@/plugins/pluginManagementTypes";
import { parsePluginMarketPage } from "@/plugins/pluginMarketCatalog";
import { declaredPluginConsent, pluginConsentAllowance } from "@/plugins/pluginConsentAllowance";
import { seedPluginChecksForVisualMock } from "@/debug/pluginChecksVisualFixture";
import { __retainedForTests } from "@/plugins/usePluginManagement";
import { __testing as slotTesting } from "@/plugins/pluginManagementSlot";

/* 测试价值（调度要求 L-5：待核实记录的每种新状态都能在模拟数据里稳定进入）
 * - 生产入口与可观察结果：`--mock` 插件市场的管理动作（pluginMarketVisualManagement，手机实际调用的同一入口）；观察
 *   Demo Uncertain Sync 在三个场景下 begin、原号查询与已装读取的回答顺序。
 * - 依据：docs/dev-rules/ui-mock-data.md：lateConsent 进入「电脑正在等你确认」，lateResult 进入「成功 + 打开」，
 *   unreadResult 进入「成功但没能读取 + 重新读取」；三者都先经过 begin 回包丢失与一次协议错误（交给待核实记录）。
 * - 缺口：截图时要靠手速与时序才能碰上这些状态，复拍无法稳定进入。
 * - 最小失败输入：每个场景一次安装与两次查询。tier: unit。
 */
const PLUGIN = "demo-market/demo-uncertain-sync";
const INSTANCE = "_root__demo-uncertain-sync";
const begin = (operationId: string) => () => pluginMarketVisualManagement("management:begin",
  { operationId, kind: "install", pluginId: PLUGIN, expectedReleaseId: "demo-uncertain-sync@1.4.2" });
const lookup = (operationId: string) => pluginMarketVisualManagement("management:operation", { operationId }) as { result: { phase: string } };
const snapshot = () => pluginMarketVisualManagement("management:snapshot", { read: "installed" });
afterEach(() => { setPluginMarketVisualScenario("normal", true); });

describe("mock market pending-check scenarios", () => {
  // Maintainer review 03:52: market=readbackFailed puts a market install into "done, but could not read" (its row ends,
  // the success waits in the list of checks with "Read again"): the installed reads right after the commit fail, the next
  // one reads the plugin. Tier: unit.
  it("readbackFailed: the two installed reads after an install commits fail, then the plugin is read", () => {
    expect(setPluginMarketVisualScenario("readbackFailed", true)).toBe(true);
    const operationId = "op-readback";
    pluginMarketVisualManagement("management:begin", { operationId, kind: "install",
      pluginId: "demo-market/demo-agenda", expectedReleaseId: "demo-agenda@1.4.2" });
    expect(snapshot).not.toThrow();
    const consent = (lookup(operationId).result as { consent?: { requestId: string } }).consent;
    pluginMarketVisualManagement("management:answer", { operationId, requestId: consent!.requestId, confirmed: true });
    let phase = "";
    for (let poll = 0; poll < 10 && phase !== "succeeded"; poll++) phase = lookup(operationId).result.phase;
    expect(phase).toBe("succeeded");
    for (let read = 0; read < 2; read++) expect(snapshot).toThrow(/TIMEOUT/);
    const read = snapshot() as { result: { ghosts: Array<{ manifest: { id: string } }> } };
    expect(read.result.ghosts.map((ghost) => ghost.manifest.id)).toContain("demo-agenda");
  });
  it.each([["lateConsent", "confirmation"], ["lateResult", "succeeded"], ["unreadResult", "succeeded"]] as const)(
    "%s: begin's reply lost, a protocol error first, then %s", (scenario, phase) => {
      expect(setPluginMarketVisualScenario(scenario, true)).toBe(true);
      const operationId = `op-${scenario}`;
      expect(begin(operationId)).toThrow(/TIMEOUT/);
      expect(() => lookup(operationId)).toThrow(/INVALID_RESPONSE/);
      expect(lookup(operationId).result.phase).toBe(phase);
      if (scenario === "unreadResult") {
        expect(snapshot).toThrow(/TIMEOUT/);
        expect(snapshot).not.toThrow();
      } else expect(snapshot).not.toThrow();
      if (phase === "succeeded") {
        // Process-wide mock state: uninstall again, as the app would, so the next scenario starts uninstalled.
        pluginMarketVisualManagement("management:begin", { operationId: `rm-${scenario}`, kind: "uninstall" }, INSTANCE);
        expect(lookup(`rm-${scenario}`).result.phase).toBe("succeeded");
      }
    });
});

/* 测试价值（调度要求 M-7、N：记录面板的每种状态都有确定性的模拟入口）
 * - 生产入口与可观察结果：`cindy://plugins?checks=<状态>` 用的同一个预置函数（seedPluginChecksForVisualMock）+ 真实
 *   controller 与待核实记录；观察记录列表的状态与结论（插件页面板直接渲染它们）。
 * - 依据：docs/dev-rules/ui-mock-data.md 的「状态 → 入口」表；打开即处于该态，不依赖手速。
 * - 缺口：两端复拍无法稳定进入待核实、离线、等你确认、成功 + 打开、读取失败、多条等态。
 * - 最小失败输入：每个状态一次预置。tier: unit。
 */
describe("pending-check states from cindy://plugins?checks=<state>", () => {
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  afterEach(() => { __retainedForTests.clear(); slotTesting.reset(); });
  it.each([
    ["running", (checks: any[]) => expect(checks.map((c) => [c.state.outcome, c.waiting])).toEqual([["running", false]])],
    ["waiting", (checks: any[]) => expect(checks.map((c) => c.waiting)).toEqual([true])],
    ["offline", (checks: any[]) => expect(checks.map((c) => c.who.deviceId)).toEqual(["cindy-visual-mock-away"])],
    ["many", (checks: any[]) => expect(checks).toHaveLength(2)],
  ] as const)("%s", async (state, assert) => {
    const after = await seedPluginChecksForVisualMock(state);
    await flush();
    expect(after).toBeTypeOf("function");
    assert(__retainedForTests.checks());
  });
  it.each([
    ["awaitingYou", () => expect(__retainedForTests.checks().map((c) => c.awaitingYou)).toEqual([true])],
    ["succeeded", () => expect(__retainedForTests.conclusions().map((c) => [c.result, c.readback])).toEqual([["succeeded", "verified"]])],
    ["unread", () => expect(__retainedForTests.conclusions().map((c) => [c.result, c.readback])).toEqual([["succeeded", "failed"]])],
    ["failed", () => expect(__retainedForTests.conclusions().map((c) => c.result)).toEqual(["failed"])],
    ["untracked", () => expect(__retainedForTests.checks()).toEqual([])],
  ] as const)("%s, after the list opened", async (state, assert) => {
    const after = await seedPluginChecksForVisualMock(state);
    await flush();
    expect(__retainedForTests.checks()).toHaveLength(1);
    after!();
    await flush();
    assert();
    // Leave the mock computer as it was (an install that succeeded is uninstalled again).
    if (state === "succeeded" || state === "unread") {
      pluginMarketVisualManagement("management:begin", { operationId: `rm-${state}`, kind: "uninstall" }, "_root__demo-agenda");
      lookup(`rm-${state}`);
    }
  });
});

/* 测试价值（调度要求 P-5：模拟数据不能悄悄偏离协议）
 * - 生产入口与可观察结果：每个 `market=` 场景下 mock 电脑的市场条目、市场详情、已装快照、操作回执与确认，过一遍手机生产
 *   的解析 / 校验（parsePluginMarketPage、parsePluginManagementDetail、parsePluginManagementSnapshot、
 *   parsePluginManagementReceipt、isPluginMarketSourceIdentity、pluginConsentAllowance）；断言全部有效。
 * - 依据：iOS 第六轮补拍：updateSourceChanged 的 sourceId 是 25 个字符（协议要 22），校验把它当成缺省，进不了目标提示。
 * - 故意无效的只有这些（显式列出）：readFailed / unreadResult / updateReadFailed / detailReadFailed 的那一次读取失败、outdated 拒绝新形状的读取、
 *   旧 Host 自定义市场（Demo Legacy …）的条目与确认不带来源身份（按协议是「无法核实」，确认不允许）、updateSourceChanged
 *   的更新详情故意换了来源（手机在 begin 前就停下，不会走到确认）。
 * - 最小失败输入：任一 sourceId 不是 22 位。tier: unit（纯内存 mock）。
 */
// Dispatcher P-5: the record panel's remaining states, and those dispatcher O added, each from its own `checks=` entry
// (docs/dev-rules/ui-mock-data.md). Same production path as above. Tier: unit.
describe("more pending-check states from cindy://plugins?checks=<state>", () => {
  const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
  afterEach(() => { __retainedForTests.clear(); slotTesting.reset(); resetPluginMarketVisualComputer(); });
  const ended = () => __retainedForTests.conclusions().map((c) => [c.entry, c.result, c.readback]);
  it.each([
    ["readingBack", () => expect(ended()).toEqual([["market-install", "succeeded", "pending"]])],
    // An older package of the same plugin over it: the computer cannot attribute it to this phone (V2.10 ②).
    ["changed", () => expect(ended()).toEqual([["market-install", "succeeded", "unconfirmed"]])],
    ["uninstalled", () => expect(ended()).toEqual([["uninstall", "succeeded", "none"]])],
    ["updateGone", () => expect(ended()).toEqual([["update", "installed", "verified"]])],
    // Android reshoot 2026-11-26 could not reach it: the receipt is gone and the computer's record is not this phone's
    // (V2.10 ②, not confirmed).
    ["updateGoneUnattributed", () => expect(ended()).toEqual([["update", "mismatch", "none"]])],
    ["unprovableUninstall", () => expect(__retainedForTests.checks().map((c) => [c.entry, c.unprovable])).toEqual([["uninstall", { present: true }]])],
    // Dispatcher R-4: a success, then the computer answers as it does when it reinstalled the same version itself, when
    // the plugin was uninstalled, and when only its catalog moved on (still this install: Go to Installed).
    ["reinstalled", () => expect(ended()).toEqual([["market-install", "succeeded", "unconfirmed"]])],
    ["legacyHost", () => expect(ended()).toEqual([["market-install", "succeeded", "legacy"]])],
    ["goneSince", () => expect(ended()).toEqual([["market-install", "succeeded", "gone"]])],
    ["catalogAhead", () => expect(ended()).toEqual([["market-install", "succeeded", "verified"]])],
    // Pre-push review 2026-11-26: the receipt is gone and the computer cannot read the plugin's market: nothing is
    // concluded, the check says why and stays; two successes both read; one read beside one still waiting.
    ["recordMissing", () => expect({ ended: ended(), checks: __retainedForTests.checks().map((c) => [c.entry, c.recordMissing]) }).toEqual({ ended: [], checks: [["market-install", true]] })],
  ] as const)("%s, after the list opened", async (state, assert) => {
    const after = await seedPluginChecksForVisualMock(state);
    await flush();
    expect(__retainedForTests.checks()).toHaveLength(1);
    after!();
    await flush();
    assert();
  });
  // Pre-push review, rounds 5 and 6: after `checks=recordMissing` (the mock computer cannot read its market) or
  // `checks=legacyHost` (it answers as an older one), a `market=` scenario kept that computer, so the documented market
  // paths ("install, then Go to Installed"; `market=readbackFailed` then "Read again") ended as "could not read" or "older
  // computer". Minimal failing input on 7951455227 (recordMissing) and 84ddb5043c (legacyHost): the seed, then
  // `market=normal`. Tier: unit.
  it.each(["recordMissing", "legacyHost"] as const)("a market scenario after checks=%s answers as a current computer that can read its market", async (seed) => {
    const after = await seedPluginChecksForVisualMock(seed);
    await flush();
    after!();
    await flush();
    expect(setPluginMarketVisualScenario("normal", true)).toBe(true);
    const read = pluginMarketVisualManagement("management:snapshot", { read: "installed" }) as
      { result: { market: { unavailableReason: string | null; items: Array<{ sourceType: string; ghostId: string; installState: string; installedOperationAttribution?: string }> } } };
    const installed = read.result.market.items.find((item) => item.ghostId === "demo-agenda");
    expect({ unavailableReason: read.result.market.unavailableReason, serverRecords: read.result.market.items.some((item) => item.sourceType === "server"),
      installed: installed && [installed.installState, installed.installedOperationAttribution] })
      .toEqual({ unavailableReason: null, serverRecords: true, installed: ["installed", "self"] });
  });
  // Pre-push review, round 7: a `market=` scenario sent before (it decides how an install's commit ends) stayed armed
  // for the next `checks=` seed, which then did not reach the state its row of ui-mock-data.md names. Minimal failing
  // input on f8d1f490c4: the three rows after the control. Tier: unit.
  it.each([["control: ", "normal"], ["", "readbackFailed"], ["", "unreadResult"], ["", "hold"]] as const)(
    "%smarket=%s, then checks=succeeded: done, with its instance read", async (_control, scenario) => {
      expect(setPluginMarketVisualScenario(scenario, true)).toBe(true);
      const after = await seedPluginChecksForVisualMock("succeeded");
      await flush();
      after!();
      await flush();
      expect({ ended: __retainedForTests.conclusions().map((c) => [c.result, c.readback]), checks: __retainedForTests.checks().length })
        .toEqual({ ended: [["succeeded", "verified"]], checks: 0 });
    });
  // Two operations at once, for the notice at the top: both proven ("2 … have a result"), or one proven beside one still
  // waiting to be checked ("2 … need a look").
  it.each([
    ["results", [["market-install", "succeeded", "verified"], ["market-install", "succeeded", "verified"]], 0],
    ["attention", [["market-install", "succeeded", "verified"]], 1],
  ] as const)("%s: two records, after the list opened", async (state, concluded, waiting) => {
    const after = await seedPluginChecksForVisualMock(state);
    await flush();
    expect(__retainedForTests.checks()).toHaveLength(2);
    after!();
    await flush();
    expect({ ended: ended(), waiting: __retainedForTests.checks().length }).toEqual({ ended: concluded, waiting });
  });
  // Dispatcher S-2 (Android seventh reshoot): on a device only the Demo Agenda consent appeared and "View and decide"
  // opened it. The page looks a record up as soon as it appears; that lookup found the consent before the second
  // operation took the computer, so the consent took it back and the second one could not begin. With `raceLookups`
  // this failed before the S-2 seed change (one record); the plain run covers the existing order.
  it.each([false, true])("decideBlocked: the consent waits for this phone while another operation holds the computer (immediate lookups: %s)", async (race) => {
    driver.raceLookups = race;
    try { await seedPluginChecksForVisualMock("decideBlocked"); } finally { driver.raceLookups = false; }
    await flush();
    const checks = __retainedForTests.checks();
    expect(checks.map((c) => [c.who.name, c.awaitingYou])).toEqual([["Demo Agenda", true], ["Demo Device Simulator", false]]);
    expect(checks[0]!.decide()).toBe(false);
  });
});

describe("the mock computer speaks the protocol in every market scenario", () => {
  const ok = (value: unknown) => (value as { result: unknown }).result;
  it.each(PLUGIN_MARKET_VISUAL_SCENARIOS)("%s", (name) => {
    setPluginMarketVisualScenario(name, true);
    const read = (input: Record<string, unknown>) => {
      try { return ok(pluginMarketVisualManagement("management:snapshot", input)); }
      catch (error) {
        // Intentional failures of these scenarios: one failed read, or an older Host refusing a newer read.
        expect(["readFailed", "unreadResult", "outdated"]).toContain(name);
        return name === "outdated" ? undefined : ok(pluginMarketVisualManagement("management:snapshot", input));
      }
    };
    const page = read({ read: "catalog", query: { scope: "all", limit: 100 } });
    if (page !== undefined) {
      const parsed = parsePluginMarketPage(page);
      for (const item of parsed.items) if (item.sourceIdentity !== undefined) expect(isPluginMarketSourceIdentity(item.sourceIdentity), item.pluginId).toBe(true);
      // Only the older Host's custom market names no source (protocol: unverifiable).
      for (const item of parsed.items.filter((entry) => entry.sourceType !== "server" && !entry.sourceIdentity)) expect(item.name).toMatch(/Legacy/);
    }
    const snapshot = parsePluginManagementSnapshot(read({ read: "installed" }) ?? read({}));
    for (const pluginId of pluginMarketVisualDemoIds()) {
      let value: unknown;
      try { value = ok(pluginMarketVisualManagement("management:market-detail", { pluginId })); }
      catch { expect(["updateReadFailed", "detailReadFailed"]).toContain(name); continue; }
      const detail = parsePluginManagementDetail(value);
      expect(detail.pluginId).toBe(pluginId);
      if (detail.sourceType !== "server" && !/Legacy/.test(detail.name)) expect(isPluginMarketSourceIdentity(detail.sourceIdentity), pluginId).toBe(true);
      if (detail.installedSourceId !== undefined) expect(detail.installedSourceId, pluginId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      // Contract V2.10: installed / update-available always carry the marker, 'self' exactly with an operation id; nothing
      // else carries either field.
      const installedNow = detail.installState === "installed" || detail.installState === "update-available";
      expect(detail.installedOperationAttribution, pluginId).toBe(installedNow ? detail.installedOperationId ? "self" : "unattributed" : undefined);
      if (!installedNow) expect(detail.installedOperationId, pluginId).toBeUndefined();
    }
    // Every consent the mock computer asks for is a valid receipt, and (except the older Host's) one the phone can allow
    // for exactly what was chosen: the same plugin, version, kind and source.
    for (const item of snapshot.market.items) {
      const installed = snapshot.ghosts.find((ghost) => ghost.manifest.id === item.ghostId);
      if (installed ? item.installState !== "update-available" : item.installState !== "not-installed") continue;
      // Intentional: updateSourceChanged's detail names another source than the installed update's on purpose, so the
      // phone stops before begin ("the source changed"); its consent is never reached.
      if (installed && name === "updateSourceChanged") continue;
      let detail;
      try { detail = parsePluginManagementDetail(ok(pluginMarketVisualManagement("management:market-detail", { pluginId: item.pluginId }))); }
      catch { continue; }
      const operationId = `protocol-${name}-${item.ghostId}`;
      try {
        pluginMarketVisualManagement("management:begin", { operationId, kind: "install", pluginId: item.pluginId,
          expectedReleaseId: detail.releaseId }, installed?.instanceKey);
      } catch { /* A lost begin reply or a refused update preflight; the lookup below still answers. */ }
      for (let i = 0; i < 4; i++) {
        let receipt;
        try { receipt = parsePluginManagementReceipt(ok(pluginMarketVisualManagement("management:operation", { operationId })), operationId); }
        catch { continue; }
        if (receipt.consent) {
          const allowance = pluginConsentAllowance({ kind: installed ? "update" : "install", deviceId: "mock", pluginId: detail.pluginId,
            ghostId: detail.ghostId, version: detail.version, releaseId: detail.releaseId, sourceType: detail.sourceType,
            source: detail.sourceIdentity ?? null }, declaredPluginConsent(receipt.consent, "mock"));
          expect(allowance.allow, `${item.pluginId}: ${JSON.stringify(allowance)}`).toBe(!/Legacy/.test(detail.name) || detail.sourceType === "server");
          pluginMarketVisualManagement("management:answer", { operationId, requestId: receipt.consent.requestId, confirmed: false });
          break;
        }
        if (["succeeded", "failed", "cancelled"].includes(receipt.phase)) break;
      }
    }
  });
});
