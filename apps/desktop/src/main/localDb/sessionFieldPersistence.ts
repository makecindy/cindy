/**
 * The persistence of a task's settings fields written back after a runtime change: the fields a
 * remote set-* may persist (REMOTE_PERSIST_FIELDS) and persistSessionFields, which writes them,
 * keeps a task's context window budget in its preference file, and broadcasts the change. Moved
 * verbatim out of localDb/ipc/sessions.ts (which imports electron) so the Node Host persists a model
 * change the same way; sessions.ts keeps both names and every caller goes through it.
 *
 * Ports, each called where the body used it (after its awaits, not when the call starts): the data
 * owner scope capture and check, the broadcast, and the context window budget hook registered with
 * the session IPC (read through `registeredSessionIpcOpts`, a live view of that registration).
 */
import { eq } from 'drizzle-orm';
import { normalizeDbAgentKind } from '../../shared/agentKindConversion';
import { normalizeContextWindowBudget } from '../../shared/sessionContextWindowBudget.js';
import {
  readSessionContextWindowBudget,
  writeSessionContextWindowBudget,
} from '../maker-host/session-context-budget-store.js';
import { getDbClient } from './client/current';
import { persistableSessionEffort, projectSessionRuntimeFields, sessionPatchToRow } from './mapper';
import { sessions } from './schema';

type OwnerScope = ReturnType<typeof import('../device-link/broadcast-tap.js').captureDataOwnerBroadcastScope> | null;

export interface SessionFieldPersistencePorts {
  captureOwnerScope: () => OwnerScope;
  isOwnerScopeCurrent: (scope: OwnerScope) => boolean;
  broadcastSessionPatched: (sessionId: string, patch: Record<string, unknown>, ownerScope?: OwnerScope) => void;
  /** The context window budget hook registered with the session IPC now (undefined when none is). */
  applyContextWindowBudget: () => import('./ipc/sessions.js').RegisterSessionIpcOpts['applyContextWindowBudget'];
}


/** device-link 远程 set-* 回流可持久化的 session settings 字段(见 persistSessionFields)。 */
export const REMOTE_PERSIST_FIELDS = new Set([
  'model',
  // set-model 第 3 参 providerId(per-session 来源)与 model 同批回流:必须在白名单内,
  // 否则被控端 DB 不写 provider_id(跨重启/resume 丢来源)、且广播 patch 不带 providerId →
  // 控制端 mirror 的 session.providerId 永不收敛(模型选择器 settle 永远卡 5s)。
  'providerId',
  'effort',
  'permissionMode',
  'fastMode',
  'planModeEnabled',
  'extraDirs',
  'writableDirs',
  // 任务级窗口预算：device-link 控制端改档位后，被控端需落库并广播，否则控制端
  // 会拿旧值回滚自己的乐观 UI。
  'contextWindowBudget',
]);

