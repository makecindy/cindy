import { describe, expect, it, vi } from "vitest";
import {
  LAUNCH_WINDOW_MS,
  createJsErrorGuard,
  describeJsError,
  type ErrorUtilsLike,
} from "./jsErrorGuard";

// 测试价值
// - 生产入口与可观察结果：createJsErrorGuard().install() 包住的全局处理函数——致命报错是否仍以
//   致命交给 React Native（App 退出 / 热更回滚），还是降为非致命（App 继续运行）并留下记录。
// - 依据：2026-11 线上崩溃日志里约一半 iOS 闪退是启动稳定后的 JS 致命错误；同时
//   expo-updates 靠「首屏后 10 秒内的致命报错」回滚坏热更，这个窗口内的行为不能变。
// - 现有覆盖缺口：此前没有任何 JS 报错兜底，也就没有对应测试。
// - 最小失败输入：根布局提交后 LAUNCH_WINDOW_MS 前 / 后各来一次 isFatal=true 的报错。
// - tier：unit（注入时钟与 ErrorUtils，不触碰真实全局）。
function setup() {
  let clock = 1_000;
  const previous = vi.fn();
  const record = vi.fn();
  let handler: (error: unknown, isFatal?: boolean) => void = previous;
  const errorUtils: ErrorUtilsLike = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next) => {
      handler = next;
    },
  };
  const guard = createJsErrorGuard({ now: () => clock, record });
  guard.install(errorUtils);
  return {
    guard,
    previous,
    record,
    report: (error: unknown, isFatal?: boolean) => handler(error, isFatal),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("JS error guard launch window", () => {
  it("keeps fatal errors fatal until the root has been committed for the whole window", () => {
    const { guard, previous, record, report, advance } = setup();
    const error = new TypeError("boom");
    advance(60_000);
    report(error, true); // root never committed: still starting up
    guard.noteRootCommitted();
    advance(LAUNCH_WINDOW_MS - 1);
    report(error, true);
    expect(previous.mock.calls).toEqual([
      [error, true],
      [error, true],
    ]);
    expect(guard.launchSettled()).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("downgrades and records a fatal error once the launch has settled", () => {
    const { guard, previous, record, report, advance } = setup();
    guard.noteRootCommitted();
    advance(LAUNCH_WINDOW_MS);
    guard.noteRootCommitted(); // a retry remount must not reopen the window
    const error = new TypeError("boom");
    report(error, true);
    expect(previous).toHaveBeenCalledExactlyOnceWith(error, false);
    expect(record).toHaveBeenCalledExactlyOnceWith("uncaught", error);
  });

  it("passes non-fatal reports through untouched", () => {
    const { guard, previous, record, report, advance } = setup();
    guard.noteRootCommitted();
    advance(LAUNCH_WINDOW_MS);
    const error = new Error("soft");
    report(error, false);
    expect(previous).toHaveBeenCalledExactlyOnceWith(error, false);
    expect(record).not.toHaveBeenCalled();
  });
});

describe("describeJsError", () => {
  it("projects a Hermes stack to the class name and top frame positions only", () => {
    const error = new TypeError("Cannot read property 'title' of private text");
    error.stack = [
      "TypeError: Cannot read property 'title' of private text at 9:9",
      "    at renderRow (address at index.android.bundle:1:2345678)",
      "    at apply (native)",
      "    at anonymous (/data/user/0/app/files/.expo-internal/bundle:1:4567)",
      "    at flush (address at index.android.bundle:1:89)",
      "    at tick (address at index.android.bundle:1:90)",
    ].join("\n");
    expect(describeJsError(error)).toEqual({
      name: "TypeError",
      line1: 1,
      column1: 2345678,
      line2: 1,
      column2: 4567,
      line3: 1,
      column3: 89,
    });
  });

  it.each([
    ["an unknown error class", Object.assign(new Error("x"), { name: "PrivateError", stack: "" })],
    ["a thrown string", "private text"],
    ["null", null],
  ])("records %s as other without positions", (_label, thrown) => {
    expect(describeJsError(thrown)).toEqual({ name: "other" });
  });
});
