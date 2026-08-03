/**
 * device-link host —— 跨设备远程控制的 main 进程接线层。
 *
 * 职责(对齐 heartbeatService 的纯 host 风格):
 *  - 把 @cindy/device-link 的 DeviceLinkClient 接入 authManager / ws / 系统信息
 *  - 登录后自动连 relay,登出即断;token 取现值,过期由 getToken 内部 refresh
 *  - presence / 连接状态变化广播给 renderer(设置页实时刷新)
 *  - 「允许被控」开关的读写入口(落盘 + 实时 presence-set)
 *  - 被控端:接线入站隧道 dispatch(link-open / invoke / push 转发)
 *  - 控制端:remoteInvoke / openLink / closeLink + push 帧 re-broadcast 给 renderer
 */

import os from 'node:os';
import { app, BrowserWindow } from 'electron';
import WebSocket from 'ws';
import {
  DeviceLinkClient,
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  DL_CONTACTS_SYNC_CHANNEL,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  type DeviceLinkConnectionIssue,
  type DeviceLinkStatus,
  type DeviceInfo,
  type HelloPayload,
  type PresenceSnapshot,
  type InvokeResultPayload,
  type LinkAcceptPayload,
  type LinkClosePayload,
  type Envelope,
  type PushPayload,
  INVOKE_TIMEOUT_OVERRIDES_MS,
} from '@cindy/device-link';
import * as authManager from '../authManager';
import { createLogger } from '../logger';
import { onQuit } from '../lifecycle';
import { tryGetDbClient } from '../localDb/client/current';
import { createOutboundHttpAgent } from '../maker-host/outbound-fetch';
import {
  DeviceLinkOwnershipArbiter,
  createDbClientOwnershipStore,
  type OwnershipStore,
} from './ownership';
import { DEVICE_LINK_PUSH } from '../../shared/deviceLinkIpc';
import {
  createTransportTimeoutReopenLoop,
  routeLinkCloseForReopen,
  shouldAbortTransportTimeoutReopen,
} from './transportTimeoutReopen';
import {
  readDeviceLinkSettings,
  rememberLastKnownDeviceName,
  updateDeviceLinkSetting,
  writeDeviceLinkSetting,
} from './settings-store';
import { keepAwakeController } from './power-blocker';
import { createDnsFallbackLookup } from './dnsFallbackLookup';
import {
  wireInboundDispatch,
  setControllersChangedListener,
  setRemoteInvokeBusyChangedListener,
  dropAllControllers,
  flushRemoteInvokeResultOutboxOnReconnect,
  forgetControllerInvokeState,
  handleControllerOffline,
  purgeRevokedController,
} from './dispatch';
import { setBusyProbe, helloBusy, pollBusyChange, resetBusyDedupe } from './busyReporter';
import {
  DL_VOICE_DICTIONARY_SYNC_CHANNEL,
  broadcastDictionaryNow,
  handleDesktopPeerOnline,
  handleIncomingDictionaryState,
  initVoiceDictionarySync,
  notifyLocalDictionaryChanged,
  shouldExchangeDictionaryWith,
} from '../voice-input/dictionarySyncDriver';
import { onVoiceInputDictionaryChanged } from '../voice-input/VoiceInputDataStore';
import { resetAll as resetSubscriptionRefs, snapshotSubscriptions } from './subscriptionRefcount';
import { getControllersForTopic } from './subscriptions';
import {
  MobileNotifyDeduper,
  buildSessionNotifyPayload,
  type MobileSessionEventKind,
} from './mobileNotify';
import { getClientEndpoint } from '../clientEndpointsService';
import {
  handleContactsDeviceLinkStatusChanged,
  handleContactsPeerPresenceChanged,
  handleIncomingContactsRelayFrame,
  initContactsDeviceSync,
  pollContactsDeviceSyncCrossProcessState,
  pollContactsDeviceSyncDataChange,
  pollContactsDeviceSyncSettingChange,
  setContactsDeviceLinkOwnerActive,
} from '../contacts-sync/driver';
import {
  invokeWithClosedLinkRecovery,
  requiresSessionLink,
} from './linkRecovery';
import {
  createResponsivenessTracker,
  type DeviceResponsivenessTracker,
} from './responsivenessTracker';

// register.ts 从 device-link/index 导入 setBusyProbe;改用 busyReporter 后在此 re-export 保持其导入不变。
export { setBusyProbe };

const log = createLogger('device-link');
// relay 建连专用的 DNS 回退(成功缓存 / 失败与慢解析回退最近成功地址)。
const relayDnsLookup = createDnsFallbackLookup({ log });

// device-link 独立部署后的 relay 地址:走运行期端点清单(烘焙值已含 dev fallback
// localhost:3335)。惰性函数而非模块级常量——远程清单在 app.ready 内解析。
// 注意:不回退到 apiBaseUrl —— device-link 已从主 server 摘除,主 server 没有这组端点。
const WS_PATH = '/api/device-link/ws';

/** relay REST base(media presign / devices 等);供 mediaTransfer / ipc 复用。 */
export function deviceLinkApiBase(): string {
  return getClientEndpoint('deviceLinkApiBaseUrl');
}

let client: DeviceLinkClient | null = null;

/**
 * transport-timeout 重开循环(控制端):被控端瞬时重置后 relay/presence 都不会
 * 再来事件,一次 openRemoteLink 失败就放弃会让在途回包与实时订阅长期挂起。
 * 退避重试 + per-device 去重,终止于:成功 / 撤权 / 待命态 / relay 离线(断线后
 * 由 presence 闪断路径接管恢复) / 次数耗尽(用户下次打开远程视图惰性重建)。
 */
const transportTimeoutReopen = createTransportTimeoutReopenLoop({
  reopen: (deviceId) => openRemoteLink(deviceId),
  // 授权边界见 shouldAbortTransportTimeoutReopen 注释:刻意**不看**
  // revokedControllers——那是「对方不再允许控制本机」,与本机主动控制对方
  // 无关;互控且仅反向撤权时重建必须照常。目标侧撤销本机控制权由入站
  // link-close('revoked') 经 routeLinkCloseForReopen 的永久关闭分支终止循环。
  shouldAbort: (deviceId) => shouldAbortTransportTimeoutReopen({
    clientOnline: client !== null && client.getStatus() === 'online',
    isOwner: arbiter === null || arbiter.isOwner(),
    // 与 openRemoteLink 的 fail-closed 门同源(#1408):本机已对该设备关闭控制
    // 时不重建,避免把被禁用的链路反复拉起又失败空转。
    controlDisabledLocally: readDeviceLinkSettings().disabledControlDeviceIds.includes(deviceId),
  }),
  log: {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
  },
});
let arbiter: DeviceLinkOwnershipArbiter | null = null;
let observedAuthRealm: ReturnType<typeof authManager.getActiveAuthRealm> | null = null;
let authRealmReconnectGeneration = 0;
let unsubscribeAuthState: (() => void) | null = null;
/** ownership store 按 DbClient 实例缓存(避免每 tick 建对象);换库(换账号)自动重建 */
let ownershipStoreCache: { db: unknown; store: OwnershipStore } | null = null;
/**
 * 持有者已生效的授权快照(允许被控开关 + 撤销名单)。用于检测**其它实例**改写共享
 * settings 文件(被动实例的设置页也能改授权,见 settings-store 多实例语义):持有者
 * 每 5s 对比快照,变化则补发 presence / 踢断新撤销的控制端。非持有者恒为 null。
 */
let appliedSettingsSnapshot: {
  remoteControlEnabled: boolean;
  revokedControllers: string[];
} | null = null;
/**
 * 「保持电脑唤醒」已应用基线。与被控授权不同:keepAwake 是**每个进程各自持有**一个
 * blocker、与 relay 持有权无关,故所有实例(含被动实例)都要跟随共享 settings 的改写
 * —— 否则在 A 实例关掉开关后,B 实例仍持有 blocker,机器不休眠而 UI 显示已关。
 * 初始化时设为盘上初值,本实例自己改写时即时更新,轮询检测外部实例的改写。
 */
