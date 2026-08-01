/**
 * notificationService — 系统级桌面通知（CC Agent session 完成 / 待回复提醒）
 * ---------------------------------------------------------------------------
 * 主进程层。提供单一 IPC handler `notification:show-session-event`：
 *   - macOS / Linux / Windows：统一走 Electron 原生 `Notification`。
 *   - 点通知后把窗口拉到前台，并通过 `notification:focus-session` 把 sessionId
 *     广播给 renderer，由 renderer 路由跳转。
 *   - 新增飞书通道:payload.channels.feishu === true 时,额外通过 feishuIm
 *     给当前 bot owner 私聊发一条 markdown 文本(复用 scheduler-host/notifier
 *     的同源 API,不新增通道机制)。
 *
 * Windows AUMID（AppUserModelID）契约：
 *   - 运行时由 main/bootstrap-electron.ts 通过 `app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)`
 *     声明；安装态由 NSIS（forge.config.ts 里的 `appId`）写到 Start Menu 快捷方式
 *     `System.AppUserModel.ID` 属性上。两边必须一致，Windows 通知中枢才会
 *     接收并显示对应 toast，否则会被静默丢弃（连 Action Center 都收不到）。
 *   - dev 下 electron.exe 启动没有 NSIS 装的快捷方式，原生 toast 可能不弹——
 *     把 dev 环境当成"通知功能要在 packaged 构建里测"即可，不再额外兜底。
 *
 * 通知偏好仍由 renderer 的 localStorage 持久化。普通会话在 renderer gate 后通过
 * payload.channels 分发；scheduler 从 main 直接发桌面通知，因此 renderer 会把
 * `notifications.enabled` 的当前值轻量同步到 main。飞书仍只按调用方 channels 分发，
 * 且额外要求 ownerOpenId 存在（TOFU 绑定前不发，只 warn）。
 */

import { app, ipcMain, nativeImage, Notification, type BrowserWindow } from 'electron';
import type { FeishuIM } from '@cindy/im';
import * as path from 'node:path';

import { markSessionNeedsAttention } from './appBadgeService';
import { getMobileNotifyGeneration, sendMobileSessionNotify } from './device-link';
import { latestMessageText } from './localDb/latestMessageText';
import { drainPersistQueue } from './messagePersistBroadcaster';
import { createLogger } from './logger';

const log = createLogger('notificationService');
let desktopNotificationsEnabled = true;

/** Renderer owns persistence; main keeps the current value for scheduler-originated toasts. */
export function getDesktopNotificationsEnabled(): boolean {
  return desktopNotificationsEnabled;
}

// dev 下 electron.exe / Electron.app 自带的是默认图标，notification toast 没有
// AUMID/.icns 兜底会显示成空白或 Electron logo——给 toast 显式塞一张 PNG
// 让 dev 体验和 packaged 一致。packaged 模式不动：Win toast 顶图由 AUMID 关联
// 的 .exe 图标渲染，Mac 由 .app bundle 的 .icns 渲染，再塞 inline icon 反而
// 让单条 toast 同时出现两个图标，破坏既定视觉(见下方 buildBody 注释)。
const devNotificationIcon = !app.isPackaged
  ? (() => {
      const p = path.join(__dirname, '../../resources/icon.png');
      const img = nativeImage.createFromPath(p);
      return img.isEmpty() ? undefined : img;
    })()
  : undefined;

/**
 * kind:
 *   - 'done'        — agent 真完成了一轮，没有待回复事项
 *   - 'error'       — agent 本轮以报错结束
 *   - 'needs-reply' — agent 抛出 ask-user / permission / plan-review，等用户处理
 */
export type SessionEventKind = 'done' | 'error' | 'needs-reply';

const CLIENT_NOTIFICATION_NAME = 'Cindy';

interface ShowSessionEventPayload {
  sessionId: string;
  title: string;
  kind: SessionEventKind;
  /**
   * 渠道偏好。renderer 侧 gate 后填入,缺省时按"仅桌面"兼容,防御漏传——
   * 当前唯一 invoke 调用方 CCAgentSidebarUpper.tsx 总是显式传 channels,
   * 这层 default 仅为新增调用方留兜底。
   * mobile 通道没有桌面侧开关:是否收到由手机端自行注册/注销推送 token 决定,
   * 发送侧的防打扰(远程正在看该会话 / 短窗去重)在 device-link 模块内收口。
   */
  channels?: { desktop?: boolean; feishu?: boolean; mobile?: boolean };
}

/**
 * Toast 文案分两层：title 同时标识 Cindy 与任务，body 放结构化终态。
 * 不能只依赖 Windows AUMID / macOS bundle 元数据标识来源：不同系统和通知中心
 * 展示的 app 元数据并不一致，只显示任务名时容易被误认成同名插件主动发出的通知。
 */
function buildBody(kind: SessionEventKind): string {
  switch (kind) {
    case 'needs-reply':
      return '需要你回复';
    case 'error':
      return '执行失败';
    case 'done':
    default:
      return '已完成 ✓';
  }
}

