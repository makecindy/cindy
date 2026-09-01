/**
 * dispatch —— device-link 被控端隧道层。
 *
 * 职责:
 *  1. 订阅 DeviceLinkClient 入站帧:link-open / link-close / invoke
 *  2. **订阅 registry(subscriptions.ts)**:控制端按 topic 订阅本机变更,本机按
 *     topic scoped 把 renderer 广播转发给订阅者。两类入口:
 *       - 新控制端:`device-link:subscribe`/`unsubscribe`(走 invoke 帧,在此拦截,
 *         用 env.src 作 controllerDeviceId,防伪造)
 *       - 老控制端:`link-open`(无 subscribe 能力)→ 视作订阅 legacy `'*'`(全量+横幅)
 *  3. invoke:双层校验(被控开关 + allowlist)→ dispatchLocalInvoke → 回 invoke-result;
 *     被控端 handler 抛的 throwIpcError `[CODE] message` 原样透传
 *  4. push 转发:broadcast-tap 命中的事件按 topicForPush 路由 → 只发订阅了该 topic 的控制端
 *     (heavy 的 `session:<id>` 流只发打开该会话的控制端;`sessions` 列表流只发侧边栏订阅者)
 *  5. 被控横幅:仅当 registry 存在 `session:<id>` / legacy `'*'` 订阅者(=活跃控制)才亮;
 *     纯 `sessions`(只看列表)订阅者不触发横幅
 *
 * 安全:开关关闭时 server 已拒转发 link-open/invoke(第一道);此处执行前再查
 * 本地 settings(第二道),server 缓存陈旧 / 被绕过时兜底。
 */

import {
  computeAllowlistHash,
  INVOKE_TIMEOUT_OVERRIDES_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  REMOTE_INVOKE_ALLOWLIST,
  REMOTE_REVIEW_EXTERNAL_INPUT_CHANNELS,
  topicForPush,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  DL_MEDIA_FETCH_CHANNEL,
  DL_VOICE_TRANSCRIBE_CHANNEL,
  DL_VOICE_CREDENTIAL_SYNC_CHANNEL,
  DL_VOICE_DICTIONARY_LEARNING_CHANNEL,
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  DL_VOICE_DICTIONARY_GET_CHANNEL,
  DL_TELEGRAM_STATUS_CHANNEL,
  DL_TELEGRAM_SET_ONLINE_CHANNEL,
  SESSION_ACTIVITY_CHANNEL,
  MAKER_EVENT_BATCH_CHANNEL,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  byteLength,
  DeviceLinkError,
  parseFsWatchTopic,
  type Envelope,
  type DeviceLinkPeerRouteStateChanged,
  type InvokePayload,
  type InvokeResultPayload,
  type LinkClosePayload,
  type LinkOpenPayload,
  type MakerEventBatchPayload,
  type PushOwnerStamp,
  type Topic,
} from '@cindy/device-link';
import {
  DEVICE_LINK_RECONCILIATION_PROBE_MARKER,
  type MobileVoiceDictionaryLearningRequest,
} from '@cindy/maker-shared/device-link-contract';
import {
  resolveProviderLogoKind,
  type ProviderLogoKind,
  type ProviderLogoRouting,
} from '@cindy/model-providers/branding';
import { app } from 'electron';
import type { DeviceLinkClient } from '@cindy/device-link';
import { createLogger } from '../logger';
import { normalizeSessionProviderId } from '../maker-host/session-provider-store.js';
import { readDeviceLinkSettings } from './settings-store';
import { dispatchLocalInvoke } from './invoke-registry';
import { getControllerPlatform } from './controllerPlatform';
import { runDeviceLinkInvokeContext } from './invoke-context';
import { fetchLocalMediaToOss } from './mediaFetch';
import { transcribeRemoteVoiceInput } from './voiceTranscribe';
import { readTelegramRemoteStatus, setTelegramRemoteOnline } from './telegramRemoteControl';
import { adviseAndRecordVoiceInputDictionaryLearning } from '../voice-input/index.js';
import { buildMobileDictionarySnapshot } from '../voice-input/dictionarySyncDriver.js';
import {
  setBroadcastTapListener,
} from './broadcast-tap';
import * as broadcastTap from './broadcast-tap';
import { createOfflinePushQueue } from './offlinePushQueue';
import * as subscriptions from './subscriptions';
import { LEGACY_TOPIC, type ActiveController } from './subscriptions';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { RECOVERY_CHECKPOINT_MARKER } from '../maker-ipc/recoveryCoordinator.js';
import {
  projectInteractionDismissedForRemote,
  projectInteractionRequestForRemote,
} from '../cindy-brain/ghostSetupInteractionBridge.js';
import {
  remoteWorkingDirRejectionToIpcError,
  type RemoteWorkingDirCheckResult,
} from './remote-workdir-guard';

const log = createLogger('device-link-dispatch');

/**
 * 老版本 mobile 只认识 #527 之前已发布的 logo kind。新 mark 可由同版本客户端按
 * provider id 自行解析，但不能作为新 wire enum 发给独立更新的旧控制端。
 */
const LEGACY_DEVICE_LINK_LOGO_KINDS: ReadonlySet<ProviderLogoKind> = new Set([
  'anthropic',
  'openai',
  'xd',
  'xai',
  'openrouter',
  'deepseek',
  'zhipu',
  'zai',
  'moonshot',
  'minimax',
  'alibaba',
]);

/** 控制端名展示上限,挡掉远端塞超长字符串撑爆被控端状态条 */
const MAX_CONTROLLER_NAME_LEN = 64;
const MAX_CONTROLLER_CAPABILITIES = 32;
const MAX_CONTROLLER_CAPABILITY_LEN = 80;
const REMOTE_MESSAGE_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:messages:list',
  'local-db:messages:around',
  'local-db:messages:around-client-id',
]);
const REMOTE_MESSAGE_CONTENT_LIMIT = 128 * 1024;
const REMOTE_TOOL_RESULT_CONTENT_LIMIT = 8 * 1024;
const REMOTE_TOOL_USE_INPUT_STRING_LIMIT = 4 * 1024;
const REMOTE_TOOL_USE_FORCED_INPUT_STRING_LIMIT = 512;
const REMOTE_TOOL_USE_METADATA_STRING_LIMIT = 1024;
const REMOTE_INVOKE_TRUNCATION_SUFFIX = '\n\n[remote content truncated: payload too large]';
const REMOTE_INVOKE_TRUNCATED_CONTENT = '[remote content truncated: payload too large]';
const REMOTE_INVOKE_FRAME_SAFETY_BYTES = 1024;
// Remote project viewers reconcile this list on a timer. Treating that background read as
// interactive activity would refresh the updater quiet period forever for sessions-only viewers.
const UPDATE_RELAUNCH_NON_BLOCKING_INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:sessions:list',
]);
const textEncoder = new TextEncoder();
const offlinePushQueue = createOfflinePushQueue();

/** 只排队可由 session snapshot 对账、且不携带权限终态的会话域事件。 */
const OFFLINE_QUEUEABLE_PUSH_CHANNELS: ReadonlySet<string> = new Set([
  'local-db:messages:created',
  'local-db:messages:deleted',
  'local-db:session:error-persisted',
  'maker:event',
  'maker:status-changed',
  'maker:interaction-request',
  'maker:interaction-dismissed',
  'maker:input:projection',
  'maker:goal:status-changed',
  'usage:message-turn-cost',
  'usage:message-model-mismatch',
]);

/** wire 输入 fail-closed：未知形状视为空能力集，并限制数量/长度避免撑大常驻 registry。 */
function sanitizeControllerCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== 'string'
      || item.length === 0
      || item.length > MAX_CONTROLLER_CAPABILITY_LEN
      || seen.has(item)
    ) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_CONTROLLER_CAPABILITIES) break;
  }
  return out;
}

function invokeControllerCapabilities(payload: InvokePayload): string[] {
  const metadata = payload.args?.[0];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  return sanitizeControllerCapabilities(
    (metadata as { capabilities?: unknown }).capabilities,
  );
}

function optionalControllerCapabilities(
  value: { capabilities?: unknown },
): string[] | undefined {
  return Object.prototype.hasOwnProperty.call(value, 'capabilities')
    ? sanitizeControllerCapabilities(value.capabilities)
    : undefined;
}

/** 远控 push 的紧凑重试预算:只在首发超 2MB 后使用,避免大 tool 输出反复打爆 relay 帧。 */
const REMOTE_PUSH_TEXT_BUDGET_CHARS = 160_000;
const REMOTE_PUSH_MAX_DEPTH = 8;
const REMOTE_PUSH_MAX_ARRAY_ITEMS = 80;
const REMOTE_PUSH_MAX_OBJECT_KEYS = 120;
const REMOTE_PUSH_TRUNCATED_TEXT = '[device-link truncated]';

/** 控制本机的控制端信息(被控端可见性状态条用)—— 定义在 subscriptions.ts。 */
export type { ActiveController } from './subscriptions';

/**
 * 需要对路径参数做收敛的 channel → args[0] 里的路径字段名。见 remote-workdir-guard。
 *
 * - `maker:create-session`:args[0].workingDir 决定 agent 在被控端哪个目录起进程。
 * - `worktree:create`:args[0].baseRepo 决定在被控端哪个仓库下执行 git worktree add,
 *   与 create-session 同口径收敛(worktree 路径本身由被控端从 baseRepo 派生,不受控制端指定)。
 *
 * `maker:fork` **不在此列**——其 invoke 签名是 `(sourceSessionId, messageClientId)`,没有
 * workingDir 参数(目录继承自源会话,即被控端自有目录),控制端无法借它指定任意路径,
 * 故无需(也无法)在此收敛。
 */
const PATH_GUARDED_CHANNELS: ReadonlyMap<string, 'workingDir' | 'baseRepo'> = new Map([
  ['maker:create-session', 'workingDir'],
  ['worktree:create', 'baseRepo'],
]);

type RemoteWorkingDirGuardValue = boolean | RemoteWorkingDirCheckResult;

/** host 注入的 workingDir 校验器(null = 未注入,放行;布尔返回值仅作旧测试兼容) */
let workingDirGuard: ((dir: string) => RemoteWorkingDirGuardValue | Promise<RemoteWorkingDirGuardValue>) | null = null;

type RemoteReviewInputGuard = (sessionId: string) => void | Promise<void>;

/** Main injects the DB-backed sessions.source authorization check once ready. */
let remoteReviewInputGuard: RemoteReviewInputGuard | null = null;

/** 注入远程 create-session/worktree:create 的本地目录校验器(register.ts 在 maker 就绪后接入)。 */
export function setRemoteWorkingDirGuard(
  guard: ((dir: string) => RemoteWorkingDirGuardValue | Promise<RemoteWorkingDirGuardValue>) | null,
): void {
  workingDirGuard = guard;
}

export function setRemoteReviewInputGuard(guard: RemoteReviewInputGuard | null): void {
  remoteReviewInputGuard = guard;
}

/** 从 args[0] 里取待收敛的路径字段(见 PATH_GUARDED_CHANNELS);取不到返回 null。 */
function extractGuardedPath(args: unknown[], field: 'workingDir' | 'baseRepo'): string | null {
  const o = args[0];
  if (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[field] === 'string') {
    const dir = (o as Record<string, string>)[field];
    return dir.trim() ? dir : null;
  }
  return null;
}

/**
 * 远程 set-* 成功后回流持久化(register.ts 在 maker 就绪后注入)。被控端大多数
 * set-* 是 runtime-only,这里补一次写被控端 DB + 广播 sessions:patched。SET_MODEL
 * 生产 handler 为了与队列 drain 原子化，会在 session 锁内先持久化并标记结果，
 * 这里只保留给最小/旧 handler 的兼容回流。调用方会等待持久化完成后才回
 * invoke-result，让控制端只在被控端 DB 已确认后同步新聊天草稿默认值。
 */
type RemoteSettingsPersist = (
  sessionId: string,
  patch: Record<string, unknown>,
) => void | Promise<void>;

let settingsPersist: RemoteSettingsPersist | null = null;

// SET_MODEL 需要把 runtime + DB 持久化放在同一把 session 锁内。handler 会在锁内
// 完成持久化后标记返回对象；dispatch 仍保留通用回流逻辑给其它 set-* 和
// 最小/旧 handler，但不得对已原子持久化的结果再写一次。WeakSet 标记不进 wire。
const settingsPersistedInsideHandler = new WeakSet<object>();

export function markRemoteSettingPersistedInsideHandler(result: object): void {
  settingsPersistedInsideHandler.add(result);
}

export function setRemoteSettingsPersist(fn: RemoteSettingsPersist | null): void {
  settingsPersist = fn;
}

/** set-* channel → 持久化的 session 字段名(args[0]=sessionId, args[1]=value)。 */
const SET_CHANNEL_FIELD: Record<string, 'model' | 'effort' | 'permissionMode' | 'fastMode' | 'planModeEnabled' | 'extraDirs' | 'writableDirs'> = {
  'maker:set-model': 'model',
  'maker:set-effort': 'effort',
  'maker:set-permission-mode': 'permissionMode',
  'maker:set-fast-mode': 'fastMode',
  'maker:set-plan-mode': 'planModeEnabled',
  'maker:set-extra-dirs': 'extraDirs',
  'maker:set-writable-dirs': 'writableDirs',
};

async function persistRemoteSetting(channel: string, args: unknown[], result: unknown): Promise<void> {
  const field = SET_CHANNEL_FIELD[channel];
  if (!field || !settingsPersist) return;
  if (
    result !== null &&
    typeof result === 'object' &&
    settingsPersistedInsideHandler.has(result)
  ) {
    return;
  }
  const sessionId = args[0];
  if (typeof sessionId !== 'string') return;
  // extraDirs 特例:set-extra-dirs handler 会按被控端 workingDir 校验、只应用 validation.valid,
  // 请求值 != 生效值(控制端选的路径在被控端常被拒或不存在)。必须持久化 handler 实际应用的子集
  // (其返回值),否则被控端 DB 会写进会话从未接受的目录,未来 resume 加载到不可用 extraDirs。
  // handler no-op(session 不在 / capability 不支持)时返回 undefined → 不持久化。
  if (channel === 'maker:set-extra-dirs') {
    if (!Array.isArray(result)) return;
    await settingsPersist(sessionId, { extraDirs: result });
    return;
  }
  if (channel === 'maker:set-writable-dirs') {
    if (!Array.isArray(result)) return;
    await settingsPersist(sessionId, { writableDirs: result });
    return;
  }
  // set-model 特例:可携带第 3 参 providerId(per-session 来源选择,见 register.ts SET_MODEL handler)。
  // 必须把它一并持久化进被控端 DB.provider_id,否则远程切来源只进了 runtime store、跨重启/resume 丢
  // (G2)。与被控端 handler 同语义:args[2]===undefined(老 2 参调用)不动 provider_id;string→写;
  // null/''→清除(回落默认路由)。写进 DB 后 mapper 自动带进 sessions:patched → 回流控制端镜像。
  if (channel === 'maker:set-model') {
    // 同引擎重选的第二段带 host revision CAS。handler 返回 superseded 表示
    // 另一控制端已在两段之间更新过意图：runtime 未应用，DB 也必须同样不落
    // 这次请求参数，否则 sessions:patched 会把过期选择反向盖回控制端。
    if (
      result !== null &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      (result as { superseded?: unknown }).superseded === true
    ) {
      return;
    }
    const patch: Record<string, unknown> = { model: args[1] };
    if (args.length > 2) {
      patch.providerId = normalizeSessionProviderId(typeof args[2] === 'string' ? args[2] : null);
    }
    await settingsPersist(sessionId, patch);
    return;
  }
  // 其余 set-*(effort/permissionMode/fastMode)原样存储(不 clamp/转换),请求值 == 生效值,
  // 直接持久化请求值,避免给热路径加一次回读。被控端 DB 始终是单一真相源。
  await settingsPersist(sessionId, { [field]: args[1] });
}

/**
 * routing 投影:剥掉每个 agent 路由的执行细节(upstream / authStrategy / headerDelete /
 * headerOverride / modelIdRewrite / adapter,含自定义供应商 endpoint),只保留非敏感的
 * `wireProtocol:'openai-chat'` 展示标记与 `disabled:true` 可用性门控。后者必须跨端保留，
 * 否则控制端用共享 registry 重算来源时会把被控端禁用的 runtime 重新当成可选。
 *
 * 历史上这里曾保留 `routing.supportsFastMode` 给控制端做 Fast 显隐;现 Fast 能力已收归
 * per-(provider, agent) 的 `models[agent].supportsFastMode`(唯一真相),控制端直接从隧道带来的
 * `models` 现查(见 ModelSelector），不再读 routing；routing 只承载上述两项跨端展示/可用性字段。
 */
function projectRoutingForDisplay(
  routing: unknown,
): Record<string, { wireProtocol?: 'openai-chat'; disabled?: true }> | undefined {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return undefined;
  const out: Record<string, { wireProtocol?: 'openai-chat'; disabled?: true }> = {};
  for (const [agent, value] of Object.entries(routing as Record<string, unknown>)) {
    const route = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    // 只暴露控制端需要的「Cindy 桥接」标记与禁用门控。原生协议/启用态缺省不回传；
    // endpoint、鉴权、headers、adapter 等执行字段仍全部留在被控端。
    out[agent] = {
      ...(route?.wireProtocol === 'openai-chat' ? { wireProtocol: 'openai-chat' as const } : {}),
      ...(route?.disabled === true ? { disabled: true as const } : {}),
    };
  }
  return out;
}

