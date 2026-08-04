/**
 * Main-side kill switch for the interrupted-turn auto-resume guard.
 *
 * File: <userData>/interrupted-turn-auto-resume-settings.json
 * Shape: { "enabled": true }
 *
 * 默认开启：上游把「已经干到一半」的 turn 打断时（SSE 流被切断，SDK 报
 * `server_error` 且自己不重试，见 maker-ipc/interruptedTurnAutoResume.ts 文件头），
 * 守卫自动补发一次续跑指令接续任务。本开关是守卫自身出问题时的逃生门（隐藏配置，
 * 不进 Settings UI；规则 20 的「隐藏配置」层级），用户可通过 agent 改本地配置文件
 * 关闭。
 *
 * 与 silent-stop 的开关**刻意分成两个文件**：两套自愈的判据、额度和故障模式都不同，
 * 逃生门必须能分别关——一套误动作时不该被迫把另一套也停掉。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('interrupted-turn-auto-resume-store');

export interface InterruptedTurnAutoResumeSettings {
  enabled: boolean;
}

const DEFAULTS: InterruptedTurnAutoResumeSettings = {
  enabled: true,
};

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

/**
 * 每次从磁盘读取，不做缓存。kill switch 是守卫出问题时的逃生门：用户手动编辑文件
 * 后必须立即生效，不能等 app 重启。guard 每次 onInterruptedTurn 调 isEnabled()
 * 触发本读（频率是「每次 turn 被打断」，与 silent-stop 同量级，不是热路径）。
 */
export function readInterruptedTurnAutoResumeSettings(): InterruptedTurnAutoResumeSettings {
  try {
    const file = settingsFilePath();
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return normalize(raw);
    }
  } catch (err) {
    // 读取/解析失败 → 回退默认(开启)。记一条 debug 便于排查用户手改坏了文件的情况。
    log.debug('interrupted turn auto resume settings unreadable — using defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { ...DEFAULTS };
}
