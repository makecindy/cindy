/**
 * Coordinates Host-authoritative plugin setup before ghost_call dispatch.
 *
 * The coordinator owns no credential values. It waits on revision-only change
 * events, re-runs the injected assessment after every signal, and resolves the
 * original caller only when the current assessment is ready.
 */

import { randomUUID } from 'node:crypto';

import type {
  GhostSetupAllowedAction,
  GhostSetupAssessment,
  GhostSetupErrorCode,
  GhostSetupPlan,
} from '../../shared/ghost.js';
import type { GhostSetupChangeBus } from './ghostSetupChangeBus.js';
import type {
  GhostSetupInteractionBridge,
  GhostSetupInteractionCommand,
  GhostSetupInteractionResponseTarget,
  GhostSetupInteractionSnapshot,
  GhostSetupInteractionStep,
} from './ghostSetupInteractionBridge.js';

export type GhostSetupEnsureResult =
  | { ok: true; assessment: GhostSetupAssessment }
  | {
      ok: false;
      errorCode:
        | 'SETUP_REQUIRED'
        | 'SETUP_CANCELLED'
        | 'TIMEOUT'
        | 'INTERNAL'
        | 'GHOST_NOT_FOUND'
        | 'GHOST_ASLEEP'
        | 'GHOST_DISABLED_IN_WORKDIR'
        | 'TOOL_NOT_FOUND';
      message: string;
      setup?: GhostSetupAssessment;
    };

export type GhostSetupTargetValidation =
  | { ok: true }
  | {
      ok: false;
      errorCode:
        'GHOST_NOT_FOUND' | 'GHOST_ASLEEP' | 'GHOST_DISABLED_IN_WORKDIR' | 'TOOL_NOT_FOUND';
      message: string;
    };

export type GhostSetupActionResult =
  | {
      ok: true;
      /** Settings actions return immediately and then wait for a committed write. */
      waitingExternal?: boolean;
    }
  | {
      ok: false;
      /** Stable identity published to interaction snapshots when the action fails. */
      errorCode: GhostSetupErrorCode;
      /** Main-only diagnostic detail; never copied into a new interaction snapshot. */
      message?: string;
    };

export interface GhostSetupCoordinatorDeps {
  changeBus: GhostSetupChangeBus;
  bridge: GhostSetupInteractionBridge;
  assess: (ghostId: string) => Promise<GhostSetupAssessment> | GhostSetupAssessment;
  validateTarget: (
    ghostId: string,
    tool: string | undefined,
    workingDir?: string | null,
  ) => GhostSetupTargetValidation;
  getGhostIdentity: (ghostId: string) => {
    id: string;
    name: string;
    iconDataUrl?: string;
  } | null;
  executeAction: (args: {
    sessionId: string;
    ghostId: string;
    action: GhostSetupAllowedAction;
    responseTarget?: GhostSetupInteractionResponseTarget;
  }) => Promise<GhostSetupActionResult>;
  executeInlineAction?: (args: {
    sessionId: string;
    ghostId: string;
    action: Extract<GhostSetupAllowedAction, { kind: 'inline_form' }>;
    value: string;
  }) => Promise<GhostSetupActionResult>;
  timeoutMs?: number;
  terminalGraceMs?: number;
  createRequestId?: () => string;
  logger?: {
    warn: (message: string, context?: Record<string, unknown>) => void;
  };
}

export interface GhostSetupEnsureRequest {
  sessionId: string | null;
  ghostId: string;
  /** Omitted for setup-only operations such as grant_only that ignore the requested tool. */
  tool?: string;
  /** Captured call scope; revalidated after every setup/policy change. */
  workingDir?: string | null;
  plan?: GhostSetupPlan;
}

const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TERMINAL_GRACE_MS = 700;

export class GhostSetupCoordinator {
  private readonly actionFlights = new Map<string, Promise<GhostSetupActionResult>>();

  constructor(private readonly deps: GhostSetupCoordinatorDeps) {}

