/**
 * Phase 3: DesktopNotifier
 *
 * 实现 `Notifier` 接口（来自 @cindy/maker-scheduler）。
 *
 * 桌面通道：直接复用 notificationService 的 main 进程入口。
 * 飞书通道：Phase 3 暂时只 log 一行（owner openId 解析逻辑要等 Phase 4 IPC
 * 时补充 schedule.notifyFeishuTarget 字段 + ownerGuard 暴露 owner 接口）。
 *
 * **硬规则**：notify() 不能 throw —— 通知失败不能中断 run。所有 try/catch 包好。
 */

import type { createMobileNotificationSender } from './mobileNotificationSender.js';
import type { Notifier, Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import { type FeishuIM } from '@cindy/im';

import type { Logger } from '@cindy/maker-scheduler';

import { renderExternalMessage } from '@cindy/im-runtime/scheduleNotification';


import type { WecomGroupNotificationPublisher } from '@cindy/im-runtime/wecomGroupNotification';

export interface DesktopNotifierDeps<Window = unknown> {
  hasUnrecoveredMatchingFailure?: (run: ScheduleRun) => Promise<boolean>;
  getMainWindow: () => Window | null;
  feishuIm: FeishuIM;
  logger: Logger;
  /** Persist the notification receipt against this exact run, when a session exists. */
  sendFeishuSessionNotification?: (sessionId: string, text: string) => Promise<void>;
  /** Global desktop preference, evaluated at send time. */
  shouldNotifyDesktop: () => boolean;
  /** Whether Agent Island should arbitrate routine scheduler desktop notifications. */
  isAgentIslandEnabled: () => boolean;
  wecomGroupPublisher?: WecomGroupNotificationPublisher;
}

export function createScheduleNotifier<Window>(host: {
  getMobileNotifyGeneration(): number;
  sendMobileSessionNotify: ReturnType<typeof createMobileNotificationSender>['sendMobileSessionNotify'];
  showDesktopSessionEvent(getWindow: () => Window | null, payload: { sessionId: string; title: string; kind: 'done' | 'error' }): unknown;
}) {
  const { getMobileNotifyGeneration, sendMobileSessionNotify, showDesktopSessionEvent } = host;
class DesktopNotifier implements Notifier {
  constructor(private readonly deps: DesktopNotifierDeps<Window>) {}

  async notify(schedule: Schedule, run: ScheduleRun): Promise<void> {
    // 链路代次在任何 await 之前捕获:飞书分支的 await 期间可能发生登出/换号,
    // 发送侧按代次不一致丢弃,旧账号调度的通知不会进新账号的链路。
    const generation = getMobileNotifyGeneration();
    if (schedule.silentWhenIdle && run.status === 'failed') {
      try {
        if (await this.deps.hasUnrecoveredMatchingFailure?.(run)) return;
      } catch (error) {
        // A failed history lookup must never hide the original failure.
        this.deps.logger.warn?.('scheduler failure dedup lookup failed', error);
      }
    }
    if (getMobileNotifyGeneration() !== generation) return;
    if (
      schedule.notify.desktop &&
      this.deps.shouldNotifyDesktop() &&
      (!this.deps.isAgentIslandEnabled() || (run.status === 'failed' && !run.sessionId))
    ) {
      try {
        this.notifyDesktop(schedule, run);
      } catch (err) {
        this.deps.logger.warn?.('desktop notify failed', err);
      }
    }
    if (schedule.notify.feishu) {
      try {
        await this.notifyFeishu(schedule, run);
      } catch (err) {
        this.deps.logger.warn?.('feishu notify failed', err);
      }
    }
    if (schedule.notify.wecomGroup && this.deps.wecomGroupPublisher) {
      try {
        await this.deps.wecomGroupPublisher.publishMarkdown(renderExternalMessage(schedule, run));
      } catch (err) {
        this.deps.logger.warn?.('WeCom group notify failed', err);
      }
    }
    // 手机推送只跟随个人通知通道:desktop / feishu 全关表示用户不想被这个调度
    // 单独打扰。wecomGroup 是共享群通知,不能隐式开启个人移动推送。
    if (run.sessionId && (schedule.notify.desktop || schedule.notify.feishu)) {
      try {
        // 正文带运行结果摘要(与飞书卡片同源素材):成功给 resultText,失败给
        // errorMsg;缺省回退终态短文案。截断由 mobileNotify 按协议上限统一处理。
        const detail = run.status === 'success' ? run.resultText : run.errorMsg;
        sendMobileSessionNotify({
          sessionId: run.sessionId,
          title: schedule.name,
          kind: run.status === 'success' ? 'done' : 'error',
          generation,
          ...(detail ? { detail } : {}),
        });
      } catch (err) {
        this.deps.logger.warn?.('mobile notify failed', err);
      }
    }
  }

  private notifyDesktop(schedule: Schedule, run: ScheduleRun): void {
    showDesktopSessionEvent(this.deps.getMainWindow, {
      sessionId: run.sessionId ?? '',
      title: schedule.name,
      // Notifier 只接收终态 run；除 success 外都表示任务没有完成，不能显示“已完成”。
      kind: run.status === 'success' ? 'done' : 'error',
    });
  }

  private async notifyFeishu(schedule: Schedule, run: ScheduleRun): Promise<void> {
    // 通知目标 = bot owner(用户私聊 bot 时 ownerGuard TOFU 记录的 open_id)。
    // 飞书 open_id 是 per-app 的,只有 bot 自己 app 内的 open_id 能调它的 IM API;
    // 历史上曾注入登录用户的主 app feishuOpenId 作参考,该字段已随飞书登录
    // 下线一并退役(2026-07)。
    const ownerOpenId = this.deps.feishuIm.getOwnerOpenId();
    if (!ownerOpenId) {
      this.deps.logger.warn?.(
        `[scheduler-notifier] feishu notify skipped: no bot owner bound — user must DM the bot once first (schedule=${schedule.id})`,
      );
      return;
    }
    const text = renderExternalMessage(schedule, run);
    try {
      if (run.sessionId && this.deps.sendFeishuSessionNotification) {
        await this.deps.sendFeishuSessionNotification(run.sessionId, text);
      } else {
        await this.deps.feishuIm.sendMarkdownText(ownerOpenId, text);
      }
    } catch (err) {
      // 飞书 SDK 包了一层 axios; 400 等业务错误的真正 message 在 response.data.code/msg
      // 里, axios.toString() 看不到。显式拆出来 log, 否则只看到 'Request failed
      // with status code 400' 跟没说一样。
      const r = (err as { response?: { data?: unknown; status?: number } }).response;
      this.deps.logger.warn?.(
        `[scheduler-notifier] feishu sendMarkdownText failed status=${r?.status ?? 'n/a'} body=${JSON.stringify(r?.data ?? null)} target=...${ownerOpenId.slice(-8)}`,
      );
      throw err;
    }
  }
}

return { DesktopNotifier };
}