/**
 * Mobile consumes the device-link provider catalog as an executable model list. Paid-only rows are
 * a Desktop upsell projection, not a cross-device model state: omit them and strip the v5-only
 * availability marker so both current and independently-updated legacy Mobile clients keep the
 * published provider model shape.
 */
function projectModelsForController(models: unknown): unknown {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return models;
  return Object.fromEntries(
    Object.entries(models as Record<string, unknown>).map(([agent, value]) => {
      if (!Array.isArray(value)) return [agent, value];
      const projected = value.flatMap((model) => {
        if (!model || typeof model !== 'object' || Array.isArray(model)) return [model];
        const { availability, ...legacyModel } = model as Record<string, unknown>;
        return availability === 'requires_payment' ? [] : [legacyModel];
      });
      return [agent, projected];
    }),
  );
}

/**
 * 隧道返回投影:`maker:provider:list` 只回「显示用」字段——先从 provider id / upstream
 * 解析非敏感 `logoKind`,再剥掉每个 provider 的 `routing` 执行字段(upstream /
 * authStrategy / 密钥策略 / 自定义供应商 endpoint 等)。执行细节(路由 / 密钥)不出被控端
 * (控制端只渲染、不执行,见设计文档 D3),但用户重命名 preset 后手机仍能按 logoKind 展示
 * 正确品牌。Fast 显隐由控制端从隧道带来的 `models[agent].supportsFastMode` 现查；
 * 模型显示 override 快照同样属于非敏感展示状态，需随目录投影给控制端。
 * 其它通道原样返回。
 */
function projectInvokeResultForTunnel(
  channel: string,
  result: unknown,
  supportsFullLogoKinds = false,
): unknown {
  if (channel !== 'maker:provider:list') return result;
  const r = result as { providers?: unknown; modelVisibilityOverrides?: unknown };
  if (!Array.isArray(r.providers)) return result;
  const providers = (r.providers as Record<string, unknown>[]).map((p) => {
    const rest = { ...p };
    const logoKind = typeof p.id === 'string'
      ? resolveProviderLogoKind(p.id, p.routing as ProviderLogoRouting | undefined)
      : null;
    // Never trust/pass through an arbitrary pre-existing value: only shared resolver output crosses.
    delete rest.logoKind;
    if (
      logoKind
      && (supportsFullLogoKinds || LEGACY_DEVICE_LINK_LOGO_KINDS.has(logoKind))
    ) {
      rest.logoKind = logoKind;
    }
    rest.models = projectModelsForController(p.models);
    rest.routing = projectRoutingForDisplay(p.routing);
    return rest;
  });
  const modelVisibilityOverrides = r.modelVisibilityOverrides
    && typeof r.modelVisibilityOverrides === 'object'
    && !Array.isArray(r.modelVisibilityOverrides)
    ? Object.fromEntries(
        Object.entries(r.modelVisibilityOverrides)
          .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      )
    : undefined;
  return {
    providers,
    ...(modelVisibilityOverrides !== undefined ? { modelVisibilityOverrides } : {}),
  };
}

/** 持有 client 的引用(转发 push 用);wireInboundDispatch 接入时设置。 */
let activeClient: DeviceLinkClient | null = null;

/**
 * presence「显式离线」判据(index.ts 接线,那里持有权威 presence 视图):返回 true
 * 仅当**当代** presence 明确宣告该设备离线;未知一律返回 false —— fail-open,不把
 * 恢复窗口的首发拦死(判据刻意不跨连接代记忆,理由见 index.ts 的同名函数注释)。
 *
 * outbox **全量** flush 据此跳过注定 DEVICE_OFFLINE 的盲发:relay 在线时全量轮每
 * REMOTE_INVOKE_RESULT_OUTBOX_RETRY_MS(500ms)跑一次,对 presence 已明说离线的
 * 控制端就是 2 帧/秒的稳定无效出站,一直持续到 TTL 出清——只喂 relay 聚合背压
 * (2026-08-08 事故的第四层失效面,见 docs/dev-rules/remote-and-mobile-adaptation.md)。
 * 条目保留不丢,恢复由该控制端 link-open 触发的定向 flush
 * (flushRemoteInvokeResultOutbox(src),不受本门禁约束)与 presence 翻回 online 后的
 * 全量轮接棒。
 */
let presenceOfflineCheck: ((deviceId: string) => boolean) | null = null;

export function setDispatchPresenceOfflineCheck(
  check: ((deviceId: string) => boolean) | null,
): void {
  presenceOfflineCheck = check;
}

/**
 * 门禁的唯一不变量:**只在 relay 确定路由不到时抑制发送**;同代内任何比 presence
 * 更新的可达证据都必须让位给发送(fail-open),且该证据不得跨连接代存活。
 *
 * 这里的「更新的证据」就是 `acceptedLinkControllers`——它记录「link-accept 已成功、
 * 尚未显式 close」的控制端,而它的增删边正好覆盖两侧:link-accept 成功即加入
 * (那一刻 relay 确实路由到了它),link-close / 撤权 / presence 宣告离线
 * (handleControllerOffline)/ teardown 立刻移除。于是「有 accepted link」天然表示
 * 「已建链,且 presence 此后没有再说它离线」——不需要任何新状态或时间戳,证据由
 * 权威源自己回收。
 *
 * 它关掉的具体缺口(codex review,同族第 3 次):presence 在同一代内滞后停留在
 * false、控制端已 link-open 回归时,定向 flush 的首发若被 BACKPRESSURE 打回,末尾
 * 排的重试是**无参全量轮**、丢掉 onlySrc 证据,于是这个已建链的 peer 会被持续跳过
 * 到 presence 更新或 TTL 丢结果。判据里带上 accepted link 后,那一轮直接 fail-open。
 */
function isKnownUnroutable(deviceId: string): boolean {
  if (!presenceOfflineCheck?.(deviceId)) return false;
  return !acceptedLinkControllers.has(deviceId);
}

/** 订阅集合变化时一次性通知 host UI 控制态与更新重启安全态。 */
type ControllersChangedListener = (
  controllers: ActiveController[],
  updateRelaunchControllers: ActiveController[],
) => void;
let onControllersChanged: ControllersChangedListener | null = null;

/** 非订阅类远程 invoke 在途状态；用于给无人值守更新持有短期 busy lease。 */
type RemoteInvokeBusyChangedListener = (busy: boolean) => void;
let onRemoteInvokeBusyChanged: RemoteInvokeBusyChangedListener | null = null;
let inFlightRemoteInvokeCount = 0;
const REMOTE_INVOKE_IN_FLIGHT_LIMIT = 64;
/**
 * Keep one slow controller from consuming the entire target-device budget.
 * The global limit still protects the host, while this per-controller slice
 * guarantees admission for other linked controllers.
 */
const REMOTE_INVOKE_IN_FLIGHT_PER_CONTROLLER_LIMIT = 16;
const REMOTE_INVOKE_IN_FLIGHT_BYTES = 16 * 1024 * 1024;
const REMOTE_INVOKE_IN_FLIGHT_PER_CONTROLLER_BYTES = 4 * 1024 * 1024;
const REMOTE_INVOKE_RESULT_CACHE_LIMIT = 128;
const REMOTE_INVOKE_RESULT_CACHE_BYTES = 16 * 1024 * 1024;
/** 本地发送背压时保留已执行结果；与 transport pending 分层且同样严格有界。 */
const REMOTE_INVOKE_RESULT_OUTBOX_LIMIT = 64;
const REMOTE_INVOKE_RESULT_OUTBOX_PER_CONTROLLER_LIMIT = 16;
const REMOTE_INVOKE_RESULT_OUTBOX_BYTES = 16 * 1024 * 1024;
const REMOTE_INVOKE_RESULT_OUTBOX_PER_CONTROLLER_BYTES = 4 * 1024 * 1024;
const REMOTE_INVOKE_RESULT_OUTBOX_RETRY_MS = 500;
/**
 * relay 离线期间 outbox 不再按 500ms 盲自旋(每轮对每个 peer trySend → 必然抛
 * NOT_CONNECTED,空转最长两分钟、日志噪音掩盖真问题):离线时只按慢节奏做 TTL
 * 出清,真正的投递由事件驱动 —— ws-online 全量 flush(index.ts 接线)、link-open /
 * subscribe 定向 flush(已有)。
 */
const REMOTE_INVOKE_RESULT_OUTBOX_OFFLINE_SWEEP_MS = 5_000;
/** 默认远程调用客户端等待预算(缺省 30s;无超时覆盖的 channel 用此值,与 allowlist 注释一致)。 */
const DEFAULT_REMOTE_INVOKE_CLIENT_WAIT_MS = 30_000;
const REMOTE_INVOKE_MAX_CLIENT_WAIT_MS = Math.max(
  DEFAULT_REMOTE_INVOKE_CLIENT_WAIT_MS,
  ...Object.values(INVOKE_TIMEOUT_OVERRIDES_MS),
);
/** 再保留一轮同等重连窗口后才放弃无人等待的回包(全局上限;逐条按 channel 收窄)。 */
const REMOTE_INVOKE_RESULT_OUTBOX_MAX_AGE_MS = REMOTE_INVOKE_MAX_CLIENT_WAIT_MS * 2;

/**
 * outbox 条目的逐 channel 保留时长:控制端对该 channel 的等待预算(两端共享
 * INVOKE_TIMEOUT_OVERRIDES_MS,缺省默认预算)× 2(再留一轮重连窗口),封顶全局上限。
 * 控制端超时后不会再认领旧 requestId 的回包(重发用新 id),listing 类回包在
 * 弱网时段最多占 outbox 两分钟纯属浪费配额;长任务 channel(60s 预算)自动保留
 * 更久。控制端可能配置更短的超时(mobile 15s),推断值只偏保守、不早丢。
 */
function outboxEntryMaxAgeMs(channel: string | undefined): number {
  const budgetMs =
    (channel && INVOKE_TIMEOUT_OVERRIDES_MS[channel]) || DEFAULT_REMOTE_INVOKE_CLIENT_WAIT_MS;
  return Math.min(budgetMs * 2, REMOTE_INVOKE_RESULT_OUTBOX_MAX_AGE_MS);
}
/**
 * ipcMain handler 没有统一 AbortSignal，不能在 30s 客户端超时时假装取消副作用。
 * 这里只在远超控制端等待窗后回收本地 bookkeeping；底层 Promise 仍带 catch 并允许自行收尾。
 */
const REMOTE_INVOKE_ORPHAN_TIMEOUT_MS = REMOTE_INVOKE_MAX_CLIENT_WAIT_MS * 2;
/**
 * 逐 channel 收窄(codex P2):orphan 截止时间按「该 channel 的控制端等待预算 × 2」取,
 * 被全局上限(REMOTE_INVOKE_ORPHAN_TIMEOUT_MS)封顶,与 outboxEntryMaxAgeMs 同款。
 * 否则 maker:compact-session 的 11min 覆盖会把全局 orphan 拉高到 22min——任何挂起的
 * 默认 30s handler 都会占满 controller 的 in-flight 配额整整 22 分钟,后续远程控制
 * 动作看起来卡住(BACKPRESSURE)。
 */
function remoteInvokeOrphanTimeoutMs(channel: string | undefined): number {
  const budgetMs =
    (channel && INVOKE_TIMEOUT_OVERRIDES_MS[channel]) || DEFAULT_REMOTE_INVOKE_CLIENT_WAIT_MS;
  return Math.min(budgetMs * 2, REMOTE_INVOKE_ORPHAN_TIMEOUT_MS);
}
interface CachedRemoteInvokeResult {
  result: InvokeResultPayload;
  bytes: number;
  fingerprint: string;
}
const completedRemoteInvokeResults = new Map<string, CachedRemoteInvokeResult>();
let completedRemoteInvokeResultBytes = 0;
interface InFlightRemoteInvoke {
  promise: Promise<InvokeResultPayload>;
  bytes: number;
  fingerprint: string;
  linkEpoch: number;
}
const inFlightRemoteInvokeResults = new Map<string, InFlightRemoteInvoke>();
let inFlightRemoteInvokeBytes = 0;
interface QueuedRemoteInvokeResult {
  src: string;
  requestId: string;
  result: InvokeResultPayload;
  channel?: string;
  args?: unknown[];
  fingerprint?: string;
  bytes: number;
  queuedAt: number;
}
const remoteInvokeResultOutbox = new Map<string, QueuedRemoteInvokeResult>();
let remoteInvokeResultOutboxBytes = 0;
let remoteInvokeResultOutboxTimer: ReturnType<typeof setTimeout> | null = null;
/** 显式 link-close/撤权世代；旧世代仍在执行的 IPC 完成后不得把结果送进新链路。 */
const remoteInvokeLinkEpoch = new Map<string, number>();
/** Controllers that have demonstrated topic-subscription support in this process/account epoch. */
const topicSubscriptionControllers = new Set<string>();
/** 已成功 accept、尚未显式 close 的控制端；可无 active topic(现代重连等待 subscribe)。 */
const acceptedLinkControllers = new Set<string>();
/**
 * 当前 active controller 所属的 relay connection generation。
 * DEVICE_OFFLINE 事件带 generation，旧 socket 的迟到事实不能清掉新链路。
 */
const controllerConnectionEpochByDevice = new Map<string, number>();
/** 同一 relay connection 内最近一次成功接受的 controller link 代次。 */
const controllerLinkGenerationByDevice = new Map<string, number>();
/**
 * relay presence 按 server 盖章的 deviceId 提供设备数据库展示名。它比控制端在
 * link-open / subscribe 里自报的主机名更权威，用于让被控提示与设备列表一致。
 * 仅作展示，不参与任何授权判断；账号 / 链路边界由 host 显式清空。
 */
const controllerDisplayNameByDevice = new Map<string, string>();
/** 控制帧自报名称仅作数据库展示名缺失时的兼容回退。 */
const reportedControllerNameByDevice = new Map<string, string>();

/** `sessions` 订阅出现时通知 host replay 当前列表级轻量状态。 */
type SessionsSubscribedListener = (controllerDeviceId: string) => void;
let onSessionsSubscribed: SessionsSubscribedListener | null = null;

export function setControllersChangedListener(cb: ControllersChangedListener | null): void {
  onControllersChanged = cb;
}

export function setRemoteInvokeBusyChangedListener(
  cb: RemoteInvokeBusyChangedListener | null,
): void {
  onRemoteInvokeBusyChanged = cb;
}

export function setSessionsSubscribedListener(cb: SessionsSubscribedListener | null): void {
  onSessionsSubscribed = cb;
}

function normalizeControllerName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, MAX_CONTROLLER_NAME_LEN)
    : undefined;
}

function resolveControllerName(deviceId: string, reportedName: unknown): string | undefined {
  const normalizedReportedName = normalizeControllerName(reportedName);
  if (normalizedReportedName) {
    reportedControllerNameByDevice.set(deviceId, normalizedReportedName);
  }
  return controllerDisplayNameByDevice.get(deviceId)
    ?? normalizedReportedName
    ?? reportedControllerNameByDevice.get(deviceId);
}

function clearReportedControllerName(deviceId: string): void {
  reportedControllerNameByDevice.delete(deviceId);
}

function readConnectionEpoch(client: DeviceLinkClient): number | undefined {
  const candidate = client as DeviceLinkClient & {
    getConnectionEpoch?: () => number;
  };
  return candidate.getConnectionEpoch?.();
}

function markControllerLinkActive(client: DeviceLinkClient, deviceId: string): void {
  const epoch = readConnectionEpoch(client);
  if (epoch !== undefined) controllerConnectionEpochByDevice.set(deviceId, epoch);
  const candidate = client as DeviceLinkClient & {
    getPeerLinkGeneration?: (peerDeviceId: string) => number;
  };
  const linkGeneration = candidate.getPeerLinkGeneration?.(deviceId);
  if (linkGeneration !== undefined) {
    controllerLinkGenerationByDevice.set(deviceId, linkGeneration);
  }
}

/**
 * presence 设备名变化(含设置页重命名)时更新展示真相；已有活跃订阅立即重发
 * controlled-state，让横幅不用等下一次 subscribe / 重连才改名。
 */
export function setControllerDisplayName(deviceId: string, name: string): void {
  const normalized = normalizeControllerName(name);
  if (normalized) {
    if (controllerDisplayNameByDevice.get(deviceId) === normalized) return;
    controllerDisplayNameByDevice.set(deviceId, normalized);
  } else {
    controllerDisplayNameByDevice.delete(deviceId);
  }
  const displayName = normalized
    ?? reportedControllerNameByDevice.get(deviceId)
    ?? deviceId.slice(0, 8);
  if (subscriptions.updateControllerMetadata(deviceId, displayName)) syncForwarding();
}

/**
 * 旧 relay presence 的主机名只刷新当前横幅，不进入数据库名或控制帧自报名缓存。
 * 已有权威名或链路自报名时保持原优先级；断链后 metadata 随订阅一起失效。
 */
export function setControllerFallbackDisplayName(deviceId: string, name: string): void {
  const normalized = normalizeControllerName(name);
  if (
    !normalized
    || controllerDisplayNameByDevice.has(deviceId)
    || reportedControllerNameByDevice.has(deviceId)
  ) {
    return;
  }
  if (subscriptions.updateControllerMetadata(deviceId, normalized)) syncForwarding();
}

/** 账号切换 / 链路 teardown 时清空 presence 展示名，避免串到下一段身份。 */
export function clearControllerDisplayNames(): void {
  controllerDisplayNameByDevice.clear();
  reportedControllerNameByDevice.clear();
}

