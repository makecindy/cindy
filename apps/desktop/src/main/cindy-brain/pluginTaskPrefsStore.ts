/**
 * User preferences for plugin-created ordinary tasks. The legacy errand adapter
 * consumes these same preferences; it does not own the model/permission policy.
 * Keep ghost-errand-prefs.json and its `errand`/`sessions` keys for installed-plugin
 * compatibility. `sessions` belongs only to the old errand sessionKey adapter.
 * Empty model preferences use the originating task or the current new-task route.
 * New ordinary tasks use ask; the legacy adapter retains its historical default.
 * Permissions stay independently user-owned, never caller-inherited.
 * Model admission belongs to the shared ordinary-session resolver, never this store.
 * The same model fields are the plugin's single "model" preference: Cindy quick
 * answers (cindy.text.oneshot) use them too; empty = the system auxiliary model.
 * Legacy per-ability oneshot catalog pins (ghost-cindy-prefs.json `overrides`)
 * are migrated here once on first read; see migrateLegacyOneshotPins.
 */

import {
  GHOST_ERRAND_PERMISSION_MODES,
  type GhostErrandPermissionMode,
} from '../../shared/ghost.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { decodeCatalogModelPin } from '../../shared/catalogModelPin.js';
import { assertGhostPrefsWritable, relocateGhostPreferenceMaps } from './ghostPreferenceRelocation.js';
import {
  GHOST_CINDY_PREFS_FILE,
  clearLegacyOverrides,
  readLegacyOneshotPins,
} from './cindyPrefsStore.js';

/** User-owned plugin task permission policy. A model source never grants authority. */
export function clampPluginTaskPermissionMode(value: unknown, fallback: GhostErrandPermissionMode = 'ask'): GhostErrandPermissionMode {
  return typeof value === 'string' && (GHOST_ERRAND_PERMISSION_MODES as readonly string[]).includes(value)
    ? value as GhostErrandPermissionMode : fallback;
}

const log = desktopMakerLogger.child('errand-prefs-store');

export async function relocateGhostErrandPrefs(from: string, to: string): Promise<void> {
  await relocateGhostPreferenceMaps('ghost-errand-prefs.json', ['errand', 'sessions'], from, to, () => {
    store = createStore();
  });
}

export { PLUGIN_TASK_AGENT_KINDS, PLUGIN_TASK_EFFORTS } from '@cindy/plugin-runtime/pluginTaskConfig';
export type { PluginTaskConfig, PluginTaskAgentKind, PluginTaskEffort } from '@cindy/plugin-runtime/pluginTaskConfig';
import { DEFAULTS, normalize, normalizeConfig, sessionMapKey, type PluginTaskConfig, type PluginTaskPrefs } from '@cindy/plugin-runtime/pluginTaskConfig';

function createStore() {
  return createOverrideSettingsFile<PluginTaskPrefs>({
    filePath: () => ownerScopedUserDataPath('ghost-errand-prefs.json'),
    defaults: DEFAULTS,
    normalize,
    log,
    label: 'ghost-errand-prefs',
    preserveUnreadableFile: true,
  });
}

let store = createStore();

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

/** 已完成旧钉档迁移的 owner 作用域(按旧文件的 owner 路径区分账号)。 */
const legacyPinMigrationDone = new Set<string>();

/**
 * 一次性迁移(幂等):旧插件详情「Cindy 能力」里快问快答的目录钉(cat: 编码的
 * 供应商×agent×模型)→ 本插件的「模型」字段。规则:
 * - 只在该插件的任务配置还没有 model 时写入 agentKind/providerId/model;effort 与
 *   fastMode 留空,由现有解析按模型默认补;权限、目录等其它字段原样保留;
 * - 已有 model(用户已显式选过)、轻量档位键(非 cat:)、解码失败的值,以及图像/
 *   视频/向量覆盖一律丢弃(它们从此跟随系统默认);
 * - 先写新配置、再删旧文件的 `overrides` 键:中途失败下一次读取重跑,已写入的
 *   插件因已有 model 被跳过,不会重复或覆盖。
 */
function migrateLegacyOneshotPins(): void {
  let scope: string;
  try {
    scope = ownerScopedUserDataPath(GHOST_CINDY_PREFS_FILE);
  } catch {
    return;
  }
  if (legacyPinMigrationDone.has(scope)) return;
  try {
    const legacy = readLegacyOneshotPins();
    if (legacy) {
      assertGhostPrefsWritable('ghost-errand-prefs.json');
      store.invalidateIfChanged();
      const errand = { ...store.read().errand };
      const migrated: string[] = [];
      const kept: string[] = [];
      const dropped: string[] = [];
      for (const [ghostId, pin] of Object.entries(legacy)) {
        if (pin === null) continue;
        const route = decodeCatalogModelPin(pin);
        if (!route) {
          dropped.push(ghostId);
          continue;
        }
        const current = errand[ghostId] ?? {};
        if (current.model !== undefined) {
          kept.push(ghostId);
          continue;
        }
        const rest: PluginTaskConfig = { ...current };
        delete rest.effort;
        delete rest.fastMode;
        const next = normalizeConfig({
          ...rest,
          agentKind: route.agentKind === 'claude-code' ? 'cc' : 'codex',
          providerId: route.providerId,
          model: route.model,
        });
        if (next.model === undefined || next.providerId === undefined) {
          dropped.push(ghostId);
          continue;
        }
        errand[ghostId] = next;
        migrated.push(ghostId);
      }
      if (migrated.length > 0) store.writePatch({ errand });
      clearLegacyOverrides();
      log.info('legacy plugin oneshot pins migrated to plugin model preference', {
        source: GHOST_CINDY_PREFS_FILE,
        migrated,
        keptExistingModel: kept,
        droppedUnsupportedPins: dropped,
      });
    }
    legacyPinMigrationDone.add(scope);
  } catch (error) {
    // 迁移失败(偏好正在搬迁/文件暂不可写)不影响读取:本次按现有配置返回,下次重试。
    log.warn('legacy plugin oneshot pin migration failed; will retry', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 读某插件的任务配置(缺省空对象 = 全跟随默认)。 */
export function readPluginTaskConfig(ghostId: string): PluginTaskConfig {
  migrateLegacyOneshotPins();
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
  assertGhostPrefsWritable('ghost-errand-prefs.json');
  migrateLegacyOneshotPins();
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
  assertGhostPrefsWritable('ghost-errand-prefs.json');
  store.invalidateIfChanged();
  const key = sessionMapKey(ghostId, sessionKey);
  const sessions = { ...store.read().sessions };
  if (sessionId === null) delete sessions[key];
  else sessions[key] = sessionId;
  store.writePatch({ sessions });
  log.info('ghost errand session mapping written', { ghostId, sessionKey: sessionKey ?? null, sessionId });
}

export const __testing = {
  normalize,
  normalizeConfig,
  sessionMapKey,
  resetLegacyPinMigration: () => legacyPinMigrationDone.clear(),
};
