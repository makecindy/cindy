/**
 * apps/desktop/src/main/maker-ipc/schedule.ts
 *
 * maker:schedule:* IPC handler 注册 + Scheduler → renderer 事件桥接。
 *
 * ── 设计 ────────────────────────────────────────────────────────────────
 *
 * 1. 写入路径**全部走 scheduler 实例方法**(create/update/pause/resume/delete/runNow)。
 *    严禁绕过去直插 storage —— Scheduler.activeSchedules Map 只在 create() 时填充,
 *    绕过 IPC 直插 storage 的 row 不会被 runtime pickup(必须重启 desktop 才看见)。
 *
 * 2. 错误模式:throwIpcError(code, msg) 抛带 code 的 Error,与 fork.ts:22-30 同范式,
 *    不允许裸 throw。
 *
 * 3. scheduler.on listener 共用一个 `MAKER_PUSH.SCHEDULE_EVENT` channel,renderer 按
 *    payload.type ('fired'|'completed'|'failed'|'changed'|'ready'|...) 分支。
 *
 * ── 启动模型 (重构: 解决 cold-start race) ───────────────────────────────
 *
 * 老问题: scheduler 真正 ready 晚于 maker IPC 注册时机(依赖 user login → localDb
 * ensureReady → attemptStartScheduler),renderer mount useSchedules 命中
 * "No handler registered" 错误,且 hook 没有 retry → UI 永久卡死。
 *
 * 新模型: 借鉴 gRPC Health Checking Protocol "eager registration + readiness
 * signal" + K8s Readiness Probe:
 *   - `registerScheduleHandlers()` 在 boot 早期一次性挂全部 ipcMain.handle;
 *     handler 内部 `withScheduler(...)` 等真实 scheduler 实例,无超时上限 IPC 30s。
 *   - `attachSchedulerEventListeners(scheduler, storage)` 在 attemptStartScheduler
 *     拿到 scheduler 后调,挂 scheduler.on(...) + setSchedulerReady + 最后 broadcast
 *     'ready' 让 renderer schedulesStore 在切账号 relogin 路径下后台预热 cache。
 *   - `resetSchedulerReady()` 在 auth:logout 调,清掉 holder;下一次 IPC await 重新
 *     pending,直到 relogin 后的 setSchedulerReady 喂入**新实例**。
 *
 * Readiness 用 mutable holder + drainable resolvers 而非单 promise — 单 promise 会
 * 被首次 resolve 锁死值,切账号后所有 handler 拿到 stopped 旧 scheduler 实例,等于
 * 把多账号污染风险换层皮。
 */

import path from 'node:path';

import { ipcMain, BrowserWindow, app } from 'electron';

import type { AgentKind, Maker } from '@cindy/maker-core';
import type {
  Scheduler,
  CreateScheduleInput,
  UpdateScheduleInput,
  ListFilter,
  ScheduleTemplate,
  SchedulerEvent,
} from '@cindy/maker-scheduler';
import {
  BUILTIN_TEMPLATES,
  applyTemplateParams,
  stabilizePreRunHookForCreate,
  stabilizePreRunHookForUpdate,
} from '@cindy/maker-scheduler';

import { createLogger } from '../logger.js';
import type { DrizzleScheduleStorage } from '../scheduler-host/storage.js';
import { executePreRunHook } from '../scheduler-host/pre-run-hook.js';
import {
  HookScriptUtilityModelError,
  installHookScript,
  stabilizeHookCommand,
} from '../scheduler-host/hook-script-generator.js';
import { resolveScriptCapabilityStatuses } from '../scheduler-host/script-capability-status.js';
import { getGhostManager } from '../cindy-brain/index.js';
import { throwIpcError, requireString, requireObject } from '../utils/ipcValidate.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import {
  resolveBoundSessionGenerationRoute,
  shouldResolveBoundSessionGenerationRoute,
} from './scheduleGenerationRoute.js';