let appliedKeepAwake: boolean | null = null;
/** 退出路径的持有权 DELETE 完成信号:sync 阶段发起,async 阶段 disposer await(见 onQuit 注释) */
let pendingQuitOwnershipRelease: Promise<void> | null = null;
const openLinkInFlight = new Map<string, Promise<LinkAcceptPayload>>();
const presenceAvailableByDevice = new Map<string, boolean>();
/**
 * 「目标设备无响应」熔断(弱网 / 对端卡死时收敛请求风暴,见 responsivenessTracker)。
 * 随 initDeviceLinkService 创建;null(极早期)时门禁直通,不影响行为。
 */
let responsivenessTracker: DeviceResponsivenessTracker | null = null;
/** 熔断探测的周期 tick(单飞探测由 tracker 内部的退避窗口控制,这里只是驱动时钟)。 */
let responsivenessProbeTimer: ReturnType<typeof setInterval> | null = null;
const RESPONSIVENESS_PROBE_TICK_MS = 5_000;
/**
 * 词典同步的对端选择只看「在线 + 是桌面」,不看 remoteControlEnabled ——
 * push 帧不属于 relay 的控制类帧,自己设备之间同步词典不该要求对方开放被控。
 */
const presenceOnlineByDevice = new Map<string, boolean>();
const presencePlatformByDevice = new Map<string, string>();
const presenceNameByDevice = new Map<string, string>();
let unsubscribeDictionaryChanged: (() => void) | null = null;

/**
 * 用户撤销过访问权限的设备,同样不参与词典同步 —— 撤销的意图是「不再跟这台设备
 * 交换数据」,不只是「不许它操作我」。
 */
function isDeviceRevoked(deviceId: string): boolean {
  return readDeviceLinkSettings().revokedControllers.includes(deviceId);
}

/**
 * relay 连续报 auth-failed 时,两次主动 refresh 之间的最小间隔。
 * refresh 是 token-rotating 端点,不节流会在「refresh 成功但 relay 仍拒」的
 * 异常态下每 30s 轮换一次 token(重连退避上限),白烧凭证。
 */
const RELAY_AUTH_RECOVERY_MIN_INTERVAL_MS = 60_000;
let lastRelayAuthRecoveryAt = 0;
/**
 * 节流窗内又来了 auth-failed 时补排的延迟自救 timer。
 * client 的 setConnectionIssue 对同类 issue 去重、不重复通知订阅者——节流窗内
 * 直接 return 而不补排的话,窗口过后再没有任何入口重新进入自救,退回无限 401。
 */
let relayAuthRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * relay 明确拒绝鉴权(401 / TOKEN_EXPIRED)时的自救:getToken 在内存 access token
 * 未清时不会触发 refresh,会一直拿过期 token 重连死循环(日志里刷 401 而用户无感知)。
 * 这里主动 refresh 一次:成功则下一轮重连拿到新 token 自愈;确定性失效则由
 * refresh 路径自己走会话过期出口(清会话 + 弹重登),auth 监听随后会停掉本服务。
 */
function recoverFromRelayAuthFailure(): void {
  const now = Date.now();
  const elapsed = now - lastRelayAuthRecoveryAt;
  if (elapsed < RELAY_AUTH_RECOVERY_MIN_INTERVAL_MS) {
    // 节流窗内:补排剩余窗口后的延迟自救(只留一个 timer),否则同类 issue 去重
    // 会让自救在首次尝试后永久停摆。
    if (relayAuthRecoveryRetryTimer === null) {
      relayAuthRecoveryRetryTimer = setTimeout(() => {
        relayAuthRecoveryRetryTimer = null;
        // 延迟期间可能已自愈(issue 清除),避免一次多余的 token 轮换。
        if (client?.getConnectionIssue()?.kind !== 'auth-failed') return;
        recoverFromRelayAuthFailure();
      }, RELAY_AUTH_RECOVERY_MIN_INTERVAL_MS - elapsed);
      relayAuthRecoveryRetryTimer.unref?.();
    }
    return;
  }
  lastRelayAuthRecoveryAt = now;
  void authManager
    .refresh()
    .then((ok) => {
      // refresh 在途期间持有权可能已被另一个共享 userData 实例夺走
      // (onDemote → teardownActiveLink 已停掉 client):此时 connectNow 会把
      // 已停的 client 拉活、绕过仲裁重连,重新制造双连接 / last-wins 互踢。
      // 重连前重新确认本实例仍是持有者。
      if (ok && arbiter?.isOwner()) client?.connectNow('relay-auth-recovered');
    })
    .catch((err) => {
      log.warn('relay auth recovery refresh threw (non-fatal)', err);
    });
}

/** Windows 历史主机名可能带尾部空白/全大写,统一 trim;空值兜底 'Unknown Device' */
function deviceName(): string {
  const name = os.hostname().trim();
  return name || 'Unknown Device';
}

function buildDeviceInfo(): DeviceInfo {
  const info: DeviceInfo = {};
  const cpuLabel = normalizeDeviceInfoText(os.cpus()[0]?.model);
  if (cpuLabel) info.cpuLabel = cpuLabel;

  const memoryGb = Math.round(os.totalmem() / 1024 ** 3);
  if (Number.isFinite(memoryGb) && memoryGb > 0) info.memoryGb = memoryGb;

  const osVersion = normalizeDeviceInfoText(systemVersion());
  if (osVersion) info.osVersion = osVersion;

  return info;
}

function systemVersion(): string {
  const electronProcess = process as NodeJS.Process & { getSystemVersion?: () => string };
  return electronProcess.getSystemVersion?.() || os.release();
}

function normalizeDeviceInfoText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 128 ? trimmed.slice(0, 128) : trimmed;
}

function wsUrl(): string {
  // WS URL 由 relay HTTP base 推(http→ws / https→wss)
  return deviceLinkApiBase().replace(/^http/, 'ws') + WS_PATH;
}

/** Host integrations that consume device-link lifecycle state. */
export interface DeviceLinkServiceOptions {
  onUpdateRelaunchBusyChanged?: (busy: boolean) => void;
}

