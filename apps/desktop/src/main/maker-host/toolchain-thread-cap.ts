/**
 * toolchain-thread-cap —— 工具链限核 env 注入(agent 资源占用治理第二层)。
 *
 * 动机: 并发闸门(command-concurrency-gate)只管"几条命令同时跑",管不住单条
 * 重命令自己 fork 满全部核(vitest/jest 默认按核数起 worker,一条 `pnpm test`
 * 就能把 10 核吃满)。对认环境变量的主流工具链,在 agent 进程 env 里注入
 * 上限值,其 spawn 的所有子命令自动继承。
 *
 * 边界(有意为之):
 *  - 只注入「构建/测试并行度」类变量;不碰 GOMAXPROCS / UV_THREADPOOL_SIZE 这类
 *    会改变被测程序运行时语义的变量(会掩盖/制造并发 bug,agent 测试结论失真)。
 *  - 用户 env 已有的同名变量一律不覆盖(用户显式设置优先)。
 *  - jest 等只认 CLI 参数的工具管不住 —— 那部分由进程优先级降档兜底。
 *  - env 是 spawn 期快照:改设置只影响新启动的 agent 会话进程。
 *  - 只对本机 spawn 注入;远端(SSH)机器的核数与资源不归本设置管。
 */

import os from 'node:os';

import type {
  AgentProcessPriority,
  AgentResourceSettings,
} from './agent-resource-settings-store.js';
import { readAgentResourceSettings } from './agent-resource-settings-store.js';

/**
 * 推荐并行度: low/normal 档给一半核,lowest 档给四分之一,至少 1。
 * 目标是"agent 干活但留出交互余量",不追求精确公平。
 */
export function recommendedToolchainThreads(
  priority: AgentProcessPriority,
  cores: number = os.availableParallelism(),
): number {
  const divisor = priority === 'lowest' ? 4 : 2;
  return Math.max(1, Math.ceil(cores / divisor));
}

/**
 * 纯函数形态(可测):按给定设置/基础 env/核数计算应注入的 env 增量。
 * baseEnv 已有的键被跳过 —— 返回值只含"确实要新增"的变量。
 */
export function computeToolchainThreadCapEnv(
  settings: Pick<AgentResourceSettings, 'capToolchainThreads' | 'processPriority'>,
  baseEnv: NodeJS.ProcessEnv,
  cores?: number,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (!settings.capToolchainThreads) return {};
  const threads = recommendedToolchainThreads(settings.processPriority, cores);
  const desired: Record<string, string> = {
    // vitest: forks 池(默认)与 threads 池各有独立上限变量,都设
    VITEST_MAX_FORKS: String(threads),
    VITEST_MAX_THREADS: String(threads),
    // cargo build 并行度
    CARGO_BUILD_JOBS: String(threads),
  };
  if (platform !== 'win32') {
    // make 系(node-gyp / 原生依赖构建等)。Windows 跳过:MSVC 工具链下 cmake/qmake
    // 可能生成 NMake Makefiles,nmake 不认 GNU Make 的 -j 语法,继承到会直接报错
    // 中止构建,而不是静默忽略(对抗式预审发现)。
    desired.MAKEFLAGS = `-j${threads}`;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (baseEnv[key] === undefined) out[key] = value;
  }
  return out;
}

/**
 * 生产入口: 读当前设置,返回应合入 agent spawn env 的增量。
 * 设置关闭时返回空对象(零行为变化)。供 runtime-configs 的 behaviorFlags 消费,
 * Claude 与 Codex 共用;调用方负责"远端 spawn 不注入"的分流。
 */
export function toolchainThreadCapEnv(): Record<string, string> {
  return computeToolchainThreadCapEnv(readAgentResourceSettings(), process.env);
}
