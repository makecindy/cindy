import type { TaskDispatchPayload } from '@cindy/slack-hook-protocol';

import { getGroupHistoryImages } from '../im/shared/groupHistorySearch.js';
import { resolveGroupHistoryImageFile } from '../im/shared/groupHistoryImages.js';
import type { GroupContextAssembly } from '../im/shared/groupWindowCore.js';
import { createLogger } from '../logger.js';
import { groupLaneOf } from './groupWindow.js';

const log = createLogger('hook-group-history-images');

export interface OfficialGroupHistoryImage {
  absPath: string;
  originalName: string;
  mimeType: string;
  author: string;
}

const OFFICIAL_GROUP_HISTORY_IMAGE_MAX_AGE_MS = 2 * 60 * 1_000;
const OFFICIAL_GROUP_HISTORY_MAX_IMAGES = 2;

/**
 * 官方 Telegram 群轮次在派发前补齐近期(≤2 分钟、最多 2 张)群历史图片。
 * 只补图片且仅随本轮模型消息发送不落库，覆盖「转发图 + 单独附言」场景，同时不放开
 * Codex 侧对 cindy_group_history 的工具限制。失败静默降级，绝不阻断派发。
 */
export async function collectOfficialGroupHistoryImages(
  payload: TaskDispatchPayload,
  assembly: Pick<GroupContextAssembly, 'imageMessages' | 'triggerAuthor' | 'triggerSentAt'>,
  isCurrent: () => boolean,
): Promise<{ images: OfficialGroupHistoryImage[]; unavailable: string[] }> {
  const lane = groupLaneOf(payload.externalKey);
  if (!lane || !assembly.imageMessages?.length) return { images: [], unavailable: [] };
  const provider = `telegram:${lane.principalId}`;
  const referenceMs = assembly.triggerSentAt ?? Date.now();
  const recent = assembly.imageMessages.filter(
    (msg) =>
      referenceMs - msg.sentAt <= OFFICIAL_GROUP_HISTORY_IMAGE_MAX_AGE_MS &&
      msg.sentAt <= referenceMs + 60_000,
  );
  if (recent.length === 0) return { images: [], unavailable: [] };

  const sameAuthor = assembly.triggerAuthor
    ? recent.filter((msg) => msg.author === assembly.triggerAuthor)
    : [];
  const others = assembly.triggerAuthor
    ? recent.filter((msg) => msg.author !== assembly.triggerAuthor)
    : recent;
  const prioritized = [...sameAuthor.slice().reverse(), ...others.slice().reverse()].slice(
    0,
    OFFICIAL_GROUP_HISTORY_MAX_IMAGES,
  );
  const orderIndex = new Map(recent.map((msg, idx) => [msg, idx]));
  prioritized.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

  const images: OfficialGroupHistoryImage[] = [];
  const seenPaths = new Set<string>();
  for (const msg of prioritized) {
    if (!isCurrent() || images.length >= OFFICIAL_GROUP_HISTORY_MAX_IMAGES) break;
    const msgLane = { provider, chatId: lane.chatId, threadId: msg.threadId };
    let row: Awaited<ReturnType<typeof getGroupHistoryImages>>;
    try {
      row = await getGroupHistoryImages({ lane: msgLane, messageId: msg.messageId });
    } catch {
      continue;
    }
    if (!row?.imageRefs.length) continue;
    for (const ref of row.imageRefs) {
      if (!isCurrent() || images.length >= OFFICIAL_GROUP_HISTORY_MAX_IMAGES) break;
      try {
        const resolved = await resolveGroupHistoryImageFile({
          lane: msgLane,
          messageId: msg.messageId,
          ref,
          scope: { access: 'lane', provider, lane: msgLane },
          isCurrent,
        });
        if (!resolved || seenPaths.has(resolved.absPath)) continue;
        seenPaths.add(resolved.absPath);
        images.push({
          absPath: resolved.absPath,
          originalName: ref.name || 'image.jpg',
          mimeType: resolved.mimeType,
          author: msg.author,
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'HISTORY_SCOPE_EXPIRED') {
          return { images: [], unavailable: [] };
        }
        log.warn(
          `official group history image fetch skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { images, unavailable: [] };
}
