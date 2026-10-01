/**
 * User preferences for plugin-created ordinary tasks. The legacy errand adapter
 * consumes these same preferences; it does not own the model/permission policy.
 * Keep ghost-errand-prefs.json and its `errand`/`sessions` keys for installed-plugin
 * compatibility. `sessions` belongs only to the old errand sessionKey adapter.
 * Empty model preferences use the originating task or the current new-task route.
 * New ordinary tasks use ask; the legacy adapter retains its historical default.
 * Permissions stay independently user-owned, never caller-inherited.
 * Model admission belongs to the shared ordinary-session resolver, never this store.
 */

import {
  GHOST_ERRAND_PERMISSION_MODES,
  type GhostErrandPermissionMode,
} from '../../shared/ghost.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

/** User-owned plugin task permission policy. A model source never grants authority. */
export function clampPluginTaskPermissionMode(value: unknown, fallback: GhostErrandPermissionMode = 'ask'): GhostErrandPermissionMode {
  return typeof value === 'string' && (GHOST_ERRAND_PERMISSION_MODES as readonly string[]).includes(value)
    ? value as GhostErrandPermissionMode : fallback;
}

const log = desktopMakerLogger.child('errand-prefs-store');

/** 插件任务可选的 agent 种类(与 sessions.agent_kind 同词汇表)。 */
export const PLUGIN_TASK_AGENT_KINDS = ['cc', 'codex', 'pi'] as const;
export type PluginTaskAgentKind = (typeof PLUGIN_TASK_AGENT_KINDS)[number];

/** 插件任务可选的思考强度(与 worker 同集合;包含 minimal)。 */
export const PLUGIN_TASK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type PluginTaskEffort = (typeof PLUGIN_TASK_EFFORTS)[number];

/** 单插件的任务配置(全部可缺省;缺省语义见文件头)。 */
export interface PluginTaskConfig {
  agentKind?: PluginTaskAgentKind;
  model?: string;
  effort?: PluginTaskEffort;
  fastMode?: boolean;
  providerId?: string;
  permissionMode?: GhostErrandPermissionMode;
  /** 绝对路径(用户亲选的项目目录);缺省 = 专属对话目录。 */
  workingDir?: string;
}

interface PluginTaskPrefs {
  errand: Record<string, PluginTaskConfig>;
  /**
   * 映射键 → 专属 errand 会话 id(runner 复用映射)。键形态两种:
   * `ghostId` = 该插件的缺省共用间;`ghostId#sessionKey` = 按钥匙分的间
   * (ghostId 与 sessionKey 的合法字符集都不含 `#`,拼接无歧义)。放在偏好
   * 文件里而非 DB:这是"哪间是它的干活间"的宿主侧记忆,丢了(手删/损坏)
   * 的后果只是下一单重建一间,不值得动 sessions schema(migration 风险不对等)。
   */
  sessions: Record<string, string>;
}

/** sessions 表的映射键(见 PluginTaskPrefs.sessions 注释)。 */
function sessionMapKey(ghostId: string, sessionKey?: string): string {
  return sessionKey ? `${ghostId}#${sessionKey}` : ghostId;
}

const DEFAULTS: PluginTaskPrefs = { errand: {}, sessions: {} };

/** 单字段清洗:类型/值域不合法一律丢弃(= 回到跟随默认),不迁就脏数据。 */
function normalizeConfig(raw: unknown): PluginTaskConfig {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const cfg: PluginTaskConfig = {};
  if (
    typeof r.agentKind === 'string' &&
    (PLUGIN_TASK_AGENT_KINDS as readonly string[]).includes(r.agentKind)
  ) {
    cfg.agentKind = r.agentKind as PluginTaskAgentKind;
  }
  if (typeof r.model === 'string' && r.model.length > 0 && r.model.length <= 128) {
    cfg.model = r.model;
  }
  if (
    typeof r.effort === 'string' &&
    (PLUGIN_TASK_EFFORTS as readonly string[]).includes(r.effort)
  ) {
    cfg.effort = r.effort as PluginTaskEffort;
  }
  if (typeof r.fastMode === 'boolean') cfg.fastMode = r.fastMode;
  if (typeof r.providerId === 'string' && r.providerId.length > 0 && r.providerId.length <= 128) {
    cfg.providerId = r.providerId;
  }
  if (
    typeof r.permissionMode === 'string' &&
    (GHOST_ERRAND_PERMISSION_MODES as readonly string[]).includes(r.permissionMode)
  ) {
    cfg.permissionMode = r.permissionMode as GhostErrandPermissionMode;
  }
  if (typeof r.workingDir === 'string' && r.workingDir.length > 0 && r.workingDir.length <= 1024) {
    cfg.workingDir = r.workingDir;
  }
  return cfg;
}

