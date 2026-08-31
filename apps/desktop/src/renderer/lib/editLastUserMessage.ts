/**
 * edit-last-message: 编辑最后一条 user 消息的提交编排。
 *
 * 语义 = 完整 rewind(对话裁剪 + 文件回滚,两端 agent 与现有 Rewind 按钮同一条
 * IPC 链路)+ 立即用编辑后的文本重发。与 Rewind 的"预填 composer 草稿"分支的
 * 区别只在最后一步:不落草稿,直接 send。
 *
 * 步骤(顺序有讲究):
 *   1. rewindCommit — 后端软删 target 及其之后的消息、重置 token、Claude 设
 *      pendingRewindTo(下一次 send 触发三件套重启)。await 返回时 DB 事务已完成。
 *   2. emitSessionPatch — sidebar 镜像 token 归零 / sdkSessionId 可能变化。
 *   3. dropMessagesFromClientId — 内存里按同一软删语义裁掉旧段(不走
 *      reloadMessages 的"清空 + 异步重拉",避免和乐观气泡竞态闪烁)。
 *   4. sendMessage — 用 rewindCommit 返回的 session 行里的 model / effort /
 *      permissionMode(选择器改动是 server-first 持久化,行值即当前值)重发;
 *      原消息附件经 buildRewindDraftAttachments 原样重建。
 *
 * 失败面:
 *   - 第 1 步抛错(SESSION_RUNNING / NO_LIVE_QUERY 等)→ 整体未发生,调用方保持
 *     编辑态让用户重试。
 *   - 重发入队失败(远端错误等)→ rewind 已 commit、旧消息已软删,编辑
 *     文本**不能丢**:落 composer 草稿兜底(saveDraft 非 silent,已挂载的
 *     ChatInput 会收到通知立即回填),与 Rewind 按钮的"预填输入框"UX 收敛到
 *     同一条路。store 侧的 error banner 由 sendMessage 内部错误处理负责。
 */

