/**
 * main/im/shared/messageHandler.ts
 * ---------------------------------------------------------------------------
 * Subscribe to ChannelIM.onMessage and route to:
 *   - slash command handler (text starts with '/'),
 *   - direct unsupported-only reply (no agent invocation),
 *   - agent turn (turnRunner.runAgentTurn).
 *
 * Per-(botContextId, userId) serial lock — 渠道事件源可能在用户连发时并发触发。
 * Without a lock, two concurrent runAgentTurn calls would race in
 * `ensureSessionWired` (both miss the cache → both spawn a maker session →
 * second clobbers first) and would also let the agent see the second user
 * message before the first turn's session creation finishes.
 *
 * 渠道无关(原 im/feishu/messageHandler.ts 工厂化): userLocks per 实例,
 * 跨渠道互不影响。
 */

import type { IMAttachment, IMMessageEvent, InteractiveCardSpec, TextChannelIM } from '@cindy/im';

import { createLogger } from '../../logger';
import {
  captureImAccountGeneration,
  isImAccountScopeClosedError,
  runInImAccountGeneration,
  type ImAccountGeneration,
} from '../accountBoundary';

import { getControlScope, isInControl } from './controlState';
import { isCommandAuthorized, isStopCommand } from './controlCommands';
import type { ImSlashHandlers } from './slashCommands';
import { looksLikeSlashCommand } from './slashCommands';
import type { ImTurnRunner } from './turnRunner';
import type { ImChannelAdapter } from './types';

/**
 * `!stop` 控制指令 — 半角/全角感叹号、大小写不敏感(issue #867)。
 * 用 `!` 而非 slash 前缀: Slack 会把 `/` 开头的输入截为原生 slash command,
 * 普通 DM 文本里只有 `!` 前缀能原样到达 bot。
 */
export { isStopCommand } from './controlCommands';

