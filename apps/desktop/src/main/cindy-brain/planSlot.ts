/**
 * planSlot.ts — Ghost Plan 接口槽。
 *
 * 插件提交完整 Plan 快照；目标任务来自 Host 当前可信上下文。
 * 本槽不保存 Plan、不做推理，也不提供读取、独立清空命令或任意 session 控制能力；
 * 零任务数组仍是一份合法的完整快照。
 */

import {
  type GhostPipePlanPayload,
  type GhostPipePlanUpdateResult,
  type InstalledGhost,
  validateGhostPlanPayload,
} from '../../shared/ghost.js';

export type PlanProjector = (
  operation: 'create' | 'update',
  ghostId: string,
  sessionContext: PlanUpdateSessionContext,
  update: Omit<GhostPipePlanPayload, 'type'>,
) => void | Promise<void>;

export interface PlanUpdateSessionContext {
  sessionId: string;
  sessionInstanceId: string;
}

export interface PlanSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  getCurrentSessionContext(ghostId: string): PlanUpdateSessionContext | null;
  isTrustedSessionContext(context: PlanUpdateSessionContext): boolean | Promise<boolean>;
  projector?: PlanProjector | null;
  now?: () => number;
  log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/** 每个插件允许短时连发，但拒绝无界紧循环发送 Plan 更新。 */
export const PLAN_UPDATE_RATE_WINDOW_MS = 1_000;
export const PLAN_UPDATE_RATE_MAX_UPDATES = 20;

export class PlanSlot {
  private projector: PlanProjector | null;
  private readonly acceptedAtByGhost = new Map<string, number[]>();

  constructor(private readonly deps: PlanSlotDeps) {
    this.projector = deps.projector ?? null;
  }

  setProjector(projector: PlanProjector | null): void {
    this.projector = projector;
  }

  async handleUpdate(ghostId: string, payload: unknown): Promise<GhostPipePlanUpdateResult> {
    return this.handle('update', ghostId, payload);
  }

  async handleCreate(ghostId: string, payload: unknown): Promise<GhostPipePlanUpdateResult> {
    return this.handle('create', ghostId, payload);
  }

  private async handle(
    operation: 'create' | 'update',
    ghostId: string,
    payload: unknown,
  ): Promise<GhostPipePlanUpdateResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('plan')) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: '插件未声明 plan 权限，或当前未启用',
      };
    }

    // 入站限流必须早于会话 DB 验身和 payload 遍历；非法/超量请求同样计数，
    // 否则有权限的故障插件仍能用拒绝路径持续压垮 Main。
    const now = this.deps.now?.() ?? Date.now();
    const attempts = (this.acceptedAtByGhost.get(ghostId) ?? []).filter(
      (timestamp) => now - timestamp < PLAN_UPDATE_RATE_WINDOW_MS,
    );
    if (attempts.length >= PLAN_UPDATE_RATE_MAX_UPDATES) {
      this.acceptedAtByGhost.set(ghostId, attempts);
      return {
        ok: false,
        errorCode: 'RATE_LIMITED',
        message: 'Plan 更新过于频繁，请稍后重试',
      };
    }
    attempts.push(now);
    this.acceptedAtByGhost.set(ghostId, attempts);

    const sessionContext = this.deps.getCurrentSessionContext(ghostId);
    const checkedContext = sessionContext
      ? await this.deps.isTrustedSessionContext(sessionContext)
      : false;
    const contextAfterCheck = this.deps.getCurrentSessionContext(ghostId);
    if (
      !sessionContext ||
      !checkedContext ||
      contextAfterCheck?.sessionId !== sessionContext.sessionId ||
      contextAfterCheck?.sessionInstanceId !== sessionContext.sessionInstanceId
    ) {
      return {
        ok: false,
        errorCode: 'NO_SESSION_CONTEXT',
        message: '当前没有可信的任务上下文，无法更新 Plan',
      };
    }

    const validated = validateGhostPlanPayload(payload);
    if (!validated.ok) {
      return { ok: false, errorCode: 'INVALID_PARAMS', message: validated.message };
    }
    if (!this.projector) {
      return {
        ok: false,
        errorCode: 'HOST_NOT_READY',
        message: 'Plan 投影服务尚未就绪',
      };
    }

    if (validated.value.type !== `plan-${operation}`) {
      return { ok: false, errorCode: 'INVALID_PARAMS', message: `type 必须是 plan-${operation}` };
    }
    const update: Omit<GhostPipePlanPayload, 'type'> = {
      ...(validated.value.explanation !== undefined
        ? { explanation: validated.value.explanation }
        : {}),
      plan: validated.value.plan,
    };
    try {
      // Plan 是会话级 UI；create 强制开始新生命周期，update 的覆盖规则由
      // Host 按当前置顶 Plan 统一决定，插件不提供可碰撞的更新键。
      await this.projector(operation, ghostId, sessionContext, update);
      return { ok: true };
    } catch (error) {
      this.deps.log?.warn('plan-update projection failed', {
        ghostId,
        sessionId: sessionContext.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, errorCode: 'INTERNAL', message: 'Plan 投影失败' };
    }
  }
}
