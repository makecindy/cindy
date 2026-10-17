/**
 * user-prefs-store —— 桌面浮窗(ghost overlay window)用户开关(kill switch)的
 * per-owner 持久化。
 *
 * File: <userData>/owners/<ownerKey>/ghost-overlay-user-prefs.json
 *
 * 形态:{ disabled: { <ghostId>: false, … } }
 * - 只记"用户显式关闭"的条目,缺项 = 默认开启(与 cindyPrefsStore 的"没写 =
 *   跟随默认"同一规则 20 语义,清除即恢复默认);
 * - owner 数据目录解析与 cindyPrefsStore 一致:ownerScopedUserDataPath,owner
 *   切换后读/写自动落到新 owner 的独立文件,互不影响;
 * - 重新开启只清除关闭条目,不触发任何 show(由插件自己再次 mount)。
 */

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('overlay-user-prefs-store');

export interface OverlayUserPrefs {
  /** ghostId → false(用户显式关闭);缺项 = 默认开启。 */
  disabled: Record<string, boolean>;
}

const DEFAULTS: OverlayUserPrefs = { disabled: {} };

function normalize(raw: unknown): OverlayUserPrefs {
  if (!raw || typeof raw !== 'object') return { disabled: {} };
  const disabledRaw = (raw as { disabled?: unknown }).disabled;
  const disabled: Record<string, boolean> = {};
  if (disabledRaw && typeof disabledRaw === 'object') {
    for (const [ghostId, value] of Object.entries(disabledRaw as Record<string, unknown>)) {
      // 只收"显式关闭"的 false;true 与其它形态一律丢弃(= 跟随默认开启)。
      if (value === false) disabled[ghostId] = false;
    }
  }
  return { disabled };
}

function createStore() {
  return createOverrideSettingsFile<OverlayUserPrefs>({
    filePath: () => ownerScopedUserDataPath('ghost-overlay-user-prefs.json'),
    defaults: DEFAULTS,
    normalize,
    log,
    label: 'ghost-overlay-user-prefs',
    preserveUnreadableFile: true,
  });
}

const store = createStore();

/** 读某意识的 overlay 用户开关;缺项 = 默认开启。 */
export function readOverlayUserEnabled(ghostId: string): boolean {
  // mtime 守卫现读:文件没变零开销,手改后下次读取即生效。
  store.invalidateIfChanged();
  return store.read().disabled[ghostId] !== false;
}

/**
 * 写/清某意识的 overlay 用户开关:false = 关闭(mount 被拒),true = 重新开启。
 * 重新开启不触发 show——由插件自己再次 mount。
 */
export function setOverlayUserEnabled(ghostId: string, enabled: boolean): void {
  store.invalidateIfChanged();
  const disabled = { ...store.read().disabled };
  if (enabled) delete disabled[ghostId];
  else disabled[ghostId] = false;
  store.writePatch({ disabled });
  log.info('ghost overlay user enabled written', { ghostId, enabled });
}

export const __testing = { normalize };