function normalize(raw: unknown): PluginTaskPrefs {
  if (!raw || typeof raw !== 'object') return { errand: {}, sessions: {} };
  const errandRaw = (raw as { errand?: unknown }).errand;
  const errand: PluginTaskPrefs['errand'] = {};
  if (errandRaw && typeof errandRaw === 'object') {
    for (const [ghostId, cfgRaw] of Object.entries(errandRaw as Record<string, unknown>)) {
      const cfg = normalizeConfig(cfgRaw);
      if (Object.keys(cfg).length > 0) errand[ghostId] = cfg;
    }
  }
  const sessionsRaw = (raw as { sessions?: unknown }).sessions;
  const sessions: PluginTaskPrefs['sessions'] = {};
  if (sessionsRaw && typeof sessionsRaw === 'object') {
    for (const [ghostId, v] of Object.entries(sessionsRaw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0 && v.length <= 128) sessions[ghostId] = v;
    }
  }
  return { errand, sessions };
}

const store = createOverrideSettingsFile<PluginTaskPrefs>({
  filePath: () => ownerScopedUserDataPath('ghost-errand-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'ghost-errand-prefs',
});

// Register owns the runtime catalog; configuration persistence never builds another picker.
let validateSelection: ((config: PluginTaskConfig) => Promise<void>) | null = null;
export function setPluginTaskConfigValidator(validator: (config: PluginTaskConfig) => Promise<void>): void {
  validateSelection = validator;
}
export async function validatePluginTaskConfig(raw: unknown): Promise<void> {
  const config = normalizeConfig(raw);
  if (raw && typeof raw === 'object') {
    for (const key of ['agentKind', 'model', 'providerId', 'effort', 'fastMode', 'permissionMode', 'workingDir'] as const) {
      if ((raw as Record<string, unknown>)[key] !== undefined && config[key] === undefined) {
        throw new Error(`任务配置 ${key} 无效，请重新选择`);
      }
    }
  }
  if (![config.agentKind, config.model, config.providerId, config.effort, config.fastMode].some(v => v !== undefined)) return;
  if (!validateSelection) throw new Error('模型服务尚未就绪，请稍后重试');
  await validateSelection(config);
}

/** 读某插件的任务配置(缺省空对象 = 全跟随默认)。 */
export function readPluginTaskConfig(ghostId: string): PluginTaskConfig {
  // mtime 守卫现读:直接改文件也算配置入口(与 cindy prefs 同契约)。
  store.invalidateIfChanged();
  return store.read().errand[ghostId] ?? {};
}

/**
 * 整份替换某插件的任务配置(设置卡整卡提交);传 null / 清洗后为空
 * 即删除条目(恢复全跟随默认,规则 20 语义)。入参收 unknown:IPC 层只做
 * 形状粗筛,逐字段值域清洗统一在这里(单一执法点)。返回清洗后的落盘值。
 */
export function writePluginTaskConfig(ghostId: string, config: unknown): PluginTaskConfig {
  store.invalidateIfChanged();
  const errand = { ...store.read().errand };
  const cfg = config === null ? {} : normalizeConfig(config);
  if (Object.keys(cfg).length === 0) delete errand[ghostId];
  else errand[ghostId] = cfg;
  store.writePatch({ errand });
  log.info('ghost errand config written', { ghostId, keys: Object.keys(cfg) });
  return cfg;
}

/** 读某插件的专属 errand 会话 id(可带分会话钥匙);null = 还没建过(或映射被清)。 */
export function readGhostErrandSessionId(ghostId: string, sessionKey?: string): string | null {
  store.invalidateIfChanged();
  return store.read().sessions[sessionMapKey(ghostId, sessionKey)] ?? null;
}

/** 写/清某插件的专属 errand 会话映射(可带分会话钥匙;null 即清除;会话失效重建时更新)。 */
export function writeGhostErrandSessionId(
  ghostId: string,
  sessionId: string | null,
  sessionKey?: string,
): void {
  store.invalidateIfChanged();
  const key = sessionMapKey(ghostId, sessionKey);
  const sessions = { ...store.read().sessions };
  if (sessionId === null) delete sessions[key];
  else sessions[key] = sessionId;
  store.writePatch({ sessions });
  log.info('ghost errand session mapping written', { ghostId, sessionKey: sessionKey ?? null, sessionId });
}

export const __testing = { normalize, normalizeConfig, sessionMapKey };