  async ensureReady(request: GhostSetupEnsureRequest): Promise<GhostSetupEnsureResult> {
    let assessment: GhostSetupAssessment;
    let unsubscribe = () => {};
    let wakeVerify: (() => void) | null = null;
    let assessmentDirty = false;

    // Subscribe before the initial read. A committed settings write racing the
    // first assessment will then keep the read loop running until one complete
    // assessment observes a quiet revision.
    unsubscribe = this.deps.changeBus.subscribe(request.ghostId, () => {
      assessmentDirty = true;
      if (wakeVerify) wakeVerify();
    });

    const readUntilQuiet = async (): Promise<
      | { ok: true; assessment: GhostSetupAssessment }
      | { ok: false; target: Exclude<GhostSetupTargetValidation, { ok: true }> }
    > => {
      for (;;) {
        assessmentDirty = false;
        const startRevision = this.deps.changeBus.currentRevision(request.ghostId);
        const target = this.deps.validateTarget(request.ghostId, request.tool, request.workingDir);
        if (!target.ok) return { ok: false, target };
        const next = await this.deps.assess(request.ghostId);
        if (
          !assessmentDirty &&
          this.deps.changeBus.currentRevision(request.ghostId) === startRevision
        ) {
          return { ok: true, assessment: next };
        }
      }
    };

    try {
      const initial = await readUntilQuiet();
      if (!initial.ok) {
        unsubscribe();
        return initial.target;
      }
      assessment = initial.assessment;
    } catch (error) {
      unsubscribe();
      return this.internalFailure('插件配置状态读取失败', error);
    }
    if (assessment.state === 'ready') {
      unsubscribe();
      return { ok: true, assessment };
    }
    if (!request.sessionId) {
      unsubscribe();
      return {
        ok: false,
        errorCode: 'SETUP_REQUIRED',
        message: '该插件尚未完成设置，请在 Cindy Desktop 中完成配置后重试。',
        setup: assessment,
      };
    }

    const identity = this.deps.getGhostIdentity(request.ghostId);
    if (!identity) {
      unsubscribe();
      return {
        ok: false,
        errorCode: 'SETUP_REQUIRED',
        message: '目标插件已卸载或当前不可用。',
      };
    }

    const sessionId = request.sessionId;
    const requestId = this.deps.createRequestId?.() ?? randomUUID();
    let plan = validatePlan(request.plan, assessment) ?? defaultPlan(assessment);
    let snapshot = toSnapshot(requestId, identity, assessment, plan);
    let settled = false;
    let verifying: Promise<void> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let activeActionId: string | undefined;
    let inlineSubmitting = false;

    return new Promise<GhostSetupEnsureResult>((resolve) => {
      const settle = (
        result: GhostSetupEnsureResult,
        dismissReason: string,
        dismissDelayMs = this.deps.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS,
      ): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timeoutId) clearTimeout(timeoutId);
        // The terminal card may remain visible for a short grace period, but
        // the request must stop participating in pending/actionable semantics
        // before the original ghost_call resumes.
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          terminal: true,
        };
        this.deps.bridge.update(snapshot);
        this.deps.bridge.complete(requestId);
        if (dismissDelayMs > 0) {
          setTimeout(() => this.deps.bridge.close(requestId, dismissReason), dismissDelayMs);
        } else {
          this.deps.bridge.close(requestId, dismissReason);
        }
        // The original ghost_call resumes immediately. The grace only keeps
        // the terminal UI visible and never delays task execution.
        resolve(result);
      };

      const settleTargetFailure = (
        failure: Exclude<GhostSetupTargetValidation, { ok: true }>,
      ): void => {
        publish(assessment, 'failed', 'TARGET_UNAVAILABLE');
        settle(failure, 'target-invalid');
      };

      const publish = (
        nextAssessment: GhostSetupAssessment,
        phase?: GhostSetupInteractionStep['phase'],
        errorCode?: GhostSetupErrorCode,
        allPendingSteps = false,
      ): void => {
        assessment = nextAssessment;
        plan = validatePlan(plan, assessment) ?? defaultPlan(assessment);
        const nextRevision = Math.max(snapshot.revision + 1, assessment.revision);
        snapshot = toSnapshot(requestId, identity, assessment, plan, {
          revision: nextRevision,
          phase,
          errorCode,
          activeActionId,
          allPendingSteps,
        });
        this.deps.bridge.update(snapshot);
      };

