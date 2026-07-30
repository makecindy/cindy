/**
 * agent-resource-settings-store —— agent 命令行资源占用治理的 main 端持久化设置。
 *
 * 文件: <userData>/agent-resource-settings.json
 *
 * 默认值为「不干预」,与本设置引入前的行为完全一致:
 *  - maxConcurrentCommands: 0 (不限制 agent Bash 命令的全局并发)
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

export interface AgentResourceSettings {
  /**
   * 所有本地 Claude 会话(含 Orca worker、subagent)同时在跑的 Bash 命令数上限;
   * 超出的命令在启动前排队等待。0 = 不限(默认,历史行为)。
   */
  maxConcurrentCommands: number;
}

const DEFAULTS: AgentResourceSettings = {
  maxConcurrentCommands: 0,
};

/** 上限的上限:超过这个值的并发治理已无意义,防手滑写进天文数字。 */
const MAX_CONCURRENT_COMMANDS_CAP = 64;

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