export function getActiveControllers(): ActiveController[] {
  return subscriptions.getControlControllers();
}

export function getUpdateRelaunchControllers(): ActiveController[] {
  return subscriptions.getUpdateRelaunchControllers();
}

export function hasInFlightRemoteInvokes(): boolean {
  return inFlightRemoteInvokeCount > 0;
}

function notifyRemoteInvokeBusyChanged(busy: boolean): void {
  try {
    onRemoteInvokeBusyChanged?.(busy);
  } catch (err) {
    log.warn(`remote invoke busy listener failed: ${String(err)}`);
  }
}

function acquireRemoteInvokeBusyLease(): () => void {
  const wasBusy = hasInFlightRemoteInvokes();
  inFlightRemoteInvokeCount += 1;
  if (!wasBusy) notifyRemoteInvokeBusyChanged(true);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightRemoteInvokeCount = Math.max(0, inFlightRemoteInvokeCount - 1);
    if (!hasInFlightRemoteInvokes()) notifyRemoteInvokeBusyChanged(false);
  };
}

function shouldAcquireRemoteInvokeBusyLease(
  src: string,
  payload: InvokePayload | undefined,
): boolean {
  if (!payload || typeof payload.channel !== 'string') return false;
  if (!readDeviceLinkSettings().remoteControlEnabled) return false;
  if (isControllerRevoked(src)) return false;
  if (!REMOTE_INVOKE_ALLOWLIST.has(payload.channel)) return false;
  if (
    payload.channel === 'local-db:sessions:get' &&
    payload.args?.[1] === DEVICE_LINK_RECONCILIATION_PROBE_MARKER
  ) {
    return false;
  }
  return !UPDATE_RELAUNCH_NON_BLOCKING_INVOKE_CHANNELS.has(payload.channel);
}

function notifySessionsSubscribed(controllerDeviceId: string): void {
  try {
    onSessionsSubscribed?.(controllerDeviceId);
  } catch (err) {
    log.warn(`sessions subscribe replay failed for ${shortId(controllerDeviceId)}: ${String(err)}`);
  }
}

// ─── 会话活动出站整流(latest-wins 键控暂存) ────────────────────────────
//
// sessions:activity 是纯状态镜像:同一会话只有**最新值**有意义。把每个事件帧
// 直接塞进 per-peer 可靠传输窗口(64 槽单 FIFO)会在 replay/爆发时占满窗口,
// 把 subscribe 的 invoke-result(控制端判定被控端存活的唯一凭据)挤到饿死——
// v0.1.26 线上:一毫秒 76 帧 replay → 回包排不进窗口 → 手机 15s 超时重订阅 →
// 每次重订阅再触发一轮 replay,拥塞自放大。这里按 (控制端, sessionId) 键控暂存,
// 只保留最新值,并在窗口占用超过软上限时停止灌入、退避重试:爆发量从
// O(事件数) 收敛到 O(会话数),窗口始终给控制面帧留余量。
const SESSION_ACTIVITY_STAGE_MAX_KEYS = 512;
const SESSION_ACTIVITY_DRAIN_RETRY_MS = 250;
/** 可靠窗口软上限:活动镜像最多占半窗,剩余留给 invoke-result 与其它推送。 */
const SESSION_ACTIVITY_WINDOW_SOFT_CAP = 32;

/**
 * `maker:event` 微批(per-(控制端, sessionId) 累积,与 activity staging 同骨架但
 * 语义相反:activity 是状态镜像只留最新值,事件流是有序流,批内**全部保留**)。
 *
 * 为什么要它:activity 整流(#1401)、拥塞取舍(#2167)、重连冷却(#2185)都不减少
 * **出站帧数**——agent 长思考期间 maker:event 仍是每事件一帧,2026-08-08 线上单
 * 毫秒 119 帧、8-07 单小时 5168 次 BACKPRESSURE,聚合速率还招来 relay 1013 断连。
 * 批把「每事件一帧」压成「每窗口一帧」,直接砍掉这条链路的源头流量。
 *
 * ── 顺序不变量与它的代价(review 四轮收敛的结论)────────────────────────────
 *
 * 批天然引入一条「延迟发送」旁路,而同会话的其它 session-scoped 推送走「立即
 * 发送」主路。只要缓冲能跨越一次失败继续存在,两条路径的相对顺序就无法用局部
 * 补丁保证——review 四轮从四个不同时序切入,全是这同一件事:交错 push 直发、
 * activity 分支提前 continue、断线积压 drain 先于旧批、退避期大批被拒而小终态
 * 帧通过。前三轮各补一处,第四轮证明补丁修不完。
 *
 * 所以这里**去掉了退避重试**,换成一条强不变量:
 *
 *   **缓冲的生命周期不跨越任何一次发送失败。** flush 返回时缓冲一定为空——整批
 *   发出、逐帧降级发出、或(逐帧也注定失败时)直接丢弃,三条出路都不保留状态。
 *
 * 于是「同会话有待发批」这个状态只存在于「窗口内、且尚未尝试发送」的区间,
 * 收口点(flushMakerEventBatchesForSessionPush)一次调用即可保证清空,顺序问题
 * 整族消失,而不是每轮补一个新场景。
 *
 * 降级本身也要收敛,否则它就是本 PR 要消掉的那个洪峰的复刻(review P1):逐帧
 * 只在**可能成功**时才做(判据见 shouldDegradeBatchToPerFrame——只有 relay 离线是
 * 恒不可能),切片内每条都试但逐帧日志静默,成败聚合成一条(账本见
 * MakerEventBatchFlushOutcome,那里记了这个洪峰判据三轮收敛的全过程)。
 *
 * 代价与为什么可接受:拥塞时不再保留事件等窗口恢复。但那本来不是本 PR 的目标
 * (常态减帧才是),而拥塞时的取舍是 #2167 的职责——降级后的逐帧发送正好落回
 * 它的可驱逐档语义。删掉退避同时也删掉了它带来的全部复杂性(段滞留、闸门、
 * 重连清位),这是缩回原始范围,不是新增机制。
 *
 * **已知且刻意接受的代价:窗口正好跨在断线时刻上的那 ≤120ms 事件不进可靠 pending**
 * (review 同族第 3 次点到,不要再改成"离线时保留批"):逐帧世界里它们在产生瞬间就
 * 被 sendPush 收进 pending,而 pending 是跨连接世代保留的
 * (client.resetLinkStateForReconnect),link 重建后按原 seq 重放;批世界里它们还在
 * 窗口内,flush 撞上 NOT_CONNECTED 即丢。三条理由说明不值得为它引机制:
 *  1. 那批 pending 也不一定活得下来 —— replayPending 前会先 dropDiscardablePendingPrefix
 *     丢掉队头连续的可丢弃前缀,而长思考期间队头恰恰就是 push,常见形态下逐帧世界
 *     同样一条不剩;活下来的场景是队头压着 live invoke/invoke-result 的那一种。
 *  2. 净账反而是赚的:pending 窗口是 64 **条消息**(MAX_TRANSPORT_PENDING_MESSAGES)。
 *     批把 64 条事件压进一条消息,同一个窗口能装的事件量提高到 64×64 —— 断线时可
 *     恢复的历史深度是逐帧世界的几十倍,代价是尾部 ≤120ms。
 *  3. 唯一的补法(离线时保留批到重连收口)会把"缓冲跨越发送失败继续存在"重新引进来,
 *     那是上面四轮顺序 bug 的同一个根因;而且离线可能持续几分钟,保留就必须配上限与
 *     淘汰策略——那是新机制,不是本 PR 的范围。push 的恢复语义一直是重连后 resync
 *     补偿(#1375),不是逐帧重放。
 */
const MAKER_EVENT_BATCH_WINDOW_MS = 120;
/** 单批事件数上限:到量立即 flush(不等窗口),避免长思考把一帧撑得过大。 */
const MAKER_EVENT_BATCH_MAX_EVENTS = 64;
/**
 * 单批字节上限(估算值,到量立即 flush)。刻意远小于可靠传输单消息上限
 * (MAX_TRANSPORT_MESSAGE_BYTES 4MB / 64 片 × 128KB):批的目的是减少帧数,
 * 不是制造需要分片的大帧——分片会把一帧放大成多帧,反噬本次优化。
 */
const MAKER_EVENT_BATCH_MAX_BYTES = 256 * 1024;

/**
 * 一个待发批段。按 ownerStamp 分段:ownerStamp 是数据归属水印、批内必须一致,
 * 同一窗口内发生归属切换时新事件进新段,段间 FIFO——保证切换前后顺序不变。
 * (缓冲不跨失败存在,所以段最多因窗口内切换而出现,不会因滞留而堆积。)
 */
interface MakerEventBatchSegment {
  events: unknown[];
  bytes: number;
  ownerStamp?: PushOwnerStamp;
}

interface MakerEventBatchStage {
  /** sessionId → 该会话的待发段序列(FIFO);Map 插入序即会话首次入批顺序。 */
  batches: Map<string, MakerEventBatchSegment[]>;
  timer: ReturnType<typeof setTimeout> | null;
}

const makerEventBatchStages = new Map<string, MakerEventBatchStage>();

function makerEventBatchOwnerStampEquals(
  a: PushOwnerStamp | undefined,
  b: PushOwnerStamp | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.dataOwnerId === b.dataOwnerId && a.ownerGeneration === b.ownerGeneration;
}

/**
 * 把一条 maker:event 收进目标控制端的批。到量(条数/字节)立即 flush,否则等
 * 窗口定时器统一 flush。
 */
function stageMakerEventPush(
  dst: string,
  sessionId: string,
  payload: unknown,
  ownerStamp?: PushOwnerStamp,
): void {
  const payloadBytes = estimateMakerEventBytes(payload);
  // 越过字节阈值的事件**不挤进本批**:挤进去只会被 takeMakerEventBatchSlice 再切出来,
  // 每次越界白送一个 1 条事件的小尾批(30KB 级事件流下 100 条会变成 ~23 帧而不是
  // ~13 帧,直接削掉大半减帧收益,review P2)。改成先把已攒的这一批收口发出,新事件
  // 成为下一批的开头 —— 强不变量不受影响:flush 仍然一次清空,新事件是 flush **之后**
  // 才入缓冲的。单条即超阈值的事件在入批前就被 forwardPush 拦到逐帧路径,所以收口后
  // 它一定装得进空批。
  const stagedTail = makerEventBatchStages.get(dst)?.batches.get(sessionId)?.at(-1);
  if (
    stagedTail
    && stagedTail.events.length > 0
    && makerEventBatchOwnerStampEquals(stagedTail.ownerStamp, ownerStamp)
    && stagedTail.bytes + payloadBytes > MAKER_EVENT_BATCH_MAX_BYTES
  ) {
    flushMakerEventBatchesForSession(dst, sessionId);
  }
  let stage = makerEventBatchStages.get(dst);
  if (!stage) {
    stage = { batches: new Map(), timer: null };
    makerEventBatchStages.set(dst, stage);
  }
  let segments = stage.batches.get(sessionId);
  if (!segments) {
    segments = [];
    stage.batches.set(sessionId, segments);
  }
  let tail = segments.at(-1);
  if (!tail || !makerEventBatchOwnerStampEquals(tail.ownerStamp, ownerStamp)) {
    tail = { events: [], bytes: 0, ...(ownerStamp ? { ownerStamp } : {}) };
    segments.push(tail);
  }
  tail.events.push(payload);
  tail.bytes += payloadBytes;
  if (
    tail.events.length >= MAKER_EVENT_BATCH_MAX_EVENTS
    || tail.bytes >= MAKER_EVENT_BATCH_MAX_BYTES
  ) {
    flushMakerEventBatchesForSession(dst, sessionId);
    return;
  }
  scheduleMakerEventBatchFlush(dst, stage);
}

/**
 * 投递该控制端的离线积压,**对启用微批的控制端同样走批**(review P1:恢复动作不得
 * 重造触发条件,见 docs/dev-rules/remote-and-mobile-adaptation.md 的故障半径三问)。
 *
 * 不这样做的后果是实测量级的:断线期间同会话事件逐条进 offlinePushQueue,重订阅时
 * 一次 drain 可能有上百条,原本逐条 sendPush 就是同一 tick 内上百帧——正是 8/8 线上
 * 单毫秒 119 帧、招来 relay 1013 的那个形状,而这一帧洪峰恰好发生在刚重连、最脆弱的
 * 时刻。走批之后同量积压压成个位数帧。
 *
 * 顺序规则与在线主路完全一致:`maker:event` 入批,其它 channel 先收口该会话的批再发,
 * 因此积压内的跨 channel 相对顺序不变。drain 完立即收口(恢复要快,不等 120ms 窗口)。
 */
function drainOfflinePushQueueTo(src: string, topics: readonly string[]): void {
  const batchCapable = subscriptions.controllerSupports(
    src,
    CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  );
  for (const queued of offlinePushQueue.drain(src, topics)) {
    const sessionId = batchCapable && queued.channel === MAKER_PUSH.EVENT
      ? readPushSessionId(queued.payload)
      : null;
    if (
      sessionId !== null
      && estimateMakerEventBytes(queued.payload) < MAKER_EVENT_BATCH_MAX_BYTES
    ) {
      stageMakerEventPush(src, sessionId, queued.payload, queued.ownerStamp);
      continue;
    }
    flushMakerEventBatchesForSessionPush(src, queued.channel, queued.payload);
    sendPushBestEffort(src, queued.channel, queued.payload, queued.ownerStamp);
  }
  flushMakerEventBatchesFor(src);
}

/** 收口单个会话的待发批(到量 / 越界 / 跨 channel 收口共用),含聚合日志。 */
function flushMakerEventBatchesForSession(dst: string, sessionId: string): void {
  const stage = makerEventBatchStages.get(dst);
  if (!stage) return;
  const outcome = createMakerEventBatchFlushOutcome();
  flushMakerEventBatchSession(dst, stage, sessionId, outcome);
  reportMakerEventBatchFlushOutcome(dst, outcome);
}

/** 读 push payload 顶层 sessionId(与 topicForPush 的 session-scoped 判据同一字段)。 */
function readPushSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function estimateMakerEventBytes(payload: unknown): number {
  try {
    const json = JSON.stringify(payload);
    // 必须按 UTF-8 计:String.length 是 UTF-16 码元数,中文/emoji 会显著低估,
    // 字节阈值随之形同虚设(单批可能被撑到需要分片或 PAYLOAD_TOO_LARGE)。
    // byteLength 与可靠传输层计算分片大小用的是同一个函数,口径一致。
    return json ? byteLength(json) : 0;
  } catch {
    // 不可序列化的 payload 交给 sendPush 报错处理;这里只保证估算不抛。
    return 0;
  }
}

