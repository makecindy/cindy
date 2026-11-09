import type { TeammateAvatarCallbacks } from '@cindy/mcps';
import { createBotCapabilityService, readBotConfigurationContext, type BotCapabilityServiceDeps } from './botCapabilityService.js';
import { createBotAvatarService, readTeammateAvatarSource } from './botAvatarService.js';
import { setBotProfileAvatar } from '../localDb/ipc/bots.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { extractIpcError } from '../../shared/ipcError.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Native tools share settings transactions and current task media ownership. */
export function createBotDesignerHost(deps: BotCapabilityServiceDeps) {
  const capabilities = createBotCapabilityService(deps);
  const setAvatar = createBotAvatarService({
    admit: caller => capabilities.admitConfiguration(caller, 'write'),
    setLocal: async input => {
      await readBotConfigurationContext(input);
      let receipt: { avatar: string; profileVersion: number } | undefined;
      try { await setBotProfileAvatar(input.botId, input.image, input.expectedVersion, input.expectedAvatar, {
        assertCurrent: () => {
          input.assertCurrent(); input.assertCommit?.();
          if (companionHomes.isShadowed(input.botId) || !companionHomes.isHomeHere(input.botId))
            throwIpcError('PRECONDITION_FAILED', '伙伴主力电脑已变化');
        },
        beforeCommit: async () => { await input.beforeCommit(); await readBotConfigurationContext(input); },
        onCommitted: (value, avatar) => { receipt = { avatar, profileVersion: value.currentVersion }; },
      }); } catch (error) {
        input.assertCurrent();
        if (!receipt) throw error;
        return { ...receipt, synchronization: 'unconfirmed' as const, warning: '头像已保存，但后续读取或同步未完成。请重新读取目标，不要重放写入。' };
      }
      if (!receipt) throwIpcError('PRECONDITION_FAILED', '头像写入尚未确认，请重新读取');
      return { ...receipt, synchronization: 'complete' as const };
    },
    readSource: async (caller, source, assertCurrent) => {
      const epoch = getCurrentDbClientSnapshot();
      if (!epoch) throwIpcError('PRECONDITION_FAILED', '伙伴数据库尚未就绪');
      const guard = () => { assertCurrent(); if (epoch !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', '账号已变化'); };
      return readTeammateAvatarSource(caller, source, epoch.client.drizzle, guard);
    },
  });
  const botAvatar: TeammateAvatarCallbacks = { set: async input => {
    try { return { ok: true, ...await setAvatar(input) }; }
    catch (error) {
      const ipc = extractIpcError(error);
      return { ok: false, errorCode: ipc?.code ?? 'BOT_AVATAR_UNAVAILABLE', message: ipc?.message ?? '无法设置伙伴头像，请检查图片和目标伙伴状态' };
    }
  } };
  return { capabilities, botAvatar };
}
