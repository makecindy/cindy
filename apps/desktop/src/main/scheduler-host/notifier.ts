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

import type { BrowserWindow } from 'electron';
import type { Notifier, Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import { stripXdtFileLinks, stripXdtImageLinks, type FeishuIM } from '@cindy/im';

import type { Logger } from '@cindy/maker-scheduler';

import { stripTrailingPathSeparators } from '../../shared/pathText';
import { showDesktopSessionEvent } from '../notificationService';
import { getMobileNotifyGeneration, sendMobileSessionNotify } from '../device-link';
import type { WecomGroupNotificationPublisher } from '../wecomGroupNotification';

export interface DesktopNotifierDeps {
  getMainWindow: () => BrowserWindow | null;
  feishuIm: FeishuIM;
  logger: Logger;
  /** Global desktop preference and Agent Island arbitration, evaluated at send time. */
  shouldNotifyDesktop: () => boolean;
  wecomGroupPublisher?: WecomGroupNotificationPublisher;
}

export class DesktopNotifier implements Notifier {
  constructor(private readonly deps: DesktopNotifierDeps) {}

  async notify(schedule: Schedule, run: ScheduleRun): Promise<void> {
    // 链路代次在任何 await 之前捕获:飞书分支的 await 期间可能发生登出/换号,
    // 发送侧按代次不一致丢弃,旧账号调度的通知不会进新账号的链路。
    const generation = getMobileNotifyGeneration();
    if (schedule.notify.desktop && this.deps.shouldNotifyDesktop()) {
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
      await this.deps.feishuIm.sendMarkdownText(ownerOpenId, text);
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

/**
 * 把 ScheduleRun 渲染成外部通知通用文案。
 *
 * 视觉布局（从上到下）:
 *   1. 状态标题 — `<emoji> <schedule name>` 加粗,emoji 据 status 区分
 *   2. （失败时）错误原因 — 截断到 200 字符
 *   3. 元信息 — 时间 · 耗时 · agent · 工作目录(短)
 *
 * 格式约束:
 *   - 仅使用飞书与企微群消息共同支持的 Markdown 子集：`**bold**`、列表、emoji
 *   - URL 直接写，由各渠道按自身能力识别
 *   - 不使用行内 code，避免渠道渲染与清洗规则产生差异
 */
function renderExternalMessage(schedule: Schedule, run: ScheduleRun): string {
  const lines: string[] = [`${statusEmoji(run.status)} **${schedule.name}**`];

  if (run.status === 'failed' && run.errorMsg) {
    lines.push('', `⚠️ ${truncate(run.errorMsg, 200)}`);
  } else if (run.status === 'success' && run.resultText) {
    // prompt 类成功：把 agent 这一轮 turn 的最终文本贴出来 — 与飞书正常对话
    // 气泡显示同源（runner 按 text 事件 isFinal 语义聚合）。截断防卡片体积过大,
    // 完整内容用户可点 "Open session" 看。上限 6000:多 PR 审查汇总这类逐行带
    // markdown 链接的正文 1500 会拦腰截断;6000 即使全 CJK(~18KB UTF-8)也在
    // 飞书互动卡片 30KB 体积上限内。
    const safeResultText = stripXdtFileLinks(stripXdtImageLinks(run.resultText)).trim();
    if (safeResultText) lines.push('', truncate(safeResultText, 6000));
  }

  // ── 元信息行（时间 / 耗时 / agent / cwd）────────────────────────────────
  const metaParts: string[] = [];
  metaParts.push(`⏰ ${formatTime(run.firedAt)}`);
  if (typeof run.finishedAt === 'number' && run.finishedAt > run.firedAt) {
    metaParts.push(`⏱️ ${formatDuration(run.finishedAt - run.firedAt)}`);
  }
  metaParts.push(`🤖 ${schedule.agentKind}${schedule.model ? ` · ${schedule.model}` : ''}`);
  const wd = shortDir(schedule.workingDir);
  if (wd) metaParts.push(`📂 ${wd}`);
  lines.push('', metaParts.join('  ·  '));

  return lines.join('\n');
}

function statusEmoji(s: ScheduleRun['status']): string {
  switch (s) {
    case 'success': return '✅';
    case 'failed': return '❌';
    case 'aborted': return '⏹️';
    case 'interrupted': return '⏹️';
    case 'running': return '⏳';
    default: return 'ℹ️';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatTime(ms: number): string {
  // 飞书内本就显示当地时区,不再写 timezone;格式 5/9 15:46
  const d = new Date(ms);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatDuration(diffMs: number): string {
  if (diffMs < 1000) return `${diffMs}ms`;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function shortDir(p?: string): string | null {
  if (!p) return null;
  const segs = stripTrailingPathSeparators(p).split(/[\\/]/);
  if (segs.length <= 2) return p;
  return `…/${segs.slice(-2).join('/')}`;
}