/** persistSessionFields (localDb/ipc/sessions.ts), with its ports first. */
export async function persistSessionFieldsWith(
  ports: SessionFieldPersistencePorts,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched } = ports;
  const registeredSessionIpcOpts = { get applyContextWindowBudget() { return ports.applyContextWindowBudget(); } };
  const ownerScope = captureOwnerScope();
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (REMOTE_PERSIST_FIELDS.has(k)) clean[k] = patch[k];
  }
  if (Object.prototype.hasOwnProperty.call(clean, 'effort')) {
    const persistableEffort = persistableSessionEffort(clean.effort);
    if (persistableEffort === undefined) delete clean.effort;
    else clean.effort = persistableEffort;
  }
  if (Object.prototype.hasOwnProperty.call(clean, 'contextWindowBudget')) {
    // 镜像回流（被控端 → 本机）的值可能是旧版 peer / 手改偏好文件留下的越界值：
    // store 的 clamp 会把越界值静默收敛（等于把本机预算改掉且没人知道），
    // 这里显式归一化并留痕；非法值**跳过该字段**，不写偏好也不触发应用钩子。
    const normalized = normalizeContextWindowBudget(clean.contextWindowBudget);
    if (normalized === null && clean.contextWindowBudget !== null) {
      console.warn('[sessions] dropping invalid mirrored context window budget', {
        sessionId,
        value: clean.contextWindowBudget,
      });
      delete clean.contextWindowBudget;
    } else {
      clean.contextWindowBudget = normalized;
    }
  }
  if (Object.keys(clean).length === 0) return;
  const db = getDbClient().drizzle;
  // 任务窗口预算不是会话列（见 session-context-budget-store 头注），单独走偏好文件；
  // 其余字段照旧走行更新。
  const hasBudgetChange = clean.contextWindowBudget !== undefined;
  const previousContextWindowBudget: number | null = hasBudgetChange
    ? readSessionContextWindowBudget(sessionId)
    : null;
  const rowPatch = { ...clean };
  delete rowPatch.contextWindowBudget;
  const setObj = sessionPatchToRow(rowPatch as Parameters<typeof sessionPatchToRow>[0], {
    bumpUpdatedAt: false,
  });
  if (Object.keys(setObj).length > 0) {
    await db.update(sessions).set(setObj).where(eq(sessions.id, sessionId));
  } else if (!hasBudgetChange) {
    return;
  }
  // 预算写偏好文件放在行更新**之后**：偏好文件不可读时 store 会拒绝写（保留坏文件给
  // 人工修），若先写就会让同一个 patch 里的其它字段（改名、归档…）整包失败。
  // 纯预算请求不能降级：那是用户唯一的意图，吞掉错误等于「看着成功、实际还是旧窗口」。
  const budgetOnlyPatch = Object.keys(rowPatch).length === 0;
  // 账号边界：偏好文件按「当下」账号的 userData 解析，而上面 db.update /
  // 下面 apply 都是 await 出来的 —— 期间切账号时这条远程镜像更新必须整条作废
  // （与 updateSessionInDb 同口径）。Greptile P1，2026-10-24。
  const budgetScopeCurrent = isOwnerScopeCurrent(ownerScope);
  let budgetWritten = false;
  let nextContextWindowBudget: number | null = null;
  if (hasBudgetChange && budgetScopeCurrent) {
    try {
      nextContextWindowBudget = writeSessionContextWindowBudget(
        sessionId, (clean.contextWindowBudget as number | null) ?? null,
      );
      budgetWritten = true;
    } catch (error) {
      if (budgetOnlyPatch) throw error;
      // 混合更新：其它字段已落库，只降级为「预算未保存」，并从广播里剔除这个键 ——
      // 否则 UI 会显示一个没存下去的值（Greptile P1，2026-10-24）。
      console.warn('[sessions] write context window budget failed; other fields already saved', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      delete clean.contextWindowBudget;
    }
  }
  let runtimeProjection = {};
  if (['model', 'providerId', 'effort', 'fastMode'].some((key) => key in clean)) {
    const [row] = await db.select({
      id: sessions.id, agentKind: sessions.agentKind, model: sessions.model,
      providerId: sessions.providerId, effort: sessions.effort, fastMode: sessions.fastMode,
      scheduledModelBaseline: sessions.scheduledModelBaseline,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (row?.scheduledModelBaseline) {
      runtimeProjection = projectSessionRuntimeFields({ ...row, agentKind: normalizeDbAgentKind(row.agentKind) });
    }
  }
  if (isOwnerScopeCurrent(ownerScope)) broadcastSessionPatched(sessionId, { ...clean, ...runtimeProjection }, ownerScope);
  // 远程 set-* 落库后同样要把新预算应用到被控端活实例（语义与 updateSessionInDb 一致）。
  if (budgetWritten && budgetScopeCurrent && isOwnerScopeCurrent(ownerScope)
    && registeredSessionIpcOpts.applyContextWindowBudget) {
    try {
      await registeredSessionIpcOpts.applyContextWindowBudget(sessionId, {
        previous: previousContextWindowBudget,
        next: nextContextWindowBudget,
      });
    } catch (error) {
      console.warn('[sessions] remote context window budget apply failed; takes effect on next start', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