import { ApiError } from '@/lib/httpClient';
import { rewindCommit as rewindCommitService } from '@/lib/sessionService';
// origin-aware 传输:device-link 远程会话的消息在被控端 DB,直连本机
// messageService.list 会查到空库(bot review 指出)。listMessagesFor 与
// rewind/重发链路的 makerApiFor 同一路由语义:本机直查,远程走隧道。
import { listMessagesFor } from '@/lib/makerTransport';
import { makerChatStore } from '@/lib/makerChatStore';
import { emitPatch as emitSessionPatch } from '@/lib/sessionsBus';
import {
  saveDraft as saveComposerDraft,
  plainTextToTiptapDoc,
} from '@/lib/composerDraftStore';
import { parseChatQuoteSegments } from '@/lib/chatQuotes';
import { quoteSegmentsToComposerDocument } from '@/lib/composerQuoteDocument';
import type { JSONContent } from '@tiptap/core';
import { expandGhostCommand } from '@/cindy-brain/ghostCommand';
import { filterGhostsForWorkdir } from '@/cindy-brain/ghostWorkdirFilter';
import {
  buildRewindDraftAttachments,
  type RewindDraftImage,
} from '@/lib/rewindDraftAttachments';
import type { AttachedFile } from '@/lib/fileTypes';
import type { FileRef, PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { Session } from '@/lib/ccAgent.types';
import type { AgentInputReference } from '../../shared/agentInputQueue';

export interface CommitEditAndResendOptions {
  sessionId: string;
  /** clientId of the last user message being edited (rewind target). */
  clientId: string;
  /** Edited text to resend. May be empty when attachments exist. */
  text: string;
  /** Original message attachments — re-sent as-is (v1 不支持编辑态增删附件). */
  images?: readonly RewindDraftImage[];
  files?: readonly FileRef[];
  /** Fallback workingDir (UserMessage prop) — session 行缺失时兜底。 */
  fallbackWorkingDir: string;
  /**
   * 原消息带「选中引用」编码标志时重发同样携带——正文内引用块的解析以该
   * 标志门控,丢掉会让 markdown blockquote 退回普通文本展示。
   */
  quotesEncoded?: boolean;
  /** 原消息语义引用 range；只有编辑框确认可见文本未改变时才传入。 */
  agentReferences?: AgentInputReference[];
  /** 原消息长粘贴 range；只有编辑框确认文本未改变时才传入。 */
  pastedTextRanges?: PastedTextRange[];
  /** 原消息 slash range；undefined 表示缺少显式 range，空数组表示明确无 slash。 */
  slashCommandRanges?: SlashCommandRange[];
}

/** 依赖注入口 — 单测用内存假件替换,生产走默认实现。 */
export interface CommitEditAndResendDeps {
  rewindCommit: (sessionId: string, clientId: string) => Promise<Session>;
  emitPatch: typeof emitSessionPatch;
  dropMessagesFromClientId: (sessionId: string, clientId: string) => void;
  sendMessage: typeof makerChatStore.sendMessage;
  /** 重发入队失败时的正文兜底:编辑文档 + 附件落 composer 草稿。 */
  saveDraftFallback: (
    sessionId: string,
    document: JSONContent | null,
    attachments: AttachedFile[],
  ) => void;
  /** 会话是否有排队中的未派发消息(pendingQueue 非空)。 */
  hasPendingQueue: (sessionId: string) => boolean;
  /** DB 真值:会话最新一条 user 消息的 clientId(无则 null)。 */
  fetchLatestUserMessageClientId: (sessionId: string) => Promise<string | null>;
  /**
   * ghost-summon-card:重发前的"发送期展开"(意识 $指令 硬指令追加段)。
   * 编辑框预填的是剥离机器追加段后的正文(UserMessage 侧),这里在 send
   * 之前按当前已装意识重新展开——与 ChatInput 的发送语义对齐(含目录级
   * 禁用同判,workingDir 与重发落点同源);fallback 草稿走未展开文本
   * (草稿重发时 ChatInput 会再展开,避免叠双份指令)。
   * 可选:单测缺省时用默认实现(jsdom 无 electronAPI 时安全退化为原文)。
   */
  expandForSend?: (text: string, workingDir?: string | null) => string;
}

/** 默认发送期展开:读本机已装意识列表(按 workingDir 滤目录级禁用);
 *  任何异常安全退化为原文。 */
function defaultExpandForSend(text: string, workingDir?: string | null): string {
  try {
    const ghosts = window.electronAPI?.ghosts?.listSync?.().ghosts ?? [];
    return expandGhostCommand(text, filterGhostsForWorkdir(ghosts, workingDir));
  } catch {
    return text;
  }
}

const defaultDeps: CommitEditAndResendDeps = {
  // requireLatestUser: main 侧权威版"最新校验"——renderer 的 DB 预查(下方
  // fetchLatestUserMessageClientId)到 IPC 落地之间存在 TOCTOU 窗口(自动化 /
  // goal runner / 第二控制端可能追加新 user 消息),main 在 SDK 副作用前与软删
  // 事务前各校验一次,超越则抛 REWIND_TARGET_NOT_LATEST。
  rewindCommit: (sessionId, clientId) =>
    rewindCommitService(sessionId, clientId, { requireLatestUser: true }),
  emitPatch: emitSessionPatch,
  dropMessagesFromClientId: (sessionId, clientId) =>
    makerChatStore.dropMessagesFromClientId(sessionId, clientId),
  sendMessage: (...args) => makerChatStore.sendMessage(...args),
  saveDraftFallback: (sessionId, document, attachments) =>
    saveComposerDraft(sessionId, {
      text: document,
      attachments,
    }),
  hasPendingQueue: (sessionId) =>
    makerChatStore.getSnapshot(sessionId).pendingQueue.length > 0,
  fetchLatestUserMessageClientId: (sessionId) => fetchLatestUserMessageClientIdViaDb(sessionId),
  expandForSend: defaultExpandForSend,
};

type LatestUserRow = {
  id: string;
  clientId: string;
  role: string;
  createdAt: number | string;
};

const rowTs = (v: number | string): number => (typeof v === 'number' ? v : Date.parse(v));

/**
 * DB 真值:会话最新一条 user 消息的 clientId。
 *
 * 必须**向老页翻页**而不是只看最新 50 条(bot review 指出的回归):工具密集的
 * 长 turn 会往 messages 表持久化远超 50 行的 tool_use/tool_result/thinking 行,
 * 最新一页可能一条 user 都没有——只查一页会把合法的"编辑真实最后一条"误判为
 * EDIT_NOT_LAST_MESSAGE 拒掉(与首条误判分页 bug 同构,方向相反)。
 * 页序从新到旧,首个含 user 行的页里按 (createdAt, id) 取最大者即全局最新。
 * 安全上限 40 页(2000 行)防病态数据下的无界扫描,翻尽仍无 user 行 → null
 * (调用方 fail-closed,会话根本没有 user 消息时本就不该有编辑入口)。
 */
export async function fetchLatestUserMessageClientIdViaDb(
  sessionId: string,
): Promise<string | null> {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 40;
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = (await listMessagesFor(sessionId, {
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
    })) as LatestUserRow[];
    if (rows.length === 0) return null;

    let latestUser: LatestUserRow | null = null;
    let oldest: LatestUserRow = rows[0];
    for (const row of rows) {
      if (
        rowTs(row.createdAt) < rowTs(oldest.createdAt) ||
        (rowTs(row.createdAt) === rowTs(oldest.createdAt) && row.id < oldest.id)
      ) {
        oldest = row;
      }
      if (row.role !== 'user') continue;
      if (
        !latestUser ||
        rowTs(row.createdAt) > rowTs(latestUser.createdAt) ||
        (rowTs(row.createdAt) === rowTs(latestUser.createdAt) && row.id > latestUser.id)
      ) {
        latestUser = row;
      }
    }
    if (latestUser) return latestUser.clientId;
    if (rows.length < PAGE_SIZE) return null;
    before = oldest.id;
  }
  return null;
}

