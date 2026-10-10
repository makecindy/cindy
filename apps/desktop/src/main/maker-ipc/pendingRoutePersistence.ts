import type { Effort } from '@cindy/maker-core';
import type { CatalogModel } from '@cindy/model-providers';

import { isSupportedRuntimeEffort } from './runtimeSelectionAxes.js';
import { resolveSessionRuntimeAxes } from './sessionRuntimeControl.js';

/**
 * pendingRoutePersistence —— pending 凭证切换收口 / 回滚时 sessions 行路由补丁的
 * 纯计算（生产接线是 register.ts 里 PendingCredentialSwitchService 的 persistRoute）。
 *
 * 抽成纯函数的原因：register.ts 的闭包无法脱离 Electron / SQLite 直接回归测试，
 * 而这里藏着一条会冻结会话队列的约束 —— sessions.effort 是 NOT NULL。固定档位
 * 目录模型（efforts = []，如未配置推理档位的自定义供应商模型）经
 * resolveSessionRuntimeAxes 收敛出的 effort 是 null，null 只代表「该模型没有
 * 推理轴」，绝不能写进 DB：2026-10 实测回滚到固定档位模型时 effort:null 落库
 * 触发 `NOT NULL constraint failed: sessions.effort`，回滚失败让会话输入队列
 * 永久冻结（queue remains gated），只能重启 App 恢复。
 */

/** persistRoute 的入参路由（收口裁决后或回滚用的 previousRoute）。 */
export interface PendingRoutePersistTarget {
  providerId: string | null;
  model?: string;
  effort?: string;
  fastMode?: boolean;
}

export interface PendingRoutePatchInput {
  /** 要落地的目标路由。 */
  route: PendingRoutePersistTarget;
  /** sessions 行现值（renderer 已按请求值预写）；undefined = 行已不存在。 */
  currentRow: { model: string; effort: string; fastMode: boolean } | undefined;
  /** register 时捕获的切换前路由；route 与它一致 = 回滚，优先恢复其轴向值。 */
  previousRoute?:
    | { model: string; providerId: string | null; effort?: string; fastMode?: boolean }
    | undefined;
  /** 目录模型（调用方经 provider 目录解析）；找到才做轴向收敛。 */
  catalogModel?: CatalogModel | undefined;
  /** 已核验的上下文窗口；仅 route.model 存在且 agentKind 已知时由调用方提供。 */
  verifiedWindow?: number | null | undefined;
}

export interface PendingRoutePatch {
  /** 可直接喂给 drizzle update 的补丁；永不含值为 null 的 effort 键。 */
  patch: Record<string, unknown>;
  /** 收敛后的内存 effort（null = 固定档位 / 无有效值，store 侧清除即走默认）。 */
  effort: Effort | null;
  fastMode: boolean;
}

/**
 * 计算 sessions 路由补丁。轴向取值顺序与原闭包一致：
 * 回滚（route == previousRoute）优先恢复 previousRoute 捕获值；否则沿用 DB 现值；
 * 行已删除时退化为 route 自带值。目录模型在场时再经 resolveSessionRuntimeAxes
 * 按目录能力收敛（无效档位回落 defaultEffort / 最近档，固定档位模型得 null）。
 *
 * 唯一的语义修正：effort 收敛为 null 时**省略** patch 里的 effort 键，保留行内
 * 现有非空值（NOT NULL 约束），而不是把 null 写进去。对固定档位模型该列本就
 * 无意义，且 resume 时仍按目录收敛为 null，省略不丢失任何可恢复状态；用户切回
 * 推理模型时行内保留的档位偏好还能继续生效。
 */
export function buildPendingRoutePatch(input: PendingRoutePatchInput): PendingRoutePatch {
  const { route, currentRow, catalogModel, verifiedWindow } = input;
  const previousRoute = input.previousRoute ?? undefined;
  const restoringPreviousRoute =
    !!route.model &&
    route.model === previousRoute?.model &&
    route.providerId === previousRoute.providerId;
  let effort: Effort | null =
    restoringPreviousRoute && route.effort && isSupportedRuntimeEffort(route.effort)
      ? route.effort
      : isSupportedRuntimeEffort(currentRow?.effort)
        ? currentRow.effort
        : !currentRow && route.effort && isSupportedRuntimeEffort(route.effort)
          ? route.effort
          : null;
  let fastMode =
    restoringPreviousRoute && route.fastMode !== undefined
      ? route.fastMode
      : currentRow
        ? currentRow.fastMode === true
        : route.fastMode === true;
  if (catalogModel) {
    const axes = resolveSessionRuntimeAxes({
      model: catalogModel,
      effort,
      fastMode,
      effortExplicit: false,
      fastExplicit: false,
    });
    if (axes.ok) {
      effort = axes.effort;
      fastMode = axes.fastMode;
    }
  }
  const patch: Record<string, unknown> = {
    providerId: route.providerId,
    fastMode,
    // 见文件头：effort 为 null 时省略该键，保留行内现有非空值（NOT NULL 约束）。
    ...(effort ? { effort } : {}),
  };
  if (route.model) patch.model = route.model;
  if (route.model && verifiedWindow) patch.contextWindow = verifiedWindow;
  return { patch, effort, fastMode };
}
