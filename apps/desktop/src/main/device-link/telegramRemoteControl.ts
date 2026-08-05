/**
 * telegramRemoteControl.ts — 被控端处理个人 Telegram bot 的跨设备上下线
 * (device-link:telegram:status / device-link:telegram:set-online)。
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 是 BYO token 直连 Bot API 的 getUpdates 长轮询: 同一 token
 * 同时只有一台设备能收消息(Telegram 侧 409 Conflict), 而两台设备之间没有任何
 * 通信通道。换机器时想让另一端让位, 原本只能人肉去那台机器操作 —— 本模块就是
 * 补这个缺口: 控制端点一下, 被控端自己 goOffline()。
 *
 * 为什么不复用 telegramBot:set-online 那条 ipcMain 通道: IM 的所有 IPC 在
 * im/host.ts 的 host.ipc.handle 里统一包了 assertTrustedAppRendererEvent, 只认
 * Electron 持有的真实 sender; 而 dispatchLocalInvoke 传的是合成 event
 * (sender: undefined), 必然判定不可信。那道闸是有意拦着 IM 凭证/配置面的, 不该
 * 为远程下线放宽, 所以这里与 media:fetch / voice:* 同款 —— 不是 ipcMain handler,
 * 由 dispatch 在通用路由前拦截执行。
 *
 * 安全: 仅由 dispatch.executeInvoke 在三道 gate(remoteControlEnabled + 未撤销 +
 * allowlist)之后调用, 调用方已是「同账号 + 显式 opt-in 被控 + 未撤销」的控制端。
 * 边界刻意收窄:
 *   - **不碰凭证**: token / owner id 不读、不写、不外传; 解绑(清凭证)仍然只能
 *     本机操作 —— 远程能做的只有"让它别收消息", 不能让它失去绑定。
 *   - 状态投影只回 kind + appId(bot 数字 id)。控制端拿 appId 与本机一比即可判断
 *     "远端占的是不是同一个 bot"(不同 bot 根本不冲突, 没必要让它下线), 这就够了;
 *     ownerUserId 是 Telegram 用户 id、botUsername 是 bot 身份, 都没有理由过网线。
 */

import type { IMErrorCode, IMStatus } from '@cindy/im';

import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const log = createLogger('device-link:telegram');

/**
 * 本模块需要的 telegram transport 能力(结构类型, 由 bootstrap 注入 telegramIm)。
 */
export interface TelegramRemoteSource {
  getStatus(): IMStatus;
  goOffline(): Promise<void>;
  goOnline(): Promise<boolean>;
}

let source: TelegramRemoteSource | null = null;

/**
 * 由 bootstrap 在 IM 接线期注入 —— **刻意不静态 import im/host**:
 *   1. 架构不变式禁止 main 进程运行时动态 import(), 依赖只能顶层静态引入或注入,
 *      而这里必须选注入;
 *   2. 直接静态 import 会把整个 IM host 拽进 device-link 的依赖链, 而 host.ts
 *      模块顶层就调 app.getPath / ipcMain.handle —— dispatch 的单测在收集期会
 *      直接炸(host.ts 顶部记着同款教训: 2026-07-30 device-link
 *      TEST_COLLECT_FAILED)。
 * 未注入时两个入口都按"未配置"处理, 不抛错: 远程控制不该因为本机没装 IM 子系统
 * 而报一个控制端看不懂的异常。
 */
export function setTelegramRemoteSource(next: TelegramRemoteSource | null): void {
  source = next;
}

/** 过网线的最小状态投影(无凭证、无 owner id、无 bot 身份)。 */
export interface TelegramRemoteStatus {
  /** 与 @cindy/im 的 IMStatus.kind 同集合。 */
  kind: 'idle' | 'connecting' | 'connected' | 'conflict' | 'offline' | 'error';
  /** bot 数字 id;未绑定/未解析出时 null。控制端据此判断是否同一个 bot。 */
  appId: string | null;
  /** 仅 kind='error' 时可能非空 —— 原文只作诊断, 控制端展示走 code。 */
  reason: string | null;
  /** 稳定错误分类;控制端按它取本地化文案, 不直接显示 reason。 */
  code: IMErrorCode | null;
}

const NOT_CONFIGURED: TelegramRemoteStatus = { kind: 'idle', appId: null, reason: null, code: null };

/** 把 IMStatus 收敛成过网线的投影(多余字段一律不带)。 */
function projectStatus(): TelegramRemoteStatus {
  if (!source) return { ...NOT_CONFIGURED };
  const status = source.getStatus();
  return {
    kind: status.kind,
    appId: 'appId' in status ? status.appId : null,
    reason: status.kind === 'error' ? status.reason : null,
    code: status.kind === 'error' ? (status.code ?? null) : null,
  };
}

/** device-link:telegram:status —— 只读快照。 */
export function readTelegramRemoteStatus(): TelegramRemoteStatus {
  return projectStatus();
}

/**
 * device-link:telegram:set-online —— 让被控端下线。除本地开关的 `online:false`
 * 外还必须带探测快照的 `expectedAppId`，供目标端在副作用前复核身份。
 *
 * 为什么在这里硬拒绝 `online:true`：`deviceLink.invoke` 是通用入口，控制端可以
 * 自行构造参数 —— 控制端 UI 只发 `false` 是产品选择，不是权限约束。放开上线等于
 * 让任一有控制权的设备**撤销目标机用户主动选择的下线状态**，把它重新拽回 409
 * 争抢。远程能做的只有「让它别收消息」，上线是目标机本人的决定，只能本地操作。
 */
export async function setTelegramRemoteOnline(arg: unknown): Promise<TelegramRemoteStatus> {
  // 形状先严格校验再谈语义: 缺字段 / null / 数组 / 字符串 / 字段类型不符
  // 一律报错, 不做"猜意图"的宽松解析。这是跨设备入口, 把畸形 payload 默默当成
  // 下线会让控制端的字段名笔误变成一次静默的真实副作用 —— 用户莫名其妙被下线,
  // 而调用方永远发现不了自己发错了。
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    throwIpcError(
      'INVALID_PARAMS',
      'expected an object payload { online: boolean, expectedAppId: string }',
    );
  }
  const record = arg as Record<string, unknown>;
  const online = record.online;
  if (typeof online !== 'boolean') {
    throwIpcError('INVALID_PARAMS', '"online" must be a boolean');
  }
  const expectedAppId = record.expectedAppId;
  if (typeof expectedAppId !== 'string' || !expectedAppId) {
    throwIpcError('INVALID_PARAMS', '"expectedAppId" must be a non-empty string');
  }
  if (online) {
    log.warn('remote set-online(true) rejected: bringing a device online is local-only');
    throwIpcError('PERMISSION_DENIED', 'bringing a device online remotely is not allowed');
  }

  // 探测快照只决定按钮是否展示，不能授权稍后的副作用。解绑/换绑可能发生在
  // probe 与 click 之间；这里在调用 goOffline 前重新取当前身份并精确比对。
  // 比对与 goOffline 调用之间没有 await，避免新开一个 TOCTOU 窗口。
  const activeSource = source;
  const current = projectStatus();
  if (!activeSource || current.appId !== expectedAppId) {
    throwIpcError('PRECONDITION_FAILED', 'Telegram bot changed since the status probe');
  }
  await activeSource.goOffline();
  const projected = projectStatus();
  log.info(`remote set-online(false) -> ${projected.kind}`);
  return projected;
}
