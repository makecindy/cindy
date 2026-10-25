import { GHOST_ERRAND_PERMISSION_MODES, type GhostErrandPermissionMode } from './shared/ghost.js';

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
  fastMode?: boolean | 'ultrafast';
  providerId?: string;
  permissionMode?: GhostErrandPermissionMode;
  /** 绝对路径(用户亲选的项目目录);缺省 = 专属对话目录。 */
  workingDir?: string;
}

export interface PluginTaskPrefs {
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
export function sessionMapKey(ghostId: string, sessionKey?: string): string {
  return sessionKey ? `${ghostId}#${sessionKey}` : ghostId;
}

export const DEFAULTS: PluginTaskPrefs = { errand: {}, sessions: {} };

/** 单字段清洗:类型/值域不合法一律丢弃(= 回到跟随默认),不迁就脏数据。 */
export function normalizeConfig(raw: unknown): PluginTaskConfig {
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
  if ((typeof r.fastMode === 'boolean' || r.fastMode === 'ultrafast')) cfg.fastMode = r.fastMode;
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

export function normalize(raw: unknown): PluginTaskPrefs {
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

