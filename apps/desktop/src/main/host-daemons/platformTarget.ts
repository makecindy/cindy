/**
 * host-daemons/platformTarget —— 按当前平台装配本机常驻项的来源。
 *
 * 三个平台各有自己的常驻物，运行时共用一个目标：
 * - Windows：计划任务（`schtasks`）。
 * - macOS：用户级 LaunchAgents（`~/Library/LaunchAgents`）+ crontab。
 * - Linux：用户级 systemd 单元（`.timer` / `.service`）+ crontab。
 * 其它平台（BSD 等）返回 null，界面回「本机不支持」而不是假装清单是空的。
 */

import { createCrontabAdapter } from './crontab.js';
import { createLaunchAgentsAdapter } from './launchAgents.js';
import { windowsScheduledTaskAdapter } from './scheduledTasks.js';
import { createSystemdUserAdapter } from './systemdUser.js';
import { combineHostDaemonAdapters, type HostDaemonTarget } from './target.js';

export function createHostDaemonTarget(platform: NodeJS.Platform): HostDaemonTarget | null {
  if (platform === 'win32') return combineHostDaemonAdapters([windowsScheduledTaskAdapter]);
  // macOS 上 cron 仍然存在（用户自己写的 crontab），与 launchd 并列扫描。
  if (platform === 'darwin') {
    return combineHostDaemonAdapters([createLaunchAgentsAdapter(), createCrontabAdapter()]);
  }
  if (platform === 'linux') {
    return combineHostDaemonAdapters([createSystemdUserAdapter(), createCrontabAdapter()]);
  }
  return null;
}