export async function commitEditAndResend(
  opts: CommitEditAndResendOptions,
  deps: CommitEditAndResendDeps = defaultDeps,
): Promise<boolean> {
  const attachments = buildRewindDraftAttachments({
    images: opts.images,
    files: opts.files,
  });
  // 空文本 + 无附件的重发会被 sendMessage 静默 no-op,那样就变成"只回退没重发"
  // ——语义上是 Rewind 而不是编辑。在 commit 之前拦下,由 UI 层禁用发送按钮兜底。
  if (!opts.text.trim() && attachments.length === 0) {
    throw new Error('edit-last-message: refusing to resend empty message');
  }

  // 队列硬守卫(UserMessage.handleEdit 的入口 toast 是第一道,这里防 mid-edit
  // 竞态):paused 队列非空时重发会追加到队尾——排在 N 条针对旧上下文写的陈旧
  // 消息之后,Continue 后重放顺序反转、且 enqueue 成功会让草稿兜底误判"已派发"。
  // 在 rewindCommit 之前拦下,整体未发生,编辑态原样保留。
  if (deps.hasPendingQueue(opts.sessionId)) {
    throw new ApiError('EDIT_QUEUE_NOT_EMPTY', 0, 'pending queue is not empty');
  }

  // 最后一条真值硬守卫(bot review P2,实为数据丢弃级风险):renderer 的
  // isLastUserMessage 基于**已加载切片**判定——搜索/深链跳转的中间窗口期,
  // 切片最后一条可能不是会话真实最后一条,此时 rewind 会把窗口之外更新的
  // 轮次一并软删。提交前用一次 DB 查询核对真值,不一致 fail-closed 拦下
  // (查询失败同样中止——宁可让用户重试,不冒静默丢轮次的风险)。
  const latestUserClientId = await deps.fetchLatestUserMessageClientId(opts.sessionId);
  if (latestUserClientId !== opts.clientId) {
    throw new ApiError('EDIT_NOT_LAST_MESSAGE', 0, 'target is no longer the latest user message');
  }

  const session = await deps.rewindCommit(opts.sessionId, opts.clientId);

  deps.emitPatch(opts.sessionId, {
    sdkSessionId: session.sdkSessionId,
    contextTokens: 0,
    contextWindow: 0,
    updatedAt: session.updatedAt,
    userSendAt: session.userSendAt,
  });
  deps.dropMessagesFromClientId(opts.sessionId, opts.clientId);

  // 意识发送期展开只作用于"发出去的文本";opts.text(用户编辑原文)继续用于
  // 下方 fallback 草稿——草稿重发经 ChatInput 再展开,不叠双份指令。
  const dispatched = await deps.sendMessage(
    opts.sessionId,
    (deps.expandForSend ?? defaultExpandForSend)(opts.text, session.workingDir ?? opts.fallbackWorkingDir ?? null),
    session.model,
    session.effort,
    session.permissionMode,
    session.workingDir ?? opts.fallbackWorkingDir,
    attachments.length > 0 ? attachments : undefined,
    undefined,
    opts.quotesEncoded ||
    opts.agentReferences?.length ||
    opts.pastedTextRanges?.length ||
    opts.slashCommandRanges !== undefined
      ? {
          ...(opts.quotesEncoded ? { quotesEncoded: true } : {}),
          ...(opts.agentReferences?.length ? { agentReferences: opts.agentReferences } : {}),
          ...(opts.pastedTextRanges?.length ? { pastedTextRanges: opts.pastedTextRanges } : {}),
          ...(opts.slashCommandRanges !== undefined ? { slashCommandRanges: opts.slashCommandRanges } : {}),
        }
      : undefined,
  );
  if (!dispatched) {
    // rewind 已 commit(旧消息已软删)但重发没送达:文本落草稿,用户在输入框
    // 找回可重发。错误提示由 sendMessage 内部写入 store 的 error banner。
    const document = opts.quotesEncoded
      ? quoteSegmentsToComposerDocument(parseChatQuoteSegments(opts.text))
      : opts.text.trim()
        ? plainTextToTiptapDoc(opts.text)
        : null;
    deps.saveDraftFallback(opts.sessionId, document, attachments);
    return false;
  }
  return true;
}

