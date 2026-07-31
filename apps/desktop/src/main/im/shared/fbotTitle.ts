/**
 * main/im/shared/fbotTitle.ts
 * ---------------------------------------------------------------------------
 * FBot 接管 session 的 title 生成助手 — 跨 cardActionHandler / runAgentTurn 复用,
 * 抽到独立模块避免反向 import (cardActionHandler 已经 import runAgentTurn)。
 *
 * 命名约定:
 *   - prefix 'FBot · ' 给所有飞书 bot 接管/新建出来的 session 打标
 *   - 草稿态 title = 'FBot · New', 跟 desktop 'New Maker' 占位 title 同语义:
 *     表示用户还没发第一条消息, 等首条消息到达后由 oneshot 生成正式 title
 *
 * generateAndPersistFbotTitle 流程: oneshot 跑 LLM → 拿短标题 → 落库 → 广播
 * sessions:patched 让 sidebar 即时刷新。失败 swallow (跟 desktop generateTitle
 * 一致, 起不出来标题不阻塞主流程)。
 */

import { BrowserWindow } from 'electron';

import { desktopSessionStorage } from '../../maker-host/session-storage';
import { generateMakerSessionTitle } from '../../maker-ipc/title';

export const FBOT_TITLE_PREFIX = 'FBot · ';
/** 草稿占位 title, 跟 desktop 'New Maker' 同语义 — 等首条消息到来后由 oneshot 替换。 */
export const FBOT_DRAFT_TITLE = `${FBOT_TITLE_PREFIX}New`;

export function fbotTitle(displayName: string, prefix: string = FBOT_TITLE_PREFIX): string {
  const name = displayName.replace(/\s+/g, ' ').trim().slice(0, 40);
  // 空显示名回落到 'New',与 FBOT_DRAFT_TITLE 拼出同一个草稿占位(`FBot · New`)。
  // 此前写死 'New Maker' 会拼出 `FBot · New Maker`:既和本模块自己的草稿常量不一致,
  // 也把 desktop 的哨兵串漏进了用户可见的飞书会话标题。
  return `${prefix}${name || 'New'}`;
}

export function broadcastSessionPatched(
  sessionId: string,
  patch: Record<string, unknown>,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:sessions:patched', { sessionId, patch });
    } catch {
      /* swallow */
    }
  }
}

/**
 * 用 seedText 调 oneshot 生成短标题, 包成 '{prefix}{gen}' 后落库 + 广播。
 * 返回落库的完整 title(渠道侧拿去 patch thread 名片/接管卡), 无结果返 null。
 *
 * 调用方:
 *   - runAgentTurn: 接管/新 thread session 收到第一条消息时, seedText = 用户
 *     消息文本(对齐 desktop makerChatStore 的 generateTitle 用法)
 *
 * 失败/无结果: swallow, 不抛 — title 起不出来也不阻塞主流程, sidebar 继续显示
 * 之前的占位 title。
 */
export async function generateAndPersistFbotTitle(
  sessionId: string,
  seedText: string,
  prefix: string = FBOT_TITLE_PREFIX,
): Promise<string | null> {
  const generated = (
    await generateMakerSessionTitle(seedText, 'claude-code', sessionId)
  )?.trim();
  if (!generated) return null;

  const title = fbotTitle(generated, prefix);
  await desktopSessionStorage.update(sessionId, { title });
  broadcastSessionPatched(sessionId, { title });
  return title;
}
