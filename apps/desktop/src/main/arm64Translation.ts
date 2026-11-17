/**
 * arm64Translation — 当前进程是否经 ARM64 转译运行(macOS Rosetta / Windows ARM 仿真)。
 *
 * Apple 芯片 Mac 装了 darwin-x64 包时，整个 Electron 主进程、renderer 与 V8 JIT
 * 都要经 Rosetta 转译：启动阶段的模块求值比原生慢约一个数量级，空闲 CPU 也明显偏高。
 * 更新链路按 process.arch 取清单，x64 安装会一直留在 x64 通道，用户自己察觉不到。
 *
 * XDT_SIMULATE_ARM64_TRANSLATION=1 仅在未打包的开发构建中生效，用于在原生机器上
 * 检查提示界面；正式包只认 Electron 的真实判定。
 */

import { app } from 'electron';

export function isRunningUnderArm64Translation(): boolean {
  if (!app.isPackaged && process.env.XDT_SIMULATE_ARM64_TRANSLATION === '1') return true;
  return app.runningUnderARM64Translation === true;
}