      const verify = (requiredPhase?: GhostSetupInteractionStep['phase']): Promise<void> => {
        if (settled) return Promise.resolve();
        if (verifying) return verifying;
        verifying = (async () => {
          publish(assessment, 'verifying');
          let current:
            | { ok: true; assessment: GhostSetupAssessment }
            | { ok: false; target: Exclude<GhostSetupTargetValidation, { ok: true }> };
          try {
            current = await readUntilQuiet();
          } catch (error) {
            if (settled) return;
            publish(assessment, 'failed', 'ASSESSMENT_FAILED');
            this.deps.logger?.warn('plugin setup assessment failed', {
              ghostId: request.ghostId,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          if (settled) return;
          if (!current.ok) {
            settleTargetFailure(current.target);
            return;
          }
          const next = current.assessment;
          if (next.state === 'ready') {
            publish(next, 'satisfied');
            settle({ ok: true, assessment: next }, 'ready');
            return;
          }
          publish(next, requiredPhase);
        })().finally(() => {
          verifying = null;
          if (assessmentDirty && !settled) wakeVerify?.();
        });
        return verifying;
      };
      wakeVerify = () => {
        const waitingExternal = snapshot.steps.some((step) => step.phase === 'waiting_external');
        void verify(waitingExternal ? 'waiting_external' : undefined);
      };

      const runAction = async (
        actionId: string,
        expectedRevision: number,
        responseTarget?: GhostSetupInteractionResponseTarget,
      ): Promise<void> => {
        if (settled) return;
        if (expectedRevision !== snapshot.revision) {
          await verify();
          return;
        }
        const target = this.deps.validateTarget(request.ghostId, request.tool, request.workingDir);
        if (!target.ok) {
          settleTargetFailure(target);
          return;
        }
        const action = findAllowedAction(assessment, actionId);
        if (!action) {
          await verify();
          return;
        }
        activeActionId = action.id;
        publish(assessment, 'action_running');
        // OAuth is a Host-global flow and remains shared. Navigation actions
        // belong to a session + responding window: two sessions displayed in
        // one window must each receive a route carrying its own sessionId.
        const flightScope =
          action.kind === 'oauth_connect'
            ? 'shared'
            : responseTarget
              ? `session:${sessionId}:target:${responseTarget.id}`
              : `session:${sessionId}`;
        const flightKey = `${request.ghostId}\u0000${action.id}\u0000${flightScope}`;
        let flight = this.actionFlights.get(flightKey);
        if (!flight) {
          flight = this.deps
            .executeAction({
              sessionId,
              ghostId: request.ghostId,
              action,
              ...(responseTarget ? { responseTarget } : {}),
            })
            .finally(() => this.actionFlights.delete(flightKey));
          this.actionFlights.set(flightKey, flight);
        }
        let result: GhostSetupActionResult;
        try {
          result = await flight;
        } catch (error) {
          result = {
            ok: false,
            errorCode: 'ACTION_FAILED',
            message: error instanceof Error ? error.message : '插件设置操作失败',
          };
        }
        if (settled) return;
        if (!result.ok) {
          publish(assessment, 'failed', result.errorCode ?? 'ACTION_FAILED');
          return;
        }
        if (result.waitingExternal) publish(assessment, 'waiting_external');
        await verify(result.waitingExternal ? 'waiting_external' : undefined);
      };

      const onCommand = async (
        command: GhostSetupInteractionCommand,
        responseTarget?: GhostSetupInteractionResponseTarget,
      ): Promise<void> => {
        if (command.action === 'cancel') {
          if (command.expectedRevision !== snapshot.revision) {
            await verify();
            return;
          }
          publish(assessment, 'cancelled', undefined, true);
          settle(
            {
              ok: false,
              errorCode: 'SETUP_CANCELLED',
              message: '用户取消了插件设置，本次调用未执行。',
            },
            'cancelled',
            command.cleanupReason ? 0 : undefined,
          );
          return;
        }
        await runAction(command.actionId, command.expectedRevision, responseTarget);
      };

      const submitInline = async (submit: {
        actionId: string;
        expectedRevision: number;
        value: string;
      }): Promise<void> => {
        if (settled) return;
        if (inlineSubmitting) {
          // 重复点击/另一窗口提交时重播权威 running 快照，确保各 Renderer
          // 都能收敛并清掉本地 command-in-flight；不复用或吞并 Secret 值。
          this.deps.bridge.update(snapshot);
          return;
        }
        if (submit.expectedRevision !== snapshot.revision) {
          await verify();
          return;
        }
        const target = this.deps.validateTarget(request.ghostId, request.tool, request.workingDir);
        if (!target.ok) {
          settleTargetFailure(target);
          return;
        }
        const action = findAllowedAction(assessment, submit.actionId);
        if (!action || action.kind !== 'inline_form') {
          await verify();
          return;
        }
        inlineSubmitting = true;
        activeActionId = action.id;
        publish(assessment, 'action_running');
        let result: GhostSetupActionResult;
        try {
          result = this.deps.executeInlineAction
            ? await this.deps.executeInlineAction({
                sessionId,
                ghostId: request.ghostId,
                action,
                value: submit.value,
              })
            : {
                ok: false,
                errorCode: 'INLINE_UNAVAILABLE',
                message: '当前版本不支持内联插件设置',
              };
        } catch (error) {
          result = {
            ok: false,
            errorCode: 'ACTION_FAILED',
            message: error instanceof Error ? error.message : '插件设置操作失败',
          };
        } finally {
          inlineSubmitting = false;
        }
        if (settled) return;
        if (!result.ok) {
          publish(assessment, 'failed', result.errorCode ?? 'ACTION_FAILED');
          return;
        }
        await verify();
      };

      try {
        this.deps.bridge.open(sessionId, snapshot, onCommand, submitInline);
      } catch (error) {
        settle(this.internalFailure('插件设置卡片打开失败', error), 'open-failed', 0);
        return;
      }
      timeoutId = setTimeout(() => {
        publish(assessment, 'failed', 'TIMEOUT', true);
        settle(
          {
            ok: false,
            errorCode: 'TIMEOUT',
            message: '插件设置等待超时，本次调用未执行。',
          },
          'timeout',
        );
      }, this.deps.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS);
    });
  }

