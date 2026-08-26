/**
 * newSessionCreation.ts — 新建会话乐观管线(模块级单例,不随页面 unmount 终止)。
 * ---------------------------------------------------------------------------
 * 点「创建」后用户**立即**进入会话页:sessionId 由手机端预生成(被控端
 * `maker:create-session` 自手机远控首版起支持 opts.id 透传,maker-core 对
 * provided id 幂等——active 复用 / storage 命中跳过 insert),因此乐观会话行、
 * projection、路由参数、订阅 topic 从一开始就是最终 id,无需 rekey 对账。
 * openLink / createSession / 首条消息 enqueue 全部在本模块后台串行完成。
 *
 * 状态机:running → done(task 移除)
 *              → create-failed(会话页横幅:重试[同 id 幂等安全] / 返回编辑[草稿回填])
 *              → enqueue-failed(会话已建成:乐观气泡摘除、草稿+附件回填 composer,
 *                                用户走正常 handleSend 重发)
 *
 * 幂等与重试口径:
 *  - openLink / subscribe 幂等,走 withTransientRemoteRetry;
 *  - createSession **不盲重**:瞬态失败先 probe getSession(id)——命中说明上一次
 *    invoke 已在被控端生效只是回执丢了,直接继续;NOT_FOUND 才退避重建(串行,
 *    防 maker-core spawn 窗口内同 id 并发双起 SDK 进程);
 *  - enqueue 失败先分辨「已应用 vs 未应用」(getProjection 按 clientId 查队列 +
 *    store 消息回流查证),已应用按成功收敛;未应用 / 无法分辨才转 enqueue-failed
 *    (重发面在会话页;注意重发走正常 handleSend、用的是**新 clientId**,被控端
 *    的 clientId 幂等去重覆盖不到它——所以「确定未应用」必须高置信:连续两次
 *    查询成功且队列 / 权威消息两路皆空,且所有 enqueue-failed 文案都引导用户先
 *    核对会话内容。不复用原 clientId 重发:用户可能改写文本后再发,同 clientId
 *    会被 dedup 静默吞掉,丢消息比双发更糟)。
 */
