/**
 * main/im/shared/controlFlow.ts
 * ---------------------------------------------------------------------------
 * thread 模型的"远程控制"发起流程 — `/xdmaker ctr` slash 与卡片按钮
 * (control:start, 出现在"已取消/已退出"收口卡上) 共用同一入口, 抽成独立模块
 * 避免 slashCommands ↔ cardActionHandler 互相 import。
 *
 * 流程: 顶层发锚点卡(未来的接管 thread root)→ 工作区选择卡发进它的 thread
 * → enterControl(scope = 锚点 ts)。后续选择/接管由 cardActionHandler 驱动。
 */

import type { ChannelIM } from "@cindy/im";

import type { ImCommandHost } from "./commandHost";
import type { ImCardBuilders } from "./cardBuilders";
import type { ImChannelAdapter } from "./types";

/**
 * 发起一次远程控制(锚点卡 + thread 内工作区选择卡)。
 * 返回 true = 锚点 + 选择卡都发出去了;false = 任一步失败(已打日志,
 * caller 可据此保留入口按钮让用户重试)。
 *
 * im 显式传入(不取 adapter.im)— 与 slashCommands / cardActionHandler 的
 * "handler 拿到哪个 im 实例就用哪个"约定一致。
 */
export async function startThreadControlFlow(
  im: ChannelIM,
  adapter: ImChannelAdapter,
  cards: ImCardBuilders,
  args: { botContextId: string; userId: string },
  host: Pick<
    ImCommandHost,
    "createLogger" | "listProjectsForControl" | "enterControl"
  >,
): Promise<boolean> {
  const { createLogger, listProjectsForControl, enterControl } = host;
  const { channel } = adapter;
  const threadUi = adapter.ui.thread;
  const log = createLogger(`im:${channel}:control`);
  if (!adapter.threadScoped || !threadUi || !im.threadKeyForMessage)
    return false;

  const projects = await listProjectsForControl();
  let anchorMessageId: string;
  try {
    const anchorCard = threadUi.controlAnchorCard;
    const anchor = await im.sendInteractiveCard(args.userId, {
      title: anchorCard.title,
      body: anchorCard.body,
      buttons: [],
    });
    anchorMessageId = anchor.messageId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`control flow anchor card send failed: ${msg}`);
    return false;
  }
  const scopeKey = im.threadKeyForMessage(anchorMessageId);
  const spec = cards.buildControlPickerCard({
    botAppId: args.botContextId,
    projects,
    anchorMessageId,
  });
  try {
    await im.sendInteractiveCard(args.userId, spec, { threadTs: scopeKey });
    enterControl(args.botContextId, args.userId, scopeKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`control flow picker(in-thread) send failed: ${msg}`);
    return false;
  }
  return true;
}
