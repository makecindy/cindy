/**
 * partner-bridge/taskService.ts
 * ---------------------------------------------------------------------------
 * 「外部系统派一单 → 伙伴跑一轮 → 取回文本与附件」的服务层。
 *
 * 一次任务的路径与 ghost errand 同源(那也是 hook / scheduler 之外第三种
 * headless 跑 turn 的方式),只是没有插件身份:
 *
 *   按 key 找/建专属会话 → 忙检 → dispatch 统一投递 → observeHookTurn 收口
 *     → 取终稿文字(观察器为主,DB 最新 assistant 消息兜底)
 *     → 解析附件引用 → 落任务终态 → 回调调用方
 *
 * 刻意不做的事:
 *   - **不排队**。同 key 上一单在途时直接 BUSY:排队的后果是"这一单的结果"
 *     对不上"正在跑的那轮",调用方拿到的答复会串单。
 *   - 不做隐藏会话。会话落侧边栏(source='bridge'),用户能看见、能进去停。
 *   - 权限档只认白名单(plan / acceptEdits / auto),缺省 plan。
 *
 * 全部依赖注入,单测用内存 fake 直接驱动(不启动 Electron / 不碰数据库)。
 */

import {
  clampPartnerPermissionMode,
  type PartnerBridgeDeps,
  type PartnerDispatchResult,
  type PartnerPermissionMode,
  type PartnerSessionRow,
  type PartnerTaskRecord,
  type PartnerTurnRequest,
} from './types.js';
import { observeHookTurn } from '../hook-control/turnObserver.js';

/** 单条指令上限(与 Slack hook 的正文量级对齐;超限直接拒绝,不截断)。 */
const MAX_PROMPT_CHARS = 32_000;
const MAX_KEY_CHARS = 200;
const MAX_CALLBACK_URL_CHARS = 2048;
/** 一轮的兜底超时(25 分钟:低于 maker-core 45 分钟 stall watchdog,留取回余量)。 */
const DEFAULT_TURN_TIMEOUT_MS = 25 * 60_000;
/** 收口后读 DB 兜底文本的重试(消息落库与 done 事件之间有毫秒级间隙)。 */
const DB_TEXT_RETRIES = 3;
const DB_TEXT_RETRY_DELAY_MS = 400;
/** 回调失败的重试次数(之后放弃并留日志,任务结果仍可从 GET 取)。 */
const DEFAULT_CALLBACK_RETRIES = 3;
const CALLBACK_BACKOFF_BASE_MS = 1_000;

const KEY_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const AGENT_KINDS = ['cc', 'codex', 'pi'] as const;

export type PartnerSubmitOutcome =
  | { ok: true; task: PartnerTaskRecord }
  | { ok: false; errorCode: 'INVALID_REQUEST' | 'BUSY' | 'SESSION_UNAVAILABLE'; message: string };

export type PartnerCancelOutcome =
  | { ok: true; task: PartnerTaskRecord }
  | { ok: false; errorCode: 'NOT_FOUND' | 'NOT_RUNNING'; message: string };

export interface PartnerTaskService {
  submit(request: PartnerTurnRequest): Promise<PartnerSubmitOutcome>;
  get(taskId: string): PartnerTaskRecord | null;
  cancel(taskId: string): Promise<PartnerCancelOutcome>;
  /** 在途任务数(健康检查与日志用)。 */
  runningCount(): number;
}

interface InflightTask {
  taskId: string;
  key: string;
  sessionId: string | null;
  stopObserver: (() => void) | null;
  cancelled: boolean;
  /**
   * 取消信号:让正在等 turn 的 race 立刻收口。
   *
   * 单靠 stopObserver 不够 —— 取消可能落在"消息已投递、观察器还没注册"的窗口里,
   * 那时既没有可停的观察器,也不会再有终态事件把这一单推出去。
   */
  cancel: ((reason: Error) => void) | null;
}

