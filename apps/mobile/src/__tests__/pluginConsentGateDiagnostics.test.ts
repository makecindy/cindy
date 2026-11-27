import { afterEach, expect, it, vi } from "vitest";
import { setMobileDebugSink } from "@/debug/mobileDebugLog";
import { CONSENT_GATE_LOG, logConsentGate, type ConsentGateValues } from "@/plugins/consentGateDiagnostics";

afterEach(() => setMobileDebugSink(undefined));

const values = { event: "allow", result: "answered", tier: "regular", why: [], visible: 132.5 } as unknown as ConsentGateValues;

/* 测试价值（调度 2026-11-27：iOS 横屏判档的诊断日志只能在开发 / mock 构建里记，正式构建不能多出记录）
 * - 生产入口与可观察结果：确认面板调用的 `logConsentGate`；观察手机本地 Debug 日志的记录点收到什么。
 * - 依据：正式构建即使用户开着 Debug 记录也不写这条、不计算数值；开发构建写一条带关键字和各值来源的记录。
 * - 覆盖缺口：vitest 按正式构建编译 `__DEV__`，面板里的调用点只能在开发构建真机上看到。
 * - 最小失败输入：Debug 记录开着、`isDev` 为 false 时调用一次；去掉构建判断就会写出。tier: unit。
 */
it("records the gate's values with their sources in development builds only, and never in production builds", () => {
  const sink = vi.fn();
  setMobileDebugSink(sink);
  const compute = vi.fn(() => values);
  logConsentGate(compute, false);
  expect({ records: sink.mock.calls.length, computed: compute.mock.calls.length }).toEqual({ records: 0, computed: 0 });
  logConsentGate(compute, true);
  expect(sink).toHaveBeenCalledExactlyOnceWith("debug", "plugins", [CONSENT_GATE_LOG, expect.objectContaining({
    visible: 132.5, from: expect.objectContaining({ visible: expect.stringContaining("containerHeight") }),
  })]);
});
