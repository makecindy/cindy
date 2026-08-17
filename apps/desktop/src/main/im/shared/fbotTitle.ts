/**
 * main/im/shared/fbotTitle.ts
 * ---------------------------------------------------------------------------
 * FBot 接管 session 的 title 生成助手 — 跨 cardActionHandler / runAgentTurn 复用,
 * 抽到独立模块避免反向 import (cardActionHandler 已经 import runAgentTurn)。
 *
 * 命名约定:
 *   - prefix 'FBot · ' 是接管 session 标题的兜底前缀(无渠道命名约定的渠道);
 *     feishu 接管 session 与渠道默认会话对齐 — 话题 lane 走 composeGeneratedTitle
 *     ([飞书·{群名}·{话题简介}] {threadId}), DM 走 generatedTitlePrefix
 *     ([飞书·DM] {简介}), 见 turnRunner.composeOrGenerateTitle
 *   - 草稿态 title = 'FBot · New', 跟 desktop 'New Maker' 占位 title 同语义:
 *     表示用户还没发第一条消息, 等首条消息到达后由 oneshot 生成正式 title
 *
 * generateAndPersistFbotTitle 流程: oneshot 跑 LLM → 拿短标题 → 落库 → 广播
 * sessions:patched 让 sidebar 即时刷新。失败 swallow (跟 desktop generateTitle
 * 一致, 起不出来标题不阻塞主流程)。
 */

import { desktopSessionStorage } from '../../maker-host/session-storage';
import { generateMakerSessionTitle } from '../../maker-ipc/title';
import { broadcastSessionPatched } from './sessionBroadcast';

export { broadcastSessionPatched } from './sessionBroadcast';

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
  const generated = await generateImSessionTitleText(sessionId, seedText);
  if (!generated) return null;

  const title = fbotTitle(generated, prefix);
  await desktopSessionStorage.update(sessionId, { title });
  broadcastSessionPatched(sessionId, { title });
  return title;
}

/**
 * 只生成标题文本(不落库) — 供渠道自定义拼装(飞书话题标题)复用 oneshot 通道。
 * 标题 oneshot 失败(无 title target / 模型输出校验不过)时, 走 utility 链兜底
 * 再试一次 — 标题是展示层, 失败不阻塞, 但兜底能把 [飞书·话题] 0f9b9b 这类
 * 默认名救回正式话题名。
 */
export async function generateImSessionTitleText(
  sessionId: string,
  seedText: string,
): Promise<string | null> {
  const generated = (await generateMakerSessionTitle(seedText, 'claude-code', sessionId))?.trim();
  if (generated) return generated;
  try {
    // 动态 import 保持本模块的静态依赖链不继续膨胀(cindySlot 同款)。
    const [{ requestUtilityText }, { getMaker }] = await Promise.all([
      import('../../utility-model/oneShotCandidates.js'),
      import('../../maker-host/index.js'),
    ]);
    const r = await requestUtilityText(
      getMaker(),
      `给下面这条消息生成一个不超过 12 个字的会话标题, 只输出标题本身:\n\n${seedText
        .trim()
        .slice(0, 300)}`,
      { maxTokens: 24, timeoutMs: 12_000, reasoningEffort: 'minimal' },
    );
    if (r.ok) {
      const text = r.text.trim().replace(/^["'「『]+|["'」』]+$/g, '').slice(0, 40);
      if (text) return text;
    }
  } catch {
    /* swallow — 兜底失败保持原样 */
  }
  return null;
}

/** 落库 + 广播一个已拼装好的标题(渠道 composeGeneratedTitle 的产物)。 */
export async function persistGeneratedSessionTitle(sessionId: string, title: string): Promise<void> {
  await desktopSessionStorage.update(sessionId, { title });
  broadcastSessionPatched(sessionId, { title });
}