/**
 * 外部通知通用文案 — 单行纯文本，保持极简并与桌面 toast 信息一致。
 * 标题 + 状态合并到一行，适用于飞书私聊和企微群消息列表。
 */
function buildExternalNotificationText(title: string, kind: SessionEventKind): string {
  const status = kind === 'needs-reply'
    ? '需要你回复'
    : kind === 'error'
      ? '执行失败'
      : '已完成 ✓';
  return `${CLIENT_NOTIFICATION_NAME} · 任务「${title}」${status}`;
}

// 防 GC：Electron Notification 实例如果不持引用，JS 引擎可能在 toast 还在显示
// 时就回收掉，导致 click handler 丢失甚至触发异常事件。用 Set 持引用，等
// close/click 后再 release。
const liveNotifications = new Set<Notification>();

/**
 * 把窗口拉到前台并广播 sessionId 给 renderer 路由跳转。
 *
 * Windows 防焦点劫持：非前台进程直接 `focus()` 会被系统拒绝，只让任务栏图标
 * 闪烁不抢前台。绕过办法：先 `setAlwaysOnTop(true)` 触发系统允许该窗口前置，
 * `show() + focus()` 之后立刻 `setAlwaysOnTop(false)` 回到正常 z-order，但
 * 焦点已经成功转移过来了。这是 Electron 社区在 Windows 上的稳定 hack。
 *
 * macOS 的 SetForegroundWindow 等价物是 `app.focus({ steal: true })`，但 Mac
 * 默认 `focus()` 行为已经够强，不需要多余处理；这里的 alwaysOnTop 在 Mac 上
 * 是无害 no-op（窗口本来就允许前置）。
 */
function focusWindow(getWindow: () => BrowserWindow | null, sessionId: string): void {
  const win = getWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.setAlwaysOnTop(false);
  if (sessionId) win.webContents.send('notification:focus-session', sessionId);
}

/**
 * 从 main 内其它模块发送与会话通知同语义的桌面 toast。
 * Scheduler 运行在 main，必须直接调用此入口；`webContents.send` 同名 IPC 只会
 * 发给 renderer，不会命中 main 的 `ipcMain.handle`。
 */
export function showDesktopSessionEvent(
  getWindow: () => BrowserWindow | null,
  payload: Pick<ShowSessionEventPayload, 'sessionId' | 'title' | 'kind'>,
): void {
  const { sessionId, title, kind } = payload;
  if (sessionId) markSessionNeedsAttention(sessionId);
  const safeTitle = title?.trim() || sessionId.slice(0, 8) || '任务';
  showDesktopToast(safeTitle, kind, () => focusWindow(getWindow, sessionId));
}

export interface NotificationServiceDeps {
  getWindow: () => BrowserWindow | null;
  /**
   * 飞书 IM 实例,用于飞书通道发消息。来源与 scheduler-host/notifier.ts 相同
   * (main/im 模块单例),保证 owner openId 与卡片回执等行为一致。
   */
  feishuIm: FeishuIM;
}

export function initNotificationService(deps: NotificationServiceDeps): void {
  const { getWindow, feishuIm } = deps;

  ipcMain.handle('notification:set-desktop-enabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('notification desktop enabled must be a boolean');
    }
    desktopNotificationsEnabled = enabled;
    return { ok: true as const };
  });

  ipcMain.handle(
    'notification:show-session-event',
    async (_event, payload: ShowSessionEventPayload): Promise<void> => {
      // renderer payload 不可信:mobile 通道会把 title/kind 送出本机(经 relay/APNs),
      // main 必须做运行时形状校验,TS 类型不算(electron-security 规则)。正文摘要
      // 不来自 renderer(main 侧读库),relay 有 per-user 频控、main 侧另有 5s
      // 去重与「被远程观看则不推」收口。
      assertValidSessionEventPayload(payload);
      const { sessionId, title, kind, channels } = payload;
      // 兜底：title 为空（极早期 session 还没生成标题）也别炸，用 sessionId 前 8 位顶上。
      const safeTitle = title?.trim() || sessionId.slice(0, 8);

      // channels 缺省/未传 → 默认仅桌面 (防御漏传,见 ShowSessionEventPayload 注释)。
      const wantDesktop = channels?.desktop ?? true;
      const wantFeishu = channels?.feishu === true;

      if (wantDesktop) {
        showDesktopSessionEvent(getWindow, { sessionId, title: safeTitle, kind });
      } else {
        // Dock/taskbar 角标独立于外发通道；即便只开飞书或两个通知开关都关闭，
        // session 进入终态后仍要在 Cindy 内标记为需要关注。
        markSessionNeedsAttention(sessionId);
      }

      if (channels?.mobile === true) {
        // fire-and-forget;离线 / 老 relay / 正被远程观看 / 短窗重复时静默跳过。
        // 整段放进独立 async 块不 await:persist 队列是全会话共享且无超时的,
        // 在这里同步等它会让别的会话的慢写入拖延本次飞书分支;半死 socket 的
        // ws.send 同步 throw 也一并落到 catch,不 reject 整个 invoke。
        // 代次在 await 之前捕获:等待期间发生登出/换号,发送侧按代次不一致丢弃,
        // 旧账号的会话标题不会经新账号的链路推出去。
        const generation = getMobileNotifyGeneration();
        void (async () => {
          // 体验优先(2026-07 产品决策):正文带该会话最近一条 assistant 内容,
          // 用户不打开 App 也能看到结果/提问。error 终态没有可靠的错误正文来源,
          // 回退终态短文案。先 drain 持久化队列:turn-done 时本轮 assistant 块
          // 可能仍在 writeChain 里,立刻读库会拿到上一轮文本(与摘要生成同口径)。
          const detail =
            kind === 'error'
              ? undefined
              : await drainPersistQueue()
                  .then(() => latestMessageText(sessionId, 'assistant'))
                  .catch(() => '');
          sendMobileSessionNotify({
            sessionId,
            title: safeTitle,
            kind,
            generation,
            ...(detail ? { detail } : {}),
          });
        })().catch((err) => {
          log.warn('[notification] mobile push failed (non-fatal)', err);
        });
      }

      if (wantFeishu) {
        await sendFeishuMessage(feishuIm, safeTitle, kind);
      }
    },
  );
}