/** 重试节奏(编辑自动停止场景专用,见 commitEditAndResendWithRunningRetry)。 */
export interface RunningRetryOptions {
  /** SESSION_RUNNING 时的额外重试次数(不含首次)。默认见 RUNNING_RETRY_DEFAULTS。 */
  attempts?: number;
  /** 每次重试间隔 ms。默认见 RUNNING_RETRY_DEFAULTS。 */
  delayMs?: number;
  /** 可注入的 sleep(测试用假时钟)。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 默认重试预算 ≈ 15s(20 × 750ms),与 UserMessageEditBox 的
 * STOP_WAIT_TIMEOUT_MS 同量级——这不是巧合而是契约:stopSession 会**乐观**
 * 清掉 renderer 的 isStreaming(bot review 指出),EditBox 的"等 idle 再提交"
 * 等待机制因此几乎总被跳过,慢停止(远端会话 / 长工具调用收尾)的整个窗口
 * 实际由这里的 SESSION_RUNNING 重试独自扛。空闲路径零额外延迟(只在
 * SESSION_RUNNING 时才睡)。
 */
export const RUNNING_RETRY_DEFAULTS = { attempts: 20, delayMs: 750 } as const;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * edit-last-message(运行中编辑):带 SESSION_RUNNING 重试的提交。
 *
 * 点编辑会自动 stop 当前 turn,发送侧先等 renderer 的 isStreaming 翻 false 再
 * 调本函数;但 renderer 状态与 main 侧 isTurnRunning 守卫之间仍有毫秒级尾差
 * (stop 的 done 事件 fan-out 先于 turnInFlight 清理到达是可能的),所以对
 * SESSION_RUNNING 做有限次短间隔重试,把这段尾差确定性地消化掉,而不是把
 * 偶发失败甩给用户重点一次。其它错误码不重试,原样抛出。
 */
export async function commitEditAndResendWithRunningRetry(
  opts: CommitEditAndResendOptions,
  deps: CommitEditAndResendDeps = defaultDeps,
  retry: RunningRetryOptions = {},
): Promise<boolean> {
  const attempts = retry.attempts ?? RUNNING_RETRY_DEFAULTS.attempts;
  const delayMs = retry.delayMs ?? RUNNING_RETRY_DEFAULTS.delayMs;
  const sleep = retry.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await commitEditAndResend(opts, deps);
    } catch (err) {
      const isRunning = err instanceof ApiError && err.code === 'SESSION_RUNNING';
      if (!isRunning || attempt >= attempts) throw err;
      await sleep(delayMs);
    }
  }
}
