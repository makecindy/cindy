import type { CodexContextWindowInfo, Logger } from '@cindy/maker-core';
import { MAKER_INVOKE } from '@cindy/maker-shared/maker-channels';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import type { ModelPriceOverrideTarget } from './modelPriceOverride.js';
import type { createModelPreferenceTargets, createModelPreferenceQueue } from './modelPreferenceTargets.js';
import type { createProviderOwnerGuards } from './providerOwnerGuards.js';
export interface ModelContextLimitView {mixed?: boolean; limit: number | null; isCustomized: boolean;}
export interface ModelContextHandlerDeps {
  readCodexContextWindowInfo?(target: ModelPriceOverrideTarget, sessionId?: string): Promise<CodexContextWindowInfo | null>;
  readModelContextLimit?(target: ModelPriceOverrideTarget): ModelContextLimitView;
  validateModelContextLimit?(targets: readonly ModelPriceOverrideTarget[], limit: number): Promise<void>;
  writeModelContextLimit?(targets: readonly ModelPriceOverrideTarget[], limit: number | null): void | Promise<void>;
}
export function registerModelContextHandlers(registry: IpcHandlerRegistry, deps: ModelContextHandlerDeps,
 host: ReturnType<typeof createModelPreferenceTargets> & ReturnType<typeof createProviderOwnerGuards> & {
  log: Pick<Logger, 'warn'>;
  assertTrustedProviderMutationSender(event: unknown): void;
  enqueuePriceMutation: ReturnType<typeof createModelPreferenceQueue>;
  withProviderConfigMutation<T>(providerId: string, run: () => Promise<T>): Promise<T>;
 }) {
const {parsePriceTarget, requirePriceTargetModel, captureProviderOwnerSession, assertProviderMutationOwner,
 assertRequestedProviderOwner, log, assertTrustedProviderMutationSender, enqueuePriceMutation, withProviderConfigMutation} = host;
  const parseContextTargets = (input: unknown): ModelPriceOverrideTarget[] => {
    const target = parsePriceTarget(input);
    const related = (input as { relatedTargets?: unknown }).relatedTargets;
    if (related === undefined) return [target];
    if (!Array.isArray(related) || related.length > 2) {
      throwIpcError('INVALID_PARAMS', 'invalid related context targets');
    }
    const targets = [target, ...related.map(parsePriceTarget)];
    if (targets.some((t) => t.providerId !== target.providerId) ||
        new Set(targets.map((t) => t.agent)).size !== targets.length) {
      throwIpcError('INVALID_PARAMS', 'context targets must name distinct harnesses of one provider');
    }
    return targets;
  };
  const assertContextOwner = (input: unknown): void => {
    const owner = input as { dataOwnerId?: unknown; ownerGeneration?: unknown } | null;
    if (!owner || (owner.dataOwnerId !== null && typeof owner.dataOwnerId !== 'string') ||
        !Number.isInteger(owner.ownerGeneration) || (owner.ownerGeneration as number) < 0) {
      throwIpcError('INVALID_PARAMS', 'context mutation requires an owner stamp');
    }
    assertRequestedProviderOwner(owner.dataOwnerId as string | null, owner.ownerGeneration as number);
  };
  const readContextTargets = (targets: ModelPriceOverrideTarget[]): ModelContextLimitView => {
    const { read } = requireContextLimitDeps();
    const views = targets.map(read);
    return {
      limit: views.find((v) => v.limit !== null)?.limit ?? null,
      isCustomized: views.some((v) => v.isCustomized),
      mixed: views.some((v) => v.limit !== views[0]!.limit),
    };
  };
  const requireContextLimitDeps = (): {
    read: NonNullable<ModelContextHandlerDeps['readModelContextLimit']>;
    write: NonNullable<ModelContextHandlerDeps['writeModelContextLimit']>;
  } => {
    if (!deps.readModelContextLimit || !deps.writeModelContextLimit) {
      throwIpcError('INTERNAL', 'model context limit override is not wired');
    }
    return { read: deps.readModelContextLimit, write: deps.writeModelContextLimit };
  };

  registry.handle(MAKER_INVOKE.MODEL_CONTEXT_LIMIT_GET, async (event, input: unknown) => {
    assertTrustedProviderMutationSender(event);
    const targets = parseContextTargets(input);
    // 读不做目录成员校验:目录漂移后 UI 仍要能显示并清掉指向已下架 id 的陈旧 override。
    const view = readContextTargets(targets);
    if (targets.length === 1 && targets[0]!.agent === 'codex') {
      const sessionId = (input as { sessionId?: unknown }).sessionId;
      if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200)) {
        throwIpcError('INVALID_PARAMS', 'invalid context session id');
      }
      return { ...view, codexContext: await deps.readCodexContextWindowInfo?.(targets[0]!, sessionId as string | undefined) ?? null };
    }
    return view;
  });

  registry.handle(
    MAKER_INVOKE.MODEL_CONTEXT_LIMIT_SET,
    async (event, targetInput: unknown, limitInput: unknown, ownerInput: unknown) => {
      assertTrustedProviderMutationSender(event);
      assertContextOwner(ownerInput);
      const targets = parseContextTargets(targetInput);
      const target = targets[0]!;
      const { write } = requireContextLimitDeps();
      // null = 恢复默认(删 override)。数值只挡「不是可用 token 数」这一类形状错误;
      // **不 clamp 到模型窗口** —— 路由把窗口配错时用户得能强行往上填(UI 侧给警示)。
      if (
        limitInput !== null &&
        (typeof limitInput !== 'number' || !Number.isSafeInteger(limitInput) || limitInput < 1_000 || limitInput > 100_000_000)
      ) {
        throwIpcError('INVALID_PARAMS', 'context limit must be a positive number or null');
      }
      const limit = limitInput as number | null;
      const ownerAtIngress = captureProviderOwnerSession();
      return withProviderConfigMutation(target.providerId, () =>
        enqueuePriceMutation(async () => {
          // 写入才校验目标在目录里:挡「合法长度但不存在的 id」被批量预埋进这份
          // 无界 key-value 文件(与停用轴同一条防线)。
          if (limit !== null) for (const t of targets) await requirePriceTargetModel(t);
          if (limit !== null) await deps.validateModelContextLimit?.(targets, limit);
          assertProviderMutationOwner(
            ownerAtIngress,
            'active account changed before persisting context limit override',
          );
          try {
            await write(targets, limit);
          } catch (err) {
            log.warn('model context limit persist failed', {
              providerId: target.providerId,
              agent: target.agent,
              modelId: target.modelId,
              error: err instanceof Error ? err.message : String(err),
            });
            throwIpcError('INTERNAL', 'failed to persist model context limit');
          }
          return readContextTargets(targets);
        }),
      );
    },
  );

  registry.handle(
    MAKER_INVOKE.MODEL_CONTEXT_LIMIT_RESET,
    async (event, input: unknown, ownerInput: unknown) => {
      assertTrustedProviderMutationSender(event);
      assertContextOwner(ownerInput);
      const targets = parseContextTargets(input);
      const target = targets[0]!;
      const { write } = requireContextLimitDeps();
      const ownerAtIngress = captureProviderOwnerSession();
      return withProviderConfigMutation(target.providerId, () =>
        enqueuePriceMutation(async () => {
          assertProviderMutationOwner(
            ownerAtIngress,
            'active account changed before resetting context limit override',
          );
          try {
            await write(targets, null);
          } catch (err) {
            log.warn('model context limit reset failed', {
              providerId: target.providerId,
              agent: target.agent,
              modelId: target.modelId,
              error: err instanceof Error ? err.message : String(err),
            });
            throwIpcError('INTERNAL', 'failed to reset model context limit');
          }
          return readContextTargets(targets);
        }),
      );
    },
  );

}
