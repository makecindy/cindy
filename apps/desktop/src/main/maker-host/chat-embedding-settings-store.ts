/**
 * chat-embedding-settings-store —— 聊天嵌入开关的 main 端持久化 source of truth。
 *
 * 落盘文件: <userData>/chat-embedding-settings.json
 *   { "enabled": true }
 *
 * 默认 true —— 聊天语义搜索默认全员开启以提升搜索体验。embedding 走 voyage-4
 * (~¥0.09/天/重度用户, 经 XD Gateway + 公司 LiteLLM bearer 集中承担, 不计用户钱包)。
 * "默认开"靠"无设置文件 → 用 DEFAULTS"实现: 全新装包 + 老用户从没碰过开关的,
 * 都会自动启用; 显式 toggle 关过 (文件 enabled:false) 的用户保持关闭, 不被覆盖。
 * 用户随时可在 Settings → 个性化 关闭。
 *
 * 注: 默认开只索引"开启之后"的新消息 (cutoff 语义, 不 backfill 历史, 见
 * chat-history-embedder.ts), 老对话仍由 FTS 在混合检索里兜底。
 *
 * 形态与 compat-mode-store / memory-settings-store 完全一致, 保持运维心智一致:
 *   - 同步 R/W (文件极小, < 30B), 不会卡 main 主线程
 *   - 写入用 .tmp + rename 原子语义, 防写一半崩 → JSON 截断
 *   - 内存 cache, 第一次从盘读, 后续走 cache
 *   - read 失败 (corrupt JSON / 权限) → fallback DEFAULTS + 删坏文件避免反复报错
 *
 * 注意: 启用状态 (enabled) 是 per-machine settings (跟 compat-mode 一样落 userData);
 * 而"cutoff timestamp" 是 per-DB 的事实 (落在 embedding_meta 表里, 见
 * chat-history-embedder.ts), 两者分开存。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('chat-embedding-settings-store');

export interface ChatEmbeddingSettings {
  enabled: boolean;
}

const DEFAULTS: ChatEmbeddingSettings = {
  enabled: true,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'chat-embedding-settings.json');
}

function normalize(raw: unknown): ChatEmbeddingSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const store = createOverrideSettingsFile<ChatEmbeddingSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'chat embedding',
});

/** 同步读 —— 第一次从磁盘, 后续走内存 cache。 */
export function readChatEmbeddingSettings(): ChatEmbeddingSettings {
  return store.read();
}

export function readChatEmbeddingSettingsState(): OverrideSettingsState<ChatEmbeddingSettings> {
  return store.readState();
}

/** 同步写 enabled 字段 + 更新 cache; 失败抛错让 IPC handler 反馈给 UI。 */
export function writeChatEmbeddingEnabled(enabled: boolean): void {
  store.writePatch({ enabled });
  log.info('chat embedding setting written', { enabled });
}

export function resetChatEmbeddingSettings(): ChatEmbeddingSettings {
  return store.reset();
}
