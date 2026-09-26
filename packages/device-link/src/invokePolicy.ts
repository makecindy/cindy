import { INVOKE_TIMEOUT_OVERRIDES_MS } from './allowlist.js';
import type { InvokePayload } from './protocol.js';

/**
 * mobile 侧 invoke 超时解析(优先级:mobile 精确表 → schedule 前缀规则 →
 * 协议契约表 → undefined = client 默认 15s)。
 *
 * 背景:mobile 把默认请求超时从 30s 收紧到 15s 后,凡是桌面端有更长执行预算的
 * 通道都必须在这里保住原有窗口,否则合法慢操作会被提前掐断(review 三轮反馈):
 *  - media:fetch:桌面拉文件传 OSS,最大 2GB;
 *  - file-browser:remote-op:searchCollect 桌面执行预算 20s(SEARCH_COLLECT_TIMEOUT_MS);
 *  - maker:schedule:*:桌面 handler 会等 scheduler 就绪(READINESS_TIMEOUT_MS=30s,
 *    冷启动 / 登出登录窗口内就绪可能落在 15-30s),40s = 就绪上限 + 执行余量;
 *  - voice:dictionary-learning:桌面 advisor 走 managed refiner,单次尝试空闲窗
 *    12s(VOICE_INPUT_MANAGED_REFINER_IDLE_TIMEOUT_MS)且主模型卡住会换备选
 *    profile 再试,合法执行可超 15s;误超时会让后台学习白白计入熔断失败;
 *  - voice:transcribe:桌面端先 downloadToBuffer 从 OSS 拉音频再走批量网关转写,
 *    两段都无更短的执行 deadline,中速/慢网络下合法执行可超 15s,且连续几条
 *    语音误超时就会错误打开设备级熔断;
 *  - maker:fork:桌面端 forkSessionAtMessage 载入完整可见消息前缀 + SDK fork +
 *    事务内批量拷贝,大会话可落在 15-30s;且该操作**非幂等**——误超时后桌面端
 *    仍会建出并广播新会话,用户重试会分叉出重复副本;
 *  - maker:rewind:commit:transcript/DB 读 + SDK/Codex 线程回滚 + Git 文件回退 +
 *    收尾 SQLite 事务,同样非幂等——误超时后对话与文件已被回退,重试会作用在
 *    已变更的历史上;
 *  - maker:get-context-usage:非运行中会话走 lazy-create 分支
 *    (ensureRemoteReadyForSessionStart + bootstrapSession),SSH 工作区仅就绪
 *    等待就允许 20s,再叠会话拉起;15s 会在桌面端继续启动时提前掐断,反复
 *    尝试还会误开设备级熔断;
 *  - maker:usage:codex-rate-limits / codex-rate-limit-reset:账号 app-server
 *    冷启动或 RPC 慢时无更短 deadline;reset 还串行做消耗 + 身份校验 + 额度
 *    刷新且有真实副作用,误超时后桌面会继续完成消耗,重试有重复扣减风险;
 *  - maker:send:makerSendTransaction 接收消息前会等
 *    ensureRemoteReadyForSessionStart(SSH 就绪窗口 20s)再落库/派发;误超时后
 *    桌面仍会接收并发出该消息,用户重试会把同一条消息发两遍;
 *  - maker:regenerate-title:桌面路径先读取来源凭证(可能要刷新 token,最长 ~10s)
 *    再发标题请求(自身 TITLE_TIMEOUT_MS=12s),合法总预算 ~22s;
 *  - maker:create-session:桌面 await maker.createSession → agent.startSession /
 *    Codex host.ensureStarted,冷启动 app-server 无更短 deadline;goal 路径无
 *    稳定的客户端会话 id,误超时后重试会建出第二个会话;
 *  - maker:message:delete:桌面提交删除前先读 handoff 历史并 await
 *    maker.closeSession(Claude 远端 close 的 cc-manager RPC 自带 15s 超时),
 *    合法可贴着 15s 边界;破坏性操作,误超时后删除实际已生效,mobile 却报失败;
 *  - maker:goal:set / goal:resume:GoalController.ensureSession 的
 *    restoreSessionForGoal 同样 await createSession 重启持久化 agent,冷启动
 *    可超 15s;两者都有真实副作用(set 落库目标并发首轮,resume 先标 active),
 *    误超时后重试会改动/重启已在跑的 goal。
 * 新增合法慢通道优先登记协议契约表(桌面控制端共用),仅 mobile 特有差异放这里。
 */
