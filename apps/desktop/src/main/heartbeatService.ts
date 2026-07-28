/**
 * heartbeatService.ts — Desktop main 进程的心跳 host 适配层。
 *
 * 职责:
 *  - 从运行期端点清单读 endpoint(getClientEndpoint('heartbeatUrl'))
 *  - 把 @cindy/heartbeat-client 按 app-mode 接入 authManager:
 *      · 仅已验证的 cloud 会话(mode === 'cloud' 且 isAuthenticated 且有 user)才启动
 *        云端心跳;signed-out / local 模式不与云端联络(account-free 本地模式的
 *        隐私语义:本地模式不得向云端上报在线状态)
 *      · cloud 归属人变更时重启心跳(uid 换人),离开 cloud 时停止
 *  - TapDB 日活节拍独立于云端心跳:任何模式下都按本地日期变更向 renderer 广播
 *    tapdb:daily-active(纯进程内通知,不产生云端请求)
 *  - App 退出时显式停心跳、停日活循环并退订 auth,确保不留 dangling timer
 *
 * 设计原则:
 *  - 跟主 server / IM / scheduler 一样,纯 host 层,不写任何业务逻辑
 *  - 任何异常都被 @cindy/heartbeat-client 内部静默吃掉,不会抛到 init
 *  - 即便 heartbeat-server 完全挂了,这里也不会影响 App 启动或任何业务
 */

import { app, BrowserWindow } from 'electron';
import { createHeartbeatClient, type HeartbeatHandle } from '@cindy/heartbeat-client';
import * as authManager from './authManager';
import { createLogger } from './logger';
import { onQuit } from './lifecycle';
import { getClientEndpoint } from './clientEndpointsService';
import { outboundFetch } from './maker-host/outbound-fetch';

const log = createLogger('heartbeat');

const DEFAULT_INTERVAL_MS = 60_000;
const TAPDB_DAILY_ACTIVE_CHANNEL = 'tapdb:daily-active';

type AuthStateSnapshot = ReturnType<typeof authManager.getAuthState>;

let handle: HeartbeatHandle | null = null;
let handleUid: string | null = null;
let tapdbTimer: NodeJS.Timeout | null = null;
let unsubscribeAuth: (() => void) | null = null;
let lastTapdbActiveDate = getLocalDateKey();

/** 已验证 cloud 会话返回其 user.id,其余模式一律 null(= 不上报云端心跳)。 */
function verifiedCloudUserId(state: AuthStateSnapshot): string | null {
  return state.mode === 'cloud' && state.isAuthenticated && state.user ? state.user.id : null;
}

function startCloudHeartbeat(uid: string): void {
  // 运行期端点清单(initClientEndpoints 在 app.ready 内早于本服务,清单全权无兜底)
  const endpoint = getClientEndpoint('heartbeatUrl');
  handleUid = uid;
  handle = createHeartbeatClient({
    endpoint,
    intervalMs: DEFAULT_INTERVAL_MS,
    // 走吃系统代理的通道:代理网络下裸 undici 直连会让心跳恒失败(静默 warn)。
    fetchImpl: outboundFetch,
    host: {
      // 每次 tick 读活的 auth 状态:离开 cloud 后旧 handle 立刻拿不到 uid
      // (client 对 null 跳过本次上报),不依赖 stop 的时序竞争。
      getUid: () => verifiedCloudUserId(authManager.getAuthState()),
      getPlatform: () => process.platform,
      getVersion: () => app.getVersion(),
      // 用主进程统一 logger,失败走 warn (与 client 契约一致)
      logger: {
        debug: (...args) => log.debug(...args),
        warn: (...args) => log.warn(...args),
      },
    },
  });
  log.info(`heartbeat client started → ${endpoint} (interval=${DEFAULT_INTERVAL_MS}ms, uid=${uid})`);
}

function stopCloudHeartbeat(): void {
  handle?.stop();
  handle = null;
  handleUid = null;
}

function applyAuthState(state: AuthStateSnapshot): void {
  const uid = verifiedCloudUserId(state);
  if (!uid) {
    if (handle) {
      stopCloudHeartbeat();
      log.info('heartbeat client stopped (left verified cloud session)');
    }
    return;
  }
  if (handle && handleUid === uid) return;
  if (handle) stopCloudHeartbeat();
  startCloudHeartbeat(uid);
}

export function initHeartbeatService(): void {
  if (handle || tapdbTimer || unsubscribeAuth) {
    log.warn('initHeartbeatService called twice, ignoring');
    return;
  }

  // TapDB 日活循环独立于云端心跳:signed-out / local 模式也要有本地日活节拍。
  tapdbTimer = setInterval(() => {
    emitTapdbDailyActiveIfNeeded();
  }, DEFAULT_INTERVAL_MS);

  unsubscribeAuth = authManager.onAuthStateChange((state) => {
    applyAuthState(state);
  });
  applyAuthState(authManager.getAuthState());

  // App quit 时显式停掉,虽然进程退出 timer 自然消亡,但保留一个干净的 shutdown 路径
  onQuit('heartbeat', () => {
    stopCloudHeartbeat();
    if (tapdbTimer) {
      clearInterval(tapdbTimer);
      tapdbTimer = null;
    }
    unsubscribeAuth?.();
    unsubscribeAuth = null;
  });
}

function emitTapdbDailyActiveIfNeeded(): void {
  const today = getLocalDateKey();
  if (lastTapdbActiveDate === today) return;

  lastTapdbActiveDate = today;
  broadcastToRenderers(TAPDB_DAILY_ACTIVE_CHANNEL, { date: today });
  log.info(`tapdb daily active tick ${today}`);
}

function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log.warn(`broadcast '${channel}' to window failed (non-fatal)`, err);
    }
  }
}

function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
