/**
 * 个人飞书 / Lark 机器人所在的群：向飞书接口「获取用户或机器人所在的群列表」读取，给设置页
 * 「群聊」总表用。同一机器人 30 秒内复用上一次结果、并发打开共用一次请求，不轮询、不重试。
 * 读不到（缺权限或网络）时抛错，由调用方退回本机记录。
 */

import type { FeishuIM } from '@cindy/im';

import { safeImAvatarUrl } from '../../../shared/imChatSettings.js';
import type { ImChatEntry } from '../shared/chatSources.js';

const GROUP_LIST_CACHE_MS = 30_000;
const GROUP_LIST_MAX_PAGES = 10;
const GROUP_LIST_PAGE_SIZE = 100;

type GroupListPorts = Pick<FeishuIM, 'callApi'>;

let cache: { botAppId: string; at: number; groups: ImChatEntry[] } | null = null;
let inflight: { botAppId: string; promise: Promise<ImChatEntry[]> } | null = null;

async function fetchBotGroups(im: GroupListPorts): Promise<ImChatEntry[]> {
  const groups: ImChatEntry[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < GROUP_LIST_MAX_PAGES; page += 1) {
    const res = await im.callApi({
      method: 'GET',
      path: '/open-apis/im/v1/chats',
      params: {
        page_size: String(GROUP_LIST_PAGE_SIZE),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    const data = (res.data ?? {}) as {
      items?: Array<{ chat_id?: unknown; name?: unknown; avatar?: unknown }>;
      has_more?: unknown;
      page_token?: unknown;
    };
    for (const item of data.items ?? []) {
      if (typeof item.chat_id !== 'string' || !item.chat_id.startsWith('oc_')) continue;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null;
      groups.push({ chatId: item.chat_id, name, avatarUrl: safeImAvatarUrl(item.avatar), kind: 'group' });
    }
    if (data.has_more !== true || typeof data.page_token !== 'string' || !data.page_token) break;
    pageToken = data.page_token;
  }
  return groups;
}

/** `refresh` = 用户点了「刷新」：不复用 30 秒内的结果，但仍与正在进行的读取合并。 */
export async function feishuBotGroups(im: GroupListPorts, botAppId: string, refresh = false): Promise<ImChatEntry[]> {
  if (!refresh && cache && cache.botAppId === botAppId && Date.now() - cache.at < GROUP_LIST_CACHE_MS) {
    return cache.groups;
  }
  if (inflight && inflight.botAppId === botAppId) return inflight.promise;
  const promise = fetchBotGroups(im).then((groups) => {
    cache = { botAppId, at: Date.now(), groups };
    return groups;
  });
  inflight = { botAppId, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

/** 头像沿用上一次从飞书读到的名单（保存不重新拉名单）。 */
export function cachedFeishuGroupAvatar(botAppId: string, chatId: string): string | null {
  return cache?.botAppId === botAppId ? cache.groups.find((group) => group.chatId === chatId)?.avatarUrl ?? null : null;
}

export const __testing = {
  resetCache(): void {
    cache = null;
    inflight = null;
  },
};