import { useSyncExternalStore } from 'react';
import * as ExpoCrypto from 'expo-crypto';
import { isPreconditionFailedRemoteError } from '@cindy/maker-shared/device-link-contract';
import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';
import { i18n } from '@/i18n';
import { isTransientRemoteError, withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { formatRemoteError } from '@/device-link/remoteStatus';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { buildQueuedTextMessage } from '@/session/inputProjection';
import {
  extractMobileSessionReferences,
  type MobileSessionReference,
} from '@/session/sessionReferences';
import {
  buildRemoteCreateSessionOptions,
  normalizeCreateSessionResult,
  resolveStartedDowngradeOrCommit,
  sessionFromCreateResult,
  type NewSessionDraft,
} from '@/session/newSession';
import type { DeviceProvidersPayload } from '@/device-link/deviceProvidersCache';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import {
  forgetPendingPrecreatedWorktree,
  parseDiscardPrecreatedAck,
  registerPendingPrecreatedWorktree,
} from '@/session/precreatedWorktreeRecovery';
import type {
  InputProjection,
  QueuedRemoteMessage,
  RemoteSerializedAttachment,
  RemoteSession,
} from '@/session/types';

export type NewSessionCreationStatus = 'running' | 'create-failed' | 'enqueue-failed';

export interface NewSessionCreationTransport {
  maker: MobileMakerTransport;
  openLink: (deviceId: string) => Promise<unknown>;
  subscribe: (owner: string, deviceId: string, topics: string[]) => Promise<void>;
  /** 手机控制端在首条消息越过 device-link 前读取各引用来源的可信历史快照。 */
  prepareQueuedMessage?: (item: QueuedRemoteMessage) => Promise<QueuedRemoteMessage>;
}

export interface NewSessionCreationParams {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  /** 草稿快照(create-failed「返回编辑」回填 + 重跑管线的材料)。 */
  draft: NewSessionDraft;
  /** 已上传完成的附件引用(enqueue-failed 时原样回填 composer 托盘)。 */
  attachments: readonly RemoteSerializedAttachment[];
  /** 新协议计划模式:enqueue 前武装 setPlanMode(best-effort)。 */
  planModeArm: boolean;
  /** 老协议 plan 档一次性语义:enqueue 后要恢复的底层权限档(null = 不需要)。 */
  legacyPlanRestore: string | null;
  /**
   * 手机两步 worktree 流程第一步已创建的受管目录。create-failed 重试继续复用它；
   * 用户放弃返回编辑时先按 sessionId + path 补偿回收，再把原项目目录回填表单。
   */
  precreatedWorktree?: {
    path: string;
    recoveryKey: string;
    originalWorkingDir: string;
    /** 持久恢复账本中的创建时间。 */
    createdAt?: number;
  };
  /** 与预创建 worktree 账本绑定的账号；空值表示旧调用方不启用持久清理。 */
  precreatedWorktreeAccountId?: string;
  /**
   * createSession 前的鉴权 fresh revalidate(与建链并行跑)。返回
   * { unauthenticated, fresh }:unauthenticated=true = 确认未鉴权 →
   * create-failed(文案用 authGateHint)并触发 onUnauthenticated(页面闭包驱逐
   * provider 缓存);fresh = 本次现拉的工作站目录(可能为 null,如拉取失败)。
   */
  confirmUnauthenticated: () => Promise<{ unauthenticated: boolean; fresh: DeviceProvidersPayload | null }>;
  authGateHint: string;
  onUnauthenticated: () => void;
  /**
   * 鉴权 fresh revalidate 之后、createSession 之前,用工作站当前目录联合校验
   * (model, providerId)(codex review P2):提交终检在 handoff 前完成,后台管线
   * 建链/鉴权期间工作站可能已替换 provider——返回需覆盖 task.draft 的 patch
   * (组合变化时调用方负责 effort/fastMode 联动),null = 无需修正。
   */
  revalidateDraftAfterAuth?: (fresh: DeviceProvidersPayload) => Promise<Partial<NewSessionDraft> | null>;
  /** Account-generation fence captured before the create flow starts. */
  isCurrentOwner?: () => boolean;
  transport: NewSessionCreationTransport;
  /** 退避 / 轮询的 sleep 注入点(单测替换为立即返回;对齐 resolveInteractionResilient 的 opts.sleep 模式)。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface NewSessionCreationTask {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly status: NewSessionCreationStatus;
  readonly error: string | null;
  readonly draft: NewSessionDraft;
  readonly attachments: readonly RemoteSerializedAttachment[];
  readonly firstMessageClientId: string;
  readonly precreatedWorktree?: {
    path: string;
    recoveryKey: string;
    originalWorkingDir: string;
    createdAt?: number;
  };
}

interface InternalTask extends NewSessionCreationTask {
  status: NewSessionCreationStatus;
  error: string | null;
  firstMessageSessionRefs: MobileSessionReference[];
  precreatedWorktreeSessionCreateStarted: boolean;
  params: NewSessionCreationParams;
}

const tasks = new Map<string, InternalTask>();
const subs = new Set<() => void>();
// useSyncExternalStore 的快照必须引用稳定:每次变更 bump 版本并重建缓存数组。
let snapshotVersion = 0;
const taskSnapshots = new Map<string, NewSessionCreationTask | null>();

function emit(): void {
  snapshotVersion += 1;
  taskSnapshots.clear();
  for (const sub of subs) sub();
}

/** createSession 重试:总尝试次数(首次 + 重试),重试前必 probe。 */
const CREATE_ATTEMPTS = 3;
const CREATE_RETRY_BASE_DELAY_MS = 800;
/**
 * enqueue 失败后的分辨轮询间隔(codex review P1):enqueue 可能已被被控端受理并
 * 瞬间 drain 进 activeTurn(手机 projection 无 activeTurn 字段),消息 row 落库
 * 回流有秒级窗口——立即分辨会把「已应用」误判成未应用,用户重发(新 clientId)
 * 造成首条消息双发。轮询给足观测窗口,连续两次「确定未应用」才转 enqueue-failed。
 */
const ENQUEUE_PROBE_DELAYS_MS = [1_500, 2_500, 4_000, 8_000] as const;
/**
 * enqueue 分辨的权威消息窗口:必须显著大于首 turn 在轮询窗口(~16s)内可能落库
 * 的行数——窗口打满时按「无法分辨」处理而非「未应用」(见 isFirstMessageApplied)。
 */
const PROBE_MESSAGE_WINDOW_LIMIT = 200;
const STALE_OWNER_CODE = 'NEW_SESSION_OWNER_CHANGED';

class StaleNewSessionOwnerError extends Error {
  readonly code = STALE_OWNER_CODE;

  constructor() {
    super(STALE_OWNER_CODE);
    this.name = 'StaleNewSessionOwnerError';
  }
}

function isStaleNewSessionOwnerError(error: unknown): boolean {
  return (
    error instanceof StaleNewSessionOwnerError
    || (
      !!error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === STALE_OWNER_CODE
    )
  );
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createUuid(): string {
  // sessionId / clientId 属安全上下文(CodeQL js/insecure-randomness),兜底
  // 不用 Math.random:平台 crypto.randomUUID 缺失时用 expo-crypto 的 CSPRNG
  // 字节手组 UUIDv4(对齐 auth/deviceId.ts 同款实现)。
  const cryptoWithUuid = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithUuid?.randomUUID === 'function') return cryptoWithUuid.randomUUID();
  const expoWithUuid = ExpoCrypto as typeof ExpoCrypto & { randomUUID?: () => string };
  if (typeof expoWithUuid.randomUUID === 'function') return expoWithUuid.randomUUID();
  const bytes = ExpoCrypto.getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createNewSessionId(): string {
  return createUuid();
}

/** 乐观 projection:首条消息以排队气泡即时上屏(会话页现有 pendingQueue 渲染)。 */
function buildOptimisticProjection(
  sessionId: string,
  queued: ReturnType<typeof buildQueuedTextMessage>,
): InputProjection {
  return {
    sessionId,
    pendingQueue: [queued],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

/** Preserve source-device hints captured before the target session creation mutates the live mirror. */
function attachFirstMessageSessionReferences(
  queued: QueuedRemoteMessage,
  refs: readonly MobileSessionReference[],
): QueuedRemoteMessage {
  return refs.length > 0
    ? { ...queued, sessionRefs: [...refs] }
    : queued;
}

function synthesizeSession(params: NewSessionCreationParams, draftOverride?: NewSessionDraft): RemoteSession {
  const draft = draftOverride ?? params.draft;
  return {
    ...sessionFromCreateResult({ sessionId: params.sessionId }, {
      ...draft,
      attachments: params.attachments,
    }),
    pendingLocalCreation: true,
  };
}

/**
 * 启动乐观创建:同步完成 store 写入(合成会话行 + 乐观排队气泡),登记 task 并
 * 后台跑管线。调用方随后立即 router.replace 进会话页。
 */
export function startNewSessionCreation(params: NewSessionCreationParams): void {
  if (params.isCurrentOwner && !params.isCurrentOwner()) return;
  const firstMessageClientId = createUuid();
  const firstMessageSessionRefs = extractMobileSessionReferences(
    params.draft.firstMessage,
    remoteSessionStore.getSessionDeviceId,
  );
  const session = synthesizeSession(params);
  remoteSessionStore.upsertDeviceSession(params.deviceId, params.deviceName, session);
  if (session.title && session.title !== DEFAULT_DRAFT_SESSION_TITLE) {
    remoteSessionStore.setPendingTitlePreview(params.sessionId, session.title);
  }
  const queued = attachFirstMessageSessionReferences(buildQueuedTextMessage(
    session,
    params.draft.firstMessage,
    new Date(),
    firstMessageClientId,
    { attachments: [...params.attachments] },
  ), firstMessageSessionRefs);
  remoteSessionStore.setInputProjectionOptimistically(params.sessionId, buildOptimisticProjection(params.sessionId, queued));
  const task: InternalTask = {
    sessionId: params.sessionId,
    deviceId: params.deviceId,
    deviceName: params.deviceName,
    status: 'running',
    error: null,
    draft: params.draft,
    attachments: params.attachments,
    firstMessageClientId,
    precreatedWorktree: params.precreatedWorktree,
    firstMessageSessionRefs,
    precreatedWorktreeSessionCreateStarted: false,
    params,
  };
  tasks.set(params.sessionId, task);
  emit();
  void runPipeline(task);
}

/** create-failed 的「重试」:同 sessionId 重跑管线(被控端幂等,安全)。 */
export function retryNewSessionCreation(sessionId: string): void {
  const task = tasks.get(sessionId);
  if (!task || task.status !== 'create-failed') return;
  // Once createSession may have run against a managed path, retrying can create
  // another wrong-id session that shares it. Recovery must first prove the
  // exact pre-generated id was claimed; unknown/NOT_FOUND stays retain-only.
  if (task.precreatedWorktreeSessionCreateStarted) return;
  if (!isTaskOwnerCurrent(task)) {
    cancelStaleOwnerTask(task);
    return;
  }
  task.status = 'running';
  task.error = null;
  // 重试前把乐观行 / 气泡恢复(返回编辑路径可能没走,行一般还在,upsert 幂等)。
  const session = synthesizeSession(task.params);
  remoteSessionStore.upsertDeviceSession(task.deviceId, task.deviceName, session);
  if (session.title && session.title !== DEFAULT_DRAFT_SESSION_TITLE) {
    remoteSessionStore.setPendingTitlePreview(sessionId, session.title);
  }
  const queued = attachFirstMessageSessionReferences(buildQueuedTextMessage(
    session,
    task.draft.firstMessage,
    new Date(),
    task.firstMessageClientId,
    { attachments: [...task.attachments] },
  ), task.firstMessageSessionRefs);
  remoteSessionStore.setInputProjectionOptimistically(sessionId, buildOptimisticProjection(sessionId, queued));
  emit();
  void runPipeline(task);
}

/**
 * 移除 task(create-failed「返回编辑」/ enqueue-failed 会话页消费完恢复材料后)。
 * removeSyntheticRow = true 时把乐观合成行从列表隐藏(仅 create-failed:会话在
 * 被控端不存在,残行点进去只会再挂一次)。
 */
export function dismissNewSessionCreation(sessionId: string, opts: { removeSyntheticRow?: boolean } = {}): void {
  const task = tasks.get(sessionId);
  if (!task) return;
  tasks.delete(sessionId);
  if (opts.removeSyntheticRow) {
    remoteSessionStore.applySessionPatch(task.deviceId, sessionId, { status: 'deleted' });
    remoteSessionStore.setInputProjectionOptimistically(sessionId, null);
    remoteSessionStore.clearPendingTitlePreview(sessionId);
  }
  emit();
}

/**
 * 回收与 create-session 共享 session 锁。若回收在 ownership 检查后收到
 * PRECONDITION_FAILED，优先再读一次权威会话；这通常表示 create-session
 * 已经提交、只是手机丢了最后的回包。把真实会话接回镜像并转入
 * enqueue-failed，避免「返回编辑」路径把一个已存在的会话误当成孤儿，
 * 也避免用户被困在 create-failed 页面。
 */
async function reconcileClaimedSessionForEdit(task: InternalTask): Promise<boolean> {
  let claimed: RemoteSession;
  try {
    assertTaskOwnerCurrent(task);
    claimed = await task.params.transport.maker.getSession(task.sessionId);
    assertTaskOwnerCurrent(task);
  } catch (error) {
    if (isStaleNewSessionOwnerError(error)) throw error;
    return false;
  }
  if (
    !claimed
    || claimed.id !== task.sessionId
    || tasks.get(task.sessionId) !== task
  ) {
    return false;
  }
  remoteSessionStore.upsertDeviceSession(task.deviceId, task.deviceName, {
    ...claimed,
    pendingLocalCreation: false,
  });
  const accountId = task.params.precreatedWorktreeAccountId?.trim();
  if (accountId && task.precreatedWorktree) {
    assertTaskOwnerCurrent(task);
    await forgetPendingPrecreatedWorktree(accountId, {
      sessionId: task.sessionId,
      recoveryKey: task.precreatedWorktree.recoveryKey,
      ...(task.precreatedWorktree.createdAt !== undefined
        ? { createdAt: task.precreatedWorktree.createdAt }
        : {}),
    });
  }
  failTask(
    task,
    'enqueue-failed',
    i18n.t('session.screen.firstMessageNotSent'),
  );
  return true;
}

/**
 * create-failed「返回编辑」的异步前置：先补偿回收未被 session 认领的预创建 worktree。
 *
 * 成功后调用方才可 stash + dismiss + 跳页，避免用户很快再次提交时与仍在执行的删除并发，
 * 重复生成第二个 worktree。任何未完成的回收（包括老被控端没有窄回收 channel）
 * 都抛给会话页并保留 task，不把启动期 orphan reconcile 当作当前运行期的完成凭据。
 */
export async function prepareNewSessionCreationForEdit(
  sessionId: string,
): Promise<NewSessionCreationTask | null> {
  const task = tasks.get(sessionId);
  if (!task || task.status !== 'create-failed') return null;
  if (!isTaskOwnerCurrent(task)) {
    cancelStaleOwnerTask(task);
    return null;
  }
  const precreated = task.precreatedWorktree;
  if (precreated) {
    if (task.precreatedWorktreeSessionCreateStarted) {
      throw new Error(i18n.t('session.new.worktreeCleanupPending'));
    }
    try {
      await withTransientRemoteRetry(async () => {
        assertTaskOwnerCurrent(task);
        await task.params.transport.openLink(task.deviceId);
        assertTaskOwnerCurrent(task);
        const discardResult = await task.params.transport.maker.worktree.discardPrecreated({
          sessionId,
          recoveryKey: precreated.recoveryKey,
        });
        assertTaskOwnerCurrent(task);
        if (!parseDiscardPrecreatedAck(discardResult)) {
          throw new Error(i18n.t('session.new.worktreeCleanupPending'));
        }
      }, { maxAttempts: 2 });
    } catch (err) {
      if (isStaleNewSessionOwnerError(err)) {
        cancelStaleOwnerTask(task);
        return null;
      }
      if (isPreconditionFailedRemoteError(err)) {
        // discard 与 create 共用 session 锁；ownership 拒绝通常意味着
        // create 已提交但回包丢失。按真实会话收敛，不能把用户留在失败页。
        if (await reconcileClaimedSessionForEdit(task)) return null;
      }
      throw err;
    }
    const accountId = task.params.precreatedWorktreeAccountId?.trim();
    if (accountId) {
      assertTaskOwnerCurrent(task);
      await forgetPendingPrecreatedWorktree(accountId, {
        sessionId,
        recoveryKey: precreated.recoveryKey,
        ...(precreated.createdAt !== undefined ? { createdAt: precreated.createdAt } : {}),
      });
    }
  }
  const current = tasks.get(sessionId);
  if (!current || current !== task || current.status !== 'create-failed') return null;
  return { ...current };
}

export function getNewSessionCreationTask(sessionId: string): NewSessionCreationTask | null {
  return tasks.get(sessionId) ?? null;
}

/**
 * 会话页 syncSession 守卫:running(被控端可能还没有这个会话,getSession 会
 * NOT_FOUND 报错横幅)与 create-failed(确定不存在)都要跳过同步;
 * enqueue-failed / done 时会话已建成,照常同步。
 */
export function shouldBlockSessionSync(sessionId: string): boolean {
  const status = tasks.get(sessionId)?.status;
  return status === 'running' || status === 'create-failed';
}

function subscribeTasks(callback: () => void): () => void {
  subs.add(callback);
  return () => {
    subs.delete(callback);
  };
}

function getTaskSnapshot(sessionId: string): NewSessionCreationTask | null {
  if (!taskSnapshots.has(sessionId)) {
    const task = tasks.get(sessionId);
    taskSnapshots.set(sessionId, task ? { ...task } : null);
  }
  return taskSnapshots.get(sessionId) ?? null;
}

/** 会话页订阅本会话的创建 task(null = 无 task / 已完成)。 */
export function useNewSessionCreationTask(sessionId: string): NewSessionCreationTask | null {
  return useSyncExternalStore(subscribeTasks, () => getTaskSnapshot(sessionId));
}

// ---------------------------------------------------------------------------
// 「返回编辑」草稿暂存信箱:会话页 stash → 跳回新建页 → new.tsx 挂载时 drain 回填。
// ---------------------------------------------------------------------------

export interface StashedNewSessionDraft {
  deviceId: string;
  deviceName: string;
  draft: NewSessionDraft;
  attachments: readonly RemoteSerializedAttachment[];
  /**
   * 「有内容没能带回来」的可见告知(新建页展示为附件错误行)。
   *
   * 新建页只有一条首条消息 + 一个受上限约束的托盘,而创建期间可能已经发出多条带附件
   * 的消息:装不下的部分只能丢,但**绝不能静默丢**——中转对象由会话页回收,用户得知道
   * 少了什么、需要重新选(review P1)。
   */
  notice?: string | null;
}

let stashedDraft: StashedNewSessionDraft | null = null;

/**
 * override 用于把「创建期间攒下的后续消息」并进带回新建页的草稿:那些消息此刻在会话页的
 * outbox 里,而合成会话行紧接着就被删掉,不并进来就再也找不回(review P1)。
 */
export function stashNewSessionDraftForEdit(
  task: NewSessionCreationTask,
  override?: {
    draft?: NewSessionDraft;
    attachments?: readonly RemoteSerializedAttachment[];
    notice?: string | null;
  },
): void {
  const baseDraft = task.precreatedWorktree
    ? {
        ...task.draft,
        workingDir: task.precreatedWorktree.originalWorkingDir,
      }
    : task.draft;
  stashedDraft = {
    deviceId: task.deviceId,
    deviceName: task.deviceName,
    draft: override?.draft
      ? {
          ...override.draft,
          workingDir: baseDraft.workingDir,
        }
      : baseDraft,
    attachments: override?.attachments ?? task.attachments,
    notice: override?.notice ?? null,
  };
}

export function drainStashedNewSessionDraft(): StashedNewSessionDraft | null {
  const value = stashedDraft;
  stashedDraft = null;
  return value;
}

// ---------------------------------------------------------------------------
// 管线
// ---------------------------------------------------------------------------

function failTask(task: InternalTask, status: 'create-failed' | 'enqueue-failed', error: string): void {
  // task 可能已被 dismiss(用户返回编辑)——不要复活。
  if (!tasks.has(task.sessionId)) return;
  if (!isTaskOwnerCurrent(task)) {
    cancelStaleOwnerTask(task);
    return;
  }
  task.status = status;
  task.error = error;
  if (status === 'enqueue-failed') {
    // 会话已建成但首条消息未入队:摘掉乐观排队气泡(草稿 / 附件由会话页从 task
    // 回填 composer,用户走正常发送);同时清掉合成行的 pendingLocalCreation
    // 禁发标——弱网下 fresh getSession / 会话页 load 可能都还没成功,不清的话
    // 用户拿着回填草稿仍被禁发,只能干等 load(codex review P2)。
    remoteSessionStore.setInputProjectionOptimistically(task.sessionId, null);
    remoteSessionStore.clearPendingTitlePreview(task.sessionId);
    remoteSessionStore.applySessionPatch(task.deviceId, task.sessionId, {
      pendingLocalCreation: false,
    });
    remoteSessionStore.applySessionPatch(task.deviceId, task.sessionId, {
      title: DEFAULT_DRAFT_SESSION_TITLE,
    });
  }
  emit();
}

function forgetPrecreatedRecoveryRecord(task: InternalTask): void {
  const precreated = task.params.precreatedWorktree;
  const accountId = task.params.precreatedWorktreeAccountId?.trim();
  if (!precreated || !accountId || !isTaskOwnerCurrent(task)) return;
  void forgetPendingPrecreatedWorktree(accountId, {
    sessionId: task.sessionId,
    recoveryKey: precreated.recoveryKey,
    ...(precreated.createdAt !== undefined ? { createdAt: precreated.createdAt } : {}),
  }).catch(() => undefined);
}

function finishTask(task: InternalTask): void {
  if (!tasks.has(task.sessionId)) return;
  if (!isTaskOwnerCurrent(task)) {
    cancelStaleOwnerTask(task);
    return;
  }
  forgetPrecreatedRecoveryRecord(task);
  tasks.delete(task.sessionId);
  emit();
}

function exactSessionFromProbe(value: unknown, sessionId: string): RemoteSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return (value as { id?: unknown }).id === sessionId
    ? value as RemoteSession
    : null;
}

async function persistPrecreatedSessionCreateStarted(task: InternalTask): Promise<void> {
  const precreated = task.precreatedWorktree;
  if (!precreated || task.precreatedWorktreeSessionCreateStarted) return;
  const accountId = task.params.precreatedWorktreeAccountId?.trim();
  if (!accountId) throw new Error(i18n.t('session.new.worktreeCleanupPending'));
  assertTaskOwnerCurrent(task);
  const persisted = await registerPendingPrecreatedWorktree(accountId, {
    sessionId: task.sessionId,
    deviceId: task.deviceId,
    path: precreated.path,
    recoveryKey: precreated.recoveryKey,
    createdAt: precreated.createdAt ?? Date.now(),
    phase: 'session-create-started',
  });
  assertTaskOwnerCurrent(task);
  if (!persisted) throw new Error(i18n.t('session.new.worktreeCleanupPending'));
  task.precreatedWorktreeSessionCreateStarted = true;
}

/** createSession 一步:瞬态失败 probe-before-retry,确定性失败直接抛。 */
/** 返回被控端分配的 workDir(dialogue 会话此刻才有;probe 收敛路径取权威行的值)。 */
/** 返回 started 写盘后二次重验修正的最终草稿(排队消息合成用,codex review P2)。 */
async function createSessionIdempotent(
  task: InternalTask,
  effectiveDraft: NewSessionDraft,
): Promise<{ workDir: string | null; finalDraft: NewSessionDraft }> {
  const { maker } = task.params.transport;
  const sleep = task.params.sleep ?? realSleep;
  // 鉴权后联合校验的最终草稿(codex review P2):只影响本次创建,不改 task.draft
  // 状态(UI 快照保持提交时语义)。precreated 分支在 persist started 后重验并
  // 重建(见下),其余路径直接使用本初值。
  let createOpts = {
    ...buildRemoteCreateSessionOptions(effectiveDraft),
    id: task.sessionId,
  };

  if (task.precreatedWorktree) {
    // Persist the retain-only phase before the first createSession side effect.
    // From here on, only an exact-id session may clear the ledger; NOT_FOUND,
    // malformed replies, wrong ids, and transport errors must never authorize
    // retrying or discarding the managed directory.
    await persistPrecreatedSessionCreateStarted(task);
    assertTaskOwnerCurrent(task);
    // started 写盘后重验普通创建目录(codex review P2:在 started 写盘后重验普通
    // 创建目录)——persist 账本的 await 期间供应商可能由 A 替换为 B,前面算出的
    // finalDraft 已过期;重拉 fresh 再联合校验,重建 createOpts(仍只影响本次
    // 创建,不改 task.draft 状态)。
    if (task.params.revalidateDraftAfterAuth) {
      const auth = await task.params.confirmUnauthenticated();
      assertTaskOwnerCurrent(task);
      // 二次重验中处理未鉴权结果(codex review P2):started 写盘期间所有适用于
      // 当前 Agent 的来源可能全部断开——此时应中止创建并显示鉴权提示,而不是
      // 继续 createSession 变成创建失败(管线最初的鉴权检查在该写盘 await 之前,
      // 无法覆盖此窗口,retain-only 阶段的任务也无法正常重试)。
      // 中止前先把账本降回 precreated(codex review P2 补强):createSession 尚未
      // 调用、worktree 未被会话认领——不降级直接抛错会让 failTask 保留
      // precreatedWorktreeSessionCreateStarted=true,retry 拒绝重试、
      // prepareNewSessionCreationForEdit 拒绝返回编辑、冷启动 recovery 也不
      // discard 未认领的 started 记录,用户被困失败页且 worktree 无法自动回收。
      // 降级成功 → 复位 sessionCreateStarted(task 可重试/可编辑/recovery 可回收);
      // 降级失败(写盘罕见失败)→ 保持 started 现状,由外层兜底。
      if (auth?.unauthenticated) {
        const pwt = task.precreatedWorktree;
        const ledger = (phase: 'precreated' | 'session-create-started') =>
          task.params.precreatedWorktreeAccountId && pwt
            ? registerPendingPrecreatedWorktree(task.params.precreatedWorktreeAccountId, {
                sessionId: task.sessionId,
                deviceId: task.deviceId,
                path: pwt.path,
                recoveryKey: pwt.recoveryKey,
                createdAt: pwt.createdAt ?? Date.now(),
                phase,
              })
            : Promise.resolve(false);
        const decision = await resolveStartedDowngradeOrCommit({
          downgrade: () => ledger('precreated'),
          restoreStarted: () => ledger('session-create-started'),
        });
        // 降级成功(downgraded)→ 账本回 precreated,复位 sessionCreateStarted
        // (codex review P1:失败时保留 true 会让 retry 拒绝重试、prepareForEdit 报
        // cleanup pending、recovery 不回收 started 记录 = 永久锁死)。
        if (decision === 'downgraded') {
          task.precreatedWorktreeSessionCreateStarted = false;
        } else {
          // 降级失败(commit)→ restoreStarted 已把账本写回 started:仅复位内存标志
          // 不够(codex review P2)——用户未点重试/返回编辑就退出应用时,冷启动
          // recovery 对 started 永不回收该 worktree;重试一次持久降级回 precreated
          // (成功则复位标志 + recovery 可回收;仍失败保持 started 现状,极端写盘失败,
          // task 至少可重试——重试重新 persist started → 二次鉴权 → 降级成功则
          // 账本回 precreated 可回收)。
          const retried = await ledger('precreated');
          if (retried) task.precreatedWorktreeSessionCreateStarted = false;
        }
        task.params.onUnauthenticated();
        throw new Error(task.params.authGateHint);
      }
      if (auth?.fresh) {
        const patch = await task.params.revalidateDraftAfterAuth(auth.fresh);
        assertTaskOwnerCurrent(task);
        if (patch) {
          effectiveDraft = { ...effectiveDraft, ...patch };
          createOpts = {
            ...buildRemoteCreateSessionOptions(effectiveDraft),
            id: task.sessionId,
          };
        }
      }
    }
    try {
      assertTaskOwnerCurrent(task);
      const created = await maker.createSession(createOpts);
      assertTaskOwnerCurrent(task);
      const result = normalizeCreateSessionResult(created);
      if (!result || result.sessionId !== task.sessionId) {
        throw new Error(i18n.t('session.new.worktreeCleanupPending'));
      }
      return { workDir: result.workDir ?? null, finalDraft: effectiveDraft };
    } catch (error) {
      if (isStaleNewSessionOwnerError(error)) throw error;
      try {
        assertTaskOwnerCurrent(task);
        const probed = exactSessionFromProbe(
          await maker.getSession(task.sessionId),
          task.sessionId,
        );
        assertTaskOwnerCurrent(task);
        if (probed) return { workDir: probed.workingDir ?? null, finalDraft: effectiveDraft };
      } catch (probeError) {
        if (isStaleNewSessionOwnerError(probeError)) throw probeError;
      }
      throw new Error(i18n.t('session.new.worktreeCleanupPending'));
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      // 重试前先 probe:上一次 invoke 可能已在被控端生效、只是回执丢失。命中即
      // 视为已创建;NOT_FOUND / probe 失败才真正重建(串行,防同 id 并发 spawn)。
      try {
        assertTaskOwnerCurrent(task);
        const probed = exactSessionFromProbe(
          await maker.getSession(task.sessionId),
          task.sessionId,
        );
        assertTaskOwnerCurrent(task);
        if (!probed) throw new Error('Invalid remote session ownership response');
        return { workDir: probed.workingDir ?? null, finalDraft: effectiveDraft };
      } catch (error) {
        if (isStaleNewSessionOwnerError(error)) throw error;
        // 未创建(或 probe 也失败):按重试继续。
      }
      assertTaskOwnerCurrent(task);
      await sleep(CREATE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      assertTaskOwnerCurrent(task);
    }
    try {
      assertTaskOwnerCurrent(task);
      const created = await maker.createSession(createOpts);
      assertTaskOwnerCurrent(task);
      const result = normalizeCreateSessionResult(created);
      if (!result) throw new Error(i18n.t('session.new.noSessionIdReturned'));
      if (result.sessionId !== task.sessionId) {
        // 被控端没有采用预生成 id(真实桌面全版本都会透传,这是防御 mock / 异常
        // 宿主):乐观行、路由、订阅全 keyed by 预生成 id,继续走会把首条消息发进
        // 错误会话。按确定性失败收敛到重试面(不自动重试,避免再建一个空会话)。
        throw new Error(i18n.t('session.new.sessionIdNotAdopted'));
      }
      return { workDir: result.workDir ?? null, finalDraft: effectiveDraft };
    } catch (err) {
      if (isStaleNewSessionOwnerError(err)) throw err;
      // 确定性失败(鉴权 / 参数 / 路径 guard 等)重试无意义,直接抛给重试面;
      // 只有瞬态失败(断连 / 超时 / 回执丢失)才走 probe-before-retry。
      if (!isTransientRemoteError(err)) throw err;
      lastErr = err;
    }
  }
  // 最后一次尝试同样可能是「已生效、回执丢失」:交给重试面之前再 probe 一次,
  // 命中即按已创建收敛——否则误判 create-failed 会让守卫挡住会话页发现既存
  // 会话,「返回编辑」还会遗留一个空的远端会话(codex review P2)。
  try {
    assertTaskOwnerCurrent(task);
    const probed = exactSessionFromProbe(
      await maker.getSession(task.sessionId),
      task.sessionId,
    );
    assertTaskOwnerCurrent(task);
    if (!probed) throw new Error('Invalid remote session ownership response');
    return { workDir: probed.workingDir ?? null, finalDraft: effectiveDraft };
  } catch (error) {
    if (isStaleNewSessionOwnerError(error)) throw error;
    // 确认未创建(或 probe 也失败):按最后的瞬态错误交给重试面(同 id 重试幂等)。
  }
  throw lastErr;
}

/** enqueue 失败后的分辨:true = 已应用;false = 确认未应用;null = 无法分辨。 */
async function isFirstMessageApplied(task: InternalTask): Promise<boolean | null> {
  const { maker } = task.params.transport;
  const clientId = task.firstMessageClientId;
  // push 回流的消息(persistUserMessage 落库后)——本地即可确认。
  if (remoteSessionStore.getMessages(task.sessionId).some(
    (message) => message.clientId === clientId,
  )) return true;
  try {
    assertTaskOwnerCurrent(task);
    const projectionEpochAtRequestStart =
      remoteSessionStore.captureInputProjectionAuthorityEpoch(task.sessionId);
    const projection = await maker.input.getProjection(task.sessionId);
    assertTaskOwnerCurrent(task);
    const accepted = remoteSessionStore.setInputProjectionIfCurrent(
      task.sessionId,
      projection,
      projectionEpochAtRequestStart,
    );
    const current = accepted ? projection : remoteSessionStore.getInputProjection(task.sessionId);
    if (current.pendingQueue.some((item) => item.clientId === clientId)) return true;
  } catch (error) {
    if (isStaleNewSessionOwnerError(error)) throw error;
    return null;
  }
  // 不在队列:可能已进 activeTurn 并落库(手机端 projection 无 activeTurn 字段),
  // 拉权威消息列表兜底确认。device-link 层不同版本返回裸数组或 { messages } 包裹,
  // 两种形状都容。
  try {
    assertTaskOwnerCurrent(task);
    const list: unknown = await maker.listMessages(task.sessionId, { limit: PROBE_MESSAGE_WINDOW_LIMIT });
    assertTaskOwnerCurrent(task);
    const wrapped = (list as { messages?: unknown } | null)?.messages;
    const messages: { clientId?: string }[] = Array.isArray(wrapped)
      ? wrapped as { clientId?: string }[]
      : Array.isArray(list) ? list as { clientId?: string }[] : [];
    if (messages.some((message) => message.clientId === clientId)) return true;
    // 窗口被打满:listMessages 是「最新窗口」,首 turn 高产出时首条 user 行可能
    // 已被挤出窗口——此时「没查到」证明不了「未应用」,按无法分辨返回 null,
    // 让轮询继续 / 走「状态未确认」文案,绝不据此判死还原重发草稿(codex P2)。
    if (messages.length >= PROBE_MESSAGE_WINDOW_LIMIT) return null;
    return false;
  } catch (error) {
    if (isStaleNewSessionOwnerError(error)) throw error;
    return null;
  }
}

function isTaskOwnerCurrent(task: InternalTask): boolean {
  return task.params.isCurrentOwner?.() ?? true;
}

function assertTaskOwnerCurrent(task: InternalTask): void {
  if (!isTaskOwnerCurrent(task)) throw new StaleNewSessionOwnerError();
}

function cancelStaleOwnerTask(task: InternalTask): void {
  if (tasks.get(task.sessionId) !== task) return;
  tasks.delete(task.sessionId);
  const session = remoteSessionStore.getSessions().find(
    (item) => item.id === task.sessionId && item.pendingLocalCreation === true,
  );
  if (session && remoteSessionStore.getSessionDeviceId(task.sessionId) === task.deviceId) {
    remoteSessionStore.applySessionPatch(task.deviceId, task.sessionId, { status: 'deleted' });
    remoteSessionStore.setInputProjectionOptimistically(task.sessionId, null);
    remoteSessionStore.clearPendingTitlePreview(task.sessionId);
  }
  emit();
}

async function runPipeline(task: InternalTask): Promise<void> {
  const { params } = task;
  const { maker, openLink, subscribe } = params.transport;
  const sessionId = task.sessionId;
  // 会话 topic 订阅放在管线**同步段头部**(trackSubscribe 先本地登记意图、再发
  // 网络包):owner 沿用 `session:<id>`,与会话页 unmount cleanup 的 handoff 契约
  // 一致。本函数的同步段在 startNewSessionCreation 内执行,必然早于跳转后的会话
  // 页 mount——因此 unmount cleanup 一定晚于本次注册,能把订阅释放掉;原先放在
  // createSession 之后,用户秒退会话页时 cleanup 先跑、订阅后注册,重 topic 会在
  // registry 里终身泄漏并随重连反复 rehydrate(codex review P2)。
  try {
    assertTaskOwnerCurrent(task);
  } catch {
    cancelStaleOwnerTask(task);
    return;
  }
  void subscribe(`session:${sessionId}`, params.deviceId, ['sessions', `session:${sessionId}`]).catch(() => undefined);
  try {
    await withTransientRemoteRetry(async () => {
      assertTaskOwnerCurrent(task);
      await openLink(params.deviceId);
      assertTaskOwnerCurrent(task);
      await subscribe(`new-session:${params.deviceId}`, params.deviceId, ['sessions']);
      assertTaskOwnerCurrent(task);
    });
    // 建链/订阅完成后再启动鉴权 fresh revalidate(codex review P2:将最终目录
    // 刷新放到建链和订阅之后)——与建链并行启动时,listProviders 可能在建链完成
    // 前就返回旧目录快照(来源 A),而建链期间工作站已替换为 B,后续拿旧 A 快照
    // 重验仍会向已删除来源创建。改为建链后拉取,终检目录是「建链后最新」。
    const freshUnauthenticated = (async (): Promise<{ unauthenticated: boolean; fresh: DeviceProvidersPayload | null } | null> => {
      if (!isTaskOwnerCurrent(task)) return null;
      try {
        const value = await params.confirmUnauthenticated();
        if (!isTaskOwnerCurrent(task)) return null;
        return value;
      } catch {
        return { unauthenticated: false, fresh: null };
      }
    })();
    const auth = await freshUnauthenticated;
    assertTaskOwnerCurrent(task);
    if (auth?.unauthenticated) {
      params.onUnauthenticated();
      failTask(task, 'create-failed', params.authGateHint);
      return;
    }
    // 鉴权 fresh revalidate 之后、createSession 之前,用工作站当前目录联合校验
    // (model, providerId)(codex review P2):终检在 handoff 前完成,建链/鉴权期间
    // 工作站可能已替换 provider——patch 覆盖 task.draft,避免向已删除来源发创建。
    // finalDraft 贯穿本管线余下阶段(createSession + 排队消息合成),不再有旧草稿
    // 携带失效来源的路径(codex review P2)。
    let draftPatch: Partial<NewSessionDraft> | null = null;
    if (auth?.fresh && params.revalidateDraftAfterAuth) {
      draftPatch = await params.revalidateDraftAfterAuth(auth.fresh);
      assertTaskOwnerCurrent(task);
    }
    const finalDraft: NewSessionDraft = draftPatch ? { ...task.draft, ...draftPatch } : task.draft;

    const createOutcome = await createSessionIdempotent(task, finalDraft);
    // started 写盘后二次重验可能修正草稿(codex review P2:将 started 后修正的
    // 草稿传给排队消息)——createOpts 用修正版创建,排队消息合成也必须用同一
    // 修正版:否则 getSession 弱网失败时 sessionForQueue 按旧 finalDraft 合成,
    // 乐观会话与首条排队消息的 lazy-create 参数仍携带已删除来源 A。
    const effectiveFinalDraft = createOutcome.finalDraft;
    assertTaskOwnerCurrent(task);
    if (!tasks.has(sessionId)) return; // 已被用户 dismiss
    // 从这一刻起 worktree 已被会话认领；即使首条消息 enqueue 后续失败，
    // 也不应把它当作可补偿回收的孤儿记录。冷启动时的 ownership 查询仍
    // 作为 AsyncStorage 写入失败/进程中断的最后兜底。
    forgetPrecreatedRecoveryRecord(task);

    // 权威会话刷新(dialogue 会话此刻才拿到被控端分配的 workingDir);失败不阻断,
    // 排队 createOpts 用合成行兜底(project 会话字段本就齐全)。
    let freshSession: RemoteSession | null = null;
    try {
      assertTaskOwnerCurrent(task);
      freshSession = await maker.getSession(sessionId);
      assertTaskOwnerCurrent(task);
      // 权威行落地时**保留** pendingLocalCreation 禁发标:enqueue 还没发生,此刻
      // 解禁的话,getSession → (setPlanMode) → enqueue 的弱网窗口(可达一两个往返)
      // 里用户抢发的第二条消息 sendAtMs 会早于首条,被控端按 sendAtMs 排序会把它
      // 排到首条前面,违背「首条消息发出后即可继续发送」语义(codex review P2)。
      // 解禁统一在 enqueue 落定后:成功路径 finishTask 前清标 / enqueue-failed 在
      // failTask 内清标。
      remoteSessionStore.upsertDeviceSession(params.deviceId, params.deviceName, {
        ...freshSession,
        pendingLocalCreation: true,
      });
    } catch (error) {
      if (isStaleNewSessionOwnerError(error)) throw error;
      freshSession = null;
    }

    if (params.planModeArm) {
      // 新协议:入队首条消息前武装计划模式,失败降级为普通发送(对齐原 create())。
      assertTaskOwnerCurrent(task);
      try {
        await maker.setPlanMode(sessionId, true);
      } catch {
        // best-effort
      }
      assertTaskOwnerCurrent(task);
    }

    // 同 clientId 重建 queued(workingDir 等 lazy-create 材料以权威会话为准):
    // 与乐观气泡同 id,权威 projection 回来时平滑对账,不闪不重。
    // fallback 合成行的 workingDir 用 createSession 返回的被控端分配值补齐:
    // dialogue 会话草稿 workingDir 为空,丢掉的话 queued.createOpts.workingDir=''
    // 会让「桌面重启后、首 turn 前」的 lazy-create 无法回到已分配的对话工作区
    // (codex review P2);project 会话两者一致,补齐是 no-op。
    const sessionForQueue = freshSession ?? {
      ...synthesizeSession(params, effectiveFinalDraft),
      ...(createOutcome.workDir ? { workingDir: createOutcome.workDir } : {}),
    };
    // fallback 路径把 reconciled 运行字段写回乐观行(codex review P1):鉴权后
    // 联合终检改了 (model, providerId),但乐观行仍是旧 task.draft——getSession
    // 失败时若不回写,会话 UI / 后续发送会继续用已删除来源,直到一次完整同步
    // 才纠正;乐观行与 queued 同源,回写后展示与首条消息一致。
    // 条件覆盖两路修正(codex review P1):①draftPatch 非 null = 首次 auth fresh
    // 重验修正;②effectiveFinalDraft !== finalDraft = started 写盘后二次重验
    // 修正(首次 auth 刷新 fail-open 时 draftPatch 为 null,但 createOutcome
    // 已按 started 后目录修正)——任一发生都必须回写,否则 UI/后续发送仍用
    // 已删除来源。
    if (!freshSession && (draftPatch !== null || effectiveFinalDraft !== finalDraft)) {
      remoteSessionStore.upsertDeviceSession(params.deviceId, params.deviceName, sessionForQueue);
    }
    const queuedDraft = attachFirstMessageSessionReferences(buildQueuedTextMessage(
      sessionForQueue,
      effectiveFinalDraft.firstMessage,
      new Date(),
      task.firstMessageClientId,
      { attachments: [...params.attachments] },
    ), task.firstMessageSessionRefs);
    let queued = queuedDraft;
    if (params.transport.prepareQueuedMessage) {
      try {
        assertTaskOwnerCurrent(task);
        queued = await params.transport.prepareQueuedMessage(queuedDraft);
        assertTaskOwnerCurrent(task);
      } catch (error) {
        if (isStaleNewSessionOwnerError(error)) throw error;
        failTask(task, 'enqueue-failed', formatRemoteError(error));
        return;
      }
    }
    try {
      assertTaskOwnerCurrent(task);
      const projectionEpochAtRequestStart =
        remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
      const projection = await maker.input.enqueue(sessionId, queued, { sendAtMs: Date.now() });
      assertTaskOwnerCurrent(task);
      remoteSessionStore.setInputProjectionIfCurrent(
        sessionId,
        projection,
        projectionEpochAtRequestStart,
      );
    } catch (error) {
      if (isStaleNewSessionOwnerError(error)) throw error;
      // 有界轮询分辨(codex review P1):enqueue 超时时消息可能已被受理并瞬间
      // drain 进 activeTurn,此刻队列查不到、消息 row 也还没回流——立即判「未
      // 应用」会引导用户用新 clientId 重发,造成首条消息双发。persistUserMessage
      // 在派发时落库,秒级窗口内 listMessages / push 必能观测到;这里最多等
      // ~16s,连续两次「确定未应用」(查询成功且两路都没有)才转 enqueue-failed,
      // 单次未确认 / 查询失败用「状态未确认」文案提示用户先核对会话内容。
      const sleep = task.params.sleep ?? realSleep;
      let confirmedMissing = 0;
      let applied: boolean | null = null;
      for (const delay of ENQUEUE_PROBE_DELAYS_MS) {
        assertTaskOwnerCurrent(task);
        await sleep(delay);
        assertTaskOwnerCurrent(task);
        if (!tasks.has(sessionId)) return; // 已被用户 dismiss
        applied = await isFirstMessageApplied(task);
        if (applied === true) break;
        if (applied === false) {
          confirmedMissing += 1;
          if (confirmedMissing >= 2) break;
        }
      }
      if (applied !== true) {
        // 两个分支的文案都引导用户先核对会话内容再重发:重发走正常 handleSend
        // 会用新 clientId,被控端幂等去重覆盖不到——万一「已应用但轮询窗口内没
        // 观测到」,盲目重发就是双发,核对提示是最后一道防线(codex review P2)。
        failTask(
          task,
          'enqueue-failed',
          confirmedMissing >= 2
            ? i18n.t('session.new.firstMessageMissingConfirm')
            : i18n.t('session.new.firstMessageUnconfirmed'),
        );
        return;
      }
      // 已应用:回执丢失,按成功收敛(权威 projection 由 push / 会话页同步补齐)。
    }

    if (params.legacyPlanRestore) {
      // 老协议 plan 一次性语义:入队后恢复底层权限档,best-effort(对齐原 create())。
      assertTaskOwnerCurrent(task);
      try {
        await maker.setPermissionMode(sessionId, params.legacyPlanRestore);
      } catch {
        // best-effort
      }
      assertTaskOwnerCurrent(task);
    }

    // 收口前主动清合成行的 pendingLocalCreation 禁发标:正常情况下上面的 fresh
    // getSession 已用权威行(无标)覆盖,但弱网下 getSession 可能失败,靠会话页
    // load 兜底又可能再失败——首条消息已入队,禁发理由已消失,不能让标残留。
    remoteSessionStore.applySessionPatch(params.deviceId, sessionId, { pendingLocalCreation: false });
    // 完成:task 移除后会话页守卫解除,由会话页 effect 触发一轮完整 syncSession。
    finishTask(task);
  } catch (err) {
    if (isStaleNewSessionOwnerError(err) || !isTaskOwnerCurrent(task)) {
      cancelStaleOwnerTask(task);
      return;
    }
    failTask(task, 'create-failed', formatRemoteError(err));
  }
}
