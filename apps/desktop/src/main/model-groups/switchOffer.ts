/**
 * 撞配额时的「换到下一个来源继续」提议(model-groups.md §6.1)。只回答「同一条路线里现在还有谁能接着用」，
 * 不切换、不排时、不重试，也不推进「轮流」的位置或记一次选择；用户点了才走选择器同一条换模型路径。
 * 纯函数，所有事实由调用方注入。
 */
import {
  modelGroupCandidateKey,
  type ModelGroupAgentKind,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupSwitchOffer,
} from '../../shared/modelGroups.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from './pick.js';
import { modelGroupRouteFor } from './routeFor.js';
import type { ModelGroupSessionBinding } from './sessionBindings.js';

/** 会话行里判断「是不是本机的普通任务」与「现在用着谁」要用的几列。 */
export interface ModelGroupSwitchOfferSessionRow {
  source?: string | null;
  agentKind?: string | null;
  providerId?: string | null;
  model?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  orcaRole?: string | null;
}

export interface ModelGroupSwitchOfferDeps {
  readBinding(sessionId: string): ModelGroupSessionBinding | null;
  clearBinding(sessionId: string): void;
  readSession(sessionId: string): Promise<ModelGroupSwitchOfferSessionRow | null>;
  /** 正在共享给别的账号。 */
  isShared(sessionId: string): boolean;
  /** 这个任务有目标(目标模式自己管撞限额后的续跑)。 */
  hasGoal(sessionId: string): Promise<boolean>;
  config(): ModelGroupsConfig;
  candidateFacts(route: ModelGroupRoute): Promise<ModelGroupCandidateFacts[]>;
  now(): number;
}

function isModelGroupAgentKind(value: unknown): value is ModelGroupAgentKind {
  return value === 'cc' || value === 'codex' || value === 'pi';
}

/**
 * 只给本机直接开的普通任务：伙伴、定时与自动化、IM、复核等来源，SSH、Agent 在另一台电脑、协同
 * (Lead / Worker)、共享中的任务与目标都不提议。被控电脑上的任务由那台的主进程回答，本机查不到会话行。
 */
function isPlainLocalTask(row: ModelGroupSwitchOfferSessionRow): boolean {
  return row.source === 'desktop' && !row.remoteHostId && !row.agentDeviceId && !row.orcaRole;
}

export async function computeModelGroupSwitchOffer(
  deps: ModelGroupSwitchOfferDeps,
  sessionId: string,
): Promise<ModelGroupSwitchOffer | null> {
  const binding = deps.readBinding(sessionId);
  if (!binding) return null;
  const row = await deps.readSession(sessionId);
  if (!row || !isPlainLocalTask(row) || deps.isShared(sessionId) || await deps.hasGoal(sessionId)) return null;
  if (!isModelGroupAgentKind(row.agentKind) || !row.providerId || !row.model) return null;
  // 任务此刻的运行位置(只给本机任务提议，所以这里总是本机)；记录里的候选键同样带位置。
  const location = row.agentDeviceId || undefined;
  const current = { agentKind: row.agentKind, providerId: row.providerId, model: row.model, agentDeviceId: location };
  if (modelGroupCandidateKey(current) !== binding.pickedKey) {
    // 模型或来源已被换过(用户自己换的，或别处换的)：这个任务不再按模型组走。
    deps.clearBinding(sessionId);
    return null;
  }
  const now = deps.now();
  const target = modelGroupRouteFor(deps.config(), binding.selection, now);
  if (target.outcome === 'missing') return null;
  const { route } = target;
  // 同一个供应商连接是同一个账号、同一份配额：一并跳过，连同正在用的这个。
  // 在别的位置运行的来源也跳过：把运行中的任务挪到另一台电脑不是这个提议做的事。
  const eligible: ModelGroupRoute = {
    ...route,
    candidates: route.candidates.map((candidate) => (candidate.agentDeviceId !== location || candidate.providerId === current.providerId
      ? { ...candidate, off: true }
      : candidate)),
  };
  if (!eligible.candidates.some((candidate) => !candidate.off)) return null;
  // 跳过的来源(含别的位置上的)已标成停用，不为它们去读别处的目录。
  const facts = await deps.candidateFacts(eligible);
  // 「轮流」从正在用的这个往后数；不读也不改新任务用的轮流位置。
  const picked = pickModelGroupCandidate(eligible, facts, { now, lastPickedKey: binding.pickedKey });
  if (picked.index === null) return null;
  const entry = picked.trace[picked.index];
  // 能用的都撞了上限时 pick 仍会选最早恢复的那个(带 limitedUntilMs)；换过去一样要等，不提议。
  if ('limitedUntilMs' in entry) return null;
  const candidate = route.candidates[picked.index];
  return {
    groupName: target.groupName,
    selection: binding.selection,
    agentKind: candidate.agentKind,
    providerId: candidate.providerId,
    model: candidate.model,
    modelName: entry.modelName,
    sourceName: entry.sourceName,
    crossEngine: candidate.agentKind !== current.agentKind,
  };
}