function scheduleMakerEventBatchFlush(dst: string, stage: MakerEventBatchStage): void {
  if (stage.timer) return;
  stage.timer = setTimeout(() => {
    stage.timer = null;
    const current = makerEventBatchStages.get(dst);
    if (current) flushMakerEventBatchStage(dst, current);
  }, MAKER_EVENT_BATCH_WINDOW_MS);
  (stage.timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * 一次 flush 的丢弃账本(聚合日志用)。
 *
 * 这里原本还有一条「批帧被拒 → 就地降级为逐帧 best-effort」的路径。它引出了 review
 * 里最长的一族反馈,**五轮**都在同一段十几行代码上打转,而且 reviewer 的要求互相
 * 抵触(同一位在第 1/4 轮与第 5 轮各站一边)——记下来,免得有人再把它加回来:
 *
 *  1. 无条件逐帧重放整个切片 → 队头不可驱逐时 ≤64 次失败、≤64 条 WARN,正是本 PR
 *     要消灭的逐事件 admission 与告警洪峰(greptile P1)。
 *  2. 改成「第一次失败就停」→ 把「这一帧自己不合格」当成「管子堵了」,误丢本可送达
 *     的批尾(greptile P1 第二轮)。
 *  3. 于是按错误码区分 → `BACKPRESSURE` 也尺寸相关(ws 容量判据含 additionalBytes、
 *     pending 判据含字节维度),按码停手同样误丢(codex P1)。
 *  4. 于是每条都试、只把日志聚合 → 又回到第 1 条:同步循环里没有 ACK 能释放窗口,
 *     ≤64 次 admission + 驱逐判定 + throw/catch 依旧在洪峰时放大主进程压力,只是
 *     WARN 被静默了(greptile P1 第三轮)。
 *
 *  5. 于是整片丢弃 → 又被要求恢复逐帧:小帧仍可进入剩余容量,最多 64 条流式增量
 *     消失(greptile P1 第四轮,与它自己的第 1、4 轮相反)。
 *
 * 1/4 与 2/3/5 是同一命题的两个反向,这段代码只有「逐帧试」与「整片丢」两种可能行为,
 * 每一轮都在要求上一轮的反面。**所以按数据定,一次定完 —— 结论是整片丢弃**,并把这
 * 一族在本 PR 内关闭(再出现同族反馈请对照这里,不要再实现一遍)。
 *
 * 定这一侧的依据是 8/8 线上那次拥塞**是 count-bound 而不是 size-bound**:三个上限里
 * pending 条数 64 是**尺寸无关**的,而 64 条 maker:event 撑不到 pending 的 16MB 字节上限
 * (每条几 KB,满窗约 1–2MB),日志里的 `reliable transport buffer is full` 正来自条数这
 * 一侧。条数满且队头不可驱逐时小帧与大帧一样进不去,逐帧就是 64 次零交付的纯浪费。
 * 反向的 size-bound 窗口真实但很窄:要求 pending 条数有余量、同时 ws bufferedAmount 落在
 * 距 8MB 上限不足 256KB 的那条带子里(≤3%)。而批本身还让 count-bound 更难触发——填满
 * 64 槽从前需要 64 条事件,现在需要最多 4096 条。
 *
 * 为什么可以直接丢:`maker:event` 与批 channel 都在 #2167 的 COALESCIBLE_PUSH_CHANNELS
 * 白名单里 —— 拥塞时丢弃最旧的镜像帧、由控制端 resync 补偿,这正是那个 PR 定下的取舍,
 * 本 PR 的职责是常态减帧而不是重新裁决拥塞语义。另外两条兜底也不再需要:批帧上限
 * 256KB 远小于 MAX_FRAME_BYTES(2MB),不会 PAYLOAD_TOO_LARGE,所以逐帧路径的
 * compactOversizedPushPayload 裁剪在这里没有用武之地;单条 ≥256KB 的事件本来就在入批
 * 前被 forwardPush 拦到逐帧路径。
 */
interface MakerEventBatchFlushOutcome {
  /**
   * relay 离线:本轮后续切片与会话只清空缓冲、不再尝试发送(sendPush 在非 online 时
   * 第一行就静默早退,成功率恒为 0)。
   *
   * 这是常态且预期的一档(push 的恢复语义一直是重连后 resync 补偿、不是重放),断线
   * 期间事件仍在产生,每 120ms 窗口一条 WARN 就是 8 条/秒的噪声 → 记 debug 而非 warn。
   */
  offline: boolean;
  /** 本轮丢弃的事件数。 */
  droppedEvents: number;
}

function createMakerEventBatchFlushOutcome(): MakerEventBatchFlushOutcome {
  return { offline: false, droppedEvents: 0 };
}

function reportMakerEventBatchFlushOutcome(
  dst: string,
  outcome: MakerEventBatchFlushOutcome,
): void {
  if (outcome.droppedEvents === 0) return;
  const line = `maker:event batch flush to ${shortId(dst)}: `
    + `${outcome.offline ? 'relay offline' : 'send rejected'}, `
    + `dropped ${outcome.droppedEvents} event(s)`;
  // 离线丢弃是预期常态(理由见 outcome.offline);relay 在线却被拒才是异常信号。
  if (outcome.offline) log.debug(line);
  else log.warn(line);
}

/** flush 该控制端的全部会话批(窗口到点 / 显式收口)。 */
function flushMakerEventBatchStage(dst: string, stage: MakerEventBatchStage): void {
  const outcome = createMakerEventBatchFlushOutcome();
  for (const sessionId of [...stage.batches.keys()]) {
    flushMakerEventBatchSession(dst, stage, sessionId, outcome);
  }
  reportMakerEventBatchFlushOutcome(dst, outcome);
}

/**
 * 发送某会话的待发批,**返回时缓冲一定为空**(强不变量,见本段顶部注释):
 * 按段 FIFO、段内按上限切片;切片发送失败时,若逐帧还有机会就就地降级为逐帧
 * best-effort 发送(与本 PR 之前的旧语义一致,含 compactOversizedPushPayload
 * 兜底),不保留、不重试。降级本身的洪峰由 outcome 账本收敛(见其定义)。
 */
function flushMakerEventBatchSession(
  dst: string,
  stage: MakerEventBatchStage,
  sessionId: string,
  outcome: MakerEventBatchFlushOutcome,
): void {
  const segments = stage.batches.get(sessionId);
  stage.batches.delete(sessionId);
  if (stage.batches.size === 0 && stage.timer) {
    clearTimeout(stage.timer);
    stage.timer = null;
  }
  if (!segments) return;
  for (const segment of segments) {
    while (segment.events.length > 0) {
      const slice = takeMakerEventBatchSlice(segment);
      if (slice.length === 0) break;
      // relay 已确认离线:只把缓冲取空(维持强不变量),不再制造成功率恒为 0 的帧。
      if (outcome.offline) {
        outcome.droppedEvents += slice.length;
        continue;
      }
      const payload: MakerEventBatchPayload = { sessionId, events: slice };
      try {
        if (!activeClient || activeClient.getStatus() !== 'online') {
          throw new DeviceLinkError('NOT_CONNECTED', 'relay offline');
        }
        if (segment.ownerStamp === undefined) {
          activeClient.sendPush(dst, MAKER_EVENT_BATCH_CHANNEL, payload);
        } else {
          activeClient.sendPush(dst, MAKER_EVENT_BATCH_CHANNEL, payload, segment.ownerStamp);
        }
      } catch (err) {
        // 发不出去就丢这一片(不降级、不重试、不滞留):理由与四轮 review 的推导见
        // MakerEventBatchFlushOutcome 注释。relay 离线时后续切片连尝试都省掉。
        if (err instanceof DeviceLinkError && err.code === 'NOT_CONNECTED') {
          outcome.offline = true;
        }
        outcome.droppedEvents += slice.length;
      }
    }
  }
}

/**
 * 从段头取一片:条数 ≤ MAX_EVENTS 且累计字节 ≤ MAX_BYTES,但**至少一条**
 * (单条即超阈值的事件已在入批前被拦到逐帧路径,这里的至少一条只是防死循环)。
 * 取出的事件同步从段里移除。
 */
function takeMakerEventBatchSlice(segment: MakerEventBatchSegment): unknown[] {
  const slice: unknown[] = [];
  let bytes = 0;
  while (segment.events.length > 0 && slice.length < MAKER_EVENT_BATCH_MAX_EVENTS) {
    const next = segment.events[0];
    const nextBytes = estimateMakerEventBytes(next);
    if (slice.length > 0 && bytes + nextBytes > MAKER_EVENT_BATCH_MAX_BYTES) break;
    segment.events.shift();
    slice.push(next);
    bytes += nextBytes;
  }
  segment.bytes = Math.max(0, segment.bytes - bytes);
  return slice;
}

/**
 * 收口某控制端的全部待发批。用在「即将投递更晚产生的积压」的时点:离线积压
 * drain 之前、relay 重连之后——批在时间上早于它们,晚发就会让控制端在终态之后
 * 又收到旧文本(review 第三轮)。flush 返回时缓冲必为空(成功或降级)。
 */
function flushMakerEventBatchesFor(dst: string): void {
  const stage = makerEventBatchStages.get(dst);
  if (!stage || stage.batches.size === 0) return;
  flushMakerEventBatchStage(dst, stage);
}

/**
 * 在转发同会话的**其它** channel 之前收口该会话的事件批,保住跨 channel 顺序。
 * 因为 flush 返回时缓冲必为空(成功或降级),这一次调用就足以保证后续帧排在
 * 全部已暂存事件之后——不需要再考虑退避、断线等中间状态(review 四轮的结论)。
 */
function flushMakerEventBatchesForSessionPush(
  dst: string,
  channel: string,
  payload: unknown,
): void {
  if (channel === MAKER_EVENT_BATCH_CHANNEL) return;
  const stage = makerEventBatchStages.get(dst);
  if (!stage || stage.batches.size === 0) return;
  const sessionId = readPushSessionId(payload);
  if (!sessionId || !stage.batches.has(sessionId)) return;
  flushMakerEventBatchesForSession(dst, sessionId);
}

/** 丢弃单个会话的待发批(退订该会话流时调用);stage 空则一并回收定时器。 */
function dropMakerEventBatch(dst: string, sessionId: string): void {
  const stage = makerEventBatchStages.get(dst);
  if (!stage) return;
  if (!stage.batches.delete(sessionId)) return;
  if (stage.batches.size === 0) clearMakerEventBatchStage(dst);
}

function clearMakerEventBatchStage(dst: string): void {
  const stage = makerEventBatchStages.get(dst);
  if (!stage) return;
  if (stage.timer) clearTimeout(stage.timer);
  makerEventBatchStages.delete(dst);
}

function clearAllMakerEventBatchStages(): void {
  for (const dst of [...makerEventBatchStages.keys()]) clearMakerEventBatchStage(dst);
}
interface SessionActivityStage {
  /** sessionId → 最新 payload + source owner;Map 插入序即更新序。 */
  queue: Map<string, { payload: unknown; ownerStamp?: PushOwnerStamp }>;
  retryTimer: ReturnType<typeof setTimeout> | null;
}
const sessionActivityStages = new Map<string, SessionActivityStage>();

function sessionActivityKey(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

function stageSessionActivityPush(
  dst: string,
  payload: unknown,
  ownerStamp?: PushOwnerStamp,
): void {
  const key = sessionActivityKey(payload);
  // 无 sessionId 的活动帧无法键控(契约上不存在);丢弃而不是绕行,避免未知
  // 形状绕过整流重新制造窗口竞争。
  if (!key) return;
  let stage = sessionActivityStages.get(dst);
  if (!stage) {
    stage = { queue: new Map(), retryTimer: null };
    sessionActivityStages.set(dst, stage);
  }
  stage.queue.delete(key);
  stage.queue.set(key, { payload, ...(ownerStamp ? { ownerStamp } : {}) });
  while (stage.queue.size > SESSION_ACTIVITY_STAGE_MAX_KEYS) {
    const oldest = stage.queue.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    stage.queue.delete(oldest);
  }
  drainSessionActivityStage(dst, stage);
}

function drainSessionActivityStage(dst: string, stage: SessionActivityStage): void {
  if (stage.retryTimer) {
    clearTimeout(stage.retryTimer);
    stage.retryTimer = null;
  }
  if (!activeClient) return;
  // relay 离线时保持退避重试(不清暂存):若只等下一个活动事件/重订阅触发,
  // 短暂 relay 闪断(控制端未察觉、不会重订阅)+ 无后续活动的场景下,暂存的
  // 收尾包会永久卡在内存里不再投递(远端列表行挂死在旧状态)。定时器成本
  // 有界:每控制端至多一个 250ms 定时器,且控制端真正离线时
  // handleControllerOffline 会清空暂存、终止重试。
  if (activeClient.getStatus() !== 'online') {
    scheduleSessionActivityRetry(dst, stage);
    return;
  }
  while (stage.queue.size > 0) {
    if (activeClient.getReliableSendQueueDepth(dst) >= SESSION_ACTIVITY_WINDOW_SOFT_CAP) {
      scheduleSessionActivityRetry(dst, stage);
      return;
    }
    const next = stage.queue.entries().next().value as
      | [string, { payload: unknown; ownerStamp?: PushOwnerStamp }]
      | undefined;
    if (!next) return;
    const [key, item] = next;
    try {
      if (item.ownerStamp === undefined) {
        activeClient.sendPush(dst, SESSION_ACTIVITY_CHANNEL, item.payload);
      } else {
        activeClient.sendPush(dst, SESSION_ACTIVITY_CHANNEL, item.payload, item.ownerStamp);
      }
      stage.queue.delete(key);
    } catch (err) {
      if (err instanceof DeviceLinkError && err.code === 'BACKPRESSURE') {
        scheduleSessionActivityRetry(dst, stage);
        return;
      }
      // 其它错误(LINK_NOT_OPEN / PAYLOAD_TOO_LARGE 等)沿 best-effort 语义丢弃该条,
      // 不让一条坏帧堵死整个暂存队列。
      stage.queue.delete(key);
      log.warn(`session activity push dropped for ${shortId(dst)}: ${String(err)}`);
    }
  }
}

function scheduleSessionActivityRetry(dst: string, stage: SessionActivityStage): void {
  if (stage.retryTimer) return;
  stage.retryTimer = setTimeout(() => {
    stage.retryTimer = null;
    const current = sessionActivityStages.get(dst);
    if (current) drainSessionActivityStage(dst, current);
  }, SESSION_ACTIVITY_DRAIN_RETRY_MS);
}

function clearSessionActivityStage(dst: string): void {
  const stage = sessionActivityStages.get(dst);
  if (!stage) return;
  if (stage.retryTimer) clearTimeout(stage.retryTimer);
  sessionActivityStages.delete(dst);
}

function clearAllSessionActivityStages(): void {
  for (const dst of [...sessionActivityStages.keys()]) clearSessionActivityStage(dst);
}

/**
 * 会话活动 replay 的**定向**投递:只发给刚完成 sessions 订阅的那一台控制端。
 * 走同一条 latest-wins 暂存链路(与 tap 路径同 key 合并),不经 topic 扇出——
 * 一台控制端 subscribe 不应把全量活动快照重复灌给其它所有控制端
 * (v0.1.26 线上:两台手机互相被对方的 subscribe 风暴灌爆窗口)。
 */
export function pushSessionActivityToController(
  controllerDeviceId: string,
  payload: unknown,
): void {
  if (!activeClient) return;
  if (!subscriptions.getControllersForTopic('sessions').includes(controllerDeviceId)) return;
  stageSessionActivityPush(controllerDeviceId, payload, broadcastTap.getSafeDataOwnerPushStamp?.());
}

/**
 * 按 topic 把一条本机广播转发给订阅了它的控制端。listener 注册后每条 tap 都过这里
 * (live 读 registry,topic 变化即时生效)。topic 算不出(无 session 标识)→ 丢弃。
 */
function forwardPush(channel: string, payload: unknown, ownerStamp?: PushOwnerStamp): void {
  if (!activeClient) return;
  const topic = topicForPush(channel, payload);
  if (!topic) return;
  let remotePayload = payload;
  if (
    channel === 'local-db:messages:created' &&
    payload &&
    typeof payload === 'object' &&
    'message' in payload
  ) {
    const msg = (payload as { message: unknown }).message;
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      const sanitized = stripRecoveryCheckpointFromMessage(msg as Record<string, unknown>);
      if (sanitized !== msg) {
        remotePayload = { ...payload, message: sanitized };
      }
    }
  }
  if (
    channel === MAKER_PUSH.INTERACTION_REQUEST &&
    payload &&
    typeof payload === 'object' &&
    'request' in payload
  ) {
    const request = projectInteractionRequestForRemote(
      (payload as { request: unknown }).request,
    );
    if (request === null) return;
    remotePayload = { ...payload, request };
  }
  if (channel === MAKER_PUSH.INTERACTION_DISMISSED) {
    remotePayload = projectInteractionDismissedForRemote(remotePayload);
  }
  const dsts = subscriptions.getControllersForTopic(topic);
  // The active registry describes peer topic intent, not whether this host can
  // currently write to the relay. During host-side reconnects sendPush is a
  // silent no-op, so route queueable pushes through the offline backlog instead.
  const relayOnline = activeClient.getStatus() === 'online';
  const liveTargets = relayOnline ? dsts : [];
  // 微批只对声明了能力的控制端启用;只在 maker:event 这一条 channel 上查询,
  // 不给其它 channel 增加每帧 capability 查询开销。
  const batchTargets = channel === MAKER_PUSH.EVENT && liveTargets.length > 0
    ? new Set(
      liveTargets.filter(
        (dst) => subscriptions.controllerSupports(
          dst,
          CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
        ),
      ),
    )
    : null;
  // 本帧是否具备入批资格(与 dst 无关的部分,循环外算一次):
  // 必须是 maker:event、能算出 sessionId、且单条不超批字节上限——单条超限的事件
  // 入批会撑爆逻辑消息上限,且失去逐帧路径的 compactOversizedPushPayload 兜底。
  const batchEligibleSessionId = batchTargets
    ? readPushSessionId(remotePayload)
    : null;
  const batchEligible = batchEligibleSessionId !== null
    && estimateMakerEventBytes(remotePayload) < MAKER_EVENT_BATCH_MAX_BYTES;
  const offlineTargets = subscriptions
    .getKnownControllersForTopic(topic)
    .filter((dst) => !liveTargets.includes(dst));
  for (const dst of offlineTargets) {
    if (OFFLINE_QUEUEABLE_PUSH_CHANNELS.has(channel)) {
      offlinePushQueue.enqueue(dst, {
        channel,
        payload: remotePayload,
        topic,
        ...(ownerStamp ? { ownerStamp } : {}),
      });
    }
  }
  for (const dst of liveTargets) {
    const willBatch = batchEligible && batchTargets!.has(dst);
    // 跨 channel 保序(review 两轮):**不入批**的帧必须排在该会话已暂存的事件
    // 之后——否则 interaction-request / status-changed / activity 终态会插到攒批
    // 的文本 delta 前面,控制端先收「已完成/确认卡」(结束流式消息)、120ms 后
    // 才收到前面的文本,表现为「终态之后又冒出流式内容」。
    // 位置要求两条,都由 review 实测推出:
    //  - 必须在 activity 分支**之前**(它自带 continue,放后面对 activity 永不生效);
    //  - 必须只对 !willBatch 的帧做,否则每条 maker:event 都会先收口上一批,
    //    批被拆回逐帧、优化完全失效。
    if (!willBatch && makerEventBatchStages.size > 0) {
      flushMakerEventBatchesForSessionPush(dst, channel, remotePayload);
    }
    if (willBatch) {
      stageMakerEventPush(dst, batchEligibleSessionId!, remotePayload, ownerStamp);
      continue;
    }
    // 会话活动是高频状态镜像:走 latest-wins 暂存整流,不直接冲可靠传输窗口。
    if (channel === SESSION_ACTIVITY_CHANNEL) {
      stageSessionActivityPush(dst, remotePayload, ownerStamp);
      continue;
    }
    // agent 事件流是本条链路的帧数大头:对声明了微批能力的控制端合并成
    // 「每窗口一帧」(见 stageMakerEventPush)。未声明能力的控制端照旧逐帧,
    // 因此旧控制端零感知。sessionId 取自 topic 路由所用的同一字段,取不到时
    // 不入批(topicForPush 已保证 session-scoped 帧必有它,这里只是防御)。
    // 转发是尽力而为的旁路:单个控制端的帧超限(PAYLOAD_TOO_LARGE,如大 tool 输出)/ 连接异常
    // 绝不能冒泡——它会经 tapWindowBroadcast 回到 broadcastToAllWindows,让被控端**本机** renderer
    // 漏收该事件(本地 UI 是第一优先);per-dst 接住也避免一个控制端坏帧拖垮其它控制端的转发。
    sendPushBestEffort(dst, channel, remotePayload, ownerStamp);
  }
}

/**
 * 被控端主动产生的 topic 域推送(不经 broadcast-tap 的路径):当前消费方是远程
 * 文件浏览的 watch 事件(fs-watch:<workdir> topic,事件由 device-op 的 watch
 * 引擎产生,不是 renderer 广播)。路由与 tap 路径同一 forwardPush,scoped 到
 * 订阅者;无 active client / 无订阅者时 no-op。
 */
export function pushToTopicSubscribers(
  channel: string,
  payload: unknown,
  ownerStamp?: PushOwnerStamp,
): void {
  forwardPush(channel, payload, ownerStamp);
}

function sendPushBestEffort(
  dst: string,
  channel: string,
  payload: unknown,
  ownerStamp?: PushOwnerStamp,
): void {
  if (!activeClient) return;
  try {
    if (ownerStamp === undefined) activeClient.sendPush(dst, channel, payload);
    else activeClient.sendPush(dst, channel, payload, ownerStamp);
    return;
  } catch (err) {
    if (!isPayloadTooLargeError(err)) {
      log.warn(`forwardPush to ${shortId(dst)} failed (${channel}): ${String(err)}`);
      return;
    }

    const compactPayload = compactOversizedPushPayload(channel, payload);
    if (!compactPayload) {
      log.warn(`forwardPush to ${shortId(dst)} failed (${channel}): ${String(err)}`);
      return;
    }

    try {
      if (ownerStamp === undefined) activeClient.sendPush(dst, channel, compactPayload);
      else activeClient.sendPush(dst, channel, compactPayload, ownerStamp);
      log.warn(`forwardPush to ${shortId(dst)} sent compact payload after oversized ${channel} frame`);
    } catch (retryErr) {
      log.warn(
        `forwardPush to ${shortId(dst)} failed after compact retry (${channel}): ${String(retryErr)}`,
      );
    }
  }
}

function isPayloadTooLargeError(err: unknown): boolean {
  return err instanceof DeviceLinkError && err.code === 'PAYLOAD_TOO_LARGE';
}

interface TruncationState {
  remainingChars: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

function compactOversizedPushPayload(channel: string, payload: unknown): unknown | null {
  // 最近日志里的超限帧集中在 maker:event:大型 tool_result/tool_result_full 会同时携带
  // event.data 与 resolvedContent。普通帧仍首发原样,这里只兜底首发超限后的实时流镜像。
  if (channel !== 'maker:event') return null;
  const state: TruncationState = {
    remainingChars: REMOTE_PUSH_TEXT_BUDGET_CHARS,
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const compact = truncateForRemotePush(payload, state, 0);
  return state.truncated ? compact : null;
}

function truncateForRemotePush(value: unknown, state: TruncationState, depth: number): unknown {
  if (typeof value === 'string') {
    return truncateRemoteString(value, state);
  }
  if (value === null || typeof value !== 'object') return value;
  if (state.seen.has(value)) {
    state.truncated = true;
    return REMOTE_PUSH_TRUNCATED_TEXT;
  }
  if (depth >= REMOTE_PUSH_MAX_DEPTH) {
    state.truncated = true;
    return REMOTE_PUSH_TRUNCATED_TEXT;
  }

  state.seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, REMOTE_PUSH_MAX_ARRAY_ITEMS).map((item) =>
      truncateForRemotePush(item, state, depth + 1),
    );
    if (value.length > REMOTE_PUSH_MAX_ARRAY_ITEMS) state.truncated = true;
    return items;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries.slice(0, REMOTE_PUSH_MAX_OBJECT_KEYS)) {
    out[key] = truncateForRemotePush(child, state, depth + 1);
  }
  if (entries.length > REMOTE_PUSH_MAX_OBJECT_KEYS || state.truncated) {
    out.__deviceLinkTruncated = true;
    state.truncated = true;
  }
  return out;
}

function truncateRemoteString(value: string, state: TruncationState): string {
  if (state.remainingChars <= 0) {
    state.truncated = true;
    return REMOTE_PUSH_TRUNCATED_TEXT;
  }
  if (value.length <= state.remainingChars) {
    state.remainingChars -= value.length;
    return value;
  }
  const keep = Math.max(0, state.remainingChars);
  state.remainingChars = 0;
  state.truncated = true;
  return `${value.slice(0, keep)}\n${REMOTE_PUSH_TRUNCATED_TEXT}`;
}

/**
 * 同步「转发 tap 开关」与「被控横幅」到当前 registry 状态。任何 registry 变更后调用:
 *  - active registry 或 remembered topic 非空 → 注册 forwardPush tap；两者均为空 → 注销。
 *    remembered topic 让普通断线期间的广播仍可进入离线队列。
 *  - UI 活跃控制端集 = 持 session:<id> / legacy '*' 的订阅者。
 *  - 更新重启阻塞集额外包含 fs-watch:<workdir>，但不扩大 UI 被控横幅语义。
 */
function syncForwarding(): void {
  setBroadcastTapListener(
    subscriptions.isEmpty() && !subscriptions.hasRememberedTopics()
      ? null
      : forwardPush,
  );
  onControllersChanged?.(
    subscriptions.getControlControllers(),
    subscriptions.getUpdateRelaunchControllers(),
  );
}

/** 把所有订阅控制端踢掉(被控开关关闭 / 用户一键断开 / 退出时调用) */
export function dropAllControllers(
  client: DeviceLinkClient,
  reason: 'user' | 'toggle-off' | 'shutdown',
): void {
  const controllerIds = new Set([
    ...subscriptions.getControllerIds(),
    ...topicSubscriptionControllers,
    ...acceptedLinkControllers,
    ...reportedControllerNameByDevice.keys(),
  ]);
  for (const dst of controllerIds) {
    try {
      client.closeLink(dst, reason, 'inbound');
    } catch (err) {
      // 本地授权/订阅清理不能依赖弱网下 link-close 真正写进 socket。
      log.warn(`closeLink to ${shortId(dst)} failed during ${reason}: ${String(err)}`);
    }
    clearReportedControllerName(dst);
  }
  clearAllRemoteInvokeState();
  subscriptions.clearAll();
  topicSubscriptionControllers.clear();
  acceptedLinkControllers.clear();
  controllerConnectionEpochByDevice.clear();
  controllerLinkGenerationByDevice.clear();
  reportedControllerNameByDevice.clear();
  offlinePushQueue.clear();
  clearAllSessionActivityStages();
  clearAllMakerEventBatchStages();
  cancelAllLinkAcceptRetries();
  syncForwarding();
}

function deactivateControllerState(
  deviceId: string,
  observedConnectionEpoch?: number,
  observedLinkGeneration?: number,
): boolean {
  const activeEpoch = controllerConnectionEpochByDevice.get(deviceId);
  const activeLinkGeneration = controllerLinkGenerationByDevice.get(deviceId);
  if (
    observedConnectionEpoch !== undefined
    && activeEpoch !== undefined
    && (
      observedConnectionEpoch < activeEpoch
      || (
        observedConnectionEpoch === activeEpoch
        && observedLinkGeneration !== undefined
        && activeLinkGeneration !== undefined
        && observedLinkGeneration < activeLinkGeneration
      )
    )
  ) {
    log.debug(
      `ignoring stale controller offline event for ${shortId(deviceId)}`
      + ` (connection=${observedConnectionEpoch}/${activeEpoch}`
      + ` link=${observedLinkGeneration ?? 'unknown'}/${activeLinkGeneration ?? 'unknown'})`,
    );
    return false;
  }
  let changed = false;
  changed = acceptedLinkControllers.delete(deviceId) || changed;
  changed = controllerConnectionEpochByDevice.delete(deviceId) || changed;
  changed = controllerLinkGenerationByDevice.delete(deviceId) || changed;
  changed = reportedControllerNameByDevice.has(deviceId) || changed;
  changed = subscriptions.getControllerIds().includes(deviceId) || changed;
  clearReportedControllerName(deviceId);
  clearSessionActivityStage(deviceId);
  clearMakerEventBatchStage(deviceId);
  cancelLinkAcceptRetry(deviceId);
  return subscriptions.clearController(deviceId) || changed;
}

/**
 * Active → inactive 的唯一单 peer 状态转换。
 *
 * 清 accepted link、active topics、横幅/更新重启 busy 与短期发送 stage；保留
 * remembered topics/capabilities、可靠 pending、invoke-result outbox 和离线队列，
 * 让控制端回来后按既有 link-open + subscribe 路径恢复。
 */
export function deactivateController(
  deviceId: string,
  reason: string,
  observedConnectionEpoch?: number,
  observedLinkGeneration?: number,
): boolean {
  const changed = deactivateControllerState(
    deviceId,
    observedConnectionEpoch,
    observedLinkGeneration,
  );
  if (changed) {
    log.info(`controller ${shortId(deviceId)} deactivated (${reason})`);
    syncForwarding();
  }
  return changed;
}

/** Relay 连接离开 online：清本连接代所有 active controller，但保留恢复意图。 */
export function deactivateAllControllers(reason: string): void {
  const controllerIds = new Set([
    ...subscriptions.getControllerIds(),
    ...topicSubscriptionControllers,
    ...acceptedLinkControllers,
    ...controllerConnectionEpochByDevice.keys(),
    ...controllerLinkGenerationByDevice.keys(),
    ...reportedControllerNameByDevice.keys(),
  ]);
  let changed = false;
  for (const deviceId of controllerIds) {
    changed = deactivateControllerState(deviceId) || changed;
  }
  if (changed) {
    log.info(`all active controllers deactivated (${reason}, count=${controllerIds.size})`);
    syncForwarding();
  }
}

/** presence offline remains an authoritative single-peer deactivation edge. */
export function handleControllerOffline(
  deviceId: string,
  routeChange?: DeviceLinkPeerRouteStateChanged,
): void {
  deactivateController(
    deviceId,
    routeChange ? 'relay-device-offline' : 'presence-offline',
    routeChange?.connectionEpoch,
    routeChange?.linkGeneration,
  );
}

/** 显式解链/撤权才丢弃该控制端的去重缓存与待发送结果。 */
export function forgetControllerInvokeState(deviceId: string): void {
  clearRemoteInvokeStateFor(deviceId);
}

/** 显式撤销时清理短时离线队列与 remembered topic，避免恢复后重放撤权期间数据。 */
export function purgeRevokedController(deviceId: string): void {
  const changed = deactivateControllerState(deviceId);
  topicSubscriptionControllers.delete(deviceId);
  offlinePushQueue.clear(deviceId);
  const wasKnown = subscriptions.getKnownControllerIds().includes(deviceId);
  subscriptions.forgetKnownController(deviceId);
  if (changed || wasKnown) {
    log.info(`controller ${shortId(deviceId)} deactivated (revoked)`);
    syncForwarding();
  }
}

/**
 * 接线被控端隧道。在 device-link host init 时调用一次。
 * 返回 unsubscribe(测试/重置用)。
 */
export function wireInboundDispatch(client: DeviceLinkClient): () => void {
  activeClient = client;
  return client.onFrame((env: Envelope) => {
    // 可靠传输的 ACK 边界是“已进入本地执行状态机”，不是“耗时 IPC 已执行完成”。
    // handleInvoke 会在第一次 await 前登记 in-flight requestId 去重；这里不把它的
    // Promise 交回 transport，避免一个慢查询把后续 stop/steer/push 全部堵在队头。
    void handleFrame(client, env).catch((err) => {
      log.error('inbound frame handling failed', err);
    });
  });
}

async function handleFrame(client: DeviceLinkClient, env: Envelope): Promise<void> {
  const src = env.src;
  switch (env.kind) {
    case 'link-open':
      if (!src || !env.id) return;
      handleLinkOpen(client, src, env.id, env.payload as LinkOpenPayload | undefined);
      return;
    case 'link-close':
      if (!src) return;
      // transport-timeout 是对端对「它作为被控端服务本机控制」的那条 link 做的
      // peer 级瞬时重置,与本机作为被控端服务对端控制的**反向**状态无关。
      // 两台桌面互控时若照常清理,会把对端作为控制端的订阅/记忆路由/去重
      // 缓存/离线队列静默删掉而对端毫不知情 → 反向实时推送断流。瞬时重置
      // 的恢复由控制端 wiring 负责(index.ts 立即 openRemoteLink / mobile
      // rehydrate);此处保持被控端状态原样,重建后双向继续。永久关闭
      // (user/toggle-off/shutdown/revoked)维持完整清理语义。
      if ((env.payload as LinkClosePayload | undefined)?.reason === 'transport-timeout') {
        log.info(`transport-timeout link reset from ${shortId(src)}; host-side controller state retained`);
        return;
      }
      clearRemoteInvokeStateFor(src);
      offlinePushQueue.clear(src);
      const deactivated = deactivateControllerState(src);
      // Keep the protocol-capability marker, but discard all remembered routing.
      // A modern controller must reconnect and explicitly subscribe; restoring the
      // legacy wildcard here would silently re-enable broad delivery.
      const wasKnown = subscriptions.getKnownControllerIds().includes(src);
      subscriptions.forgetKnownController(src);
      if (deactivated || wasKnown) syncForwarding();
      log.info(`control link closed by ${shortId(src)}`);
      return;
    case 'invoke':
      if (!src || !env.id) return;
      await handleInvoke(client, src, env.id, env.payload as InvokePayload);
      return;
    default:
      // invoke-result / push / presence 等不应到达被控端 dispatch,忽略
      return;
  }
}

/** 该控制端是否在「撤销访问权限」黑名单内(逐设备,持久化在 settings)。 */
function isControllerRevoked(deviceId: string): boolean {
  return readDeviceLinkSettings().revokedControllers.includes(deviceId);
}

/**
 * link-accept 发送失败(WS 背压 / 瞬时 socket 竞态)的有限重试。
 *
 * 控制端的 openLink 正拿着 30s 预算干等 accept;此前发送失败直接静默放弃,
 * 控制端必然等满超时再靠订阅重放/熔断恢复兜底重开(2026-08-03 线上现场:
 * 被控端上行拥塞时反复出现 no link-accept within 30000ms)。背压是瞬时状态,
 * 短退避内发送缓冲大概率已排空;重试走完整 handleLinkOpen(复验开关/撤权),
 * 每 src 只保留最新一次(新 link-open 顶掉旧重试)。耗尽后回到原语义:
 * 等控制端重发 link-open。
 */
const LINK_ACCEPT_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];
const linkAcceptRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 已撤权控制端反复 open 时，closeLink 与 warn 的最小间隔。 */
const REVOKED_LINK_OPEN_REJECT_INTERVAL_MS = 30_000;
const revokedLinkOpenRejectAt = new Map<string, number>();

function cancelLinkAcceptRetry(src: string): void {
  const timer = linkAcceptRetryTimers.get(src);
  if (!timer) return;
  clearTimeout(timer);
  linkAcceptRetryTimers.delete(src);
}

function cancelAllLinkAcceptRetries(): void {
  for (const src of [...linkAcceptRetryTimers.keys()]) cancelLinkAcceptRetry(src);
}

/** @param failedAttempts 已失败的发送次数(≥1);第 n 次失败用 delays[n-1] 档退避。 */
function scheduleLinkAcceptRetry(
  client: DeviceLinkClient,
  src: string,
  requestId: string,
  payload: LinkOpenPayload | undefined,
  failedAttempts: number,
): void {
  if (failedAttempts > LINK_ACCEPT_RETRY_DELAYS_MS.length) {
    log.warn(
      `link-accept to ${shortId(src)} gave up after ${failedAttempts} attempts; waiting for controller to re-open`,
    );
    return;
  }
  cancelLinkAcceptRetry(src);
  const timer = setTimeout(() => {
    linkAcceptRetryTimers.delete(src);
    // 世代/连接校验:client 已更换或 relay 已断线时放弃——断线会 fail 掉控制端
    // 的 pending openLink,它必然重发 link-open,旧 requestId 的 accept 已无意义。
    if (activeClient !== client || client.getStatus() !== 'online') return;
    handleLinkOpen(client, src, requestId, payload, failedAttempts);
  }, LINK_ACCEPT_RETRY_DELAYS_MS[failedAttempts - 1]);
  (timer as unknown as { unref?: () => void }).unref?.();
  linkAcceptRetryTimers.set(src, timer);
}

function handleLinkOpen(
  client: DeviceLinkClient,
  src: string,
  requestId: string,
  payload: LinkOpenPayload | undefined,
  acceptAttempt = 0,
): void {
  // 同 src 的新 link-open / 本轮执行顶掉遗留的 accept 重试(requestId 已过时)
  cancelLinkAcceptRetry(src);
  // 第二道开关校验(server 已是第一道)
  if (!readDeviceLinkSettings().remoteControlEnabled) {
    // server 正常不会转发到这里;真到了说明状态不一致,静默不 accept
    log.warn(`link-open from ${shortId(src)} rejected: remote control disabled locally`);
    return;
  }
  // 逐设备黑名单:已撤销访问权限的控制端,发 link-close('revoked') 给明确信号
  // (legacy openLink 仍会超时,但控制端据此 link-close 标记「已撤销」),不接受其 link-open。
  if (isControllerRevoked(src)) {
    // 清理必须每次都做:限频只挡 closeLink/日志,不能把 purge 也吞掉。
    // 否则短暂解禁再撤权时,restore 窗口里装上的订阅会在 throttle 内继续收 push。
    purgeRevokedController(src);
    const now = Date.now();
    const last = revokedLinkOpenRejectAt.get(src) ?? 0;
    if (now - last >= REVOKED_LINK_OPEN_REJECT_INTERVAL_MS) {
      log.warn(`link-open from ${shortId(src)} rejected: access revoked`);
      revokedLinkOpenRejectAt.set(src, now);
      client.closeLink(src, 'revoked', 'inbound');
    }
    return;
  }
  const name = resolveControllerName(src, payload?.controllerName) ?? src.slice(0, 8);
  // 老控制端无 subscribe 能力:link-open 视作订阅 legacy '*'(全量转发 + 横幅),向后兼容。
  // 已在当前 link 上证明支持 topic 的客户端可能重复 open;不能重新装回兼容 wildcard。
  const capabilities = sanitizeControllerCapabilities(payload?.capabilities);
  const rememberedModernTopics = subscriptions.hasRememberedModernTopics(src);
  const knownModernController =
    topicSubscriptionControllers.has(src)
    || rememberedModernTopics;
  // 先确认 link-accept 已经进入 socket/可靠层，再提交本地订阅状态。弱网背压下
  // accept 发送失败时不能留下“控制端未连上、被控端却显示已受控”的幽灵订阅。
  try {
    client.sendLinkAccept(src, requestId, {
      appVersion: app.getVersion(),
      allowlistHash: computeAllowlistHash(),
    });
  } catch (err) {
    // 背压等瞬时失败:短退避重试(见 LINK_ACCEPT_RETRY_DELAYS_MS 注释),
    // 订阅状态不提交(幽灵订阅防护语义保持不变)。
    log.warn(
      `link-accept send failed for ${shortId(src)} (attempt ${acceptAttempt + 1}): ${String(err)}`,
    );
    scheduleLinkAcceptRetry(client, src, requestId, payload, acceptAttempt + 1);
    return;
  }
  markControllerLinkActive(client, src);
  acceptedLinkControllers.add(src);
  if (knownModernController) {
    subscriptions.updateControllerMetadata(src, name, capabilities);
  } else {
    subscriptions.subscribe(src, [LEGACY_TOPIC], name, capabilities);
  }
  syncForwarding();
  flushRemoteInvokeResultOutbox(src);
  if (!knownModernController) {
    // 同上:投递离线积压前先排空该控制端的事件批,保住跨积压的顺序。
    flushMakerEventBatchesFor(src);
    drainOfflinePushQueueTo(src, [LEGACY_TOPIC]);
  }
  log.info(`control link opened by ${shortId(src)} (${name})`);
}

async function handleInvoke(
  client: DeviceLinkClient,
  src: string,
  requestId: string,
  payload: InvokePayload | undefined,
): Promise<void> {
  const cacheKey = `${src}\u0000${requestId}`;
  const invokeLinkEpoch = remoteInvokeLinkEpoch.get(src) ?? 0;
  const fingerprint = JSON.stringify(payload) ?? '';
  const admissionFailure = currentRemoteInvokeAdmissionFailure(src);
  if (admissionFailure) {
    if (!sendInvokeResultSafe(
      client,
      src,
      requestId,
      admissionFailure,
      payload?.channel,
      payload?.args,
      fingerprint,
    )) {
      throw new DeviceLinkError('BACKPRESSURE', 'admission failure invoke-result could not be queued');
    }
    return;
  }
  const queued = remoteInvokeResultOutbox.get(cacheKey);
  if (queued) {
    if (queued.fingerprint !== undefined && queued.fingerprint !== fingerprint) {
      sendRequestIdReuseError(client, src, requestId, payload);
      return;
    }
    if (!sendInvokeResultSafe(
      client,
      src,
      requestId,
      queued.result,
      payload?.channel,
      payload?.args,
      fingerprint,
    )) {
      throw new DeviceLinkError('BACKPRESSURE', 'queued invoke-result could not be retried');
    }
    return;
  }
  const cached = completedRemoteInvokeResults.get(cacheKey);
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      sendRequestIdReuseError(client, src, requestId, payload);
      return;
    }
    if (!sendInvokeResultSafe(
      client,
      src,
      requestId,
      cached.result,
      payload?.channel,
      payload?.args,
      fingerprint,
    )) {
      throw new DeviceLinkError('BACKPRESSURE', 'cached invoke-result could not be queued');
    }
    return;
  }
  const inFlight = inFlightRemoteInvokeResults.get(cacheKey);
  if (inFlight) {
    if (inFlight.fingerprint !== fingerprint) {
      sendRequestIdReuseError(client, src, requestId, payload);
      return;
    }
    if (inFlight.linkEpoch !== invokeLinkEpoch) return;
    const result = await inFlight.promise;
    if ((remoteInvokeLinkEpoch.get(src) ?? 0) !== invokeLinkEpoch) return;
    if (!sendInvokeResultSafe(
      client,
      src,
      requestId,
      result,
      payload?.channel,
      payload?.args,
      fingerprint,
    )) {
      throw new DeviceLinkError('BACKPRESSURE', 'in-flight invoke-result could not be queued');
    }
    return;
  }
  if (payload && (payload.channel === DL_SUBSCRIBE_CHANNEL || payload.channel === DL_UNSUBSCRIBE_CHANNEL)) {
    const result = handleSubscriptionFrame(src, payload);
    if (!sendInvokeResultSafe(
      client,
      src,
      requestId,
      result,
      payload.channel,
      payload.args,
      fingerprint,
    )) {
      throw new DeviceLinkError('BACKPRESSURE', 'subscription invoke-result could not be queued');
    }
    return;
  }

  const invokeBytes = encodedByteLength(fingerprint);
  const controllerAdmission = remoteInvokeAdmissionState(src);
  const controllerAtLimit = (
    controllerAdmission.messages >= REMOTE_INVOKE_IN_FLIGHT_PER_CONTROLLER_LIMIT
    || controllerAdmission.bytes + invokeBytes > REMOTE_INVOKE_IN_FLIGHT_PER_CONTROLLER_BYTES
  );
  const globalAtLimit = (
    inFlightRemoteInvokeResults.size + remoteInvokeResultOutbox.size >= REMOTE_INVOKE_IN_FLIGHT_LIMIT
    || inFlightRemoteInvokeBytes + remoteInvokeResultOutboxBytes + invokeBytes
      > REMOTE_INVOKE_IN_FLIGHT_BYTES
  );
  if (controllerAtLimit || globalAtLimit) {
    const result: InvokeResultPayload = {
      ok: false,
      error: {
        code: 'BACKPRESSURE',
        message: 'remote invoke execution queue is full',
      },
    };
    if (!sendInvokeResultSafe(
      client,
      src,
      requestId,
      result,
      payload?.channel,
      payload?.args,
      fingerprint,
    )) {
      throw new DeviceLinkError('BACKPRESSURE', 'overload invoke-result could not be queued');
    }
    return;
  }

  const releaseBusyLease = shouldAcquireRemoteInvokeBusyLease(src, payload)
    ? acquireRemoteInvokeBusyLease()
    : () => undefined;
  const executionPromise = Promise.resolve()
    .then(() => executeInvoke(src, payload))
    .catch((err): InvokeResultPayload => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`remote invoke escaped execution boundary from ${shortId(src)}: ${message}`);
      return {
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message,
        },
      };
    });
  const resultPromise = settleRemoteInvokeWithOrphanDeadline(
    executionPromise,
    src,
    payload?.channel,
  ).finally(releaseBusyLease);
  const inFlightEntry = {
    promise: resultPromise,
    bytes: invokeBytes,
    fingerprint,
    linkEpoch: invokeLinkEpoch,
  };
  inFlightRemoteInvokeResults.set(cacheKey, inFlightEntry);
  inFlightRemoteInvokeBytes += invokeBytes;
  let result: InvokeResultPayload;
  try {
    result = normalizeInvokeResultForWire(await resultPromise);
    if ((remoteInvokeLinkEpoch.get(src) ?? 0) !== invokeLinkEpoch) return;
  } finally {
    if (inFlightRemoteInvokeResults.get(cacheKey) === inFlightEntry) {
      inFlightRemoteInvokeResults.delete(cacheKey);
      inFlightRemoteInvokeBytes -= invokeBytes;
    }
  }
  if (!sendInvokeResultSafe(
    client,
    src,
    requestId,
    result,
    payload?.channel,
    payload?.args,
    fingerprint,
  )) {
    throw new DeviceLinkError('BACKPRESSURE', 'invoke-result could not be queued');
  }
}