export function initDeviceLinkService(options: DeviceLinkServiceOptions = {}): void {
  // 「保持电脑唤醒」按持久化偏好在启动时应用(与登录 / relay 无关,幂等)。
  const initialKeepAwake = readDeviceLinkSettings().keepAwake;
  keepAwakeController.apply(initialKeepAwake);
  appliedKeepAwake = initialKeepAwake;

  if (client) {
    log.warn('initDeviceLinkService called twice, ignoring');
    return;
  }

  client = new DeviceLinkClient({
    getWsUrl: wsUrl,
    getToken: async () => {
      const token = authManager.getAccessToken();
      if (token) return token;
      // 无现值(冷启动竞态/过期被清):尝试 refresh 一次,失败则跳过本轮重连
      const ok = await authManager.refresh().catch(() => false);
      return ok ? authManager.getAccessToken() : null;
    },
    getHello: (): HelloPayload => ({
      deviceName: deviceName(),
      platform: process.platform,
      appVersion: app.getVersion(),
      remoteControlEnabled: readDeviceLinkSettings().remoteControlEnabled,
      deviceInfo: buildDeviceInfo(),
      // 报**当前**真实 busy(而非硬编码 false),并同步 dedupe 基线:重连可能发生在 turn 进行中,
      // 硬编码 false 会把 server presence 覆盖成空闲、且轮询 dedupe 压掉补正(New-F)。见 busyReporter。
      busy: helloBusy(),
    }),
    // agent:`ws` 不吃系统代理,relay 在代理网络下会连不上;直连时为 undefined,
    // 行为与不传一致(见 maker-host/outbound-fetch)。
    // lookup:DNS 失败/慢解析时回退最近成功地址(弱网 VPN 下 DNS 单段可吃掉
    // 大半个握手窗口);代理模式下由代理解析域名,本层自然旁路。
    createWebSocket: async (url, headers) =>
      new WebSocket(url, {
        headers,
        agent: await createOutboundHttpAgent(url),
        // ClientOptions 类型未声明 lookup,但 ws 会把额外选项透传给
        // http.request(其 RequestOptions 原生支持 lookup)→ net/tls 建连。
        lookup: relayDnsLookup,
      } as WebSocket.ClientOptions),
    logger: {
      debug: (...args) => log.debug(...args),
      info: (...args) => log.info(...args),
      warn: (...args) => log.warn(...args),
      error: (...args) => log.error(...args),
    },
    // 弱网收紧:默认 20s ping × (2+1) tick 要 ~60s 才判死半开连接,期间所有请求黑洞。
    // 15s ping 把判死缩到 ~45s;不动 pongMissLimit——高延迟链路(实测响应性可达 ~10s)
    // 下更激进的宽限会把「慢但活着」误判成死链,造成重连循环(mobile 用 10s×1 是因为
    // 手机端 TCP 半开假活远比桌面常见,桌面不照搬)。
    timing: { pingIntervalMs: 15_000 },
  });

  responsivenessTracker = createResponsivenessTracker({
    // 探测直接走 client.invoke(guardInvoke 已在 tracker 内持有探测席位,不能再套
    // remoteInvoke 的外层门禁,否则自旋)。sessions:list 属 UNLINKED legacy 通道,无需 link。
    probeInvoke: (deviceId, channel, args) => {
      if (!client) throw new Error('[DEVICE_LINK_NOT_CONNECTED] device-link client not initialized');
      return client.invoke(deviceId, { channel, args }, INVOKE_TIMEOUT_OVERRIDES_MS[channel]);
    },
    onUnresponsiveChanged: (deviceId, unresponsive) => {
      broadcast(DEVICE_LINK_PUSH.RESPONSIVENESS_CHANGED, { deviceId, unresponsive });
      // 恢复时主动重放该设备的订阅:熔断 open 期间 subscribe 都被快速失败挡掉了,
      // 不重放的话 push 驱动的列表 / 会话镜像会一直缺流,直到用户手动重试。
      // linkTornDown 闸:teardown 的 resetAll 也会触发本回调,那时不能再发订阅。
      if (!unresponsive && !linkTornDown && client?.getStatus() === 'online') {
        replayActiveSubscriptions(`responsiveness-recovered:${deviceId.slice(0, 8)}`, deviceId);
      }
    },
    // 探测同样遵守本机「关闭对该设备的控制」的 fail-closed 偏好,不给禁用目标发任何帧。
    isProbeEligible: (deviceId) =>
      client?.getStatus() === 'online' &&
      arbiter?.isOwner() === true &&
      presenceAvailableByDevice.get(deviceId) === true &&
      !readDeviceLinkSettings().disabledControlDeviceIds.includes(deviceId),
    log: {
      info: (...args) => log.info(...args),
      warn: (...args) => log.warn(...args),
      debug: (...args) => log.debug(...args),
    },
  });
  if (responsivenessProbeTimer) clearInterval(responsivenessProbeTimer);
  responsivenessProbeTimer = setInterval(() => {
    responsivenessTracker?.probeTick();
  }, RESPONSIVENESS_PROBE_TICK_MS);
  responsivenessProbeTimer.unref();

  client.onStatusChange((status) => {
    if (status !== 'online') {
      openLinkInFlight.clear();
      // relay 离线:重开循环全部终止,恢复交给断线重连后的 presence 闪断路径。
      transportTimeoutReopen.dispose();
    }
    // 断线期间 relay 不会为对端补发 offline presence,重连后同一台电脑仍以
    // online 到达,`wasOnline` 还是 true —— 上线握手不会触发,而断线这段时间的
    // 改动谁也不会主动推。清空在线视图,让重连后的 presence 重新走一遍握手。
    if (status !== 'online') presenceOnlineByDevice.clear();
    broadcast(DEVICE_LINK_PUSH.STATUS_CHANGED, { status });
    handleContactsDeviceLinkStatusChanged(status === 'online');
    if (status === 'online') {
      replayActiveSubscriptions('ws-online');
      // 重连即投递被控端积压的 invoke-result:离线期间 outbox 只做慢速 TTL 出清,
      // 不再自旋重试,上线事件是它的主投递触发点。
      flushRemoteInvokeResultOutboxOnReconnect();
    }
  });
  // 连接问题(鉴权失效/被顶号/超限/版本不符)→ 推给 renderer,让设置页与
  // 远程会话 banner 能把「一直重连」的真实原因说清楚,而不是笼统的 connecting。
  client.onConnectionIssue((issue) => {
    if (issue) {
      log.warn(
        `device-link connection issue: ${issue.kind}${issue.detail ? ` (${issue.detail})` : ''}`,
      );
    }
    broadcast(DEVICE_LINK_PUSH.CONNECTION_ISSUE, { issue });
    // 鉴权失效不能只在设置页可见:主动 refresh,把「被顶下线」汇入全局会话过期出口。
    if (issue?.kind === 'auth-failed') recoverFromRelayAuthFailure();
  });
  // 死锁自愈(控制端半):对端还在按可靠流给本机发帧,但本机侧 link 未就绪 ——
  // 沉默丢弃会让两边互等(发送端等 ACK、接收端等 link)。只对本机确实在控制
  // (有活跃订阅)的设备主动重建链路;client 侧已 30s/peer 节流,openRemoteLink
  // 自带 in-flight 去重。被控端方向(控制端给本机发帧)没有订阅记录,自然忽略。
  client.onReliableFrameBeforeLink((deviceId) => {
    if (snapshotSubscriptions(deviceId).length === 0) return;
    if (readDeviceLinkSettings().disabledControlDeviceIds.includes(deviceId)) return;
    log.info(`re-opening control link for ${deviceId.slice(0, 8)} after before-link reliable frame`);
    openRemoteLink(deviceId).catch((err) => {
      log.debug(`re-open link for ${deviceId.slice(0, 8)} failed`, err);
    });
  });
  client.onPresenceChanged((snap: PresenceSnapshot) => {
    const wasAvailable = presenceAvailableByDevice.get(snap.deviceId);
    const available = snap.online && snap.remoteControlEnabled;
    const wasOnline = presenceOnlineByDevice.get(snap.deviceId);
    presenceAvailableByDevice.set(snap.deviceId, available);
    presenceOnlineByDevice.set(snap.deviceId, snap.online);
    // 权威 presence 已宣布不可用(离线 / 关被控):「响应性」判定失去意义,清熔断状态
    // 并作废在途结果,让离线态自己的 UI 接管;设备回来后首个请求再超时会重新累计。
    if (!available && wasAvailable === true) responsivenessTracker?.clearDevice(snap.deviceId);
    presencePlatformByDevice.set(snap.deviceId, snap.platform);
    presenceNameByDevice.set(snap.deviceId, snap.selfName || snap.deviceName);
    void rememberLastKnownDeviceName(snap.deviceId, snap.deviceName); // best-effort 名称缓存,不阻塞 presence 处理
    broadcast(DEVICE_LINK_PUSH.PRESENCE_CHANGED, snap);
    // 被控端兜底:对等控制端下线 → 清掉它在本机的订阅 registry(防僵尸订阅持续 sendPush)。
    if (!snap.online) handleControllerOffline(snap.deviceId);
    handleContactsPeerPresenceChanged({ deviceId: snap.deviceId, online: snap.online });
    if (available && wasAvailable === false) {
      replayActiveSubscriptions(`presence-online:${snap.deviceId.slice(0, 8)}`, snap.deviceId);
    }
    // 词典同步不看「允许被控」开关(push 帧不是控制类帧,这是自己设备之间的数据
    // 流动),但撤销过的设备必须排除 —— 判定统一走 shouldExchangeDictionaryWith,
    // 三个入口共用一份条件。
    if (
      wasOnline !== true &&
      shouldExchangeDictionaryWith({
        online: snap.online,
        platform: snap.platform,
        revoked: isDeviceRevoked(snap.deviceId),
      })
    ) {
      handleDesktopPeerOnline(snap.deviceId);
    }
  });

  let updateRelaunchControllersBusy = false;
  let remoteInvokeBusy = false;
  const notifyUpdateRelaunchBusy = (): void => {
    options.onUpdateRelaunchBusyChanged?.(updateRelaunchControllersBusy || remoteInvokeBusy);
  };

  // 先注册远程活动监听，再接线入站帧；否则首个 subscribe / invoke 可能落在空窗期。
  setControllersChangedListener((controllers, updateRelaunchControllers) => {
    broadcast(DEVICE_LINK_PUSH.CONTROLLED_STATE, { controllers });
    updateRelaunchControllersBusy = updateRelaunchControllers.length > 0;
    notifyUpdateRelaunchBusy();
  });
  setRemoteInvokeBusyChangedListener((busy) => {
    remoteInvokeBusy = busy;
    notifyUpdateRelaunchBusy();
  });

  // 被控端:接线入站隧道(link-open / invoke / link-close → 本机 handler dispatch)
  wireInboundDispatch(client);

  // busy presence:每 5s 探一次本机是否有 turn 在跑,变化才上报(dedupe by value)
  startBusyReporting();

  // 控制端:被控端转发回来的 push 帧 → re-broadcast 给 renderer 远程视图,
  // 带上来源 deviceId(src),renderer 据此把事件路由到对应远程设备的 store
  client.onFrame((env: Envelope) => {
    if (!env.src) return;
    // 控制端:被控端撤销访问权限会发 link-close('revoked')。据此移除该被控端的项目/对话 +
    // 标记「已撤销」(presence 不变 —— 被控端仍在线且全局允许被控,故必须靠这条信号)。
    if (env.kind === 'link-close') {
      const reason = (env.payload as LinkClosePayload | undefined)?.reason;
      // reason → 重开循环动作统一路由:transport-timeout(可恢复瞬时重置,
      // 可靠层保留 stream/pending,被控端保留订阅与在途回包,link-accept 后
      // 双向同 seq 续传)触发有界退避重建;其它一切 reason(user/toggle-off/
      // shutdown/revoked/未知新值)都是永久关闭——必须终止已在进行的重开
      // 循环,否则刚被断开的控制链会被退避重试重新建起。
      routeLinkCloseForReopen(reason, transportTimeoutReopen, env.src);
      if (reason === 'revoked') {
        // 撤权后在途请求会陆续超时——那不是「设备无响应」,是访问被收回。清熔断并
        // 作废在途结果(翻代),避免 unresponsive 状态与撤权状态并存(对齐 mobile 语义)。
        responsivenessTracker?.clearDevice(env.src);
        broadcast(DEVICE_LINK_PUSH.ACCESS_REVOKED, { deviceId: env.src });
      }
      return;
    }
    if (env.kind !== 'push') return;
    const p = env.payload as PushPayload;
    // 词典同步帧在 main 侧消费,不转给 renderer —— 它不是远程视图事件,
    // renderer 也不该看到别的设备的同步状态。
    if (p?.channel === DL_VOICE_DICTIONARY_SYNC_CHANNEL) {
      // 入站与出站走同一份准入判定:这条通道承载的是可写 CRDT 状态,只接受电脑
      // 对端。手机在这套设计里是只读消费者(走 invoke 拉快照),不该能推状态过来
      // 改桌面词典 —— 出站已经这么把关了,入站漏掉就等于白设。
      if (
        shouldExchangeDictionaryWith({
          online: true,
          platform: presencePlatformByDevice.get(env.src),
          revoked: isDeviceRevoked(env.src),
        })
      ) {
        handleIncomingDictionaryState(env.src, p.payload);
      }
      return;
    }
    if (p?.channel === DL_CONTACTS_SYNC_CHANNEL) {
      if (
        shouldExchangeDictionaryWith({
          online: true,
          platform: presencePlatformByDevice.get(env.src),
          revoked: isDeviceRevoked(env.src),
        })
      ) {
        handleIncomingContactsRelayFrame(env.src, p.payload);
      }
      return;
    }
    broadcast(DEVICE_LINK_PUSH.REMOTE_PUSH, {
      deviceId: env.src,
      channel: p.channel,
      payload: p.payload,
    });
  });

  // 词典对等同步:传输能力注入驱动,驱动只管什么时候发、发给谁。
  initVoiceDictionarySync({
    sendState: (deviceId, payload) => {
      client?.sendPush(deviceId, DL_VOICE_DICTIONARY_SYNC_CHANNEL, payload);
    },
    listOnlineDesktopDevices: () =>
      [...presenceOnlineByDevice.entries()]
        .filter(([deviceId, online]) =>
          shouldExchangeDictionaryWith({
            online,
            platform: presencePlatformByDevice.get(deviceId),
            revoked: isDeviceRevoked(deviceId),
          }),
        )
        .map(([deviceId]) => deviceId),
  });
  initContactsDeviceSync({
    getSelfDeviceId: () => client?.getSelfDeviceId() ?? null,
    listOnlineDesktopDevices: () =>
      [...presenceOnlineByDevice.entries()]
        .filter(
          ([deviceId, online]) =>
            deviceId !== client?.getSelfDeviceId() &&
            shouldExchangeDictionaryWith({
              online,
              platform: presencePlatformByDevice.get(deviceId),
              revoked: isDeviceRevoked(deviceId),
            }),
        )
        .map(([deviceId]) => ({
          deviceId,
          deviceName: presenceNameByDevice.get(deviceId) ?? deviceId.slice(0, 8),
        })),
    isPeerAllowed: (deviceId) =>
      deviceId !== client?.getSelfDeviceId() &&
      shouldExchangeDictionaryWith({
        online: presenceOnlineByDevice.get(deviceId) === true,
        platform: presencePlatformByDevice.get(deviceId),
        revoked: isDeviceRevoked(deviceId),
      }),
    sendRelayFrame: (deviceId, frame) => {
      client?.sendPush(deviceId, DL_CONTACTS_SYNC_CHANNEL, frame);
    },
  });
  if (unsubscribeDictionaryChanged) unsubscribeDictionaryChanged();
  unsubscribeDictionaryChanged = onVoiceInputDictionaryChanged((options) => {
    if (options?.immediate) broadcastDictionaryNow();
    else notifyLocalDictionaryChanged();
  });

  // 同机多实例单持有者仲裁:共享 userData(同 deviceId)的多个实例中,只有认领
  // 成功的持有者才连 relay,其余被动待命 —— 否则 relay 的 last-wins 顶号语义会
  // 让双活实例无限互踢(4409 循环),手机端远程连接在实例间漂移。见 ./ownership.ts。
  arbiter = new DeviceLinkOwnershipArbiter({
    // DB 访问必须走 DbClient:worker 接管后 main 侧 raw _db 已被释放(bootstrap
    // Phase 1.1),getRawDb() 在稳态永久抛错;DbClient 同时覆盖 worker 与 inproc
    // fallback 两种模式。未就绪(登录初期 / takeover 进行中 / 关库竞态)返回 null →
    // 仲裁器亚秒级快速重试。store 按 DbClient 实例缓存,换账号换库时自动重建。
    getStore: () => {
      const dbClient = tryGetDbClient();
      if (!dbClient) return null;
      if (ownershipStoreCache?.db !== dbClient) {
        ownershipStoreCache = { db: dbClient, store: createDbClientOwnershipStore(dbClient) };
      }
      return ownershipStoreCache.store;
    },
    // ownerId 由仲裁器生成并按 start() 轮换(防 stale release 误删新行),这里只给诊断字段
    instance: {
      ownerPid: process.pid,
      ownerLabel: `${app.getVersion()}${app.isPackaged ? '' : '-dev'}`,
    },
    onAcquire: () => {
      // 认领成功但期间已登出:不连(登出路径已 stop 仲裁,这里是 tick 竞态兜底)
      if (!authManager.getAuthState().isAuthenticated) return;
      linkTornDown = false;
      client?.start();
      setContactsDeviceLinkOwnerActive(true);
      refreshAppliedSettingsSnapshot();
      pollContactsDeviceSyncSettingChange();
      pollContactsDeviceSyncDataChange();
      pollContactsDeviceSyncCrossProcessState();
    },
    onDemote: () => {
      setContactsDeviceLinkOwnerActive(false);
      appliedSettingsSnapshot = null;
      teardownActiveLink();
    },
  });

  // 登录态驱动仲裁:已登录即参与认领(控制端列表/被控端可达都依赖这条 WS)
  observedAuthRealm = authManager.getActiveAuthRealm();
  syncWithAuthState(authManager.getAuthState().isAuthenticated);
  unsubscribeAuthState = authManager.onAuthStateChange((state) => {
    const nextRealm = authManager.getActiveAuthRealm();
    const realmChanged = observedAuthRealm !== null && observedAuthRealm !== nextRealm;
    observedAuthRealm = nextRealm;
    syncWithAuthState(state.isAuthenticated, realmChanged);
  });
  onQuit('device-link', () => {
    authRealmReconnectGeneration += 1;
    unsubscribeAuthState?.();
    unsubscribeAuthState = null;
    observedAuthRealm = null;
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    if (responsivenessProbeTimer) {
      clearInterval(responsivenessProbeTimer);
      responsivenessProbeTimer = null;
    }
    // 先释放持有权(删行),幸存实例在下一轮 tick 内接管,无需等心跳过期。
    // sync 阶段只发起 DELETE(RPC 已入 worker 队列),真正的落盘等待交给下面
    // async 阶段的 disposer —— sync 阶段不 await,直接退出会与 DbClient
    // dispose / 进程退出竞速,输了就退化成 15s 过期窗口。
    pendingQuitOwnershipRelease = arbiter?.stop() ?? null;
    arbiter = null;
    // 优雅告知在控的控制端本机即将下线。teardownActiveLink 幂等:持有者路径
    // 已由上面 stop() 的 onDemote 执行过一次,linkTornDown 标记拦截重复清理。
    teardownActiveLink();
    setControllersChangedListener(null);
    setRemoteInvokeBusyChangedListener(null);
    client = null;
  });

  // async 阶段(被 await、先于 post-async 的关库)等 DELETE 真正落盘
  onQuit(
    'device-link-ownership-release',
    async () => {
      if (pendingQuitOwnershipRelease) await pendingQuitOwnershipRelease;
    },
    'async',
  );

  log.info(`device-link service initialized → ${wsUrl()}`);
}

