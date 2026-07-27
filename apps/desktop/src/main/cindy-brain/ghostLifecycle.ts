/**
 * ghostLifecycle —— 插件生命周期统一投影(纯函数层)。
 *
 * 单一事实源策略:不迁移任何现有存储(`.disabled` 标记、workdir prefs、
 * 保险库、OAuth 账号表、runtime 状态机各自仍是真身),这里只做**读取聚合**,
 * 把「安装 / 启用 / 就绪」三维状态投影成一个 readiness 枚举 + 派生视图,
 * 供 agent 发现层(花名册 / ghost_list)、插件页 UI、scheduler 能力警示
 * 统一消费——消灭「装了未配置却被 agent 当作可用」的口径分叉。
 *
 * 判定全同步、不缓存(探针底层是文件存在性 / 内存清单读取),调用方现查。
 * 评估失败不折叠成 ready:readiness = 'unknown' 且不可调用,与
 * 「setup 字段缺失 ≠ ready」的协议契约同向。
 */

import type { GhostRuntimeState } from './runtime/GhostRuntime.js';
import type { GhostSetupAssessment } from '../../shared/ghost.js';
import type { GhostLifecycleEntry, GhostReadiness } from '../../shared/ghostLifecycle.js';

export type { GhostLifecycleEntry, GhostReadiness };

/** 投影输入:每个已安装插件一份事实快照(由调用方从各存储真身现查)。 */
export interface GhostLifecycleFacts {
  id: string;
  name: string;
  enabled: boolean;
  accountAvailable: boolean;
  runtimeState?: GhostRuntimeState;
  /** 配置评估结果;评估抛错由调用方捕获后传 Error。 */
  assessment: GhostSetupAssessment | Error;
}

export interface LifecycleProbes {
  isAccountAvailable(id: string): boolean;
  runtimeStateOf(id: string): GhostRuntimeState | undefined;
  assess(id: string): GhostSetupAssessment;
}

/** 单插件投影:优先级 blocked > degraded > unknown > reauth > setup > ready。 */
export function projectGhostLifecycle(facts: GhostLifecycleFacts): GhostLifecycleEntry {
  const base = { id: facts.id, name: facts.name, enabled: facts.enabled };
  if (!facts.accountAvailable) {
    return { ...base, readiness: 'blocked' };
  }
  if (facts.runtimeState === 'crashed' || facts.runtimeState === 'fused') {
    return { ...base, readiness: 'degraded', runtimeState: facts.runtimeState };
  }
  if (facts.assessment instanceof Error) {
    return { ...base, readiness: 'unknown' };
  }
  const assessment = facts.assessment;
  if (assessment.state === 'ready') {
    return { ...base, readiness: 'ready' };
  }
  const hasExpired = assessment.groups.some((group) =>
    group.items.some((item) => item.state === 'expired'),
  );
  return {
    ...base,
    readiness: hasExpired ? 'needs_reauth' : 'needs_setup',
    setup: assessment,
  };
}

/** 批量投影:逐个插件独立判定,单插件评估失败不拖垮整份清单。 */
export function projectGhostLifecycles(
  ghosts: readonly { id: string; name: string; enabled: boolean }[],
  probes: LifecycleProbes,
  onAssessmentError?: (id: string, error: unknown) => void,
): GhostLifecycleEntry[] {
  return ghosts.map((ghost) => {
    let assessment: GhostLifecycleFacts['assessment'];
    try {
      assessment = probes.assess(ghost.id);
    } catch (error) {
      assessment = error instanceof Error ? error : new Error(String(error));
      onAssessmentError?.(ghost.id, error);
    }
    return projectGhostLifecycle({
      id: ghost.id,
      name: ghost.name,
      enabled: ghost.enabled,
      accountAvailable: probes.isAccountAvailable(ghost.id),
      runtimeState: probes.runtimeStateOf(ghost.id),
      assessment,
    });
  });
}

/** 派生视图:agent 可发现 = 全局启用 + 未 workdir 停用 + 非 blocked。 */
export function isDiscoverable(entry: GhostLifecycleEntry, workdirDisabled: boolean): boolean {
  return entry.enabled && !workdirDisabled && entry.readiness !== 'blocked';
}

/** 派生视图:agent 可调用 = 可发现 + 就绪。 */
export function isCallable(entry: GhostLifecycleEntry, workdirDisabled: boolean): boolean {
  return isDiscoverable(entry, workdirDisabled) && entry.readiness === 'ready';
}

/** readiness 的人话摘要(给 agent 的发现层条目用;UI 徽章走 i18n,不复用此表)。 */
export function readinessSummary(entry: GhostLifecycleEntry): string | null {
  switch (entry.readiness) {
    case 'needs_setup':
      return '需要完成配置后才能使用;正确动作是发起配置引导,不要盲调。';
    case 'needs_reauth':
      return '授权已过期,需要重新连接;正确动作是发起重新授权引导,不要盲调。';
    case 'degraded':
      return '插件运行异常(崩溃或已熔断);请引导用户到插件页重载,不要重试调用。';
    case 'unknown':
      return '配置状态暂时无法判定;请引导用户到插件页检查该插件状态,不要盲调。';
    default:
      return null;
  }
}
