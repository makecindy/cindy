/**
 * script-capability-status — script 任务能力的运行时可用性探测(纯函数)
 * ---------------------------------------------------------------------------
 * 能力**目录**是静态白名单(@cindy/maker-scheduler 的 SCRIPT_CAPABILITIES,授权
 * 语义、任务的持久配置);本模块解决的是另一半——**可用性**(瞬时状态):jira.*
 * 走 xd-atlassian 意识,意识未装入 / 沉睡时任务触发必失败。表单在能力选择器里
 * 按本探测结果标注警示,但**不过滤清单**——建任务时的意识状态不代表任务运行时
 * 的状态,藏掉选项会挡住"先建任务、稍后唤醒意识"的正常路径。
 */
import { SCRIPT_CAPABILITIES, type ScriptCapability } from '@cindy/maker-scheduler';

/**
 * 能力 → 依赖意识 id。只登记有意识依赖的能力;不在表内 = host 原生实现,恒可用
 * (如 sessions.dispatch 直接走 maker-ipc 的 orca collab service)。
 * 与 script-capability-broker.ts 的实际调用路径保持一致——broker 换实现时同步改这里。
 */
const CAPABILITY_GHOST_DEPS: Partial<Record<ScriptCapability, string>> = {
  'jira.read': 'xd-atlassian',
  'jira.comment': 'xd-atlassian',
  // 2026-07-17:主机飞书 token 链退役,feishu.* 改走 xd-feishu 意识 ghost pipe。
  'feishu.read': 'xd-feishu',
};

export type ScriptCapabilityRuntimeState = 'ok' | 'ghost-missing' | 'ghost-asleep';

export interface ScriptCapabilityStatus {
  capability: ScriptCapability;
  state: ScriptCapabilityRuntimeState;
  /** 依赖意识的显示名(未装入时回退 id),仅 state != 'ok' 时对提示文案有用。 */
  ghostName?: string;
}

export interface GhostStateSnapshot {
  id: string;
  name: string;
  /** InstalledGhost.enabled:false = 沉睡(能力不注册,broker 调用会失败)。 */
  enabled: boolean;
}

export function resolveScriptCapabilityStatuses(
  ghosts: readonly GhostStateSnapshot[],
): ScriptCapabilityStatus[] {
  return SCRIPT_CAPABILITIES.map((capability) => {
    const depId = CAPABILITY_GHOST_DEPS[capability];
    if (!depId) return { capability, state: 'ok' as const };
    const ghost = ghosts.find((g) => g.id === depId);
    if (!ghost) return { capability, state: 'ghost-missing' as const, ghostName: depId };
    if (!ghost.enabled) return { capability, state: 'ghost-asleep' as const, ghostName: ghost.name };
    return { capability, state: 'ok' as const };
  });
}