  private internalFailure(message: string, error: unknown): GhostSetupEnsureResult {
    this.deps.logger?.warn('plugin setup coordinator failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, errorCode: 'INTERNAL', message };
  }
}

let coordinatorSingleton: GhostSetupCoordinator | null = null;

export function initGhostSetupCoordinator(deps: GhostSetupCoordinatorDeps): GhostSetupCoordinator {
  coordinatorSingleton = new GhostSetupCoordinator(deps);
  return coordinatorSingleton;
}

export function getGhostSetupCoordinator(): GhostSetupCoordinator | null {
  return coordinatorSingleton;
}

function findAllowedAction(
  assessment: GhostSetupAssessment,
  actionId: string,
): GhostSetupAllowedAction | null {
  for (const group of assessment.groups) {
    if (group.items.some((item) => item.state === 'satisfied')) continue;
    for (const item of group.items) {
      const action = item.actions.find((candidate) => candidate.id === actionId);
      if (action) return action;
    }
  }
  return null;
}

function validatePlan(
  plan: GhostSetupPlan | undefined,
  assessment: GhostSetupAssessment,
): GhostSetupPlan | null {
  if (!plan || plan.assessmentRevision !== assessment.revision || plan.steps.length === 0) {
    return null;
  }
  const requirementsByRef = new Map(
    assessment.groups.flatMap((group) =>
      group.items.map((item) => [item.ref, { group, item }] as const),
    ),
  );
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id) || step.requirementRefs.length === 0) return null;
    stepIds.add(step.id);
    const requirements = step.requirementRefs.map((ref) => requirementsByRef.get(ref));
    if (requirements.some((requirement) => !requirement)) return null;
    const groups = new Set(requirements.map((requirement) => requirement?.group.id));
    if (groups.size !== 1) return null;
    const group = requirements[0]?.group;
    if (!group || group.items.some((item) => item.state === 'satisfied')) return null;
    if (
      !requirements.some(
        (requirement) =>
          requirement !== undefined &&
          requirement.item.state !== 'satisfied' &&
          requirement.item.actions.some((action) => action.id === step.actionId),
      )
    ) {
      return null;
    }
  }
  for (const group of assessment.groups) {
    if (group.items.some((item) => item.state === 'satisfied')) continue;
    // Agent may arrange copy/order, but it cannot hide a valid setup path.
    // Every actionable item in an unsatisfied any-of group must remain visible,
    // otherwise e.g. "Brave OR Tavily" silently degrades to the first provider.
    for (const item of group.items) {
      if (item.state === 'satisfied' || item.actions.length === 0) continue;
      const actionIds = new Set(item.actions.map((action) => action.id));
      if (
        !plan.steps.some(
          (step) => step.requirementRefs.includes(item.ref) && actionIds.has(step.actionId),
        )
      ) {
        return null;
      }
    }
  }
  return plan;
}