function syncWithAuthState(isAuthenticated: boolean, realmChanged = false): void {
  if (!client || !arbiter) return;
  if (isAuthenticated) {
    if (realmChanged) {
      restartDeviceLinkForAuthRealmChange();
      return;
    }
    // 不直接 client.start():先参与仲裁,认领成功由 onAcquire 启动连接
    arbiter.start();
  } else {
    authRealmReconnectGeneration += 1;
    stopArbitrationAndTeardown();
  }
}

/**
 * 同账号被另一 shared-userData 实例切到其它区域时，登录态仍是 authenticated，
 * 普通 arbiter.start() 会幂等早退，旧 WS 因而不会换区。先完整释放持有权并拆掉
 * 旧 client，再以最新 realm/token 重新参与仲裁；generation 防止等待释放期间登出
 * 或再次切区后把过期连接复活。
 */
function restartDeviceLinkForAuthRealmChange(): void {
  const generation = ++authRealmReconnectGeneration;
  const targetRealm = authManager.getActiveAuthRealm();
  void stopArbitrationAndTeardown()
    .catch((error) => {
      log.warn('device-link ownership release during auth realm switch failed', error);
    })
    .then(() => {
      if (
        generation !== authRealmReconnectGeneration ||
        !authManager.getAuthState().isAuthenticated ||
        authManager.getActiveAuthRealm() !== targetRealm
      ) {
        return;
      }
      arbiter?.start();
    });
}

