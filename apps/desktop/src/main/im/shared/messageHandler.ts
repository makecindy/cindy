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

import type { IMAttachment, IMMessageEvent, TextChannelIM } from '@cindy/im';

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
  const log = createLogger(`im:${channel}:msg`);

  /** Per-user serial lock — same shape as legacy messageRouter.turnLocks. */
  const userLocks = new Map<string, Promise<void>>();

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
      try {
        await im.sendMarkdownText(event.senderId, reply, { threadTs: event.scopeKey });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`!stop reply failed (non-fatal): ${msg}`);
      }
      return;
    }

    // ── slash command (only on plain text: no attachments, no unsupported) ──
    if (pureTextCommandInput && looksLikeSlashCommand(event.text)) {
      // 渠道钩子先于命令处理 — 飞书靠它记住开话题 slash 事件的群主流取数
      // lane(thread 前上下文), 供流程结束后话题里的第一条 agent 消息使用。
      try {
        adapter.onSlashCommandEvent?.(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`onSlashCommandEvent threw (non-fatal): ${msg}`);
      }
      try {
        await slash.handleSlashCommand(event.text, {
          botContextId: event.contextId,
          userId: event.senderId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`slash command threw: ${msg}`);
      }
      return;
    }

    const hasContent = event.text.length > 0 || event.attachments.length > 0;

    // ── pure-unsupported: reply directly, do NOT invoke agent ───────────────
    if (!hasContent && event.unsupported.length > 0) {
      try {
        await im.sendText(event.senderId, ui.agent.unsupportedOnly(event.unsupported), {
          threadTs: event.scopeKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`unsupportedOnly send failed (non-fatal): ${msg}`);
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
    if (adapter.prepareAgentTurnText) {
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
      try {
        await im.sendText(event.senderId, ui.agent.sendInternalError(msg), {
          threadTs: event.scopeKey,
        });
      } catch {
        /* swallow */
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
