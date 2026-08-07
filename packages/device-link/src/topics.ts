/**
 * device-link 推送 topic 路由(client-agnostic,被控端 + 未来 mobile/web 共享)。
 * ---------------------------------------------------------------------------
 * 远程控制把「控制端纯镜像 / 被控端单一真相」落到 push 流上:控制端按 **topic**
 * 订阅被控端的变更,被控端按 topic scoped 转发(只发订阅了该 topic 的控制端)。
 *
 * 两档 topic:
 *  - `sessions`(轻):会话**列表读模型**变更 —— 会话行的创建 / 元数据 patch
 *    (status/title/pinnedAt/model/effort/...) + 列表级实时活动摘要。侧边栏订阅它。低频。
 *  - `session:<id>`(重):**单个会话**的实时流 —— maker 事件 / 状态 / 输入投影 /
 *    交互审批 / 消息创建。打开该会话的视图才订阅它(= 活跃控制,触发被控横幅)。
 *
 * 为什么放在 `@cindy/device-link` 而非桌面 host:topic 语义是协议契约的一部分,
 * mobile/web 控制端要用**同一份**映射决定订阅什么、被控端要用它决定转发给谁。
 * 本文件零依赖、不 import 任何 app 内部模块(channel 名是字符串字面量,与
 * allowlist.ts 的 PUSH_FORWARD_ALLOWLIST 同源约定)。
 */

/**
 * 订阅 / 路由的 topic。
 *  - `sessions` = 列表读模型;
 *  - `session:<id>` = 单会话流;
 *  - `fs-watch:<workdir>` = 被控端某 workdir 的文件树变更流(远程文件浏览用)。
 *    与前两档不同,它是**订阅驱动**的:被控端在收到该 topic 订阅时才启动
 *    fs watch、最后一个订阅者退订/断链即停,没有常驻监听成本;不触发被控横幅
 *    (纯只读观察,活跃控制语义仍由 `session:<id>` 承担)。
 */
export type Topic = 'sessions' | `session:${string}` | `fs-watch:${string}`;

/** 被控端文件树变更事件的 push channel(与 desktop FILE_BROWSER_PUSH.EVENT 同名约定)。 */
export const FILE_BROWSER_EVENT_CHANNEL = 'maker:file-browser:event';

/** 远程文件浏览的聚合 invoke channel(单 channel:老被控端 CHANNEL_NOT_ALLOWED 即全无能力)。 */
export const FILE_BROWSER_REMOTE_OP_CHANNEL = 'file-browser:remote-op';

const FS_WATCH_TOPIC_PREFIX = 'fs-watch:';

export function fsWatchTopic(workdir: string): Topic {
  return `${FS_WATCH_TOPIC_PREFIX}${workdir}` as Topic;
}

/** 解析 fs-watch topic 的 workdir;非该档 topic 返回 null。 */
export function parseFsWatchTopic(topic: string): string | null {
  if (!topic.startsWith(FS_WATCH_TOPIC_PREFIX)) return null;
  const workdir = topic.slice(FS_WATCH_TOPIC_PREFIX.length);
  return workdir.length > 0 ? workdir : null;
}

export type SessionActivityPhase = 'running' | 'needs-interaction' | 'completed' | 'error';

export interface SessionActivityPayload {
  sessionId: string;
  phase: SessionActivityPhase;
  compactDetail: string;
  interactionKind?: string;
  attention?: boolean;
}

/** 会话列表级实时活动摘要 channel。归 `sessions` topic,不触发 active-control 横幅。 */
export const SESSION_ACTIVITY_CHANNEL = 'local-db:sessions:activity';

/**
 * 会话**列表级**读模型 channel:会话行的增 / 改。归 `sessions` topic。
 * `sessions:created` 只带 {sessionId}(无 row 数据)→ 控制端据此重拉列表;
 * `sessions:patched` 带 {sessionId, patch} → 控制端可直接 apply。
 * `session:error-persisted` 归 sessions topic:控制端未打开该会话时已取消订阅
 * `session:<id>`,若只走单会话 topic 信号会丢;sidebar 持续订阅 sessions topic
 * 保证任何控制端都能收到并把已缓存会话的 historyLoaded 置 false。
 */
const SESSION_LIST_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:sessions:created',
  'local-db:sessions:patched',
  'local-db:session:error-persisted',
  SESSION_ACTIVITY_CHANNEL,
  // session 终身累计 cost / token(sessions 行级字段的裸 UPDATE 补偿推送):归 sessions
  // topic 而非 session:<id> —— 会话未在控制端打开时 session:<id> 无人订阅,镜像会停在
  // 旧值,下次打开 chip 先显示过期累计;列表订阅常开保证镜像始终新鲜。低频(turn 结束
  // 各一条)、payload 极小。
  'usage:session-spend-changed',
  'usage:session-tokens-changed',
]);

/**
 * 账号 / 全局级 channel:不绑定单个会话,但列表订阅者需要(影响列表展示 / 控制端
 * 全局消费)。低频,并入 `sessions` topic 随列表订阅一起走,避免再开一档 topic。
 */
const ACCOUNT_CHANNELS: ReadonlySet<string> = new Set([
  // provider 目录是设备级快照；控制端订阅 sessions 后按来源 deviceId 精确刷新。
  'maker:provider:changed',
  'maker:schedule:event',
  'maker:project-automation:event',
  // 被控端「当前 New Maker 草稿」全量变更:账号 / 全局级(无 sessionId),并入 `sessions` topic
  // 随设备列表订阅一起走(控制端打开远程项目草稿时据此实时刷新),不另开一档 topic。
  'maker:new-maker-draft:changed',
  'maker:new-maker-worktree-branch:changed',
  // /learn run 状态机流转:payload = { type, run },run 同时关联触发会话与蒸馏会话
  // (状态卡两处都渲染),按单一 sessionId 路由会漏一边 → 按账号级并入 `sessions` topic
  // (低频状态机事件,量极小)。
  'learn:event',
]);

/** 从 unknown payload 安全读一个字符串字段。 */
function readStringField(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * 给定一条被控端广播(channel + payload),算出它属于哪个 topic;算不出返回 null
 * (调用方应丢弃,不转发)。这是 fan-out 路由的唯一依据。
 *
 *  - 列表级 / 账号级 channel → `sessions`
 *  - `maker:orca:worker-changed` → 顶层 `leadSessionId` → `session:<leadSessionId>`
 *  - 其余 session-scoped channel(maker:event / status / input:projection /
 *    interaction-request / interaction-dismissed / messages:created / turn cost)→
 *    顶层 `sessionId` → `session:<sessionId>`
 *  - 取不到 session 标识 → null
 */
export function topicForPush(channel: string, payload: unknown): Topic | null {
  if (SESSION_LIST_CHANNELS.has(channel) || ACCOUNT_CHANNELS.has(channel)) {
    return 'sessions';
  }
  if (channel === FILE_BROWSER_EVENT_CHANNEL) {
    // 文件树变更是 workdir 域(payload 无 sessionId),路由到 fs-watch:<workdir>。
    const workdir = readStringField(payload, 'workdir');
    return workdir ? fsWatchTopic(workdir) : null;
  }
  if (channel === 'maker:orca:worker-changed') {
    const lead = readStringField(payload, 'leadSessionId');
    return lead ? `session:${lead}` : null;
  }
  const sid = readStringField(payload, 'sessionId');
  return sid ? `session:${sid}` : null;
}