async function executeInvoke(
  src: string,
  payload: InvokePayload | undefined,
): Promise<InvokeResultPayload> {
  return await runInvoke(src, payload);
}

function settleRemoteInvokeWithOrphanDeadline(
  execution: Promise<InvokeResultPayload>,
  src: string,
  channel: string | undefined,
): Promise<InvokeResultPayload> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const orphanMs = remoteInvokeOrphanTimeoutMs(channel);
  const timeout = new Promise<InvokeResultPayload>((resolve) => {
    timer = setTimeout(() => {
      timer = null;
      log.warn(
        `remote invoke orphan deadline exceeded for ${channel ?? '?'} from ${shortId(src)}; ` +
        'underlying handler may still be running',
      );
      resolve({
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message:
            `[TIMEOUT] remote invoke exceeded ${orphanMs}ms; ` +
            'the underlying operation may still be running',
        },
      });
    }, orphanMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([execution, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function currentRemoteInvokeAdmissionFailure(src: string): InvokeResultPayload | null {
  if (!readDeviceLinkSettings().remoteControlEnabled) {
    return { ok: false, error: { code: 'REMOTE_DISABLED', message: 'remote control disabled' } };
  }
  if (isControllerRevoked(src)) {
    return { ok: false, error: { code: 'ACCESS_REVOKED', message: 'access revoked by target device' } };
  }
  return null;
}

function remoteInvokeAdmissionState(src: string): { messages: number; bytes: number } {
  const prefix = `${src}\u0000`;
  let messages = 0;
  let bytes = 0;
  for (const [key, entry] of inFlightRemoteInvokeResults) {
    if (!key.startsWith(prefix)) continue;
    messages += 1;
    bytes += entry.bytes;
  }
  for (const entry of remoteInvokeResultOutbox.values()) {
    if (entry.src !== src) continue;
    messages += 1;
    bytes += entry.bytes;
  }
  return { messages, bytes };
}

function sendRequestIdReuseError(
  client: DeviceLinkClient,
  src: string,
  requestId: string,
  payload: InvokePayload | undefined,
): void {
  const result: InvokeResultPayload = {
    ok: false,
    error: {
      code: 'INTERNAL',
      message: 'request id reused with different payload',
    },
  };
  // 非法复用帧不能覆盖同 requestId 的 canonical success/error outbox；本地背压时宁可
  // 丢掉这条诊断响应，也不能让它在稍后先到、错误 resolve 原请求。
  const attempt = trySendInvokeResult(
    client,
    src,
    requestId,
    result,
    payload?.channel,
    payload?.args,
  );
  if (!attempt.sent) {
    log.warn(`request-id reuse error could not be sent to ${shortId(src)}`);
  }
}

function rememberRemoteInvokeResult(
  key: string,
  fingerprint: string,
  result: InvokeResultPayload,
): void {
  const serialized = safeJsonStringify(result);
  if (!serialized) return;
  const bytes = encodedByteLength(serialized) + encodedByteLength(fingerprint);
  const previous = completedRemoteInvokeResults.get(key);
  if (previous) {
    completedRemoteInvokeResultBytes -= previous.bytes;
    completedRemoteInvokeResults.delete(key);
  }
  completedRemoteInvokeResults.set(key, { result, bytes, fingerprint });
  completedRemoteInvokeResultBytes += bytes;
  while (
    completedRemoteInvokeResults.size > REMOTE_INVOKE_RESULT_CACHE_LIMIT
    || completedRemoteInvokeResultBytes > REMOTE_INVOKE_RESULT_CACHE_BYTES
  ) {
    const oldestKey = completedRemoteInvokeResults.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = completedRemoteInvokeResults.get(oldestKey);
    completedRemoteInvokeResults.delete(oldestKey);
    if (oldest) completedRemoteInvokeResultBytes -= oldest.bytes;
  }
}

function clearRemoteInvokeResultsFor(deviceId: string): void {
  const prefix = `${deviceId}\u0000`;
  for (const [key, cached] of completedRemoteInvokeResults) {
    if (!key.startsWith(prefix)) continue;
    completedRemoteInvokeResults.delete(key);
    completedRemoteInvokeResultBytes -= cached.bytes;
  }
}

function clearRemoteInvokeStateFor(deviceId: string): void {
  remoteInvokeLinkEpoch.set(deviceId, (remoteInvokeLinkEpoch.get(deviceId) ?? 0) + 1);
  clearRemoteInvokeResultsFor(deviceId);
  const prefix = `${deviceId}\u0000`;
  for (const [key, queued] of remoteInvokeResultOutbox) {
    if (!key.startsWith(prefix)) continue;
    remoteInvokeResultOutbox.delete(key);
    remoteInvokeResultOutboxBytes -= queued.bytes;
  }
  if (remoteInvokeResultOutbox.size === 0) clearRemoteInvokeResultOutboxTimer();
}

function clearAllRemoteInvokeState(): void {
  const deviceIds = new Set<string>();
  for (const key of completedRemoteInvokeResults.keys()) {
    deviceIds.add(key.slice(0, key.indexOf('\u0000')));
  }
  for (const key of inFlightRemoteInvokeResults.keys()) {
    deviceIds.add(key.slice(0, key.indexOf('\u0000')));
  }
  for (const queued of remoteInvokeResultOutbox.values()) {
    deviceIds.add(queued.src);
  }
  for (const deviceId of deviceIds) clearRemoteInvokeStateFor(deviceId);
}

function normalizeInvokeResultForWire(result: InvokeResultPayload): InvokeResultPayload {
  if (safeJsonStringify(result)) return result;
  return {
    ok: false,
    error: {
      code: 'IPC_ERROR',
      message: '[SERIALIZATION_ERROR] remote invoke result is not JSON serializable',
    },
  };
}

function sanitizeMessageInvokeResult(
  result: InvokeResultPayload,
  channel: string | undefined,
): InvokeResultPayload {
  if (!channel || !REMOTE_MESSAGE_CHANNELS.has(channel)) return result;
  if (!result.ok || !Array.isArray(result.result)) return result;
  let changed = false;
  const sanitized = result.result.map((msg: unknown) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
    const out = stripRecoveryCheckpointFromMessage(msg as Record<string, unknown>);
    if (out !== msg) changed = true;
    return out;
  });
  return changed ? { ok: true, result: sanitized } : result;
}

/**
 * 发送 invoke-result,并对「结果帧超 MAX_FRAME_BYTES」和本地发送背压兜底。
 * sendInvokeResult → sendEnvelope 在结果超限时抛 PAYLOAD_TOO_LARGE;若不接住,异常会冒泡到
 * handleFrame 的 .catch(只 log),控制端收不到任何 invoke-result,只能干等 30s 超时。常见触发:
 * 分页读到带超大 tool 输出的会话(local-db:messages:list / around)。消息页优先把超大消息内容
 * 裁剪成仍可渲染的 `ok:true` 结果;其它 channel 回紧凑错误,让控制端立即失败而非卡死。
 * BACKPRESSURE / NOT_CONNECTED 等瞬态发送失败则保留原结果进有界 outbox；绝不能把已经成功
 * 执行的 mutation 改写成 BACKPRESSURE error，否则控制端重试会重复副作用。
 */
function sendInvokeResultSafe(
  client: DeviceLinkClient,
  src: string,
  requestId: string,
  result: InvokeResultPayload,
  channel?: string,
  args?: unknown[],
  fingerprint?: string,
): boolean {
  const key = `${src}\u0000${requestId}`;
  const normalized = sanitizeMessageInvokeResult(normalizeInvokeResultForWire(result), channel);
  const attempt = trySendInvokeResult(client, src, requestId, normalized, channel, args);
  // 以真正能上 wire 的结果作为去重真相：超限原结果若被 compact/改成结构化错误，
  // 不能把缓存留在原始大对象上，否则缓存可能自淘汰且重复 requestId 会再次执行。
  if (fingerprint !== undefined) {
    rememberRemoteInvokeResult(key, fingerprint, attempt.result);
  }
  if (attempt.sent) {
    removeRemoteInvokeResultOutboxEntry(key);
    return true;
  }
  return enqueueRemoteInvokeResult({
    src,
    requestId,
    result: attempt.result,
    channel,
    args,
    fingerprint,
    bytes: invokeResultOutboxBytes(attempt.result, fingerprint),
    queuedAt: Date.now(),
  });
}

function trySendInvokeResult(
  client: DeviceLinkClient,
  src: string,
  requestId: string,
  result: InvokeResultPayload,
  channel?: string,
  args?: unknown[],
  logFailure = true,
): { sent: true; result: InvokeResultPayload } | { sent: false; result: InvokeResultPayload } {
  let candidate = result;
  try {
    client.sendInvokeResult(src, requestId, candidate);
    return { sent: true, result: candidate };
  } catch (err) {
    const code = err instanceof DeviceLinkError ? err.code : 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    if (logFailure) {
      log.warn(`invoke-result send failed for ${channel ?? '?'} from ${shortId(src)}: ${message}`);
    }
    if (code === 'PAYLOAD_TOO_LARGE') {
      const compactResult = compactInvokeResultForDeviceLink(channel, result, { dst: src, requestId }, args);
      if (compactResult) {
        candidate = compactResult;
        try {
          client.sendInvokeResult(src, requestId, candidate);
          log.warn(`sent compact message invoke-result for ${channel ?? '?'} to ${shortId(src)}`);
          return { sent: true, result: candidate };
        } catch (compactErr) {
          if (logFailure) {
            log.warn(`compact message invoke-result failed from ${shortId(src)}: ${String(compactErr)}`);
          }
          if (!isPayloadTooLargeError(compactErr)) {
            return { sent: false, result: candidate };
          }
        }
      }
      candidate = { ok: false, error: { code, message } };
      try {
        client.sendInvokeResult(src, requestId, candidate);
        return { sent: true, result: candidate };
      } catch (fallbackErr) {
        if (logFailure) {
          log.error(
            `fallback error invoke-result also failed from ${shortId(src)}: ${String(fallbackErr)}`,
          );
        }
        return { sent: false, result: candidate };
      }
    }
    return { sent: false, result: candidate };
  }
}

function invokeResultWireBytes(result: InvokeResultPayload): number {
  const serialized = safeJsonStringify(result);
  return serialized ? encodedByteLength(serialized) : 0;
}

function invokeResultOutboxBytes(
  result: InvokeResultPayload,
  fingerprint: string | undefined,
): number {
  return invokeResultWireBytes(result) + (fingerprint === undefined ? 0 : encodedByteLength(fingerprint));
}

function remoteInvokeResultOutboxState(src: string): { messages: number; bytes: number } {
  let messages = 0;
  let bytes = 0;
  for (const entry of remoteInvokeResultOutbox.values()) {
    if (entry.src !== src) continue;
    messages += 1;
    bytes += entry.bytes;
  }
  return { messages, bytes };
}

function enqueueRemoteInvokeResult(entry: QueuedRemoteInvokeResult): boolean {
  const key = `${entry.src}\u0000${entry.requestId}`;
  if (remoteInvokeResultOutbox.has(key)) {
    scheduleRemoteInvokeResultOutboxFlush();
    return true;
  }
  const controllerOutbox = remoteInvokeResultOutboxState(entry.src);
  if (
    entry.bytes <= 0
    || controllerOutbox.messages >= REMOTE_INVOKE_RESULT_OUTBOX_PER_CONTROLLER_LIMIT
    || controllerOutbox.bytes + entry.bytes > REMOTE_INVOKE_RESULT_OUTBOX_PER_CONTROLLER_BYTES
    || remoteInvokeResultOutbox.size >= REMOTE_INVOKE_RESULT_OUTBOX_LIMIT
    || remoteInvokeResultOutboxBytes + entry.bytes > REMOTE_INVOKE_RESULT_OUTBOX_BYTES
  ) {
    log.error(
      `invoke-result outbox full for ${entry.channel ?? '?'} to ${shortId(entry.src)} ` +
      `(controllerMessages=${controllerOutbox.messages}, controllerBytes=${controllerOutbox.bytes}, ` +
      `messages=${remoteInvokeResultOutbox.size}, bytes=${remoteInvokeResultOutboxBytes})`,
    );
    return false;
  }
  remoteInvokeResultOutbox.set(key, entry);
  remoteInvokeResultOutboxBytes += entry.bytes;
  log.warn(
    `queued invoke-result after local send backpressure for ${entry.channel ?? '?'} ` +
    `to ${shortId(entry.src)}`,
  );
  scheduleRemoteInvokeResultOutboxFlush();
  return true;
}

function removeRemoteInvokeResultOutboxEntry(key: string): void {
  const queued = remoteInvokeResultOutbox.get(key);
  if (!queued) return;
  remoteInvokeResultOutbox.delete(key);
  remoteInvokeResultOutboxBytes -= queued.bytes;
  if (remoteInvokeResultOutbox.size === 0) clearRemoteInvokeResultOutboxTimer();
}

function clearRemoteInvokeResultOutboxTimer(): void {
  if (!remoteInvokeResultOutboxTimer) return;
  clearTimeout(remoteInvokeResultOutboxTimer);
  remoteInvokeResultOutboxTimer = null;
}

function scheduleRemoteInvokeResultOutboxFlush(): void {
  if (remoteInvokeResultOutboxTimer || remoteInvokeResultOutbox.size === 0) return;
  // relay 在线才值得 500ms 快重试;离线只保留慢节奏 TTL 出清,投递由事件驱动
  // (ws-online 全量 / link-open、subscribe 定向)。
  const delayMs = activeClient?.getStatus() === 'online'
    ? REMOTE_INVOKE_RESULT_OUTBOX_RETRY_MS
    : REMOTE_INVOKE_RESULT_OUTBOX_OFFLINE_SWEEP_MS;
  remoteInvokeResultOutboxTimer = setTimeout(() => {
    remoteInvokeResultOutboxTimer = null;
    flushRemoteInvokeResultOutbox();
  }, delayMs);
  (remoteInvokeResultOutboxTimer as unknown as { unref?: () => void }).unref?.();
}

/** ws-online 等连接级事件的全量 flush 入口(index.ts 接线);挂起的慢扫描立即换快挡。 */
export function flushRemoteInvokeResultOutboxOnReconnect(): void {
  if (remoteInvokeResultOutbox.size === 0) return;
  clearRemoteInvokeResultOutboxTimer();
  flushRemoteInvokeResultOutbox();
}

/**
 * ws-online 的事件批收口入口(index.ts 接线,与 outbox 的重连 flush 并列)。
 * 断线前攒的批必须最先出去:它在时间上早于离线积压与重连后的一切新推送,
 * 晚发就会让控制端在终态之后又收到旧文本(review 第三轮)。
 */
export function flushMakerEventBatchesOnReconnect(): void {
  for (const dst of [...makerEventBatchStages.keys()]) {
    flushMakerEventBatchesFor(dst);
  }
}

function flushRemoteInvokeResultOutbox(onlySrc?: string): void {
  const client = activeClient;
  if (!client) {
    scheduleRemoteInvokeResultOutboxFlush();
    return;
  }
  const relayOnline = client.getStatus() === 'online';
  const now = Date.now();
  const blockedPeers = new Set<string>();
  for (const [key, queued] of remoteInvokeResultOutbox) {
    if (onlySrc && queued.src !== onlySrc) continue;
    if (now - queued.queuedAt >= outboxEntryMaxAgeMs(queued.channel)) {
      log.warn(
        `dropping expired invoke-result outbox entry for ${queued.channel ?? '?'} ` +
        `to ${shortId(queued.src)}`,
      );
      removeRemoteInvokeResultOutboxEntry(key);
      continue;
    }
    // 离线轮只做上面的 TTL 出清:trySend 必然 NOT_CONNECTED,不空转、不刷日志。
    if (!relayOnline) continue;
    if (blockedPeers.has(queued.src)) continue;
    // presence 已明确宣告该控制端离线、且它当下也没有 accepted link:全量轮跳过盲发
    // (每 500ms 一帧必弹 DEVICE_OFFLINE,只喂 relay 聚合背压),条目保留、TTL 照常。
    // 判据与 fail-open 边界见 isKnownUnroutable。门禁只作用于全量轮(onlySrc 为空):
    // 定向轮由 link-open 触发,「对端刚主动建链」是比 presence 更强、更新的在线证据,
    // presence 短暂滞后/误报不得把这条恢复事件一并拦死(review P2)。
    if (!onlySrc && isKnownUnroutable(queued.src)) {
      blockedPeers.add(queued.src);
      continue;
    }
    const attempt = trySendInvokeResult(
      client,
      queued.src,
      queued.requestId,
      queued.result,
      queued.channel,
      queued.args,
      false,
    );
    if (!attempt.sent) {
      blockedPeers.add(queued.src);
      if (attempt.result !== queued.result) {
        const bytes = invokeResultOutboxBytes(attempt.result, queued.fingerprint);
        remoteInvokeResultOutboxBytes += bytes - queued.bytes;
        queued.result = attempt.result;
        queued.bytes = bytes;
      }
      continue;
    }
    removeRemoteInvokeResultOutboxEntry(key);
    log.info(
      `flushed queued invoke-result for ${queued.channel ?? '?'} to ${shortId(queued.src)}`,
    );
  }
  if (remoteInvokeResultOutbox.size > 0) scheduleRemoteInvokeResultOutboxFlush();
}

function compactInvokeResultForDeviceLink(
  channel: string | undefined,
  result: InvokeResultPayload,
  frame: { dst: string; requestId: string },
  args?: unknown[],
): InvokeResultPayload | null {
  if (!channel || !REMOTE_MESSAGE_CHANNELS.has(channel)) return null;
  if (!result.ok || !Array.isArray(result.result)) return null;
  const compactMessages = result.result.map(compactRemoteMessageForDeviceLink);
  const compact: InvokeResultPayload = {
    ok: true,
    result: compactMessages,
  };
  if (fitsInvokeResultFrame(frame, compact)) return compact;

  const placeholderMessages = compactMessages.map(forceCompactRemoteMessageContent);
  const placeholderCompact: InvokeResultPayload = {
    ok: true,
    result: placeholderMessages,
  };
  if (fitsInvokeResultFrame(frame, placeholderCompact)) return placeholderCompact;

  for (let keep = placeholderMessages.length - 1; keep > 0; keep -= 1) {
    const sliced: InvokeResultPayload = {
      ok: true,
      result: sliceRemoteMessageWindowForChannel(channel, placeholderMessages, keep, args),
    };
    if (fitsInvokeResultFrame(frame, sliced)) return sliced;
  }
  return null;
}

function sliceRemoteMessageWindowForChannel(
  channel: string,
  messages: unknown[],
  keep: number,
  args?: unknown[],
): unknown[] {
  // messages:list returns desc(createdAt), so the front of the page is newest.
  if (channel === 'local-db:messages:list') {
    return markRemoteRowsTrimmed(messages.slice(0, keep), messages.length);
  }

  const anchorIndex = findRemoteMessageAnchorIndex(channel, messages, args);
  if (anchorIndex >= 0) return sliceMessageWindowAroundAnchor(messages, keep, anchorIndex);

  // around/around-client-id return chronological windows, so the tail is newest.
  return messages.slice(-keep);
}

function findRemoteMessageAnchorIndex(channel: string, messages: unknown[], args?: unknown[]): number {
  const anchorKey = channel === 'local-db:messages:around'
    ? 'id'
    : channel === 'local-db:messages:around-client-id'
      ? 'clientId'
      : null;
  const anchorValue = args?.[1];
  if (!anchorKey || typeof anchorValue !== 'string') return -1;
  return messages.findIndex((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    return (message as Record<string, unknown>)[anchorKey] === anchorValue;
  });
}

function sliceMessageWindowAroundAnchor(messages: unknown[], keep: number, anchorIndex: number): unknown[] {
  const clampedKeep = Math.max(1, Math.min(keep, messages.length));
  const before = Math.floor((clampedKeep - 1) / 2);
  const start = Math.min(Math.max(0, anchorIndex - before), messages.length - clampedKeep);
  return messages.slice(start, start + clampedKeep);
}

function fitsInvokeResultFrame(frame: { dst: string; requestId: string }, payload: InvokeResultPayload): boolean {
  const serialized = JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'invoke-result',
    id: frame.requestId,
    dst: frame.dst,
    payload,
  });
  return encodedByteLength(serialized) <= MAX_FRAME_BYTES - REMOTE_INVOKE_FRAME_SAFETY_BYTES;
}

function forceCompactRemoteMessageContent(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  return {
    ...record,
    agentMeta: markRemoteContentTruncated(record.agentMeta),
    content: record.role === 'tool_use'
      ? compactRemoteToolUseContent(record.content, true)
      : REMOTE_INVOKE_TRUNCATED_CONTENT,
  };
}

function compactRemoteMessageForDeviceLink(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (record.role === 'tool_use') {
    const compactContent = compactRemoteToolUseContent(record.content, false);
    if (compactContent === record.content) {
      return stripRecoveryCheckpointFromMessage(record);
    }
    return {
      ...record,
      agentMeta: markRemoteContentTruncated(record.agentMeta),
      content: compactContent,
    };
  }
  const contentLimit = record.role === 'tool_result'
    ? REMOTE_TOOL_RESULT_CONTENT_LIMIT
    : REMOTE_MESSAGE_CONTENT_LIMIT;
  const compactContent = compactRemoteMessageContent(record.content, contentLimit);
  if (compactContent === record.content) {
    return stripRecoveryCheckpointFromMessage(record);
  }
  return {
    ...record,
    agentMeta: markRemoteContentTruncated(record.agentMeta),
    content: compactContent,
  };
}

function markRemoteContentTruncated(agentMeta: unknown): Record<string, unknown> {
  return mergeRemoteAgentMeta(agentMeta, { remoteContentTruncated: true });
}

function markRemoteRowsTrimmed(messages: unknown[], originalCount: number): unknown[] {
  if (messages.length >= originalCount) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    return {
      ...record,
      agentMeta: mergeRemoteAgentMeta(record.agentMeta, {
        remoteRowsTrimmed: true,
        remoteOriginalRowCount: originalCount,
      }),
    };
  });
}

