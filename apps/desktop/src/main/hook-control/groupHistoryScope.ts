import { groupLaneOf } from './groupWindow.js';
import type { GroupHistoryAccessScope } from '../im/shared/groupHistoryAccess.js';

/** 官方 Telegram externalKey 的调用侧解析；共享检索核心不认识协议 key。 */
export function groupHistoryAccessForExternalKey(
  externalKey: string,
): GroupHistoryAccessScope | undefined {
  const lane = groupLaneOf(externalKey);
  if (!lane) return undefined;
  const provider = `telegram:${lane.principalId}`;
  return {
    access: 'lane',
    provider,
    lane: { provider, chatId: lane.chatId, threadId: lane.threadId },
  };
}
