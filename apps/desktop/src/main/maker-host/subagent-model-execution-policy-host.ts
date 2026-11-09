// Desktop Host:按当前会话生成 ModelExecutionPolicySnapshot。
//
// 构成(2026-11-07 取证结论的执行层固化):
//  - allow-list = 用户 bot-model-chain 的路由(按 harness 过滤)+ 当前父路由
//    (正在运行的会话模型,写快照时由调用方传入);
//  - tier 分类是**展示/审核用**的,不是授权信号:local(本地 endpoint) /
//    free OpenRouter 免费模型(模型名带 :free 后缀) / 其余 paid;
//  - approvals 只来自 Host 的用户审批存储(过期即失效,Agent 不能创建);
//  - 任何读取失败返回 undefined → 调用方 fail-closed(不写授权,不派发)。
//
// 判定本身(decideModelExecution)只在 maker-core 的 model-execution-policy.ts
// 里有一份实现;本文件只负责"组装快照",不重复实现规则。
import type {
  AllowedModelRoute,
  ModelExecutionApproval,
  ModelExecutionPolicySnapshot,
  ModelRouteTier,
} from '@cindy/maker-core';
import { readBotModelChainSettings } from './bot-model-chain-settings-store.js';
import { readSubagentModelApprovals } from './subagent-model-approvals-store.js';
import { getDesktopProviderService } from './createDesktopProviderService.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('subagent-model-execution-policy-host');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

export interface ExecutionPolicyContext {
  sessionId: string;
  projectRoot?: string;
  projectId?: string;
  model: string;
  provider: string;
}

function isLocalUpstream(upstream: string | undefined): boolean {
  if (!upstream) return false;
  try {
    const url = new URL(upstream);
    return LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function classifyTier(
  providerId: string,
  modelId: string,
  localProviderIds: ReadonlySet<string>,
): ModelRouteTier {
  if (localProviderIds.has(providerId)) return 'local';
  // OpenRouter 免费模型的命名约定是 ":free" 后缀 —— 只决定 tier 展示,
  // **不**代表授权(免费 ≠ 可执行,见 model-execution-policy.ts 注释)。
  return modelId.endsWith(':free') ? 'free' : 'paid';
}

type ChainRoute = { harness?: string; providerId?: string | null; model?: string };

let chainRequest: { key: string; promise: Promise<{ chain: ReadonlyArray<ChainRoute>; localProviderIds: Set<string> }> } | undefined;

/**
 * 读一次路由链 + 本地 provider 集合,同次并发调用复用在途请求
 * (快照每次 setModel 都要写,避免每次都全量读 provider)。
 */
function readChainAndLocalProviders(): Promise<{ chain: ReadonlyArray<ChainRoute>; localProviderIds: Set<string> }> {
  const key = 'current';
  if (chainRequest?.key === key) return chainRequest.promise;
  const promise = (async () => {
    const settings = await readBotModelChainSettings({ availableAgents: new Set(['pi', 'claude', 'codex']) });
    const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
    const localProviderIds = new Set<string>();
    for (const provider of providers) {
      const upstream = provider.routing?.pi?.upstream ?? provider.routing?.['claude-code']?.upstream;
      if (isLocalUpstream(upstream)) localProviderIds.add(provider.id);
    }
    return { chain: settings.modelChain, localProviderIds };
  })();
  chainRequest = { key, promise };
  promise.finally(() => {
    if (chainRequest?.promise === promise) chainRequest = undefined;
  });
  return promise;
}

function assemblePolicySnapshot(
  chain: ReadonlyArray<ChainRoute>,
  localProviderIds: ReadonlySet<string>,
  approvals: readonly ModelExecutionApproval[],
  context: ExecutionPolicyContext,
  harness: 'pi' | 'claude' | 'codex' | 'any',
): ModelExecutionPolicySnapshot {
  const now = Date.now();
  const allowedRoutes = new Map<string, AllowedModelRoute>();
  for (const route of chain) {
    if (harness !== 'any' && route.harness && route.harness !== harness) continue;
    const providerId = route.providerId ?? 'pi';
    const modelId = route.model;
    if (!providerId.trim() || !modelId?.trim()) continue;
    allowedRoutes.set(`${providerId}\u0000${modelId}`, {
      provider: providerId.trim(),
      model: modelId.trim(),
      tier: classifyTier(providerId.trim(), modelId.trim(), localProviderIds),
    });
  }
  // 当前父路由:这个 session 自己正在用的模型,子代理/Worker 继承它必须能跑。
  if (context.provider.trim() && context.model.trim()) {
    allowedRoutes.set(`${context.provider}\u0000${context.model}`, {
      provider: context.provider.trim(),
      model: context.model.trim(),
      tier: classifyTier(context.provider.trim(), context.model.trim(), localProviderIds),
    });
  }
  // 只下发仍有效的 approval(过期不进快照,避免快照里躺着过期授权)。
  const liveApprovals = approvals.filter((approval) => approval.expiresAt > now && approval.grantedAt <= now);
  return {
    version: 1,
    sessionId: context.sessionId,
    ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
    // 默认 development:链上了 allow-list 的 free 模型可跑;local-only/approved-paid
    // 为后续设置项,先不开放(不发明 UI)。
    mode: 'development',
    allowedRoutes: [...allowedRoutes.values()],
    approvals: liveApprovals,
    issuedAt: now,
  };
}

async function buildSnapshot(
  context: ExecutionPolicyContext,
  harness: 'pi' | 'any',
  label: string,
): Promise<ModelExecutionPolicySnapshot | undefined> {
  try {
    const [{ chain, localProviderIds }, approvals] = await Promise.all([
      readChainAndLocalProviders(),
      readSubagentModelApprovals(),
    ]);
    return assemblePolicySnapshot(chain, localProviderIds, approvals, context, harness);
  } catch (error) {
    log.warn(`${label} execution policy failed; snapshot omitted (fail-closed)`, {
      sessionId: context.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Pi subagent 侧:只认 harness=pi 的链上路由。 */
export async function resolveDesktopPiSubagentModelExecutionPolicy(
  context: ExecutionPolicyContext,
): Promise<ModelExecutionPolicySnapshot | undefined> {
  return buildSnapshot(context, 'pi', 'pi subagent');
}

/** Orca Worker 创建侧同口径授权:任一 harness 的链上路由 + 当前父路由 + 有效 approvals。 */
export async function resolveDesktopOrcaWorkerModelExecutionPolicy(
  context: ExecutionPolicyContext,
): Promise<ModelExecutionPolicySnapshot | undefined> {
  return buildSnapshot(context, 'any', 'orca worker');
}
