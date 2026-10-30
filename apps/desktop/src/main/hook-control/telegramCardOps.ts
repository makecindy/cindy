/**
 * hook-control/telegramCardOps.ts
 * ---------------------------------------------------------------------------
 * 官方 Telegram 一轮里的**执行中交互卡**(ask / plan / 权限): 双方协商
 * `telegram-card-ops-v1` 后由本端用与个人 bot 同一份卡片渲染(@cindy/im
 * `layoutTelegramCard`: 粗体标题 + markdown 正文 → HTML、正文上限、短按钮成对排布)
 * 经 msg.op(`purpose: 'interaction-card'`)发布与收口。
 *
 * 分工: 卡片的**语义**(选项、按钮文案、决策映射、超时默认)仍在 `interactions.ts`,
 * 不因载体改变; 本模块只负责把那张卡渲染成 Telegram 形态并驱动发布 / 收口。按钮回调
 * 仍由服务端收入站(它铸 callback_data、记 buttonId 映射), 照旧回 interaction.decision;
 * 群里的卡改投 owner 私聊也仍由服务端按现行规则决定。
 *
 * 回落: 卡片 op 拿到明确失败(含 HTML 被拒)时改发旧的 interaction.request, 交服务端
 * 渲染 —— 卡片是这一轮能否继续的关键路径, 不能因为新载体失败就让用户看不到。之后同一张
 * 卡的收口也走旧路径(interaction.cancel), 两条路径不混用。
 */

import {
  makeMessageOp,
  type InteractionButton,
  type MessageOpAction,
} from '@cindy/slack-hook-protocol';
import { callWithTelegramRateLimitRetry, layoutTelegramCard } from '@cindy/im';

import {
  abortableSleep,
  isMsgOpOutcomeUnknown,
  MSG_OP_UNKNOWN_REPLAYS,
  msgOpErrorFromResult,
  TELEGRAM_OP_MARKER,
  TelegramMsgOpError,
  type MsgOpResultRouter,
  type MsgOpSendFn,
} from './telegramMsgOp.js';

/** 一张执行中交互卡(与 interaction.request 同一份内容)。 */
export interface OfficialInteractionCard {
  interactionId: string;
  kind: string;
  title: string;
  body: string;
  buttons: InteractionButton[];
}

type CardState = { mode: 'client'; messageId: string } | { mode: 'legacy' } | { mode: 'lost' };

export interface OfficialTelegramCardPublisherDeps {
  connectionId: string;
  requestId: string;
  externalKey: string;
  getSend: () => MsgOpSendFn | undefined;
  router: MsgOpResultRouter;
  /** 旧路径: interaction.request / interaction.cancel(服务端渲染)。 */
  legacy: {
    open(card: OfficialInteractionCard): void;
    close(interactionId: string, reason: string): void;
  };
  log: { info(msg: string): void; warn(msg: string): void };
  resultTimeoutMs?: number;
}

export interface OfficialTelegramCardPublisher {
  open(card: OfficialInteractionCard): void;
  /** 卡片已决 / 超时 / 撤销: 把正文改成收口说明并清键盘。 */
  close(interactionId: string, reason: string): void;
  /**
   * 等在途的发卡 / 收口编辑结束(有界)。dispatcher 在发 turn.end 之前调用: 收口编辑要
   * 先于 turn.end 到达服务端, 否则服务端的收口清扫会先把卡片当成未收口处理。
   */
  drain(timeoutMs?: number): Promise<void>;
  /** 换账号 / dispose: 停止一切出站(在途发布照常收口但不再发后续 op)。 */
  dispose(): void;
}

/** drain 的默认上限: 只为等已交出的编辑拿回执, 不为它无限推迟 turn.end。 */
const CARD_DRAIN_TIMEOUT_MS = 5_000;

