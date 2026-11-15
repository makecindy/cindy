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

import { readInterruptedTurnAutoResumeSettingsFrom, type InterruptedTurnAutoResumeSettings } from './interruptedTurnAutoResumeSettingsCore.js';

export type { InterruptedTurnAutoResumeSettings } from './interruptedTurnAutoResumeSettingsCore.js';

export function readInterruptedTurnAutoResumeSettings(): InterruptedTurnAutoResumeSettings {
  return readInterruptedTurnAutoResumeSettingsFrom(app.getPath('userData'));
}