const SESSION_EVENT_KINDS: ReadonlySet<string> = new Set(['done', 'error', 'needs-reply']);
const SESSION_ID_MAX_LENGTH = 256;
const SESSION_TITLE_MAX_LENGTH = 1024;

/** show-session-event 的运行时校验:非法直接抛(invoke reject),不进任何通知通道。 */
function assertValidSessionEventPayload(
  payload: unknown,
): asserts payload is ShowSessionEventPayload {
  const p = payload as Partial<ShowSessionEventPayload> | null;
  if (
    !p ||
    typeof p !== 'object' ||
    typeof p.sessionId !== 'string' ||
    p.sessionId.length === 0 ||
    p.sessionId.length > SESSION_ID_MAX_LENGTH ||
    typeof p.title !== 'string' ||
    p.title.length > SESSION_TITLE_MAX_LENGTH ||
    typeof p.kind !== 'string' ||
    !SESSION_EVENT_KINDS.has(p.kind) ||
    (p.channels !== undefined && (typeof p.channels !== 'object' || p.channels === null))
  ) {
    throw new TypeError('invalid session event payload');
  }
}

/** 桌面 toast 分支 — 原实现保持不变,只是拆出来便于 channels 选择性执行。 */
function showDesktopToast(safeTitle: string, kind: SessionEventKind, onClick: () => void): void {
  const body = buildBody(kind);

  // Electron Notification 在某些 Linux 桌面环境下可能不可用——静默兜底。
  if (!Notification.isSupported()) {
    log.warn('[notification] Notification.isSupported() === false, skip');
    return;
  }

  const notif = new Notification({
    title: `${CLIENT_NOTIFICATION_NAME} · ${safeTitle}`,
    body,
    // silent 默认 false——发声音，与 Electron 默认一致。
    // icon 仅在 dev 下传值；packaged 时为 undefined，回到原行为(由 AUMID/.icns 兜底)。
    ...(devNotificationIcon ? { icon: devNotificationIcon } : {}),
  });
  liveNotifications.add(notif);

  const release = () => {
    liveNotifications.delete(notif);
  };

  notif.on('click', onClick);
  notif.on('close', release);
  notif.on('failed', (_e, error) => {
    // 通知发不出去时主动留痕，方便定位 AUMID / 系统通知开关 / Focus Assist 类问题。
    log.warn('[notification] failed to show:', error);
    release();
  });
  notif.show();
}

/**
 * 飞书私聊分支 — 给当前 bot owner 发一条 markdown 文本。
 *
 * ownerOpenId 由 ownerGuard 在用户首次私聊 bot 时 TOFU 记录;未绑定就跳过 + warn
 * (设置里开了开关但还没绑 bot 的边界状态)。整体不能 throw — 通知失败不能影响
 * 桌面通道的展示和上层调用方。
 */
async function sendFeishuMessage(
  feishuIm: FeishuIM,
  safeTitle: string,
  kind: SessionEventKind,
): Promise<void> {
  const ownerOpenId = feishuIm.getOwnerOpenId();
  if (!ownerOpenId) {
    log.warn('[notification] feishu skipped: no bot owner bound (user must DM the bot once)');
    return;
  }
  try {
    await feishuIm.sendMarkdownText(ownerOpenId, buildExternalNotificationText(safeTitle, kind));
  } catch (err) {
    // 飞书 SDK 包了一层 axios; 400 等业务错误的真正 message 在 response.data 里,
    // 显式拆出来 log。与 scheduler-host/notifier.ts 的 catch 写法对齐。
    const r = (err as { response?: { data?: unknown; status?: number } }).response;
    log.warn(
      `[notification] feishu sendMarkdownText failed status=${r?.status ?? 'n/a'} body=${JSON.stringify(r?.data ?? null)} target=...${ownerOpenId.slice(-8)}`,
    );
  }
}
