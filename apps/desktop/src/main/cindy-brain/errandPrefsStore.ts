/**
 * errandPrefsStore —— agent 槽「派活取件(errand)」的每插件用户配置持久化。
 *
 * File: <userData>/ghost-errand-prefs.json
 *
 * 形态:{ errand: { <ghostId>: { agentKind?, model?, effort?, fastMode?,
 *          providerId?, permissionMode?, workingDir? } } }
 * - 全部字段缺省 = 跟随默认:agent/模型/effort/fast/供应商跟随「新建草稿」
 *   偏好快照(与 Orca worker 同源,见 newMakerDefaultsCache),permissionMode
 *   缺省 'plan'(只读,2026-07-31 定案),workingDir 缺省专属对话目录;
 * - permissionMode 只收 GHOST_ERRAND_PERMISSION_MODES(plan/acceptEdits/auto),
 *   **bypassPermissions 在协议层就不存在**,存储层照单执法;
 * - 抽离插件**不**清配置——与 cindy 槽覆盖同语义,重装回来钉的配置还在;
 * - 模型/供应商的白名单校验由消费方(errand 服务)按当下目录做,存储层
 *   不感知清单(过期值静默落回默认并留日志,同 cindySlot override 契约)。
 */

import {
  GHOST_ERRAND_PERMISSION_MODES,
  type GhostErrandPermissionMode,
} from '../../shared/ghost.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('errand-prefs-store');

/** errand 会话可选的 agent 种类(与 sessions.agent_kind 同词汇表)。 */
export const GHOST_ERRAND_AGENT_KINDS = ['cc', 'codex'] as const;
export type GhostErrandAgentKind = (typeof GHOST_ERRAND_AGENT_KINDS)[number];

/** errand 会话可选的思考强度(与 worker 同集合;minimal 刻意不收)。 */
export const GHOST_ERRAND_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type GhostErrandEffort = (typeof GHOST_ERRAND_EFFORTS)[number];

/** 单插件的 errand 配置(全部可缺省;缺省语义见文件头)。 */
export interface GhostErrandConfig {
  agentKind?: GhostErrandAgentKind;
  model?: string;
  effort?: GhostErrandEffort;
  fastMode?: boolean;
  providerId?: string;
  permissionMode?: GhostErrandPermissionMode;
  /** 绝对路径(用户亲选的项目目录);缺省 = 专属对话目录。 */
  workingDir?: string;
}

interface GhostErrandPrefs {
  errand: Record<string, GhostErrandConfig>;
  /**
   * ghostId → 专属 errand 会话 id(runner 复用映射)。放在偏好文件里而非
   * DB:这是"哪间是它的干活间"的宿主侧记忆,丢了(手删/损坏)的后果只是
   * 下一单重建一间,不值得动 sessions schema(migration 风险不对等)。
   */
  sessions: Record<string, string>;
}

const DEFAULTS: GhostErrandPrefs = { errand: {}, sessions: {} };

/** 单字段清洗:类型/值域不合法一律丢弃(= 回到跟随默认),不迁就脏数据。 */
function normalizeConfig(raw: unknown): GhostErrandConfig {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const cfg: GhostErrandConfig = {};
  if (
    typeof r.agentKind === 'string' &&
    (GHOST_ERRAND_AGENT_KINDS as readonly string[]).includes(r.agentKind)
  ) {
    cfg.agentKind = r.agentKind as GhostErrandAgentKind;
  }
  if (typeof r.model === 'string' && r.model.length > 0 && r.model.length <= 128) {
    cfg.model = r.model;
  }
  if (
    typeof r.effort === 'string' &&
    (GHOST_ERRAND_EFFORTS as readonly string[]).includes(r.effort)
  ) {
    cfg.effort = r.effort as GhostErrandEffort;
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

function normalize(raw: unknown): GhostErrandPrefs {
  if (!raw || typeof raw !== 'object') return { errand: {}, sessions: {} };
  const errandRaw = (raw as { errand?: unknown }).errand;
  const errand: GhostErrandPrefs['errand'] = {};
  if (errandRaw && typeof errandRaw === 'object') {
    for (const [ghostId, cfgRaw] of Object.entries(errandRaw as Record<string, unknown>)) {
      const cfg = normalizeConfig(cfgRaw);
      if (Object.keys(cfg).length > 0) errand[ghostId] = cfg;
    }
  }
  const sessionsRaw = (raw as { sessions?: unknown }).sessions;
  const sessions: GhostErrandPrefs['sessions'] = {};
  if (sessionsRaw && typeof sessionsRaw === 'object') {
    for (const [ghostId, v] of Object.entries(sessionsRaw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0 && v.length <= 128) sessions[ghostId] = v;
    }
  }
  return { errand, sessions };
}

const store = createOverrideSettingsFile<GhostErrandPrefs>({
  filePath: () => ownerScopedUserDataPath('ghost-errand-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'ghost-errand-prefs',
});

/** 读某插件的 errand 配置(缺省空对象 = 全跟随默认)。 */
export function readGhostErrandConfig(ghostId: string): GhostErrandConfig {
  // mtime 守卫现读:直接改文件也算配置入口(与 cindy prefs 同契约)。
  store.invalidateIfChanged();
  return store.read().errand[ghostId] ?? {};
}

/**
 * 整份替换某插件的 errand 配置(设置卡整卡提交);传 null / 清洗后为空
 * 即删除条目(恢复全跟随默认,规则 20 语义)。入参收 unknown:IPC 层只做
 * 形状粗筛,逐字段值域清洗统一在这里(单一执法点)。返回清洗后的落盘值。
 */
export function writeGhostErrandConfig(ghostId: string, config: unknown): GhostErrandConfig {
  store.invalidateIfChanged();
  const errand = { ...store.read().errand };
  const cfg = config === null ? {} : normalizeConfig(config);
  if (Object.keys(cfg).length === 0) delete errand[ghostId];
  else errand[ghostId] = cfg;
  store.writePatch({ errand });
  log.info('ghost errand config written', { ghostId, keys: Object.keys(cfg) });
  return cfg;
}

/** 读某插件的专属 errand 会话 id;null = 还没建过(或映射被清)。 */
export function readGhostErrandSessionId(ghostId: string): string | null {
  store.invalidateIfChanged();
  return store.read().sessions[ghostId] ?? null;
}

/** 写/清某插件的专属 errand 会话映射(null 即清除;会话失效重建时更新)。 */
export function writeGhostErrandSessionId(ghostId: string, sessionId: string | null): void {
  store.invalidateIfChanged();
  const sessions = { ...store.read().sessions };
  if (sessionId === null) delete sessions[ghostId];
  else sessions[ghostId] = sessionId;
  store.writePatch({ sessions });
  log.info('ghost errand session mapping written', { ghostId, sessionId });
}

export const __testing = { normalize, normalizeConfig };