export function createMessageHandler(
  adapter: ImChannelAdapter,
  slash: ImSlashHandlers,
  turnRunner: ImTurnRunner,
): (im: TextChannelIM) => () => void {
  const { ui, channel, threadScoped } = adapter;
  // 富卡渠道(仅 feishu 实现这两个能力): 群主流 @ 开话题的「思考中」开场白卡
  // 在非流式终态分支的收口 — 见各分支内 consume/discard 调用点。
  const richIm = adapter.output?.kind === 'rich-card' ? adapter.output.im : null;

  /**
   * 尝试消费 pending 开场白卡并把终态回复 patch 上去。消费成功返回 true
   * (调用方跳过另发); 无 pending opener 或 patch 失败返回 false(回落正常
   * 发送 — 失败场景下发送兜底, 且认领已完成, 同话题下一条不会再 patch 错卡)。
   */
  async function consumeOpenerWithText(userId: string, text: string): Promise<boolean> {
    if (!richIm?.consumePendingOpenerCard) return false;
    try {
      return await richIm.consumePendingOpenerCard(userId, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`consumePendingOpenerCard failed (fallback to normal send): ${msg}`);
      return false;
    }
  }

  const log = createLogger(`im:${channel}:msg`);

  /** Per-user serial lock — same shape as legacy messageRouter.turnLocks. */
  const userLocks = new Map<string, Promise<void>>();

  /**
   * 提前打「已收到」表情 —— 与 turnRunner 的 ackProcessing 是同一个动作, 只是
   * 时机更早: 群上下文拼装排在 runAgentTurn 之前, 慢的时候(回翻群历史 + 轻量
   * 模型判断)用户几十秒看不到反馈。句柄交给 turn 接管(ImRunAgentTurnArgs
   * .ackReactionIdPromise), 由它负责撤掉, 这里不自己清理。
   * 渠道没有表情能力或打失败 ⇒ null, turn 也不会再补打。
   */
  async function ackProcessingEarly(
    im: TextChannelIM,
    messageId: string,
  ): Promise<string | null> {
    try {
      return (await im.reactToMessage?.(messageId, adapter.processingEmoji)) ?? null;
    } catch {
      return null;
    }
  }

  async function processOne(
    im: TextChannelIM,
    event: IMMessageEvent,
    accountGeneration: ImAccountGeneration,
  ): Promise<void> {
    log.info(
      `processOne sender=...${event.senderId.slice(-8)} chat=...${event.chatId.slice(-8)} ` +
        `textLen=${event.text.length} att=${event.attachments.length} unsupported=${event.unsupported.length}`,
    );

    // ── 控制命令的主人门: 群成员的 !stop / slash 静默丢弃 ────────────────────
    // 群消息的 senderId 是**群 lane**(telegram g/<chatId>、钉钉
    // encodeLaneUserId(conversationId)), 所以群成员发的 !stop 会解析到同一个群
    // 会话 —— 等于掐掉主人正在跑的那一轮; slash 则会去动主人的目录/会话。
    // 静默(不回提示)与 telegram 入站层同口径: 群里不可被探测。也不落到 agent,
    // 否则命令会变成一句普通 prompt。
    //
    // 放在 /ctr 拦截**之前**: 否则主人正走 /ctr 时, 群成员发命令会收到一句
    // "控制流程中" —— 等于把主人的状态回给了没有权限的人。
    //
    // 只有**纯文本**才算控制命令: 附件与 unsupported(音视频/超限/未知类型等)都要
    // 让消息走 unsupportedNotice / unsupportedOnly / agent 的原有路径, 不能被当成
    // 一句裸命令吞掉 —— 那会连"你那个音频我处理不了"的反馈一起吃掉。
    // 这个判据必须与下面两条命令分支**逐字一致**: 门比分支窄一点, 非主人的
    // `!stop` + unsupported 就会穿过门再被分支执行, 洞等于没堵。
    const pureTextCommandInput =
      event.text.length > 0 && event.attachments.length === 0 && event.unsupported.length === 0;
    const commandLike =
      pureTextCommandInput && (isStopCommand(event.text) || looksLikeSlashCommand(event.text));
    if (commandLike && !isCommandAuthorized(event)) {
      log.info(
        `dropped non-owner command sender=...${event.senderId.slice(-8)} ` +
          `speaker=...${(event.speaker?.id ?? '').slice(-8)}`,
      );
      return;
    }

    // ── /ctr 原子化拦截 ────────────────────────────────────────────────
    // 该 (bot, owner) 处于 /ctr 流程中 → 任何消息都不路由到 slash/agent,
    // 直接回提示让用户走卡片按钮 (back/exit/session-pick) 退出。包括重复
    // /ctr 命令本身: 已经有一张卡片在了, 多发只会徒增混乱, 也被吞掉。
    // 卡片按钮事件走 cardAction 通道, 不进 processOne, 不受影响。
    // threadScoped 渠道只拦: ① 顶层消息(含重复 /xdmaker ctr)② 控制锚点
    // thread 里的消息(选完之前别跟还不存在的 agent 说话)— 其它 thread 路由
    // 到各自独立 session, 与选择流程的原子性无关, 放行。
    const blockedByControl = threadScoped
      ? isInControl(event.contextId, event.senderId) &&
        (!event.threadTs || event.threadTs === getControlScope(event.contextId, event.senderId))
      : isInControl(event.contextId, event.senderId);
    if (blockedByControl) {
      log.info(
        `dropped (in /ctr) sender=...${event.senderId.slice(-8)} bot=...${event.contextId.slice(-8)}`,
      );
      try {
        await im.sendMarkdownText(event.senderId, ui.agent.controlInProgress, {
          threadTs: event.scopeKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`controlInProgress notice failed (non-fatal): ${msg}`);
      }
      return;
    }

    // ── !stop 控制指令: 中止当前 turn, 绝不作为普通消息入队 ─────────────────
    // 放在 slash 之前; 与 slash 同口径只认纯文本(见 pureTextCommandInput)。turn
    // 运行期间 userLocks 并不持锁(runAgentTurn 在 dispatch 后即返回), 所以这里能在
    // 上一轮仍在跑时立刻执行, 而不是排到它后面。
    if (pureTextCommandInput && isStopCommand(event.text)) {
      let reply: string;
      try {
        const result = await turnRunner.stopActiveTurn({
          botContextId: event.contextId,
          userId: event.senderId,
          scopeKey: threadScoped ? event.scopeKey : undefined,
        });
        reply = result.stopped ? ui.agent.stopDone(result.droppedQueued) : ui.agent.stopIdle;
        log.info(
          `!stop handled sender=...${event.senderId.slice(-8)} stopped=${result.stopped} dropped=${result.droppedQueued}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`stopActiveTurn threw: ${msg}`);
        reply = ui.agent.sendInternalError(msg);
      }
      // 群主流 @ 开话题的首条若是 !stop: 「思考中」开场白卡就地 patch 成
      // stop 回复(消费 pending opener), 不再另发一条; 消费不了再走正常发送。
      // 仅当本条消息**自己**开了话题(groupContextLane 存在)才消费 — 同话题
      // 后续消息 B 不得认领上一轮 A 的 pending opener, 否则 B 的终态回复会
      // 覆盖 A 的思考卡, A 的回答另发新卡造成归属错乱。
      const openerConsumed = event.groupContextLane
        ? await consumeOpenerWithText(event.senderId, reply)
        : false;
      if (!openerConsumed) {
        try {
          await im.sendMarkdownText(event.senderId, reply, {
            threadTs: event.scopeKey,
            fallbackOpenerId: richIm?.takeNotedFallbackOpenerId?.(event.senderId, 'markdown'),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`!stop reply failed (non-fatal): ${msg}`);
        }
      }
      return;
    }

    // ── slash command (only on plain text: no attachments, no unsupported) ──
    if (pureTextCommandInput && looksLikeSlashCommand(event.text)) {
      // 群主流 @ 开话题的首条若是 slash: slash 自备回复(文本/卡片), 把它的
      // **首个**回复就地消费开场白卡(patch 文本 / 替换卡片)— 卡不卡住, 也
      // 不用撤回后拿已删消息当回复锚点。消费过一次后后续回复正常发送。
      // 仅当本条消息**自己**开了话题(groupContextLane 存在)才注入 sink —
      // 同话题后续 slash 不得认领上一轮的 pending opener(归属错乱, 同
      // !stop 分支的说明)。
      // bind 接收者: FeishuIM 方法内部访问 this.log, 裸函数引用会导致 catch
      // 路径(撤回开场白卡)在 this=undefined 下抛错、卡残留。
      const consumeCard = event.groupContextLane
        ? richIm?.consumePendingOpenerCard?.bind(richIm)
        : undefined;
      const consumeAsCard = event.groupContextLane
        ? richIm?.consumePendingOpenerAsCard?.bind(richIm)
        : undefined;
      const sink = consumeCard
        ? {
            used: false,
            async withMarkdown(userId: string, markdown: string): Promise<boolean> {
              if (this.used) return false;
              const ok = await consumeCard(userId, markdown);
              if (ok) this.used = true;
              return ok;
            },
            async withCard(userId: string, spec: InteractiveCardSpec): Promise<boolean> {
              if (this.used) return false;
              const ok = (await consumeAsCard?.(userId, spec)) ?? false;
              if (ok) this.used = true;
              return ok;
            },
          }
        : undefined;
      try {
        await slash.handleSlashCommand(event.text, {
          botContextId: event.contextId,
          userId: event.senderId,
          consumePendingOpener: sink,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`slash command threw: ${msg}`);
        // slash 在首个回复发出前抛错(如 /ctr 枚举失败): sink 未被调用,
        // 开场白卡用内部错误内容收口 — 否则「思考中」卡永久保留。
        // withMarkdown 返回 false(撤回/空窗暂存)或抛错时走正常发送兜底,
        // 与 !stop / runAgentTurn 失败分支同一口径。
        const errorText = ui.agent.sendInternalError(msg);
        let openerConsumed = false;
        if (sink) {
          try {
            openerConsumed = await sink.withMarkdown(event.senderId, errorText);
          } catch {
            openerConsumed = false;
          }
        }
        if (!openerConsumed) {
          try {
            await im.sendMarkdownText(event.senderId, errorText, {
              threadTs: event.scopeKey,
              fallbackOpenerId: richIm?.takeNotedFallbackOpenerId?.(event.senderId, 'markdown'),
            });
          } catch {
            /* 发送失败与卡残留同一最终边界 */
          }
        }
      }
      return;
    }

    const hasContent = event.text.length > 0 || event.attachments.length > 0;

    // ── pure-unsupported: reply directly, do NOT invoke agent ───────────────
    if (!hasContent && event.unsupported.length > 0) {
      const notice = ui.agent.unsupportedOnly(event.unsupported);
      // 同 !stop: 开场白卡就地 patch 成 unsupported 提示, 消费不了再另发;
      // 仅本条消息自己开了话题(groupContextLane)才消费。
      const openerConsumed = event.groupContextLane
        ? await consumeOpenerWithText(event.senderId, notice)
        : false;
      if (!openerConsumed) {
        try {
          await im.sendText(event.senderId, notice, {
            threadTs: event.scopeKey,
            fallbackOpenerId: richIm?.takeNotedFallbackOpenerId?.(event.senderId, 'markdown'),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`unsupportedOnly send failed (non-fatal): ${msg}`);
        }
      }
      return;
    }

    if (!hasContent) {
      // empty + no unsupported — should already be filtered upstream, but be safe
      return;
    }

    // ── mixed: ack the dropped bits as a SEPARATE text msg, then run agent ──
    if (event.unsupported.length > 0) {
      try {
        await im.sendText(event.senderId, ui.agent.unsupportedNotice(event.unsupported), {
          threadTs: event.scopeKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`unsupportedNotice send failed (non-fatal): ${msg}`);
      }
    }

    // ── invoke agent ────────────────────────────────────────────────────────
    // 送模型正文改写钩子(群上下文拼装): 失败按"不改写"降级, 不阻断消息。
    let prepared: {
      agentText: string;
      contextAttachments?: IMAttachment[];
      commit?: () => void | Promise<void>;
    } | null = null;
    // 「已收到」表情先落, 再拼上下文 —— 群上下文拼装要回翻群历史(可能翻页 + 调
    // 轻量模型), 慢的时候几十秒没有任何反馈, 用户只能看着不动的消息猜 bot 是不是
    // 挂了(实测最慢到 87s)。句柄交给 turn 接管(turn 收口时照常撤掉/换成结果
    // 表情; turn 没建起来就 rejected 时由 turnRunner 撤掉)。
    // undefined = 没提前打, turn 自己打(与老行为一致)。
    let handedOverAck: Promise<string | null> | null | undefined;
    // 用户消息也提前落库 —— 表情只解决了「渠道里看得到反馈」, 桌面端那条会话里
    // 这条消息要等 turn 真正派发才出现(落库挂在 provider 受理的 onAccepted 上),
    // 群上下文拼装慢的时候就是 15~60s 的空白, 看着像消息丢了。忙 / 新会话 /
    // 受保护内容时返回 null, 完全退回原行为(见 persistInboundUserMessageEarly)。
    let prePersisted: { sessionId: string; clientId: string } | null = null;
    if (adapter.prepareAgentTurnText) {
      handedOverAck = event.messageId ? ackProcessingEarly(im, event.messageId) : null;
      try {
        prePersisted =
          (await turnRunner.persistInboundUserMessageEarly?.({
            botContextId: event.contextId,
            userId: event.senderId,
            scopeKey: threadScoped ? event.scopeKey : undefined,
            text: event.text,
            attachments: event.attachments,
            ...(event.protectedContent === true ? { protectedContent: true } : {}),
          })) ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`early user-message persist failed (non-fatal): ${msg}`);
      }
      try {
        prepared = await adapter.prepareAgentTurnText(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`prepareAgentTurnText failed (degraded to raw text): ${msg}`);
      }
    }
    // 按事件挂 per-turn 权限策略(telegram 群成员触发 → 破坏性调用强确认)。
    const turnPermissionPolicy = adapter.turnPermissionPolicyFor?.(event);
    const groupHistoryAccess = adapter.groupHistoryAccessFor?.(event);
    try {
      await turnRunner.runAgentTurn({
        botContextId: event.contextId,
        userId: event.senderId,
        userMessageId: event.messageId,
        text: event.text,
        // 受保护群的触发消息照常起 turn, 但不进会话存档(渠道侧已挡住群历史池,
        // 这里挡住第二条路径)。
        ...(event.protectedContent === true ? { protectedContent: true } : {}),
        ...(turnPermissionPolicy ? { turnPermissionPolicy } : {}),
        ...(groupHistoryAccess ? { groupHistoryAccess } : {}),
        ...(handedOverAck !== undefined ? { ackReactionIdPromise: handedOverAck } : {}),
        // 早期拒绝终态(missing_auth / credential busy): 本条消息自己开了话题
        // 时, 用终态文案收口开场白卡 — 否则「思考中」卡残留且下一条误认领。
        ...(event.groupContextLane
          ? {
              onEarlyReject: async (reason: string, text: string) => {
                void reason;
                return consumeOpenerWithText(event.senderId, text);
              },
            }
          : {}),
        ...(prePersisted ? { prePersistedUserMessage: prePersisted } : {}),
        ...(prepared ? { agentText: prepared.agentText } : {}),
        // 群历史附件只进模型消息、不落库(见 ImRunAgentTurnArgs.contextAttachments)。
        ...(prepared?.contextAttachments?.length
          ? { contextAttachments: prepared.contextAttachments }
          : {}),
        ...(prepared?.commit
          ? {
              // turnRunner 只在 provider 真正接受消息后调用；排队、停止与
              // teardown 都不推进游标, 受理前失败时上下文批次下次仍进 prompt。
              onRouteResolved: async () => {
                await prepared?.commit?.();
              },
            }
          : {}),
        attachments: event.attachments,
        // threadScoped 渠道: scopeKey = thread root ts(thread = session 路由键)
        scopeKey: threadScoped ? event.scopeKey : undefined,
        // Title generation and similar detached work must stay visible to the
        // same account drain without delaying the foreground message dispatch.
        trackBackgroundTask: (operation) => {
          void runInImAccountGeneration(accountGeneration, operation).catch((err) => {
            if (isImAccountScopeClosedError(err)) {
              log.info(`drop background task from stale account generation channel=${channel}`);
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`account-scoped background task failed (non-fatal): ${msg}`);
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`runAgentTurn threw: ${msg}`);
      // 本条消息自己开了话题(groupContextLane)时, 开场白卡还没被流式认领 —
      // 用内部错误内容收口它, 否则卡永久残留且同话题下一条会 patch 错卡。
      const errorText = ui.agent.sendInternalError(msg);
      const openerConsumed = event.groupContextLane
        ? await consumeOpenerWithText(event.senderId, errorText)
        : false;
      if (!openerConsumed) {
        try {
          await im.sendText(event.senderId, errorText, {
            threadTs: event.scopeKey,
            fallbackOpenerId: richIm?.takeNotedFallbackOpenerId?.(event.senderId, 'markdown'),
          });
        } catch {
          /* swallow */
        }
      }
    }
  }

  return function attachMessageHandler(im: TextChannelIM): () => void {
    return im.onMessage((event) => {
      // Capture synchronously, before entering the per-user queue. A boolean
      // check at execution time could accept old-account work after relogin.
      const accountGeneration = captureImAccountGeneration();
      if (accountGeneration === null) {
        log.info(`drop inbound message after account boundary closed channel=${channel}`);
        return;
      }
      // threadScoped 渠道: 同 thread 串行、跨 thread 并行(scopeKey 进锁键);
      // feishu scopeKey 恒 undefined — 键多一个冒号后缀, 行为不变。
      const key = `${event.contextId}:${event.senderId}:${threadScoped ? (event.scopeKey ?? '') : ''}`;
      const prev = userLocks.get(key) ?? Promise.resolve();
      const work = prev
        .catch(() => {
          /* prior turn failure should not block subsequent messages */
        })
        .then(() =>
          runInImAccountGeneration(accountGeneration, () =>
            processOne(im, event, accountGeneration),
          ).catch((err) => {
            if (isImAccountScopeClosedError(err)) {
              log.info(`drop inbound message from stale account generation channel=${channel}`);
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`processOne threw: ${msg}`);
          }),
        );
      userLocks.set(key, work);
      void work.finally(() => {
        // Only clear if I'm still the tail (no follow-up enqueued).
        if (userLocks.get(key) === work) userLocks.delete(key);
      });
    });
  };
}