export function createPartnerTaskService(deps: PartnerBridgeDeps): PartnerTaskService {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const callbackRetries = deps.callbackRetries ?? DEFAULT_CALLBACK_RETRIES;

  /** 任务档案(进程内)。进程重启后历史任务不可查,映射与会话本身仍持久。 */
  const tasks = new Map<string, PartnerTaskRecord>();
  /** 在途任务:同 key 只允许一单(busy 判定与取消都靠它)。 */
  const inflight = new Map<string, InflightTask>();
  let taskSeq = 0;

  function nextTaskId(): string {
    taskSeq += 1;
    return `ptask_${now().toString(36)}_${taskSeq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function findInflightByKey(key: string): InflightTask | undefined {
    for (const item of inflight.values()) {
      if (item.key === key) return item;
    }
    return undefined;
  }

  /** 既有会话还能不能当这一单的干活间:权限档或目录对不上就换新间。 */
  function sessionMatches(
    row: PartnerSessionRow,
    permissionMode: string,
    workingDir: string | undefined,
    agentKind: string | undefined,
  ): boolean {
    if (row.status !== 'active') return false;
    if (row.permissionMode !== permissionMode) return false;
    // 显式指定 agent 时必须命中同一 agent,否则同一 key 换 agent 会静默沿用旧会话。
    if (agentKind && row.agentKind !== agentKind) return false;
    if (workingDir) {
      if (row.workspaceKind !== 'project' || row.workingDir !== workingDir) return false;
    } else if (row.workspaceKind !== 'dialogue') {
      return false;
    }
    return true;
  }

  async function resolveSession(
    request: PartnerTurnRequest,
    permissionMode: PartnerPermissionMode,
    workingDir: string | undefined,
  ): Promise<
    | { ok: true; sessionId: string }
    | { ok: false; errorCode: 'NOT_READY' | 'SESSION_UNAVAILABLE'; message: string }
  > {
    const requestedAgentKind = request.agentKind ?? deps.getDraftDefaults().agentKind;
    const existing = deps.readSessionId(request.key);
    if (existing) {
      const row = await deps.getSessionRow(existing);
      if (row && sessionMatches(row, permissionMode, workingDir, requestedAgentKind)) {
        return { ok: true, sessionId: existing };
      }
      // 旧间不可用或配置已变:解除映射换新间(旧会话留在侧边栏,历史可查)。
      deps.writeSessionId(request.key, null);
    }
    // 先定 agent,再只取该 agent 的模型／强度／供应商默认。
    const agentKind = requestedAgentKind;
    const draft = deps.getDraftDefaults(agentKind);
    try {
      const sessionId = await deps.createSession({
        key: request.key,
        title: `伙伴任务 · ${request.key.slice(0, 40)}`,
        permissionMode,
        ...(agentKind ? { agentKind } : {}),
        ...(workingDir ? { workingDir } : {}),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.effort ? { effort: draft.effort } : {}),
        ...(draft.fastMode !== undefined ? { fastMode: draft.fastMode } : {}),
        ...(draft.providerId !== undefined ? { providerId: draft.providerId } : {}),
      });
      deps.writeSessionId(request.key, sessionId);
      return { ok: true, sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn('partner session create failed', { key: request.key, error: message });
      return {
        ok: false,
        errorCode: /DbClient not ready/i.test(message) ? 'NOT_READY' : 'SESSION_UNAVAILABLE',
        message,
      };
    }
  }

  function fail(task: PartnerTaskRecord, errorCode: string, error: string): void {
    task.status = 'failed';
    task.errorCode = errorCode;
    task.error = error;
    task.finishedAt = now();
    deps.log.info('partner task failed', {
      taskId: task.taskId,
      errorCode,
      sessionId: task.sessionId,
    });
  }

  function finish(task: PartnerTaskRecord): void {
    task.finishedAt = now();
    deps.log.info('partner task finished', {
      taskId: task.taskId,
      status: task.status,
      sessionId: task.sessionId,
      attachments: task.attachments.length,
      chars: task.text?.length ?? 0,
    });
  }

  function callbackPayload(task: PartnerTaskRecord): Record<string, unknown> {
    return {
      taskId: task.taskId,
      key: task.key,
      status: task.status,
      sessionId: task.sessionId,
      text: task.text,
      attachments: task.attachments,
      errorCode: task.errorCode,
      error: task.error,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    };
  }

  async function deliverCallback(task: PartnerTaskRecord, url: string): Promise<void> {
    const payload = callbackPayload(task);
    for (let attempt = 0; attempt <= callbackRetries; attempt += 1) {
      if (attempt > 0) await sleep(CALLBACK_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      try {
        await deps.deliverCallback(url, payload);
        return;
      } catch (err) {
        deps.log.warn('partner callback attempt failed', {
          taskId: task.taskId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    deps.log.warn('partner callback gave up', { taskId: task.taskId, url });
  }

  async function readFinalText(
    sessionId: string,
    observerFinalText: string,
    observerLiveText: string,
    dispatchedAt: number,
  ): Promise<string> {
    let text = observerFinalText.trim() || observerLiveText.trim();
    if (!text) {
      for (let i = 0; i < DB_TEXT_RETRIES && !text; i += 1) {
        if (i > 0) await sleep(DB_TEXT_RETRY_DELAY_MS);
        text = ((await deps.readLatestAssistantText(sessionId, dispatchedAt)) ?? '').trim();
      }
    }
    if (!text) text = '(本轮没有可取回的文字回复)';
    return text;
  }

  async function runTask(
    task: PartnerTaskRecord,
    request: PartnerTurnRequest,
    permissionMode: PartnerPermissionMode,
    workingDir: string | undefined,
    inflightTask: InflightTask,
  ): Promise<void> {
    const cancelled = new Promise<never>((_, reject) => {
      inflightTask.cancel = (reason) => reject(reason);
    });
    // 取消可能发生在 resolveSession 期间 —— 那时还没进入 race,先挂一个接收方
    // 避免 unhandled rejection;真正的终态由下面的 cancelled 检查落。
    void cancelled.catch(() => {});
    const session = await resolveSession(request, permissionMode, workingDir);
    if (!session.ok) {
      fail(task, session.errorCode, session.message);
      return;
    }
    const sessionId = session.sessionId;
    task.sessionId = sessionId;
    inflightTask.sessionId = sessionId;
    if (inflightTask.cancelled) {
      task.status = 'cancelled';
      task.errorCode = 'CANCELLED';
      task.error = '调用方已取消这一单';
      finish(task);
      return;
    }

    if (deps.isSessionBusy(sessionId)) {
      fail(task, 'BUSY', '这个 key 的会话正被占用(可能用户正在里面操作),请稍后重试');
      return;
    }

    const dispatchedAt = now();
    let dispatched: PartnerDispatchResult;
    try {
      dispatched = await deps.dispatch({ targetSessionId: sessionId, message: request.prompt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(task, classifyTurnSetupError(message), message);
      return;
    }
    if (!dispatched.ok) {
      if (
        dispatched.errorCode === 'NOT_FOUND' ||
        dispatched.errorCode === 'ARCHIVED' ||
        dispatched.errorCode === 'DELETED'
      ) {
        deps.writeSessionId(request.key, null);
        fail(task, 'SESSION_UNAVAILABLE', dispatched.message);
        return;
      }
      if (dispatched.errorCode === 'BUSY') {
        fail(task, 'BUSY', dispatched.message);
        return;
      }
      // 投递返回失败也走同一套分类:agent 缺凭证是最常见的首次失败。
      fail(task, classifyTurnSetupError(dispatched.message), dispatched.message);
      return;
    }
    if (dispatched.wakeKind === 'queued') {
      // 忙检与投递之间的窄竞态:消息已进队,但结果不再属于这一单。
      deps.log.warn('partner message queued behind a foreign turn', { taskId: task.taskId, sessionId });
      fail(
        task,
        'BUSY',
        '会话恰好正忙,本单消息已入队但结果不再取回;请先确认上一单结果,不要重复提交同一指令',
      );
      return;
    }

    const observable = deps.getObservableSession(sessionId);
    if (!observable) {
      fail(task, 'SESSION_UNAVAILABLE', '会话进程不可用,请稍后再试');
      return;
    }

    const observer = observeHookTurn(observable, {
      onSilentStopSettled: deps.onSilentStopSettled,
      log: { warn: (msg) => deps.log.warn(msg, { taskId: task.taskId }) },
    });
    inflightTask.stopObserver = () => observer.stop();

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        observer.finished,
        cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('partner turn timeout'));
          }, turnTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      observer.stop();
      if (inflightTask.cancelled) {
        task.status = 'cancelled';
        task.errorCode = 'CANCELLED';
        task.error = '调用方已取消这一单';
        finish(task);
        return;
      }
      if (timedOut) {
        fail(task, 'TIMEOUT', '任务超时(任务可能仍在会话里继续,可打开该会话查看)');
        return;
      }
      fail(task, 'TURN_FAILED', err instanceof Error ? err.message : String(err));
      return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inflightTask.stopObserver = null;
      inflightTask.cancel = null;
    }

    if (inflightTask.cancelled) {
      task.status = 'cancelled';
      task.errorCode = 'CANCELLED';
      task.error = '调用方已取消这一单';
      finish(task);
      return;
    }

    const finalText = await readFinalText(
      sessionId,
      observer.finalText(),
      observer.text(),
      dispatchedAt,
    );
    const resolved = await deps.resolveAttachments({
      text: finalText,
      workingDir: workingDir ?? null,
      sessionId,
    });
    task.text = resolved.text;
    task.attachments = resolved.attachments;
    task.status = 'succeeded';
    finish(task);
  }

  return {
    async submit(request) {
      const key = typeof request.key === 'string' ? request.key.trim() : '';
      const prompt = typeof request.prompt === 'string' ? request.prompt : '';
      if (!key || key.length > MAX_KEY_CHARS || !KEY_PATTERN.test(key)) {
        return {
          ok: false,
          errorCode: 'INVALID_REQUEST',
          message: `key 必须是 1-${MAX_KEY_CHARS} 个可打印字符(不含控制字符)`,
        };
      }
      if (!prompt.trim()) {
        return { ok: false, errorCode: 'INVALID_REQUEST', message: 'prompt 不能为空' };
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        return {
          ok: false,
          errorCode: 'INVALID_REQUEST',
          message: `prompt 超过 ${MAX_PROMPT_CHARS} 字符上限`,
        };
      }
      const callbackUrl = typeof request.callbackUrl === 'string' ? request.callbackUrl.trim() : '';
      if (callbackUrl && !isHttpUrl(callbackUrl)) {
        return {
          ok: false,
          errorCode: 'INVALID_REQUEST',
          message: 'callbackUrl 只接受 http/https 地址',
        };
      }
      if (callbackUrl.length > MAX_CALLBACK_URL_CHARS) {
        return { ok: false, errorCode: 'INVALID_REQUEST', message: 'callbackUrl 过长' };
      }
      if (
        request.agentKind !== undefined &&
        !(AGENT_KINDS as readonly string[]).includes(request.agentKind)
      ) {
        return {
          ok: false,
          errorCode: 'INVALID_REQUEST',
          message: 'agentKind 只接受 cc / codex / pi',
        };
      }
      if (findInflightByKey(key)) {
        return {
          ok: false,
          errorCode: 'BUSY',
          message: '这个 key 已有一单在途,等它结束或换一个 key',
        };
      }

      let workingDir: string | undefined;
      if (typeof request.workingDir === 'string' && request.workingDir.trim()) {
        const normalized = await deps.normalizeWorkingDir(request.workingDir.trim());
        if (!normalized) {
          return {
            ok: false,
            errorCode: 'INVALID_REQUEST',
            message: 'workingDir 不存在或不是目录',
          };
        }
        workingDir = normalized;
      }

      const permissionMode = clampPartnerPermissionMode(request.permissionMode);
      const task: PartnerTaskRecord = {
        taskId: nextTaskId(),
        key,
        prompt,
        sessionId: null,
        status: 'running',
        text: null,
        attachments: [],
        errorCode: null,
        error: null,
        createdAt: now(),
        finishedAt: null,
      };
      tasks.set(task.taskId, task);
      const inflightTask: InflightTask = {
        taskId: task.taskId,
        key,
        sessionId: null,
        stopObserver: null,
        cancelled: false,
        cancel: null,
      };
      inflight.set(task.taskId, inflightTask);
      deps.log.info('partner task accepted', { taskId: task.taskId, key, permissionMode });

      // 后台跑,调用方立刻拿到 taskId 去轮询或等回调。
      void runTask(task, { ...request, key, prompt, ...(callbackUrl ? { callbackUrl } : {}) }, permissionMode, workingDir, inflightTask)
        .catch((err: unknown) => {
          deps.log.warn('partner task crashed', {
            taskId: task.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          if (task.status === 'running') fail(task, 'INTERNAL', '任务执行异常');
        })
        .finally(() => {
          inflight.delete(task.taskId);
          if (callbackUrl && task.status !== 'running') void deliverCallback(task, callbackUrl);
        });

      return { ok: true, task };
    },

    get(taskId) {
      return tasks.get(taskId) ?? null;
    },

    async cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return { ok: false, errorCode: 'NOT_FOUND', message: '没有这个任务' };
      if (task.status !== 'running') {
        return { ok: false, errorCode: 'NOT_RUNNING', message: '任务已经结束' };
      }
      const item = inflight.get(taskId);
      if (item) item.cancelled = true;
      item?.stopObserver?.();
      item?.cancel?.(new Error('partner task cancelled'));
      if (item?.sessionId) {
        try {
          await deps.abortSession(item.sessionId);
        } catch (err) {
          deps.log.warn('partner task abort failed', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (item === undefined) {
        // 会话还没建出来就被取消:直接落终态,后台分支看到 cancelled 即返回。
        task.status = 'cancelled';
        task.errorCode = 'CANCELLED';
        task.error = '调用方已取消这一单';
        finish(task);
      }
      return { ok: true, task };
    },

    runningCount() {
      return inflight.size;
    },
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 把"还没准备好"与"真的坏了"分开:外部系统据此决定是等一会儿重试,
 * 还是去 Cindy 里补登录／模型配置。
 */
function classifyTurnSetupError(
  message: string,
): 'NOT_READY' | 'AGENT_NOT_AUTHENTICATED' | 'INTERNAL' {
  if (/DbClient not ready/i.test(message)) return 'NOT_READY';
  if (/not authenticated|no_key|missing credentials/i.test(message)) {
    return 'AGENT_NOT_AUTHENTICATED';
  }
  return 'INTERNAL';
}
