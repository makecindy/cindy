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
 *  - App 退出时显式停心跳并退订 auth,确保不留 dangling timer
 *
 * 本服务曾经还承担 TapDB 的跨天日活节拍(60s 检查本地日期,0 点广播
 * tapdb:daily-active 让 renderer 续报)。该机制把所有过夜挂机设备的活跃事件压在
 * 00:00-00:01,在 TapDB 小时趋势上制造 0 点尖峰,且把「进程活着」误报成「用户
 * 活跃」。2026-07-28 起活跃改为 renderer 侧交互驱动(见
 * renderer/analytics/tapdbClient.ts 的「活跃口径」),此处不再有任何 TapDB 逻辑。
 *
 * 设计原则:
 *  - 跟主 server / IM / scheduler 一样,纯 host 层,不写任何业务逻辑
 *  - 任何异常都被 @cindy/heartbeat-client 内部静默吃掉,不会抛到 init
 *  - 即便 heartbeat-server 完全挂了,这里也不会影响 App 启动或任何业务
 */

import { app } from 'electron';
import { createHeartbeatClient, type HeartbeatHandle } from '@cindy/heartbeat-client';
import * as authManager from './authManager';
import { createLogger } from './logger';
import { onQuit } from './lifecycle';
import { getClientEndpoint } from './clientEndpointsService';
import { outboundFetch } from './maker-host/outbound-fetch';

const log = createLogger('heartbeat');

const DEFAULT_INTERVAL_MS = 60_000;

type AuthStateSnapshot = ReturnType<typeof authManager.getAuthState>;

let handle: HeartbeatHandle | null = null;
let handleUid: string | null = null;
let handleRealm: ReturnType<typeof authManager.getActiveAuthRealm> | null = null;
let unsubscribeAuth: (() => void) | null = null;

/** 已验证 cloud 会话返回其 user.id,其余模式一律 null(= 不上报云端心跳)。 */
function verifiedCloudUserId(state: AuthStateSnapshot): string | null {
  return state.mode === 'cloud' && state.isAuthenticated && state.user ? state.user.id : null;
}

function startCloudHeartbeat(uid: string): void {
  // 运行期端点清单(initClientEndpoints 在 app.ready 内早于本服务,清单全权无兜底)
  const endpoint = getClientEndpoint('heartbeatUrl');
  handleUid = uid;
  handleRealm = authManager.getActiveAuthRealm();
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
  log.info(
    `heartbeat client started → ${endpoint} (interval=${DEFAULT_INTERVAL_MS}ms, uid=${uid})`,
  );
}

function stopCloudHeartbeat(): void {
  handle?.stop();
  handle = null;
  handleUid = null;
  handleRealm = null;
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
  const realm = authManager.getActiveAuthRealm();
  if (handle && handleUid === uid && handleRealm === realm) return;
  if (handle) stopCloudHeartbeat();
  startCloudHeartbeat(uid);
}

export function initHeartbeatService(): void {
  if (handle || unsubscribeAuth) {
    log.warn('initHeartbeatService called twice, ignoring');
    return;
  }

  unsubscribeAuth = authManager.onAuthStateChange((state) => {
    applyAuthState(state);
  });
  applyAuthState(authManager.getAuthState());

  // App quit 时显式停掉,保留一个干净的 shutdown 路径
  onQuit('heartbeat', () => {
    stopCloudHeartbeat();
    unsubscribeAuth?.();
    unsubscribeAuth = null;
  });
}
