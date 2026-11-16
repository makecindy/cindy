/**
 * Main-side kill switch for the silent-stop auto-resume guard.
 *
 * File: <userData>/silent-stop-auto-resume-settings.json
 * Shape: { "enabled": true }
 *
 * 默认开启:上游偶发用空内容 assistant 消息静默收尾"干到一半"的 turn(社区同型
 * anthropics/claude-code#50597 / #38905),守卫检测后自动补发「继续」接续任务。
 * 本开关是守卫自身出问题时的逃生门(隐藏配置,不进 Settings UI;规则 20 的
 * "隐藏配置"层级),用户可通过 agent 改本地配置文件关闭。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SilentStopAutoResumeSettings {
  enabled: boolean;
}

const DEFAULTS: SilentStopAutoResumeSettings = {
  enabled: true,
};

export const SILENT_STOP_AUTO_RESUME_SETTINGS_FILE = 'silent-stop-auto-resume-settings.json';

function normalize(raw: unknown): SilentStopAutoResumeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

/**
 * 每次从磁盘读取,不走 createOverrideSettingsFile 的缓存。
 * kill switch 是守卫出问题时的逃生门:用户手动编辑文件后必须立即生效,
 * 不能等 app 重启。guard 每次 onSilentStop 调用 isEnabled() 触发本读。
 * 文件在调用方给出的 profile 根目录(桌面的 userData)。
 */
export function readSilentStopAutoResumeSettingsFrom(userDataDir: string): SilentStopAutoResumeSettings {
  try {
    const file = path.join(userDataDir, SILENT_STOP_AUTO_RESUME_SETTINGS_FILE);
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return normalize(raw);
    }
  } catch {
    // 读取/解析失败 → 回退默认(开启)
  }
  return { ...DEFAULTS };
}

export { DEFAULTS as SILENT_STOP_AUTO_RESUME_DEFAULTS, normalize as normalizeSilentStopAutoResumeSettings };
