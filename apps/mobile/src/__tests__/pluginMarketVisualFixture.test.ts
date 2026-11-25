import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ randomUUID: () => "visual-operation" }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, Platform: { OS: "ios" } }));
vi.mock("@/auth/AuthContext", () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock("@/device-link/DeviceLinkContext", () => ({ useDeviceLink: () => ({}) }));
vi.mock("@/device-link/revokedDevicesStore", () => ({ useRevokedDevices: () => null }));
import { pluginMarketVisualManagement, setPluginMarketVisualScenario } from "@/debug/pluginMarketVisualFixture";
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
