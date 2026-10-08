/**
 * 钉钉「钉钉账号」方式的群访问设置。
 *
 * guestFullAccess：群任务处于「完全访问」时，是否也放行群成员（非主人）的轮次。
 * 缺省关闭 —— 与 Telegram 一致，完全访问只放行主人；打开是主人对本机的显式授权，
 * 群成员的请求将以主人的完整权限执行、不再逐次确认。adapter 每轮派发前现读，
 * 关闭后立即生效。
 */

import { desktopMakerLogger } from '../../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';

const log = desktopMakerLogger.child('dingtalk-access-store');

export interface DingTalkAccessConfig {
  guestFullAccess: boolean;
}

const ACCESS_DEFAULTS: DingTalkAccessConfig = { guestFullAccess: false };

export function normalizeDingTalkAccess(raw: unknown): DingTalkAccessConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // 只有显式 true 才算打开，损坏或缺失一律按关闭处理。
  return { guestFullAccess: r.guestFullAccess === true };
}

const accessFile = createOverrideSettingsFile<DingTalkAccessConfig>({
  filePath: () => ownerScopedImUserDataPath('dingtalk-bot-access.json'),
  defaults: ACCESS_DEFAULTS,
  normalize: normalizeDingTalkAccess,
  log,
  label: 'dingtalk-bot-access',
});

export function readDingTalkAccess(): DingTalkAccessConfig {
  return accessFile.read();
}

export function patchDingTalkAccess(patch: unknown): DingTalkAccessConfig {
  const r = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  if (typeof r.guestFullAccess === 'boolean') {
    accessFile.writePatch({ guestFullAccess: r.guestFullAccess });
    log.info('dingtalk guest full access updated', { enabled: r.guestFullAccess });
  }
  return accessFile.read();
}