export const MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  // Even a small row count can contain one large message: the Android weak-link
  // regression took ~18s to deliver 200KB. Do not enqueue another copy at 15s.
  'local-db:messages:list': 30_000,
  'device-link:media:fetch': 30_000,
  'device-link:voice:dictionary-learning': 30_000,
  'device-link:voice:transcribe': 30_000,
  'file-browser:remote-op': 30_000,
  'maker:create-session': 30_000,
  'maker:fork': 30_000,
  'maker:get-context-usage': 30_000,
  'maker:goal:resume': 30_000,
  'maker:goal:set': 30_000,
  'maker:message:delete': 30_000,
  'maker:regenerate-title': 30_000,
  'maker:rewind:commit': 30_000,
  'maker:send': 30_000,
  'maker:usage:codex-rate-limit-reset': 30_000,
  'maker:usage:codex-rate-limits': 30_000,
};

export const MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS = 40_000;

export function resolveRemoteInvokeTimeoutMs(
  channel: string,
  args?: unknown[],
  platform: 'desktop' | 'mobile' = 'desktop',
): number | undefined {
  if (platform === 'desktop') return INVOKE_TIMEOUT_OVERRIDES_MS[channel];
  // Renewals must settle before the 12s lease, independently of slow media offers.
  const request = args?.[0];
  if (channel === 'device-link:remote-desktop:v1' && request &&
      typeof request === 'object' && 'op' in request && request.op === 'heartbeat') return 5_000;
  const exact = MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS[channel];
  if (exact !== undefined) return exact;
  if (channel.startsWith('maker:schedule:')) return MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS;
  return INVOKE_TIMEOUT_OVERRIDES_MS[channel];
}

const PEER_RESET_RETRYABLE_READ_CHANNELS = new Set([
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:sessions:get-many',
  'local-db:conversations:search',
  'local-db:history:messages',
  'local-db:messages:list',
  'local-db:messages:view',
  'local-db:messages:work-details',
  'local-db:messages:around',
  'local-db:messages:around-client-id',
  'local-db:messages:estimatedSessionValue',
  'local-db:recent-workdirs:list',
  'local-db:subagent-runs:list',
  'local-db:subagent-runs:detail',
  'local-db:subagent-runs:transcript',
  'local-db:bots:list',
  'local-db:bots:get',
  'local-db:orca-workflows:get-by-lead',
  'local-db:orca-workflows:get-by-worker-session',
  'local-db:orca-workflows:list-workers-by-lead',
]);

/** Safe to retry after a peer reset; this does not grant permission or allow coalescing. */
export function isPeerResetRetryableReadChannel(channel: string): boolean {
  return PEER_RESET_RETRYABLE_READ_CHANNELS.has(channel);
}

/**
 * A completed invocation whose result authorization failed is a separate retry
 * boundary from peer reset, snapshot coalescing, and Host DB admission. Keep
 * this list explicit: list/get names do not prove the handler is read-only.
 * Bot and remote-resource reads can provision, migrate, or reconcile data.
 * The session list's derived backfills are guarded/idempotent; the other
 * entries only read stored session state or the active runtime snapshot.
 */
const COMPLETED_INVOKE_RETRYABLE_READ_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:sessions:get-many',
  'local-db:sessions:interrupted-pending',
  'maker:list-active',
]);

export function isCompletedInvokeRetryableReadChannel(channel: string | undefined): boolean {
  return channel !== undefined && COMPLETED_INVOKE_RETRYABLE_READ_CHANNELS.has(channel);
}

const COALESCIBLE_LISTING_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:sessions:list',
  'maker:get-capabilities',
  'maker:provider:list',
  'maker:git-safety:get',
  'maker:schedule:list-sidebar-index-runs',
]);

/**
 * Read freshness is independent of retry safety and Host background admission.
 * sessions:get is a read-after-write recovery boundary, so it never shares an
 * earlier read. A fresh list likewise must not join a snapshot begun before a write.
 */
export function canCoalesceRemoteListing(payload: InvokePayload | undefined): payload is InvokePayload {
  if (!payload || !COALESCIBLE_LISTING_CHANNELS.has(payload.channel)) return false;
  const options = payload.args?.[2];
  return !(payload.channel === 'local-db:sessions:list'
    && options && typeof options === 'object' && !Array.isArray(options)
    && (options as { fresh?: unknown }).fresh === true);
}
