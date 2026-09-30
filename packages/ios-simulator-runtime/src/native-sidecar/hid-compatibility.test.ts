import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);

/**
 * 手动验证（macOS，已安装 Xcode 工具链及仓库依赖）：
 * 1. 通过 DEVELOPER_DIR 选择待验证的 Xcode 安装目录下的 Contents/Developer，
 *    用 xcrun swiftc --version 确认工具链；分别验证 Xcode 26.6 和 27。
 * 2. 在仓库根目录执行：
 *    pnpm --filter @cindy/ios-simulator-runtime exec vitest run src/native-sidecar/hid-compatibility.test.ts
 * 3. 确认该用例通过且未跳过。它编译生产共用的 Swift 源码，检查屏幕目标映射、
 *    异步完成与超时隔离；临时二进制会自动清理。
 * Linux/Windows 会跳过此用例，不能视为 HID 回归已验证。这里使用合成屏幕元数据，
 * 不启动模拟器；真实模拟器的点击、拖动及旋转后触控仍需单独验收。
 */
it.skipIf(process.platform !== "darwin")(
  "executes the helper's screen-target and delivery-completion regression checks",
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cindy-hid-checks-"),
    );
    const nativeRoot = fileURLToPath(new URL("../../native/", import.meta.url));
    const binary = path.join(directory, "hid-checks");
    try {
      await run(
        "/usr/bin/xcrun",
        [
          "swiftc",
          path.join(nativeRoot, "hid-compatibility.swift"),
          path.join(nativeRoot, "tests/hid-compatibility-checks.swift"),
          "-o",
          binary,
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      const { stdout } = await run(binary, [], { timeout: 5_000 });
      expect(JSON.parse(stdout)).toEqual([
        "legacy target",
        "legacy built-in target with screen API",
        "legacy built-in still requires matching screen identity",
        "Xcode 2700 built-in screen keeps screen-addressed input",
        "Xcode 2710 built-in screen keeps screen-addressed input",
        "unknown built-in routing fails closed",
        "screen 1 target",
        "non-default screen target",
        "screen identity mismatch",
        "screen ID flag collision",
        "screen-addressed type 4",
        "screen-addressed type 5",
        "indirect screen 1",
        "indirect screen 2",
        "missing screen",
        "missing binding",
        "disconnected screen",
        "incomplete screen properties",
        "asynchronous completion",
        "delivery error propagation",
        "bounded completion timeout",
        "late and duplicate completion",
        "completed sends keep input available",
        "completed failure does not poison the sequence",
        "timeout rejects queued send before message construction",
        "late completion cannot re-arm timed-out input",
        "fresh helper sequence accepts recovery release",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  70_000,
);