export function createOfficialTelegramCardPublisher(
  deps: OfficialTelegramCardPublisherDeps,
): OfficialTelegramCardPublisher {
  const { connectionId, requestId, externalKey, router, log } = deps;
  const cards = new Map<string, Promise<CardState>>();
  /** 在途的发卡与收口编辑(drain 等它们)。 */
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  };
  const abort = new AbortController();
  const sleep = abortableSleep(abort.signal);
  const isLive = (): boolean => !abort.signal.aborted;

  async function perform(
    interactionId: string,
    opIdBase: string,
    action: MessageOpAction,
    interactionClosed: boolean,
  ): Promise<string | null> {
    let attempt = 0;
    let replays = 0;
    const once = async (): Promise<string | null> => {
      if (!isLive()) throw new TelegramMsgOpError('telegram card publisher is disposed');
      const send = deps.getSend();
      if (!send) throw new TelegramMsgOpError('telegram card publisher is offline');
      const opId = `${opIdBase}:${attempt}`;
      const result = await router.request(
        connectionId,
        send,
        makeMessageOp({
          opId,
          requestId,
          scope: { externalKey },
          purpose: 'interaction-card',
          interactionId,
          ...(interactionClosed ? { interactionClosed: true } : {}),
          action,
        }),
        opId,
        deps.resultTimeoutMs,
      );
      if (isMsgOpOutcomeUnknown(result)) {
        throw new TelegramMsgOpError(`telegram msg.op ${opId} outcome unknown`);
      }
      if (result!.ok) return result!.messageId ?? result!.messageIds?.[0] ?? null;
      attempt += 1;
      throw msgOpErrorFromResult(result!);
    };
    for (;;) {
      try {
        return await callWithTelegramRateLimitRetry(once, { sleep, isLive });
      } catch (err) {
        const unknown =
          err instanceof TelegramMsgOpError && err.errorCode === undefined && !err.serverCode;
        if (unknown && isLive() && replays < MSG_OP_UNKNOWN_REPLAYS) {
          replays += 1;
          continue;
        }
        throw err;
      }
    }
  }

  async function publish(card: OfficialInteractionCard): Promise<CardState> {
    const { html, rows } = layoutTelegramCard({
      title: card.title,
      body: card.body,
      buttons: card.buttons,
    });
    try {
      const messageId = await perform(
        card.interactionId,
        `${requestId}${TELEGRAM_OP_MARKER.card}${card.interactionId}:open`,
        {
          kind: 'send',
          text: html,
          tier: 'html',
          buttons: rows.map((row) =>
            row.map(({ button, text }) => ({ token: button.id, label: text })),
          ),
        },
        false,
      );
      if (messageId !== null) return { mode: 'client', messageId };
      log.warn(
        `telegram card ${card.interactionId} published without a messageId; it cannot be closed`,
      );
      return { mode: 'lost' };
    } catch (err) {
      const unknown =
        err instanceof TelegramMsgOpError && err.errorCode === undefined && !err.serverCode;
      if (unknown || !isLive()) {
        // 不知道它落没落地: 再走旧路径可能出现两张卡, 宁可只留这一张(30 分钟超时照常收口)。
        log.warn(`telegram card ${card.interactionId} outcome unknown; not falling back`);
        return { mode: 'lost' };
      }
      log.info(
        `telegram card ${card.interactionId} rejected (${err instanceof Error ? err.message : String(err)}); falling back to interaction.request`,
      );
      deps.legacy.open(card);
      return { mode: 'legacy' };
    }
  }

  return {
    open(card) {
      if (!isLive() || cards.has(card.interactionId)) return;
      cards.set(card.interactionId, track(publish(card)));
    },
    close(interactionId, reason) {
      const pending = cards.get(interactionId);
      if (!pending) return;
      cards.delete(interactionId);
      void track(
        pending.then(async (state) => {
          if (state.mode === 'legacy') {
            deps.legacy.close(interactionId, reason);
            return;
          }
          if (state.mode !== 'client' || !isLive()) return;
          const { html } = layoutTelegramCard({ body: reason, buttons: [] });
          try {
            await perform(
              interactionId,
              `${requestId}${TELEGRAM_OP_MARKER.card}${interactionId}:close`,
              { kind: 'edit', messageId: state.messageId, text: html, tier: 'html', buttons: [] },
              true,
            );
          } catch (err) {
            log.warn(
              `telegram card ${interactionId} close failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }),
      );
    },
    async drain(timeoutMs = CARD_DRAIN_TIMEOUT_MS) {
      if (inflight.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
    dispose() {
      abort.abort();
      cards.clear();
    },
  };
}
