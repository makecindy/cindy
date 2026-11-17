/**
 * The vision-bridge settings file, shared by Desktop and the Node Host. Moved verbatim from
 * vision-bridge-settings-store.ts, which now builds the Desktop instance. The userData
 * directory arrives as a port; every other import is unchanged. Each launcher creates one
 * instance holding the former module state (the snapshot cache).
 */

import path from 'node:path';

import type { VisionBackendRef, VisionBridgeSettings } from '../../shared/visionBridgeSettings.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';

export type { VisionBackendRef, VisionBridgeSettings };

/** The Desktop-only reads, resolved by each launcher. */
export interface VisionBridgeSettingsStorePorts {
  app: { getPath(name: 'userData'): string };
}

/** One instance per launcher; the former module state lives in it. */
export function createVisionBridgeSettingsStore(ports: VisionBridgeSettingsStorePorts) {
const { app } = ports;

const log = desktopMakerLogger.child('vision-bridge-settings-store');

const DEFAULTS: VisionBridgeSettings = {
  enabled: false,
  targetModels: [],
  primary: null,
  fallback: null,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'vision-bridge-settings.json');
}

function normalizeBackendRef(raw: unknown): VisionBackendRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const providerId = typeof r.providerId === 'string' ? r.providerId.trim() : '';
  const modelId = typeof r.modelId === 'string' ? r.modelId.trim() : '';
  if (providerId.length === 0 || modelId.length === 0) return null;
  return { providerId, modelId };
}

function normalize(raw: unknown): VisionBridgeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  // trim 后保留非空白元素，与 IPC 层 trim 保持一致，避免脏值落盘。
  const targetModels = Array.isArray(r.targetModels)
    ? r.targetModels
        .map((m) => (typeof m === 'string' ? m.trim() : ''))
        .filter((m): m is string => m.length > 0)
    : [];
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
    targetModels,
    primary: normalizeBackendRef(r.primary),
    fallback: normalizeBackendRef(r.fallback),
  };
}

const store = createOverrideSettingsFile<VisionBridgeSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'vision bridge',
  // targetModels 需要「显式空数组也保留 override」：用户显式清空（取消默认勾选的
  // no-vision 模型）时，[] 是有意选择，不能被「等值默认」逻辑当未自定义删掉。
  // 其余 key 仍按等默认删除 override（configuration-and-overrides 语义）。
  mergeOverrides: ({ patch, next, defaults: d, overrides }) => {
    const out: Record<string, unknown> = { ...overrides };
    if ('targetModels' in patch) {
      out.targetModels = next.targetModels;
    }
    for (const key of Object.keys(patch) as Array<keyof VisionBridgeSettings>) {
      if (key === 'targetModels') continue;
      if (JSON.stringify(next[key]) === JSON.stringify(d[key])) {
        delete out[key];
      } else {
        out[key] = next[key] as unknown;
      }
    }
    return out;
  },
});

// 内存快照缓存：视觉桥配置在进程生命周期内几乎恒定（仅设置页变更时变），而 proxy
// transform 每请求都调 shouldBridge → 每次同步 statSync 是 hot-path I/O（对齐
// maker-core-and-agent-behavior §3.2 热路径约束）。首次 read 缓存，write/reset 清空。
// 缓存同时保留 customizedKeys，供 isTargetModel 判断"用户是否显式自定义了 targetModels"。
interface CachedSnapshot {
  value: VisionBridgeSettings;
  customizedKeys: string[];
  /** 快照创建时刻（ms）。TTL 过期后重读，感知外部改文件/跨进程变更。 */
  createdAt: number;
}
let cachedSnapshot: CachedSnapshot | null = null;
/** 快照 TTL：hot-path（proxy shouldBridge 每请求）在 TTL 内零 I/O；外部改文件在 TTL 后感知。 */
const CACHE_TTL_MS = 2000;

function readVisionBridgeSettings(): VisionBridgeSettings {
  return readCachedSnapshot().value;
}

/** 供 isTargetModel：判断 targetModels 是否被用户显式自定义（决定是否启用 no-vision 默认）。 */
function isTargetModelsCustomized(): boolean {
  return readCachedSnapshot().customizedKeys.includes('targetModels');
}

function readCachedSnapshot(): CachedSnapshot {
  if (cachedSnapshot && Date.now() - cachedSnapshot.createdAt < CACHE_TTL_MS) {
    return cachedSnapshot;
  }
  const state = store.readState();
  cachedSnapshot = { value: state.value, customizedKeys: state.customizedKeys, createdAt: Date.now() };
  return cachedSnapshot;
}

function readVisionBridgeSettingsState(): OverrideSettingsState<VisionBridgeSettings> {
  return store.readState();
}

function writeVisionBridgeSettings(patch: Partial<VisionBridgeSettings>): void {
  store.writePatch(patch);
  cachedSnapshot = null; // 写后失效，下次 read 现读新值
  log.info('vision bridge settings written', {
    keys: Object.keys(patch),
    enabled: patch.enabled,
  });
}

function resetVisionBridgeSettings(): VisionBridgeSettings {
  const value = store.reset();
  cachedSnapshot = null;
  return value;
}

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
const visionBridgePortableSettings = portableOverrideSettings(store);

return { readVisionBridgeSettings, isTargetModelsCustomized, readVisionBridgeSettingsState, writeVisionBridgeSettings, resetVisionBridgeSettings, visionBridgePortableSettings };
}