function mergeRemoteAgentMeta(agentMeta: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  if (!agentMeta || typeof agentMeta !== 'object' || Array.isArray(agentMeta)) {
    return { ...patch };
  }
  const { recoveryCheckpoint: _, ...safe } = agentMeta as Record<string, unknown>;
  return { ...safe, ...patch };
}

function stripRecoveryCheckpointFromMessage(record: Record<string, unknown>): Record<string, unknown> {
  const agentMeta = record.agentMeta;
  const hasCheckpointInMeta = agentMeta && typeof agentMeta === 'object' && !Array.isArray(agentMeta) &&
    'recoveryCheckpoint' in (agentMeta as Record<string, unknown>);
  const content = record.content;
  const checkpointIdx = typeof content === 'string'
    ? (content as string).indexOf(RECOVERY_CHECKPOINT_MARKER)
    : -1;
  const hasCheckpointInContent = checkpointIdx >= 0;
  if (!hasCheckpointInMeta && !hasCheckpointInContent) return record;
  const result: Record<string, unknown> = { ...record };
  if (hasCheckpointInMeta) {
    const { recoveryCheckpoint: _, ...safeMeta } = agentMeta as Record<string, unknown>;
    result.agentMeta = safeMeta;
  }
  if (hasCheckpointInContent) {
    result.content = (content as string).slice(0, checkpointIdx);
  }
  return result;
}