function defaultPlan(assessment: GhostSetupAssessment): GhostSetupPlan {
  const steps = assessment.groups.flatMap((group, index) => {
    if (group.items.some((item) => item.state === 'satisfied')) return [];
    return group.items.flatMap((item, itemIndex) => {
      if (item.state === 'satisfied') return [];
      const action = item.actions[0];
      if (!action) return [];
      return [
        {
          id: `setup-${index + 1}-${itemIndex + 1}`,
          requirementRefs: [item.ref],
          title: item.label,
          // 字段 label 已承担标题职责；没有额外说明时保持为空，避免 Host
          // fallback 在卡片里把同一份文案重复成「标题 + 描述 + 字段名」。
          description: item.description ?? '',
          actionId: action.id,
        },
      ];
    });
  });
  return { assessmentRevision: assessment.revision, steps };
}

function toSnapshot(
  requestId: string,
  identity: GhostSetupInteractionSnapshot['ghost'],
  assessment: GhostSetupAssessment,
  plan: GhostSetupPlan,
  override?: {
    revision?: number;
    phase?: GhostSetupInteractionStep['phase'];
    errorCode?: GhostSetupErrorCode;
    activeActionId?: string;
    allPendingSteps?: boolean;
  },
): GhostSetupInteractionSnapshot {
  const groupsByRef = new Map(
    assessment.groups.flatMap((group) => group.items.map((item) => [item.ref, group] as const)),
  );
  const actionsById = new Map(
    assessment.groups.flatMap((group) =>
      group.items.flatMap((item) => item.actions.map((action) => [action.id, action] as const)),
    ),
  );
  const steps = plan.steps.map((step) => {
    const referencedGroups = step.requirementRefs
      .map((ref) => groupsByRef.get(ref))
      .filter((group): group is NonNullable<typeof group> => Boolean(group));
    const satisfied =
      referencedGroups.length > 0 &&
      referencedGroups.every((group) => group.items.some((item) => item.state === 'satisfied'));
    const action = actionsById.get(step.actionId);
    const active =
      override?.allPendingSteps === true ||
      !override?.activeActionId ||
      step.actionId === override.activeActionId;
    return {
      id: step.id,
      groupId: referencedGroups[0]?.id ?? step.id,
      groupMode: referencedGroups[0]?.mode ?? ('any_of' as const),
      title: step.title,
      description: step.description,
      phase: satisfied
        ? ('satisfied' as const)
        : active
          ? (override?.phase ?? 'pending')
          : ('pending' as const),
      ...(action && !satisfied ? { action } : {}),
      ...(!satisfied && active && override?.errorCode
        ? { errorCode: override.errorCode }
        : {}),
    };
  });
  return {
    kind: 'plugin_setup',
    requestId,
    revision: override?.revision ?? assessment.revision,
    ghost: identity,
    ...(plan.intro ? { intro: plan.intro } : {}),
    steps,
  };
}
