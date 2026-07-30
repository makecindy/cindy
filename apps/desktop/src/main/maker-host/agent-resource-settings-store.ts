/**
 * agent-resource-settings-store —— agent 命令行资源占用治理的 main 端持久化设置。
 *
 * 文件: <userData>/agent-resource-settings.json
 *
 * 默认值为「不干预」,与本设置引入前的行为完全一致:
 *  - maxConcurrentCommands: 0 (不限制 agent Bash 命令的全局并发)
 *  - processPriority: 'normal' (不降 agent 进程优先级)
 *  - capToolchainThreads: false (不注入工具链限核 env)
 *
 * 配置层级:当前为隐藏配置(无 Settings UI,直接改 JSON 文件或由 agent 代改)。
 * 读取入口调 invalidateIfChanged(),文件被进程外修改后下次读取即生效,不需要重启;
 * 后续 Settings UI 接入(IPC 写路径)复用同一 store。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('agent-resource-settings-store');

/**
 * agent 进程的 OS 调度优先级档位:
 *  - 'normal': 不干预(默认)。
 *  - 'low'   : nice/BELOW_NORMAL —— agent 照常用满空闲核,但前台应用永远优先。
 *  - 'lowest': nice 最低档 + macOS 上额外 taskpolicy -b(压到能效核,风扇安静),
 *              代价是 agent 任务明显变慢,agent 起的 dev server 也会变慢。
 *
 * POSIX 限制:非特权进程无法把已调低的优先级调回来——从 low/lowest 切回
 * normal 只对**新启动**的 agent 进程生效,在跑的进程保持原档直到退出
 * (macOS 的 taskpolicy 背景钳制是例外,可以清除)。
 */
export type AgentProcessPriority = 'normal' | 'low' | 'lowest';

export interface AgentResourceSettings {
  /**
   * 所有本地 Claude 会话(含 Orca worker、subagent)同时在跑的 Bash 命令数上限;
   * 超出的命令在启动前排队等待。0 = 不限(默认,历史行为)。
   */
  maxConcurrentCommands: number;
  /** agent 进程(claude / codex 及其子进程)的调度优先级档位。 */
  processPriority: AgentProcessPriority;
  /**
   * 是否向 agent 进程注入工具链限核 env(VITEST_MAX_FORKS / MAKEFLAGS 等),
   * 防止单条测试/构建命令自己 fork 满全部核。只对新启动的 agent 进程生效;
   * 用户 env 里已有的同名变量不覆盖。
   */
  capToolchainThreads: boolean;
}

const DEFAULTS: AgentResourceSettings = {
  maxConcurrentCommands: 0,
  processPriority: 'normal',
  capToolchainThreads: false,
};

/** 上限的上限:超过这个值的并发治理已无意义,防手滑写进天文数字。IPC 写路径复用同一常量。 */
export const MAX_CONCURRENT_COMMANDS_CAP = 64;

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'agent-resource-settings.json');
}

function normalize(raw: unknown): AgentResourceSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    maxConcurrentCommands:
      typeof r.maxConcurrentCommands === 'number' && Number.isFinite(r.maxConcurrentCommands)
        ? clampInt(r.maxConcurrentCommands, 0, MAX_CONCURRENT_COMMANDS_CAP)
        : DEFAULTS.maxConcurrentCommands,
    processPriority:
      r.processPriority === 'low' || r.processPriority === 'lowest'
        ? r.processPriority
        : DEFAULTS.processPriority,
    capToolchainThreads: r.capToolchainThreads === true,
  };
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(v)));
}

const store = createOverrideSettingsFile<AgentResourceSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'agent-resource',
});

export function readAgentResourceSettings(): AgentResourceSettings {
  // 隐藏配置约定:直接改文件也是正式入口,读取前按 mtime 失效缓存。
  store.invalidateIfChanged();
  return store.read();
}

export function readAgentResourceSettingsState(): OverrideSettingsState<AgentResourceSettings> {
  store.invalidateIfChanged();
  return store.readState();
}

export function writeAgentResourceSetting<K extends keyof AgentResourceSettings>(
  key: K,
  value: AgentResourceSettings[K],
): void {
  store.writePatch({ [key]: value } as Partial<AgentResourceSettings>);
  log.info('agent resource setting written', { key, value });
}

export function resetAgentResourceSettings(): AgentResourceSettings {
  return store.reset();
}

export const __testing = { normalize };