function compactRemoteMessageContent(content: unknown, limit: number): unknown {
  if (typeof content === 'string') return truncateRemoteInvokeString(content, limit);
  const serialized = safeJsonStringify(content);
  if (!serialized || encodedByteLength(serialized) <= limit) return content;
  return REMOTE_INVOKE_TRUNCATED_CONTENT;
}

function compactRemoteToolUseContent(content: unknown, force: boolean): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return force
      ? REMOTE_INVOKE_TRUNCATED_CONTENT
      : compactRemoteMessageContent(content, REMOTE_MESSAGE_CONTENT_LIMIT);
  }
  if (!force) {
    const serialized = safeJsonStringify(content);
    if (serialized && encodedByteLength(serialized) <= REMOTE_MESSAGE_CONTENT_LIMIT) return content;
  }

  const record = content as Record<string, unknown>;
  const compacted = compactRemoteToolUseMetadata(record);
  if ('input' in record) {
    compacted.input = compactRemoteToolUseInput(
      record.input,
      force ? REMOTE_TOOL_USE_FORCED_INPUT_STRING_LIMIT : REMOTE_TOOL_USE_INPUT_STRING_LIMIT,
    );
  }
  return compacted;
}

function compactRemoteToolUseMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'input') continue;
    if (typeof value === 'string') {
      compacted[key] = truncateRemoteInvokeString(value, REMOTE_TOOL_USE_METADATA_STRING_LIMIT);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function compactRemoteToolUseInput(input: unknown, stringLimit: number): unknown {
  if (typeof input === 'string') return truncateRemoteInvokeString(input, stringLimit);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return compactRemoteMessageContent(input, stringLimit);
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      compacted[key] = truncateRemoteInvokeString(value, stringLimit);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      compacted[key] = value;
      continue;
    }
    const serialized = safeJsonStringify(value);
    compacted[key] = serialized && encodedByteLength(serialized) <= stringLimit
      ? value
      : REMOTE_INVOKE_TRUNCATED_CONTENT;
  }
  return compacted;
}

function truncateRemoteInvokeString(value: string, limit: number): string {
  if (encodedByteLength(value) <= limit) return value;
  const suffixBytes = encodedByteLength(REMOTE_INVOKE_TRUNCATION_SUFFIX);
  const valueBudget = Math.max(0, limit - suffixBytes);
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodedByteLength(value.slice(0, mid)) <= valueBudget) lo = mid;
    else hi = mid - 1;
  }
  return `${value.slice(0, lo)}${REMOTE_INVOKE_TRUNCATION_SUFFIX}`;
}

function encodedByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function safeJsonStringify(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

/** 处理 subscribe / unsubscribe 控制帧;返回 invoke-result。 */
function isRemoteSubscriptionTopic(value: unknown): value is Topic {
  if (typeof value !== 'string') return false;
  if (value === 'sessions') return true;
  if (value.startsWith('session:')) return value.length > 'session:'.length;
  return parseFsWatchTopic(value) !== null;
}

function handleSubscriptionFrame(src: string, payload: InvokePayload): InvokeResultPayload {
  // 被控开关(server 已 gate invoke,这里二次兜底)
  if (!readDeviceLinkSettings().remoteControlEnabled) {
    return { ok: false, error: { code: 'REMOTE_DISABLED', message: 'remote control disabled' } };
  }
  // 逐设备黑名单:已撤销 → 拒绝订阅(控制端据此 ACCESS_REVOKED 标记「已撤销」+ 移除该设备)。
  if (isControllerRevoked(src)) {
    return { ok: false, error: { code: 'ACCESS_REVOKED', message: 'access revoked by target device' } };
  }
  const arg = (payload.args ?? [])[0];
  const o =
    arg && typeof arg === 'object'
      ? (arg as { topics?: unknown; controllerName?: unknown; capabilities?: unknown })
      : {};
  const topics = Array.isArray(o.topics)
    ? o.topics.filter(isRemoteSubscriptionTopic)
    : [];
  // legacy `'*'`(全量 firehose + 点亮被控横幅)只允许走 link-open 路径,不接受 subscribe 帧
  // 携带 —— 上面 filter 已剔除,防控制端一帧订全部会话流。
  const name = resolveControllerName(src, o.controllerName);
  const isSub = payload.channel === DL_SUBSCRIBE_CHANNEL;
  if (isSub) {
    // link-open provisionally installs legacy '*' for old clients. A non-empty modern subscribe
    // proves topic support, so replace that compatibility firehose and remember the capability
    // until disconnect. Empty/fully-filtered frames leave legacy compatibility intact.
    // Add the modern topics first so replacing the last legacy topic does not discard the
    // controller metadata (including negotiated capabilities) with the registry entry.
    const hadLegacyTopic = subscriptions.controllerHasTopic(src, LEGACY_TOPIC);
    subscriptions.subscribe(src, topics, name, optionalControllerCapabilities(o));
    if (topics.length > 0) {
      topicSubscriptionControllers.add(src);
      if (hadLegacyTopic) subscriptions.unsubscribe(src, [LEGACY_TOPIC]);
    }
  } else {
    subscriptions.unsubscribe(src, topics);
    // 退订 sessions 后暂存里的活动快照不应再投递(含已排期的重试)。
    if (topics.includes('sessions')) clearSessionActivityStage(src);
    // 退订 session:<id> 后该会话的待发事件批同样不应再投递(控制端已不要这条流)。
    for (const topic of topics) {
      const sessionId = topic.startsWith('session:') ? topic.slice('session:'.length) : null;
      if (sessionId) dropMakerEventBatch(src, sessionId);
    }
  }
  syncForwarding();
  if (isSub && topics.includes('sessions')) {
    notifySessionsSubscribed(src);
  }
  if (isSub && topics.length > 0) {
    // 先排空断线前的事件批,再投递离线积压(review 第三轮):断线期间同会话的
    // 新事件与终态推送进的是 offlinePushQueue,而旧批留在内存等重试 timer;
    // 不先收口就会让新帧先于断线前的文本送达,重现「终态后冒出文本」。
    flushMakerEventBatchesFor(src);
    drainOfflinePushQueueTo(src, topics);
  }
  return { ok: true, result: { ok: true } };
}

/** 纯函数:执行远程 invoke 并产出 result(可单测,不依赖 client) */
export async function runInvoke(
  src: string,
  payload: InvokePayload | undefined,
): Promise<InvokeResultPayload> {
  if (!payload || typeof payload.channel !== 'string') {
    return { ok: false, error: { code: 'INTERNAL', message: 'malformed invoke payload' } };
  }
  // 双层校验之一:被控开关
  if (!readDeviceLinkSettings().remoteControlEnabled) {
    return { ok: false, error: { code: 'REMOTE_DISABLED', message: 'remote control disabled' } };
  }
  // 逐设备黑名单:已撤销访问权限的控制端直接拒绝(早于 allowlist)。
  if (isControllerRevoked(src)) {
    log.warn(`blocked invoke from revoked controller ${shortId(src)}: ${payload.channel}`);
    return { ok: false, error: { code: 'ACCESS_REVOKED', message: 'access revoked by target device' } };
  }
  // 双层校验之二:allowlist(权威)
  if (!REMOTE_INVOKE_ALLOWLIST.has(payload.channel)) {
    log.warn(`blocked non-allowlisted channel from ${shortId(src)}: ${payload.channel}`);
    return {
      ok: false,
      error: { code: 'CHANNEL_NOT_ALLOWED', message: `channel '${payload.channel}' not allowed remotely` },
    };
  }

  // Review sessions may be mirrored to controllers for visibility, but their
  // only input is the host's direct reviewer.send() call. Reject before the
  // synthetic ipcMain event is dispatched, then let the handler repeat the
  // same DB-backed check as defense in depth for local Renderer calls.
  if (REMOTE_REVIEW_EXTERNAL_INPUT_CHANNELS.has(payload.channel) && remoteReviewInputGuard) {
    const sessionId = payload.args?.[0];
    if (typeof sessionId === 'string') {
      try {
        await remoteReviewInputGuard(sessionId);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'IPC_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  }

  // device-link:media:fetch 不是 ipcMain handler(同 subscribe),在此拦截:解析本机媒体 →
  // 上传 OSS 中转 → 回 { ossKey, mimeType, size }。已过三道 gate,等同受信本地访问。
  if (payload.channel === DL_MEDIA_FETCH_CHANNEL) {
    try {
      const result = await fetchLocalMediaToOss((payload.args ?? [])[0]);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`media:fetch failed from ${shortId(src)}: ${message}`);
      return { ok: false, error: { code: 'MEDIA_FETCH_FAILED', message } };
    }
  }

  // device-link:telegram:* 不是 ipcMain handler(IM 的 ipcMain 面统一挂了
  // assertTrustedAppRendererEvent, 合成 event 必然不可信 —— 那道闸不该为远程下线
  // 放宽), 故在此拦截。已过三道 gate, 等同受信本地访问。只切轮询、不碰凭证:
  // 远程能让它停收消息, 但拿不走也删不掉绑定(解绑仍只能本机操作)。
  if (payload.channel === DL_TELEGRAM_STATUS_CHANNEL) {
    return { ok: true, result: readTelegramRemoteStatus() };
  }
  if (payload.channel === DL_TELEGRAM_SET_ONLINE_CHANNEL) {
    try {
      const result = await setTelegramRemoteOnline((payload.args ?? [])[0]);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`telegram:set-online failed from ${shortId(src)}: ${message}`);
      return { ok: false, error: { code: 'IPC_ERROR', message } };
    }
  }

  // Legacy device-link:voice:transcribe 不是 ipcMain handler:早期手机语音方案上传录音到 OSS 后,
  // 被控端下载并用本机 voice-input batch ASR 配置转写。当前手机版主流程走 credential sync
  // + 手机端实时 ASR/refine,此处仅保留协议兼容面。已过三道 gate,等同受信本地访问。
  if (payload.channel === DL_VOICE_TRANSCRIBE_CHANNEL) {
    try {
      const result = await transcribeRemoteVoiceInput((payload.args ?? [])[0]);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`voice:transcribe failed from ${shortId(src)}: ${message}`);
      return { ok: false, error: { code: 'VOICE_TRANSCRIBE_FAILED', message } };
    }
  }

  // device-link:voice:credential-sync 已下线:手机语音输入改走 Cindy 官方语音服务
  // (Cindy 登录 → voice-server 一次性票据),桌面不再向手机穿透 XD Gateway key。
  // 保留 channel 匹配,让旧手机版拿到可读错误而不是 CHANNEL_NOT_ALLOWED。
  if (payload.channel === DL_VOICE_CREDENTIAL_SYNC_CHANNEL) {
    log.warn(`voice:credential-sync rejected from ${shortId(src)}: feature removed`);
    return {
      ok: false,
      error: {
        code: 'VOICE_CREDENTIAL_SYNC_REMOVED',
        message: '手机语音输入已改用 Cindy 官方语音服务,请升级手机版。',
      },
    };
  }

  // device-link:voice:dictionary:get 是手机拉取本机词典的只读快照。手机在后台不维持
  // WebSocket,拿不到桌面之间对等同步的 push 帧,所以改为需要时主动拉一份;它只读、
  // 不参与合并,避免移动端维护一份会分叉的词典。
  if (payload.channel === DL_VOICE_DICTIONARY_GET_CHANNEL) {
    try {
      return { ok: true, result: buildMobileDictionarySnapshot() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`voice:dictionary:get failed from ${shortId(src)}: ${message}`);
      return { ok: false, error: { code: 'VOICE_DICTIONARY_GET_FAILED', message } };
    }
  }

  // device-link:voice:dictionary-learning 是手机端 voice refine 后的术语学习 evidence 回写:
  // 手机只负责检测用户编辑,真正 advisor + 词典写入仍在被控桌面执行,避免移动端词典分叉。
  if (payload.channel === DL_VOICE_DICTIONARY_LEARNING_CHANNEL) {
    try {
      const result = await handleMobileVoiceDictionaryLearning(src, (payload.args ?? [])[0]);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`voice:dictionary-learning failed from ${shortId(src)}: ${message}`);
      return { ok: false, error: { code: 'VOICE_DICTIONARY_LEARNING_FAILED', message } };
    }
  }

  // 参数级收敛:create-session 的 workingDir / worktree:create 的 baseRepo 决定 agent
  // 在哪个目录起进程或跑 git,allowlist 只挡 channel 不挡 args。路径必须在被控端
  // 当前可访问且确为目录,历史记录不能替代实时探测。
  const guardedField = PATH_GUARDED_CHANNELS.get(payload.channel);
  if (guardedField && workingDirGuard) {
    const dir = extractGuardedPath(payload.args ?? [], guardedField);
    const guardResult = dir ? await workingDirGuard(dir) : true;
    if (guardResult === false) {
      log.warn(`blocked remote ${payload.channel} to unknown ${guardedField} from ${shortId(src)}: ${dir}`);
      return {
        ok: false,
        error: {
          code: 'CHANNEL_NOT_ALLOWED',
          message: `${guardedField} not allowed for remote ${payload.channel}`,
        },
      };
    }
    if (guardResult !== true && !guardResult.allowed) {
      const rejection = remoteWorkingDirRejectionToIpcError(guardResult.reason);
      log.warn(`blocked remote ${payload.channel} for ${guardedField} reason ${guardResult.reason} from ${shortId(src)}`);
      return {
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message: `[${rejection.code}] ${rejection.message}`,
        },
      };
    }
  }

  try {
    const args = payload.args ?? [];
    const listingCapabilities = payload.channel === 'maker:provider:list'
      ? invokeControllerCapabilities(payload)
      : [];
    const result = await runDeviceLinkInvokeContext(
      {
        controllerDeviceId: src,
        channel: payload.channel,
        // 平台按 server 盖章的 src 查本机 presence 登记表,不采信控制端自报的任何
        // 帧内字段(allowlist 只挡 channel 不挡 args,见下方 dispatchLocalInvoke 前的说明)。
        controllerPlatform: getControllerPlatform(src),
      },
      // provider:list 的首参只承载隧道能力协商，不进入本机 IPC handler。
      () => dispatchLocalInvoke(
        payload.channel,
        payload.channel === 'maker:provider:list' ? [] : args,
      ),
    );
    // 远程 set-* 回流:被控端 set-* runtime-only,补一次 DB 持久化 + 广播 patched,让控制端
    // 镜像收敛到被控端真相(取代控制端乐观覆盖)。本机会话不走这条(走 renderer update)。
    await persistRemoteSetting(payload.channel, payload.args ?? [], result);
    return {
      ok: true,
      result: projectInvokeResultForTunnel(
        payload.channel,
        result,
        subscriptions.controllerSupports(
          src,
          CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
        )
        || listingCapabilities.includes(CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2),
      ),
    };
  } catch (err) {
    // 被控端 handler 的 throwIpcError `[CODE] message` 原样透传,
    // 控制端 renderer 继续用 extractIpcError 解码
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: 'IPC_ERROR', message } };
  }
}

function normalizeMobileVoiceDictionaryLearningRequest(
  input: unknown,
): MobileVoiceDictionaryLearningRequest {
  if (!input || typeof input !== 'object') {
    throw new Error('dictionary learning request is required');
  }
  const record = input as Partial<MobileVoiceDictionaryLearningRequest>;
  const beforeText = typeof record.beforeText === 'string' ? record.beforeText.trim() : '';
  const afterText = typeof record.afterText === 'string' ? record.afterText.trim() : '';
  if (!beforeText || !afterText) {
    throw new Error('dictionary learning request requires beforeText and afterText');
  }
  const rawTranscriptText = typeof record.rawTranscriptText === 'string' && record.rawTranscriptText.trim()
    ? record.rawTranscriptText.trim()
    : undefined;
  const context = record.context && typeof record.context === 'object'
    ? record.context
    : undefined;
  return {
    source: 'mobile',
    rawTranscriptText,
    beforeText,
    afterText,
    context: {
      uiLanguage: readOptionalString(context, 'uiLanguage'),
      sourceLanguage: readOptionalString(context, 'sourceLanguage'),
      selectionBefore: readOptionalString(context, 'selectionBefore'),
      selectionAfter: readOptionalString(context, 'selectionAfter'),
    },
  };
}

async function handleMobileVoiceDictionaryLearning(
  controllerDeviceId: string,
  input: unknown,
): Promise<unknown> {
  const request = normalizeMobileVoiceDictionaryLearningRequest(input);
  return adviseAndRecordVoiceInputDictionaryLearning(
    {
      source: 'in_app',
      rawTranscriptText: request.rawTranscriptText,
      beforeText: request.beforeText,
      afterText: request.afterText,
      context: request.context,
    },
    {
      senderId: controllerDeviceId,
      sourceLabel: 'mobile',
    },
  );
}

function readOptionalString(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function shortId(deviceId: string): string {
  return deviceId.slice(0, 8);
}

export const __testing = {
  reset(): void {
    subscriptions.__testing.reset();
    onControllersChanged = null;
    onRemoteInvokeBusyChanged = null;
    inFlightRemoteInvokeCount = 0;
    completedRemoteInvokeResults.clear();
    completedRemoteInvokeResultBytes = 0;
    inFlightRemoteInvokeResults.clear();
    inFlightRemoteInvokeBytes = 0;
    remoteInvokeResultOutbox.clear();
    remoteInvokeResultOutboxBytes = 0;
    clearRemoteInvokeResultOutboxTimer();
    remoteInvokeLinkEpoch.clear();
    topicSubscriptionControllers.clear();
    acceptedLinkControllers.clear();
    controllerConnectionEpochByDevice.clear();
    controllerLinkGenerationByDevice.clear();
    controllerDisplayNameByDevice.clear();
    reportedControllerNameByDevice.clear();
    onSessionsSubscribed = null;
    activeClient = null;
    offlinePushQueue.clear();
    clearAllSessionActivityStages();
    clearAllMakerEventBatchStages();
    cancelAllLinkAcceptRetries();
    revokedLinkOpenRejectAt.clear();
    setBroadcastTapListener(null);
    presenceOfflineCheck = null;
    remoteReviewInputGuard = null;
  },
  getActiveControllers,
  getUpdateRelaunchControllers,
  hasInFlightRemoteInvokes,
  controllerSupports: subscriptions.controllerSupports,
  optionalControllerCapabilities,
  sendInvokeResultSafe,
  projectInvokeResultForTunnel,
  remoteInvokeInFlightLimit: REMOTE_INVOKE_IN_FLIGHT_LIMIT,
  remoteInvokeInFlightPerControllerLimit: REMOTE_INVOKE_IN_FLIGHT_PER_CONTROLLER_LIMIT,
  remoteInvokeOrphanTimeoutMs: REMOTE_INVOKE_ORPHAN_TIMEOUT_MS,
  remoteInvokeOrphanTimeoutForChannelMs: remoteInvokeOrphanTimeoutMs,
  remoteInvokeResultOutboxLimit: REMOTE_INVOKE_RESULT_OUTBOX_LIMIT,
  remoteInvokeResultOutboxPerControllerLimit: REMOTE_INVOKE_RESULT_OUTBOX_PER_CONTROLLER_LIMIT,
  remoteInvokeResultOutboxSize: () => remoteInvokeResultOutbox.size,
  flushRemoteInvokeResultOutbox,
  outboxEntryMaxAgeMs,
  linkAcceptRetryDelaysMs: LINK_ACCEPT_RETRY_DELAYS_MS,
  pendingLinkAcceptRetryCount: () => linkAcceptRetryTimers.size,
  forwardPush,
  queuedPushesFor(deviceId: string) {
    return offlinePushQueue.snapshot(deviceId);
  },
  sessionActivityStageSize(deviceId: string): number {
    return sessionActivityStages.get(deviceId)?.queue.size ?? 0;
  },
  sessionActivityWindowSoftCap: SESSION_ACTIVITY_WINDOW_SOFT_CAP,
  sessionActivityStageMaxKeys: SESSION_ACTIVITY_STAGE_MAX_KEYS,
  sessionActivityDrainRetryMs: SESSION_ACTIVITY_DRAIN_RETRY_MS,
  handleLinkOpen,
  handleSubscriptionFrame,
  purgeRevokedController,
  setActiveClient(c: DeviceLinkClient | null): void {
    activeClient = c;
  },
};
