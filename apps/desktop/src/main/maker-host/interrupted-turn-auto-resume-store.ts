/**
 * Main-side kill switch for the interrupted-turn auto-resume guard.
 *
 * File: <userData>/interrupted-turn-auto-resume-settings.json
 * Shape: { "enabled": true }
 *
 * 默认开启：上游把「已经干到一半」的 turn 打断时（SSE 流被切断，SDK 报
 * `server_error` 且自己不重试，见 maker-ipc/interruptedTurnAutoResume.ts 文件头），
 * 守卫自动补发一次续跑指令接续任务。本开关既是 Settings UI 中的用户偏好，也是
 * 守卫自身出问题时可手改文件的逃生门。
 *
 * 与 silent-stop 的开关**刻意分成两个文件**：两套自愈的判据、额度和故障模式都不同，
 * 逃生门必须能分别关——一套误动作时不该被迫把另一套也停掉。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('interrupted-turn-auto-resume-store');

export interface InterruptedTurnAutoResumeSettings {
  enabled: boolean;
}

const DEFAULTS: InterruptedTurnAutoResumeSettings = {
  enabled: true,
};
const MAX_SETTINGS_BYTES = 4_096;

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'interrupted-turn-auto-resume-settings.json');
}

function normalize(raw: unknown): InterruptedTurnAutoResumeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const store = createOverrideSettingsFile<InterruptedTurnAutoResumeSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'interrupted turn auto resume',
  maxBytes: MAX_SETTINGS_BYTES,
  preserveUnreadableFile: true,
});

/**
 * kill switch 是守卫出问题时的逃生门：每次 guard 判定都直接读取这个有 4 KiB 上限的
 * 小文件。不能只看 mtime；时间戳粒度内的原地写也必须立即阻止下一次自动续跑。
 */
export function readInterruptedTurnAutoResumeSettings(): InterruptedTurnAutoResumeSettings {
  return readInterruptedTurnAutoResumeSettingsState().value;
}

export function readInterruptedTurnAutoResumeSettingsState(): OverrideSettingsState<
  InterruptedTurnAutoResumeSettings
> {
  const file = settingsFilePath();
  try {
    if (!fs.existsSync(file)) {
      return {
        value: { ...DEFAULTS },
        defaults: { ...DEFAULTS },
        isCustomized: false,
        customizedKeys: [],
      };
    }
    const stat = fs.statSync(file);
    if (stat.size > MAX_SETTINGS_BYTES) {
      throw new Error(`file exceeds ${MAX_SETTINGS_BYTES} byte limit`);
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings file root must be an object');
    }
    const customizedKeys = Object.keys(parsed);
    return {
      value: normalize({ ...DEFAULTS, ...parsed }),
      defaults: { ...DEFAULTS },
      isCustomized: customizedKeys.length > 0,
      customizedKeys,
    };
  } catch (error) {
    // Preserve the user's file but expose reset in Settings so the UI is not permanently stuck.
    log.debug('interrupted turn auto resume settings unreadable — using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      value: { ...DEFAULTS },
      defaults: { ...DEFAULTS },
      isCustomized: true,
      customizedKeys: [],
    };
  }
}

export async function writeInterruptedTurnAutoResumeEnabled(enabled: boolean): Promise<void> {
  await store.writePatchAtomic({ enabled });
}

export async function resetInterruptedTurnAutoResumeSettings(): Promise<
  InterruptedTurnAutoResumeSettings
> {
  return store.resetAtomic();
}

export const __testing = {
  normalize,
  invalidate: store.invalidateIfChanged,
};