/**
 * 登出 / 掉登录态的统一收口:先停仲裁(若持有 → 释放行 + onDemote → teardown),
 * 非持有者再补一次 teardown 保证被控状态彻底清空。可能被连续触发(显式登出释放
 * 先走、auth 监听器随后再走),teardownActiveLink 自身有防重入,重复调用无害。
 * 返回 release 完成信号供登出路径 await。
 */
function stopArbitrationAndTeardown(): Promise<void> {
  if (!arbiter) return Promise.resolve();
  const wasOwner = arbiter.isOwner();
  const released = arbiter.stop();
  if (!wasOwner) teardownActiveLink();
  return released;
}

/**
 * 登出前显式释放 device-link 持有权。**必须在 lifecycleDbClientManager.dispose
 * 之前调用**(bootstrap 的 auth:logout handler):dispose 会同步 clearCurrentDbClient,
 * 之后 store 不可用,释放只能退化为等 staleMs(15s+)过期,幸存实例接管变慢。
 * 这里 await DELETE 真正落盘(带 1.5s 超时兜底,worker 卡死不阻塞登出)。
 */
export async function releaseDeviceLinkOwnershipBeforeLogout(): Promise<void> {
  const released = stopArbitrationAndTeardown();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, 1_500);
    timeoutHandle.unref?.();
  });
  try {
    await Promise.race([released, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** teardownActiveLink 防重入标记:连接建立(onAcquire)时清除。 */
let linkTornDown = false;

/**
 * 链路代次:每次 teardown(登出 / 失去持有权)递增。跨 await 的通知任务在发起时
 * 捕获、发送时校验 —— 期间发生过账号边界,任务即过期丢弃,防止旧账号触发的
 * 通知经新账号重连后的 client 发到新账号的手机。
 */
let mobileNotifyGeneration = 0;

/** 当前链路代次。异步取通知正文前捕获,随 payload 传回 sendMobileSessionNotify。 */
export function getMobileNotifyGeneration(): number {
  return mobileNotifyGeneration;
}

/**
 * 停下本实例的 relay 连接并拆掉被控状态(登出与失去持有权共用;幂等,重复调用
 * 直接跳过,不对已关闭的连接重复跑清理)。
 * 必须先拆被控状态再断连:否则 dispatch 里的 broadcast-tap 监听 + activeControllers
 * 会残留 —— 继续对旧 client 转发本机事件、状态栏显示幽灵控制端,
 * 同进程换账号登录还会把上一账号的控制端串到新账号。
 */
function teardownActiveLink(): void {
  if (!client || linkTornDown) return;
  linkTornDown = true;
  mobileNotifyGeneration += 1;
  if (relayAuthRecoveryRetryTimer !== null) {
    clearTimeout(relayAuthRecoveryRetryTimer);
    relayAuthRecoveryRetryTimer = null;
  }
  dropAllControllers(client, 'shutdown');
  // 熔断状态是账号 / 链路作用域的:登出或失去持有权后全部翻篇,不串到下一段链路。
  responsivenessTracker?.resetAll();
  for (const timer of subscriptionReplayRetryTimers.values()) clearTimeout(timer);
  subscriptionReplayRetryTimers.clear();
  presenceAvailableByDevice.clear();
  // 词典同步驱动是进程级的,**不随单次链路起停**:多实例仲裁的 demote → acquire
  // 只会 client.start(),不会重跑 initDeviceLinkService,在这里 stop 掉它会让词典
  // 同步在降级过一次之后永久失效。清空 presence 就够了 —— 没有对端就不会发送,
  // client 为 null 时 sendPush 也是 no-op。
  presenceOnlineByDevice.clear();
  presencePlatformByDevice.clear();
  presenceNameByDevice.clear();
  resetSubscriptionRefs();
  resetBusyDedupe(); // 重置 busy dedupe,避免重连后首个真实 busy 状态被旧值压掉
  client.stop();
}

function replayActiveSubscriptions(reason: string, deviceId?: string): void {
  const refs = snapshotSubscriptions(deviceId);
  if (refs.length === 0) return;
  const topicCount = refs.reduce((sum, item) => sum + item.topics.length, 0);
  log.debug(
    `device-link replay subscriptions (${reason}): devices=${refs.length} topics=${topicCount}`,
  );
  for (const { deviceId, topics } of refs) {
    replayDeviceSubscription(deviceId, topics, reason, 0);
  }
}

/**
 * 重放失败的有限重试(弱网修复,2026-08):重连后的 subscribe 若恰好赶上链路抖动
 * 失败,此前只留一行 warn —— push 流静默缺失,直到下一次重连或用户手动操作。
 * 每设备最多补 2 次(3s / 9s),重试前重新校验前置条件并取当前订阅快照;熔断 open
 * 的设备不重试(恢复时 tracker 自会触发一次定向重放)。
 */
const SUBSCRIPTION_REPLAY_RETRY_DELAYS_MS = [3_000, 9_000] as const;
const subscriptionReplayRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function replayDeviceSubscription(
  deviceId: string,
  topics: string[],
  reason: string,
  attempt: number,
): void {
  // 新一轮重放顶掉该设备挂起的重试,避免多路触发(ws-online / presence / 熔断恢复)叠加。
  const prev = subscriptionReplayRetryTimers.get(deviceId);
  if (prev) {
    clearTimeout(prev);
    subscriptionReplayRetryTimers.delete(deviceId);
  }
  void remoteSubscribe(deviceId, topics).catch((err) => {
    const delay = SUBSCRIPTION_REPLAY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      log.warn(
        `device-link replay subscriptions failed (${reason}) for ${deviceId.slice(0, 8)}, giving up: ${String(err)}`,
      );
      return;
    }
    log.warn(
      `device-link replay subscriptions failed (${reason}) for ${deviceId.slice(0, 8)}, retrying in ${delay}ms: ${String(err)}`,
    );
    const timer = setTimeout(() => {
      subscriptionReplayRetryTimers.delete(deviceId);
      if (linkTornDown || client?.getStatus() !== 'online') return;
      if (responsivenessTracker?.isUnresponsive(deviceId)) return;
      if (presenceAvailableByDevice.get(deviceId) !== true) return;
      // 快照可能已变(窗口退订 / 新增 topic):按该设备当前的订阅快照重放。
      const current = snapshotSubscriptions(deviceId).find((ref) => ref.deviceId === deviceId);
      if (!current || current.topics.length === 0) return;
      replayDeviceSubscription(deviceId, current.topics, `${reason}-retry`, attempt + 1);
    }, delay);
    timer.unref?.();
    subscriptionReplayRetryTimers.set(deviceId, timer);
  });
}

export function getDeviceLinkStatus(): DeviceLinkStatus {
  return client?.getStatus() ?? 'stopped';
}

/** 当前被熔断判定为「无响应」的目标设备(控制端本地判定,供 getState / UI 镜像)。 */
export function getUnresponsiveDeviceIds(): string[] {
  return responsivenessTracker?.getUnresponsiveDeviceIds() ?? [];
}

/**
 * 系统睡眠唤醒:立即重建连接而不是干等退避计时器(最坏 30s)+ 心跳判死(~45s)。
 * 状态仍是 online 也要重建 —— 睡眠期间 socket 大概率已半开假活(对端早没了,
 * 本端没收到 close、心跳未累计到判死),此时只解除退避救不了半开黑洞
 * (review P1/P2:connectNow 对 online 是空操作)。restartConnection 对 stopped
 * client 不拉起,但持有权 / 登录双闸仍在前面,不绕过仲裁。
 */
export function handleDeviceLinkSystemResume(): void {
  if (!client || linkTornDown) return;
  if (arbiter && !arbiter.isOwner()) return;
  if (!authManager.getAuthState().isAuthenticated) return;
  log.info('system resume: rebuilding device-link connection immediately');
  client.restartConnection('system-resume');
}

export function getDeviceLinkConnectionIssue(): DeviceLinkConnectionIssue | null {
  return client?.getConnectionIssue() ?? null;
}

/** 切换「允许被控」开关:落盘 + 在线时即时 presence-set 广播;关闭时踢掉所有控制端 */
export async function setRemoteControlEnabled(enabled: boolean): Promise<void> {
  // 先消化并 enforce 盘上的外部变化(另一实例可能刚改过授权),再应用本地修改;
  // 否则随后的快照刷新会把未 enforce 的外部撤销当成"已生效",吞掉即时踢断。
  pollExternalSettingsChange();
  await writeDeviceLinkSetting('remoteControlEnabled', enabled);
  client?.sendPresence({ remoteControlEnabled: enabled });
  if (!enabled && client) {
    // 开关关闭立即踢断所有在控链路(server 侧此后也拒转发,双保险)
    dropAllControllers(client, 'toggle-off');
  }
  // 末尾再 poll 一次(而非仅刷新基线):写锁释放到这里之间,别的实例可能已插入
  // 新授权变更,仅刷新基线会把它静默记为已生效、永不 enforce;poll 是幂等的,
  // 本地刚做过的动作重复 enforce 无害,同时能捕获这条竞态窗口里的外部变更。
  pollExternalSettingsChange();
  log.info(`remote control ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * 切换「保持电脑唤醒」:落盘 + 立即 start/stop 本机 powerSaveBlocker。
 * 与被控授权 / relay 连接无关,是纯本机本地偏好。
 */
export async function setKeepAwakeEnabled(enabled: boolean): Promise<void> {
  await writeDeviceLinkSetting('keepAwake', enabled);
  keepAwakeController.apply(enabled);
  appliedKeepAwake = enabled; // 同步基线,避免随后轮询把自己的改写当成外部变更重复应用
  log.info(`keep-awake ${enabled ? 'enabled' : 'disabled'}`);
}

/** 被控端:一键断开当前所有控制链路(WS 与开关保持) */
export function disconnectAllControllers(): void {
  if (client) dropAllControllers(client, 'user');
}

/**
 * 被控端:撤销某控制端的访问权限(逐设备黑名单,持久化)。
 * 立即踢断当前链路,且后续该设备的 subscribe/invoke/link-open 一律被拒(ACCESS_REVOKED),
 * 直到 restoreController 恢复。
 */
export async function revokeController(deviceId: string): Promise<void> {
  // 先消化并 enforce 盘上的外部变化,避免快照刷新吞掉别的实例刚写入的撤销(见 setRemoteControlEnabled)
  pollExternalSettingsChange();
  // updater 在写锁内基于盘上最新名单追加,不能锁外算好整数组再整值写
  // (两个实例并发撤销不同控制端时,后写者的旧数组会覆盖掉先写者刚加的那条)
  await updateDeviceLinkSetting('revokedControllers', (latest) =>
    latest.includes(deviceId) ? latest : [...latest, deviceId],
  );
  // 在线连着的:发 link-close('revoked'),控制端据此立即移除本机项目/对话 + 标记「已撤销」。
  try {
    client?.closeLink(deviceId, 'revoked', 'inbound');
  } catch (err) {
    log.warn(`closeLink failed while revoking ${deviceId.slice(0, 8)}: ${String(err)}`);
  }
  forgetControllerInvokeState(deviceId);
  // 踢掉它的订阅 registry + 重算转发/横幅(复用对等下线的单设备清理路径)。
  handleControllerOffline(deviceId);
  purgeRevokedController(deviceId);
  // 末尾再 poll 一次(而非仅刷新基线):写锁释放到这里之间,别的实例可能已插入
  // 新授权变更,仅刷新基线会把它静默记为已生效、永不 enforce;poll 是幂等的,
  // 本地刚做过的动作重复 enforce 无害,同时能捕获这条竞态窗口里的外部变更。
  pollExternalSettingsChange();
  log.info(`access revoked for controller ${deviceId.slice(0, 8)}`);
}

/**
 * 被控端:恢复某控制端的访问权限。无法直接通知已断开的控制端(无链路),
 * 故发一次 presence 广播 —— 控制端收到后重新评估该设备 → 重试订阅成功 → 自动恢复。
 */
export async function restoreController(deviceId: string): Promise<void> {
  // 先消化并 enforce 盘上的外部变化,避免快照刷新吞掉别的实例刚写入的撤销(见 setRemoteControlEnabled)
  pollExternalSettingsChange();
  // 同 revokeController:锁内基于盘上最新名单移除,不锁外预计算整数组
  await updateDeviceLinkSetting('revokedControllers', (latest) =>
    latest.includes(deviceId) ? latest.filter((id) => id !== deviceId) : latest,
  );
  const { remoteControlEnabled } = readDeviceLinkSettings();
  client?.sendPresence({ remoteControlEnabled });
  // 末尾再 poll 一次(而非仅刷新基线):写锁释放到这里之间,别的实例可能已插入
  // 新授权变更,仅刷新基线会把它静默记为已生效、永不 enforce;poll 是幂等的,
  // 本地刚做过的动作重复 enforce 无害,同时能捕获这条竞态窗口里的外部变更。
  pollExternalSettingsChange();
  log.info(`access restored for controller ${deviceId.slice(0, 8)}`);
}

// ─── busy presence(被控端把「本机有 turn 在跑」上报,供控制端设备列表显示)──
// 状态与 dedupe 逻辑在 ./busyReporter(纯逻辑、可单测);这里只持有定时器并驱动 client.sendPresence。

let busyTimer: ReturnType<typeof setInterval> | null = null;

function startBusyReporting(): void {
  if (busyTimer) return;
  busyTimer = setInterval(() => {
    // keep-awake 与 relay 持有权无关,所有实例都跟随共享 settings:先于 client 守卫执行,
    // 避免被动实例(client 恒 null)漏应用其它实例对 keepAwake 的改写。
    pollExternalKeepAwakeChange();
    if (!client) return;
    pollExternalSettingsChange();
    const busy = pollBusyChange(); // 只在 busy 与 dedupe 基线翻转时返回新值,否则 null
    if (busy === null) return;
    client.sendPresence({ busy });
  }, 5_000);
  busyTimer.unref();
}

// ─── 多实例授权同步(持有者响应其它实例改写的共享 settings)─────────────────────

/** 把当前盘上授权设置记为"已生效"基线;仅持有者维护,非持有者置 null。 */
function refreshAppliedSettingsSnapshot(): void {
  if (!arbiter?.isOwner()) {
    appliedSettingsSnapshot = null;
    return;
  }
  const { remoteControlEnabled, revokedControllers } = readDeviceLinkSettings();
  appliedSettingsSnapshot = { remoteControlEnabled, revokedControllers: [...revokedControllers] };
}

/**
 * 持有者轮询共享 settings 文件的外部变化(被动实例的设置页改了授权):
 * 开关翻转 → 补发 presence(关闭时踢断所有控制端);新增撤销 → 踢断对应控制端;
 * 移除撤销 → 补发一次 presence 让控制端重试订阅自动恢复(对齐 restoreController)。
 * 本实例自己的修改在各 mutator 里已即时生效并同步快照,不会走到这里重复应用。
 */
function pollExternalSettingsChange(): void {
  if (!client || !arbiter?.isOwner()) return;
  pollContactsDeviceSyncSettingChange();
  pollContactsDeviceSyncDataChange();
  pollContactsDeviceSyncCrossProcessState();
  const prev = appliedSettingsSnapshot;
  const { remoteControlEnabled, revokedControllers } = readDeviceLinkSettings();
  appliedSettingsSnapshot = { remoteControlEnabled, revokedControllers: [...revokedControllers] };
  if (!prev) return;

  if (prev.remoteControlEnabled !== remoteControlEnabled) {
    client.sendPresence({ remoteControlEnabled });
    if (!remoteControlEnabled) dropAllControllers(client, 'toggle-off');
    log.info(
      `remote control ${remoteControlEnabled ? 'enabled' : 'disabled'} (external settings change)`,
    );
  }

  const newlyRevoked = revokedControllers.filter((id) => !prev.revokedControllers.includes(id));
  for (const deviceId of newlyRevoked) {
    try {
      client.closeLink(deviceId, 'revoked', 'inbound');
    } catch (err) {
      log.warn(
        `closeLink failed while applying external revoke for ${deviceId.slice(0, 8)}: ${String(err)}`,
      );
    }
    forgetControllerInvokeState(deviceId);
    handleControllerOffline(deviceId);
    purgeRevokedController(deviceId);
    log.info(`access revoked for controller ${deviceId.slice(0, 8)} (external settings change)`);
  }

  const restored = prev.revokedControllers.filter((id) => !revokedControllers.includes(id));
  if (restored.length > 0) {
    client.sendPresence({ remoteControlEnabled });
    log.info(`access restored for ${restored.length} controller(s) (external settings change)`);
  }
}

/**
 * 跟随其它实例对 keepAwake 的改写(**所有实例**都参与,不受 relay 持有权限制):
 * 共享 settings 里 keepAwake 翻转 → 本进程 start/stop 自己的 blocker。apply 幂等,
 * 基线相等时直接短路。本实例自己的修改在 setKeepAwakeEnabled 里已即时应用并同步基线。
 */
function pollExternalKeepAwakeChange(): void {
  const { keepAwake } = readDeviceLinkSettings();
  if (keepAwake === appliedKeepAwake) return;
  appliedKeepAwake = keepAwake;
  keepAwakeController.apply(keepAwake);
  log.info(`keep-awake ${keepAwake ? 'enabled' : 'disabled'} (external settings change)`);
  // 推送给本进程 renderer，使设置页开关跟随显示（防止 UI 与实际状态脱节）。
  broadcast(DEVICE_LINK_PUSH.KEEP_AWAKE_CHANGED, { keepAwake });
}

// ─── 控制端 API(供 device-link:invoke / remote-control IPC 调用)──────────────

/** 控制端 API 的被动态守卫:被动实例的 client 永远 stopped,给出可诊断的明确错误
 * 而不是笼统的 NOT_CONNECTED(renderer 会把后者显示成"重连中"误导用户)。 */
function assertNotStandby(): void {
  if (arbiter && !arbiter.isOwner()) {
    throw new Error(
      '[DEVICE_LINK_STANDBY] device-link is owned by another instance on this machine; use that instance for remote control',
    );
  }
}

/** 本机主动关闭对某设备的控制后，所有新建链路与业务调用都必须继续 fail closed。 */
function assertRemoteControlTargetEnabled(deviceId: string): void {
  if (readDeviceLinkSettings().disabledControlDeviceIds.includes(deviceId)) {
    throw new Error('[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally');
  }
}

/** 控制端:向目标设备发起控制链路(link-open → link-accept) */
export async function openRemoteLink(deviceId: string): Promise<LinkAcceptPayload> {
  assertNotStandby();
  assertRemoteControlTargetEnabled(deviceId);
  if (!client) throw new Error('[DEVICE_LINK_NOT_CONNECTED] device-link client not initialized');
  const existing = openLinkInFlight.get(deviceId);
  if (existing) return existing;

  const request = client.openLink(deviceId, {
    controllerName: deviceName(),
    protocolVersion: 1,
    appVersion: app.getVersion(),
    capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2],
  });
  openLinkInFlight.set(deviceId, request);
  const cleanup = (): void => {
    if (openLinkInFlight.get(deviceId) === request) openLinkInFlight.delete(deviceId);
  };
  void request.then(cleanup, cleanup);
  return request;
}

/** 控制端:解除控制链路 */
export function closeRemoteLink(deviceId: string): void {
  // 本地主动断开同样必须终止重开循环:否则用户刚点断开,退避重试又把
  // 链路建回来。
  transportTimeoutReopen.cancel(deviceId);
  openLinkInFlight.delete(deviceId);
  client?.closeLink(deviceId, 'user');
}

/** 重开期间本地撤权时，撤销已成功建立的临时控制链路，保持 fail-closed。 */
function assertRemoteControlTargetEnabledAfterReopen(deviceId: string): void {
  try {
    assertRemoteControlTargetEnabled(deviceId);
  } catch (err) {
    closeRemoteLink(deviceId);
    throw err;
  }
}

/**
 * 本机在 device-link 网络中的设备 id(relay ack 下发);未连接 / 未 ack 时 null。
 * 供会话引用解析等消费方识别「指向本机自己的 deviceId」——深链是可复制的字符串,
 * 控制端生成的 `?device=` 链接可能被带回归属设备本机粘贴发送。
 */
export function getSelfDeviceId(): string | null {
  return client?.getSelfDeviceId() ?? null;
}

/** 控制端:对目标设备远程 invoke 一个 allowlist 内的 channel。
 *  被控端自身持有执行预算的 channel(desktop-cmd:run)按协议契约放宽隧道超时,
 *  避免与被控端执行超时对撞(见 INVOKE_TIMEOUT_OVERRIDES_MS)。 */
export async function remoteInvoke(
  deviceId: string,
  channel: string,
  args: unknown[],
): Promise<InvokeResultPayload> {
  assertNotStandby();
  assertRemoteControlTargetEnabled(deviceId);
  const invoke = (): Promise<InvokeResultPayload> => {
    if (!client) throw new Error('[DEVICE_LINK_NOT_CONNECTED] device-link client not initialized');
    return client.invoke(deviceId, { channel, args }, INVOKE_TIMEOUT_OVERRIDES_MS[channel]);
  };
  const run = (): Promise<InvokeResultPayload> =>
    invokeWithClosedLinkRecovery(
      invoke,
      () => openRemoteLink(deviceId),
      () => assertRemoteControlTargetEnabled(deviceId),
      () => closeRemoteLink(deviceId),
    );
  // 熔断门禁:目标设备连续超时判定无响应后,新请求立即以 DEVICE_UNRESPONSIVE 快速失败
  // (不占管道、不等 12~30s 超时),恢复由周期单飞探测驱动。tracker 未初始化时直通。
  if (!responsivenessTracker) return run();
  return responsivenessTracker.guardInvoke(deviceId, channel, run);
}

/**
 * 控制端:订阅被控端某 topic 的变更推送(push 驱动)。走 invoke 帧承载,被控端 dispatch
 * 拦截执行。带上本机设备名,供被控端横幅展示「正在被 X 控制」(与 openRemoteLink 同款)。
 */
export async function remoteSubscribe(
  deviceId: string,
  topics: string[],
): Promise<InvokeResultPayload> {
  assertNotStandby();
  assertRemoteControlTargetEnabled(deviceId);
  if (!client) throw new Error('[DEVICE_LINK_NOT_CONNECTED] device-link client not initialized');
  const run = async (): Promise<InvokeResultPayload> => {
    if (!client) throw new Error('[DEVICE_LINK_NOT_CONNECTED] device-link client not initialized');
    if (requiresSessionLink(topics) && !client.isLinkReady(deviceId)) {
      await openRemoteLink(deviceId);
    }
    assertRemoteControlTargetEnabledAfterReopen(deviceId);
    if (!client) throw new Error('[DEVICE_LINK_NOT_CONNECTED] device-link client not initialized');
    return client.invoke(deviceId, {
      channel: DL_SUBSCRIBE_CHANNEL,
      args: [
        {
          topics,
          controllerName: deviceName(),
          capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2],
        },
      ],
    });
  };
  // 同一张熔断门禁盖住「重开 link + subscribe」整段(单席位,内部 openLink 的失败不
  // 重复计 strike):设备无响应期间 bootstrap 快速失败,恢复后由 tracker 重放订阅。
  if (!responsivenessTracker) return run();
  return responsivenessTracker.guardInvoke(deviceId, DL_SUBSCRIBE_CHANNEL, run);
}

/** 控制端:取消订阅被控端某 topic。 */
export async function remoteUnsubscribe(
  deviceId: string,
  topics: string[],
): Promise<InvokeResultPayload> {
  assertNotStandby();
  if (!client) throw new Error('[DEVICE_LINK_NOT_CONNECTED] device-link client not initialized');
  return client.invoke(deviceId, { channel: DL_UNSUBSCRIBE_CHANNEL, args: [{ topics }] });
}

// ─── 手机推送(notify 帧,经 relay 下发 APNs)───────────────────────────────────

const mobileNotifyDeduper = new MobileNotifyDeduper();

/**
 * 会话终态时给本账号已注册推送 token 的手机发系统推送(fire-and-forget)。
 * 静默跳过的场景(返回 false):
 *  - relay 未连接 / server 未声明 notify capability(老 relay,黑洞防护)
 *  - 有控制端正订阅该会话的实时流(session:<id> topic)——人已经在手机上看着这
 *    个会话,系统推送只会重复打扰
 *  - 同 session + kind 5s 短窗去重
 * 手机端是否收得到由手机侧开关决定(注册/注销 token),桌面端不再设第二个开关。
 */
export function sendMobileSessionNotify(payload: {
  sessionId: string;
  title: string;
  kind: MobileSessionEventKind;
  /** 内容摘要(最近一条 assistant 内容 / 定时任务结果),缺省回退终态短文案 */
  detail?: string;
  /**
   * 发起时捕获的 getMobileNotifyGeneration()。调用路径里有 await(取正文/等
   * 其它通道)时必传:与当前代次不一致说明期间发生过登出/失去持有权,任务
   * 过期丢弃,不得把旧账号的通知发进新账号的链路。
   */
  generation?: number;
}): boolean {
  if (!client) return false;
  if (payload.generation !== undefined && payload.generation !== mobileNotifyGeneration) {
    log.debug(
      `mobile notify dropped: link generation changed (account/ownership boundary), session=${payload.sessionId.slice(0, 8)}`,
    );
    return false;
  }
  const selfDeviceId = client.getSelfDeviceId();
  if (!selfDeviceId) return false;
  if (getControllersForTopic(`session:${payload.sessionId}`).length > 0) {
    log.debug(
      `mobile notify skipped: session ${payload.sessionId.slice(0, 8)} is being watched remotely`,
    );
    return false;
  }
  if (!mobileNotifyDeduper.shouldSend(payload.sessionId, payload.kind)) return false;
  const sent = client.sendNotify(
    buildSessionNotifyPayload({
      sessionId: payload.sessionId,
      title: payload.title,
      kind: payload.kind,
      selfDeviceId,
      detail: payload.detail,
    }),
  );
  if (sent) {
    log.debug(`mobile notify sent: session=${payload.sessionId.slice(0, 8)} kind=${payload.kind}`);
  }
  return sent;
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log.warn(`broadcast '${channel}' failed (non-fatal)`, err);
    }
  }
}