const log = createLogger('maker-ipc:schedule');

function broadcast(channel: string, payload: unknown): void {
  // device-link tap:schedule:event 在 PUSH_FORWARD_ALLOWLIST,补 tap 才会真正转发给控制端,
  // 否则远程自动化「能操作但状态不回流」(列表/角标停在旧值)。
  tapWindowBroadcast(channel, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn(`broadcast to window failed: ${String(e)}`);
    }
  }
}

function broadcastSchedulerEvent(event: SchedulerEvent): void {
  broadcast(MAKER_PUSH.SCHEDULE_EVENT, event);
  try {
    getAgentIslandService()?.handleScheduleEvent(event);
  } catch (err) {
    log.warn(`agent island schedule event update failed: ${String(err)}`);
  }
}

/** 非 Scheduler 引擎写入 run 衍生数据后，通知各端重新读取该任务。 */
export function broadcastSchedulerChanged(scheduleId: string): void {
  if (!scheduleId) return;
  broadcastSchedulerEvent({ type: 'changed', scheduleId });
}

/**
 * 把 scheduler 抛的业务 Error 翻成带 code 的 IPC error。
 * Scheduler 当前抛的 message 形态固定为 'schedule {id} not found' 等明文(见
 * engine/scheduler.ts:241/265/272 等),按 message 嗅探一次性收口。
 */
function rewrapSchedulerError(err: unknown): never {
  if (err instanceof Error && typeof (err as { code?: unknown }).code === 'string') {
    throw err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(msg)) throwIpcError('NOT_FOUND', msg);
  if (/invalid|cron|timezone|template parameter|missing required|script execution/i.test(msg)) {
    throwIpcError('INVALID_PARAMS', msg);
  }
  throwIpcError('INTERNAL', msg);
}

// ── Scheduler readiness holder ────────────────────────────────────────────
// Mutable holder + drainable resolvers,支持 logout → login 循环切账号,每次都
// resolve 新 Scheduler 实例。30s 超时兜底,防止 scheduler 启动卡死时 IPC 永久 hang。
const READINESS_TIMEOUT_MS = 30_000;

interface SchedulerDeps {
  scheduler: Scheduler;
  storage: DrizzleScheduleStorage;
}

let _current: SchedulerDeps | null = null;
let _pending: Array<(v: SchedulerDeps) => void> = [];

/**
 * 由 attachSchedulerEventListeners 在 scheduler 真正 ready 后调。
 * 第一次调:resolve 所有 pending await;后续调(切账号 relogin):覆盖 _current,
 * 之后 await 直接拿新实例。
 */
export function setSchedulerReady(scheduler: Scheduler, storage: DrizzleScheduleStorage): void {
  _current = { scheduler, storage };
  const resolvers = _pending;
  _pending = [];
  resolvers.forEach((r) => r(_current!));
}

/**
 * 由 bootstrap auth:logout handler 在 resetScheduler() 之后调。
 * 不 reject _pending — 让在途 IPC 继续等下次 setSchedulerReady,30s 超时兜底。
 * reject 会让 renderer 立刻拿到 "scheduler not ready" 错误;而 logout → login 通常
 * < 30s,用户切账号期间打开自动化页应当看到 loading 而非错误。
 */
export function resetSchedulerReady(): void {
  _current = null;
}

function awaitReady(): Promise<SchedulerDeps> {
  if (_current) return Promise.resolve(_current);
  return new Promise((r) => _pending.push(r));
}

/**
 * Testing 入口:把 holder 完全清零(_current = null + _pending = [])。
 * 仅 vitest 用,不要在 production 代码里 import。resetSchedulerReady() 与之不同 —
 * 后者是生产逻辑,故意不清 _pending(留给在途 IPC 等下一次 setReady)。
 */
export function __resetReadinessForTest(): void {
  _current = null;
  _pending = [];
}

export async function awaitReadyWithTimeout(): Promise<SchedulerDeps> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      awaitReady(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error('scheduler readiness timeout')),
          READINESS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    // 防 timer 堆积:scheduler 已 resolve 时若不 clear,setTimeout 仍会 30s 后 fire,
    // reject 被 race 忽略但 timer 句柄不释放,高频 IPC 下 N 个并发 = N 个 timer。
    if (timer) clearTimeout(timer);
  }
}

/**
 * Handler 通用 wrapper:等 scheduler ready,再跑业务 cb,捕获业务异常 rewrap 成
 * IPC error。readiness 失败和业务失败分两层 try/catch,避免 readiness timeout
 * 被 rewrapSchedulerError 的 message 嗅探误判成 INVALID_PARAMS。
 */
async function withScheduler<T>(cb: (deps: SchedulerDeps) => Promise<T>): Promise<T> {
  let deps: SchedulerDeps;
  try {
    deps = await awaitReadyWithTimeout();
  } catch (err) {
    throwIpcError(
      'INTERNAL',
      `scheduler not ready: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return await cb(deps);
  } catch (err) {
    rewrapSchedulerError(err);
  }
}

function listAllTemplates(): ScheduleTemplate[] {
  const projectTemplates: ScheduleTemplate[] = [];
  return [...BUILTIN_TEMPLATES, ...projectTemplates];
}

function findTemplate(id: string): ScheduleTemplate | null {
  return listAllTemplates().find((template) => template.id === id) ?? null;
}

function buildCreateScheduleInput(
  template: ScheduleTemplate,
  prompt: string,
  overrides: Partial<CreateScheduleInput>,
): CreateScheduleInput {
  return {
    name: requireString(overrides.name ?? template.name, 'name'),
    prompt: overrides.prompt ?? prompt,
    kind: overrides.kind ?? 'cron',
    cronExpr: requireString(overrides.cronExpr ?? template.cronExpr, 'cronExpr'),
    timezone: requireString(overrides.timezone ?? template.timezone, 'timezone'),
    recurring: overrides.recurring ?? template.recurring ?? true,
    manual: overrides.manual,
    intervalMs: overrides.intervalMs,
    agentKind: overrides.agentKind ?? template.agentKind ?? 'claude-code',
    model: overrides.model ?? template.model,
    effort: overrides.effort ?? template.effort,
    workingDir: overrides.workingDir,
    useWorktree: overrides.useWorktree ?? template.useWorktree ?? false,
    targetSessionId: overrides.targetSessionId,
    persistentSession: overrides.persistentSession ?? template.persistentSession,
    silentWhenIdle: overrides.silentWhenIdle ?? template.silentWhenIdle,
    preRunHook: overrides.preRunHook,
    notify: overrides.notify ?? template.notify ?? { desktop: true, feishu: false },
    expireAt: overrides.expireAt,
  };
}

/**
 * boot 早期一次性挂全部 maker:schedule:* IPC handler。
 *
 * 调用时机:跟 registerMakerIpc 同期(maker 实例 ready 之前都可以,handler 内部
 * 会 await scheduler ready)。**只调一次**,无需 removeHandler 防重 — 这是相对
 * 老 registerMakerScheduleIpc 的关键差异:老 API 在 logout → login 时被重复
 * 调用,因此需要每次先 removeHandler;新 API handler 不依赖 scheduler 实例闭包,
 * scheduler 切换通过 setSchedulerReady 喂入,handler 本身永远不需要重注册。
 */
export function registerScheduleHandlers(getMaker?: () => Maker | null): void {
  log.info('registering maker:schedule:* IPC handlers (boot-eager, awaiting readiness)');

  const resolveSessionWorkDir = async (sessionId: string): Promise<string | undefined> => {
    try {
      const meta = await getMaker?.()?.getSessionMeta(sessionId);
      return meta?.workDir?.trim() ? meta.workDir : undefined;
    } catch {
      return undefined;
    }
  };
  const hookPathDeps = {
    resolveSessionWorkDir,
    stabilizeCommand: async (input: { command: string; workingDir?: string }) =>
      stabilizeHookCommand(input.command, input.workingDir),
  };

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_LIST, async (_e, filter: unknown) =>
    withScheduler(({ scheduler }) =>
      scheduler.list((filter ?? undefined) as ListFilter | undefined),
    ),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_GET, async (_e, id: unknown) => {
    const scheduleId = requireString(id, 'id');
    return withScheduler(({ scheduler }) => scheduler.get(scheduleId));
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_CREATE, async (_e, input: unknown) => {
    requireObject(input, 'input');
    return withScheduler(async ({ scheduler }) => {
      const normalized = await stabilizePreRunHookForCreate(
        input as CreateScheduleInput,
        hookPathDeps,
      );
      return scheduler.create(normalized);
    });
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_UPDATE, async (_e, id: unknown, patch: unknown) => {
    const scheduleId = requireString(id, 'id');
    requireObject(patch, 'patch');
    return withScheduler(({ scheduler }) =>
      scheduler.updateFromCurrent(scheduleId, (existing) =>
        stabilizePreRunHookForUpdate(
          existing,
          patch as UpdateScheduleInput,
          hookPathDeps,
        ),
      ),
    );
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_DELETE, async (_e, id: unknown) => {
    const scheduleId = requireString(id, 'id');
    return withScheduler(async ({ scheduler, storage }) => {
      // 删 automation 前先把它名下所有未读历史标记为已读 —— 用户都决定删了,
      // 残留 unread badge 没意义。失败仅记日志,不阻断 delete 主流程。
      try {
        const updated = await storage.markAllRunsRead(scheduleId);
        if (updated > 0) {
          broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: 'read', scheduleId });
        }
      } catch (readErr) {
        log.warn(`[delete] mark-all-runs-read failed (non-fatal): ${String(readErr)}`);
      }
      await scheduler.delete(scheduleId);
    });
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_PAUSE, async (_e, id: unknown) => {
    const scheduleId = requireString(id, 'id');
    return withScheduler(async ({ scheduler, storage }) => {
      const result = await scheduler.pause(scheduleId);
      // pause 后顺手清掉这条 schedule 名下的未读历史 —— 用户主动暂停就视为
      // 已不再关心当前一批结果,badge 一并消化。失败仅记日志,不影响 pause 本身。
      try {
        const updated = await storage.markAllRunsRead(scheduleId);
        if (updated > 0) {
          broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: 'read', scheduleId });
        }
      } catch (readErr) {
        log.warn(`[pause] mark-all-runs-read failed (non-fatal): ${String(readErr)}`);
      }
      return result;
    });
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_RESUME, async (_e, id: unknown) => {
    const scheduleId = requireString(id, 'id');
    return withScheduler(({ scheduler }) => scheduler.resume(scheduleId));
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_RUN_NOW, async (_e, id: unknown) => {
    const scheduleId = requireString(id, 'id');
    return withScheduler(({ scheduler }) => scheduler.runNow(scheduleId));
  });

  // 表单「AI 生成」:按用户自然语言描述生成前置检查脚本(utility model 单次生成,
  // 带供应商回退链),落盘后返回可直接填入的命令。修改流传 currentCommand,
  // 生成器识别出旧脚本路径时覆写同一文件(命令不变)。
  // 与 MCP schedule_set_pre_run_hook 共用同一统一安装通道 installHookScript
  // (落盘路径规范 + 落盘即自测),返回的 test 让 UI 直接回显自测结果。
  // 绑定会话(heartbeat)任务的表单没有 workingDir(hideWorkspaceFields),真实
  // 运行 cwd 是绑定会话的 meta.workDir —— 测试 / AI 生成必须用同一目录,否则
  // repo-relative 检查在弹窗里给出与生产运行相反的误导结果。renderer 只传
  // targetSessionId,解析在 main 用代码完成(规则 9)。
  const resolveHookWorkingDir = async (body: Record<string, unknown>): Promise<string | undefined> => {
    const explicit =
      typeof body.workingDir === 'string' && body.workingDir.trim() ? body.workingDir : undefined;
    if (explicit) return explicit;
    const targetSessionId =
      typeof body.targetSessionId === 'string' && body.targetSessionId.trim()
        ? body.targetSessionId.trim()
        : undefined;
    if (!targetSessionId) return undefined;
    try {
      return await resolveSessionWorkDir(targetSessionId);
    } catch {
      return undefined;
    }
  };

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_GENERATE_PRE_RUN_HOOK, async (_e, payload: unknown) => {
    const body = requireObject(payload, 'payload');
    const description = requireString(body.description, 'description');
    const maker = getMaker?.();
    if (!maker) throwIpcError('INTERNAL', 'maker not ready for hook script generation');
    const workingDir = await resolveHookWorkingDir(body);
    const requestedAgentKind: AgentKind | undefined = body.agentKind === 'codex' || body.agentKind === 'claude-code'
      ? body.agentKind
      : undefined;
    const targetSessionId = typeof body.targetSessionId === 'string' && body.targetSessionId.trim()
      ? body.targetSessionId.trim()
      : undefined;
    let providerId = typeof body.providerId === 'string' ? body.providerId : undefined;
    let agentKind = requestedAgentKind;
    let model = typeof body.model === 'string' ? body.model : undefined;
    if (targetSessionId && shouldResolveBoundSessionGenerationRoute({ targetSessionId, providerId, model })) {
      const session = await maker.getSessionMeta(targetSessionId).catch(() => null);
      // Bound-session fallback must use the same live connection snapshot as
      // the provider picker. Never turn an unconnected built-in provider into
      // a routable candidate just because it exists in the catalog.
      const { getDesktopProviderService } = await import('../maker-host/createDesktopProviderService.js');
      const providers = await getDesktopProviderService().listProviders({ allowSideEffects: true });
      const route = resolveBoundSessionGenerationRoute({
        session,
        sessionProviderId: getSessionProvider(targetSessionId),
        providers,
      });
      if (!route) {
        return {
          ok: false as const,
          reason: 'no_candidate' as const,
          attempts: [{
            providerId: getSessionProvider(targetSessionId) ?? targetSessionId,
            model: session?.model?.trim() ?? '',
            transport: session?.agentKind === 'codex' ? 'codex-responses' as const : 'litellm-chat-completions' as const,
            status: 'skipped' as const,
            reason: 'model_unavailable' as const,
          }],
        };
      }
      providerId = route.providerId;
      agentKind = route.agentKind;
      model = route.model;
    }
    try {
      const installed = await installHookScript(
        {
          maker,
          fallbackDir: path.join(app.getPath('userData'), 'schedule-hooks'),
          logger: log,
        },
        {
          description,
          scheduleName: typeof body.scheduleName === 'string' ? body.scheduleName : undefined,
          workingDir,
          currentCommand: typeof body.currentCommand === 'string' ? body.currentCommand : undefined,
          providerId,
          agentKind,
          model,
        },
      );
      return { ok: true as const, ...installed };
    } catch (err) {
      if (err instanceof HookScriptUtilityModelError) return err.failure;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  // 表单「测试运行」:立即执行一次前置检查脚本并回显结果(exit code / stdout /
  // stderr / 耗时 / 放行判定)。不依赖 scheduler 实例、不落任何记录 —— 纯诊断。
  ipcMain.handle(MAKER_INVOKE.SCHEDULE_TEST_PRE_RUN_HOOK, async (_e, payload: unknown) => {
    const body = requireObject(payload, 'payload');
    const command = requireString(body.command, 'command');
    const timeoutMs =
      typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
        ? body.timeoutMs
        : undefined;
    // 绑定会话任务:workingDir 空时按 targetSessionId 解析会话目录(与生产运行一致)
    const workingDir = await resolveHookWorkingDir(body);
    return executePreRunHook({
      command,
      timeoutMs,
      cwd: workingDir,
      stdinPayload: {
        event: 'schedule-pre-run',
        scheduleId: 'test',
        scheduleName: typeof body.scheduleName === 'string' ? body.scheduleName : 'test',
        runId: 'test',
        firedAt: Date.now(),
        workingDir,
      },
    });
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_LIST_RUNS, async (_e, scheduleId: unknown, limit: unknown) => {
    const id = requireString(scheduleId, 'scheduleId');
    const lim = typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined;
    return withScheduler(({ scheduler }) => scheduler.listRuns(id, lim));
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_LIST_SIDEBAR_INDEX_RUNS, async () =>
    withScheduler(({ storage }) => storage.listSidebarIndexRuns()),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_LIST_COST_SUMMARIES, async () =>
    withScheduler(({ storage }) => storage.listCostSummaries()),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_DELETE_RUN, async (_e, runId: unknown) => {
    const id = requireString(runId, 'runId');
    return withScheduler(({ scheduler }) => scheduler.deleteRun(id));
  });

  // Renderer 在 delete/pause 前查 in-flight 数量 —— >0 时弹合并文案的二次确认
  // ("该自动化有 N 次执行正在进行,...是否继续?")。本接口同步返回内存 Map 大小,
  // 不查 DB,几乎无延迟。
  ipcMain.handle(MAKER_INVOKE.SCHEDULE_GET_INFLIGHT_COUNT, async (_e, id: unknown) => {
    const scheduleId = requireString(id, 'id');
    return withScheduler(({ scheduler }) =>
      Promise.resolve(scheduler.getInflightCount(scheduleId)),
    );
  });

  // Renderer 首次进入页面时补取一次运行快照，避免错过更早广播的 runtime-state。
  ipcMain.handle(MAKER_INVOKE.SCHEDULE_GET_RUNTIME_STATE, async () =>
    withScheduler(({ scheduler }) => Promise.resolve(scheduler.getRuntimeSnapshot())),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_GET_UNREAD_COUNT, async () =>
    withScheduler(({ storage }) => storage.getUnreadRunCount()),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_MARK_ALL_RUNS_READ, async () =>
    withScheduler(async ({ storage }) => {
      const updated = await storage.markAllUnreadRuns();
      // 仅在有真实更新时广播,避免 no-op 也触发下游 refetch。
      // 广播 'all-read' 而非 'read' —— 后者要求带 scheduleId,这里是全局清。
      if (updated > 0) {
        broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: 'all-read' });
      }
      return updated;
    }),
  );

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_MARK_RUN_READ, async (_e, runId: unknown) => {
    const id = requireString(runId, 'runId');
    return withScheduler(async ({ storage }) => {
      const scheduleId = await storage.markRunRead(id);
      // markRunRead 已自带 "已读 / 非终态 / 不存在" 三种 no-op 短路;
      // 拿到 scheduleId 才广播 —— 让 useRuns 拉到带 readAt 的新 row、badge hook 重算总数。
      if (scheduleId) {
        broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: 'read', scheduleId });
      }
    });
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_MARK_SCHEDULE_RUNS_READ, async (_e, scheduleId: unknown) => {
    const id = requireString(scheduleId, 'scheduleId');
    return withScheduler(async ({ storage }) => {
      const updated = await storage.markAllRunsRead(id);
      // 仅在有真实更新时广播,避免 no-op 也触发下游 refetch。
      if (updated > 0) {
        broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: 'read', scheduleId: id });
      }
      return updated;
    });
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_LIST_TEMPLATES, async () => {
    // Templates 不依赖 scheduler 实例,但走 withScheduler 让 readiness window
    // 内的调用也排队等(与其他 schedule IPC 行为一致,避免协议表面不一)。
    return withScheduler(async () => listAllTemplates());
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_CREATE_FROM_TEMPLATE, async (_e, payload: unknown) => {
    const body = requireObject(payload, 'payload');
    const templateId = requireString(body.templateId, 'templateId');
    const paramValues =
      body.paramValues && typeof body.paramValues === 'object'
        ? (body.paramValues as Record<string, string>)
        : {};
    const overrides =
      body.overrides && typeof body.overrides === 'object'
        ? (body.overrides as Partial<CreateScheduleInput>)
        : {};
    return withScheduler(({ scheduler }) => {
      const template = findTemplate(templateId);
      if (!template) throwIpcError('NOT_FOUND', `template ${templateId} not found`);
      const prompt = applyTemplateParams(
        template.prompt ?? '',
        paramValues,
        template.parameters,
      );
      return scheduler.create(buildCreateScheduleInput(template, prompt, overrides));
    });
  });

  ipcMain.handle(MAKER_INVOKE.SCHEDULE_SCRIPT_CAPABILITY_STATUS, async () => {
    // 查询型 handler(规则 13 例外):探测失败不该挡住表单——返回空列表,
    // renderer 视为"未知",不标警示也不报错。
    try {
      const ghosts = getGhostManager()
        .list()
        .map((g) => ({ id: g.manifest.id, name: g.manifest.name, enabled: g.enabled }));
      return { statuses: resolveScriptCapabilityStatuses(ghosts) };
    } catch (err) {
      log.warn(`script capability status probe failed (non-fatal): ${String(err)}`);
      return { statuses: [] };
    }
  });

  log.info('maker:schedule:* IPC handlers registered');
}

/**
 * attemptStartScheduler 拿到新 Scheduler 实例后调一次。
 *
 * 关键时序(spec worker 锦上添花 #7):必须**最后**调 broadcast('ready'),让
 * renderer schedulesStore 收到 ready 时,main 端的 5 个 scheduler.on listener
 * 已全连上,接下来的 'changed' / 'fired' / ... 不会漏接。
 *
 * setSchedulerReady 同时 resolve 此前所有在途 IPC 的 awaitReady promise — handler
 * 立刻拿到新实例继续业务。
 */
export function attachSchedulerEventListeners(
  scheduler: Scheduler,
  storage: DrizzleScheduleStorage,
): void {
  // 单一 channel 多事件类型:renderer 按 event.type 分支
  scheduler.on('fired', broadcastSchedulerEvent);
  scheduler.on('completed', broadcastSchedulerEvent);
  scheduler.on('failed', broadcastSchedulerEvent);
  scheduler.on('silenced', broadcastSchedulerEvent);
  scheduler.on('notified', broadcastSchedulerEvent);
  scheduler.on('deferred', broadcastSchedulerEvent);
  scheduler.on('skipped', broadcastSchedulerEvent);
  scheduler.on('session-bound', broadcastSchedulerEvent);
  scheduler.on('changed', broadcastSchedulerEvent);
  scheduler.on('runtime-state', broadcastSchedulerEvent);

  // 必须在 .on 全挂完之后调:setSchedulerReady 会立即 resolve 在途 await,
  // 之后业务 IPC 跑起来可能触发 changed/fired,listener 漏挂会丢事件。
  setSchedulerReady(scheduler, storage);

  // 必须最后:'ready' 是 store 后台预热信号(切账号 relogin 场景),收到时
  // 期待事件通道已全连上。冷启动场景下,store ensure() 已经在 awaitReady,
  // setSchedulerReady 一调 list() 就返回真数据,'ready' 不重复触发预热
  // (store 用 wasReset flag 区分)。
  broadcast(MAKER_PUSH.SCHEDULE_EVENT, { type: 'ready' });

  log.info('scheduler ready: listeners attached + ready broadcast sent');
}
