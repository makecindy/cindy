// Desktop Host:按当前会话生成 ModelExecutionPolicySnapshot。
//
// 构成(2026-11-07 取证结论的执行层固化):
//  - allow-list = 用户 bot-model-chain 的路由(按 harness 过滤)+ 当前父路由
//    (正在运行的会话模型,写快照时由调用方传入);
//  - tier 分级(P0-1/P0-2 修正版):
//      local  = provider 注册在本地 catalog **且**其 endpoint 经验证指向本机
//               (loopback 或本机网卡地址 —— 不是「所有私有 IP 都算本地」);
//      free   = provider 从目录交回的**零价格**模型(当前是 OpenRouter/Vercel
//               模型发现给的 discoveredCost);价格未知一律归 paid,绝不推断零;
//      paid   = 其余。free 只是分级,**不**代表授权 —— free 在 local-only 下仍拒绝。
//  - mode 由用户设置决定(默认 approved-paid);涉及私人数据的 session / project
//    强制 local-only(P1-6);
//  - 快照用 Host signing key 签名(P1-8),扩展/runner 派发前验证;
//  - approvals 只来自 Host 的用户审批存储(过期即失效,Agent 不能创建);
//  - 任何读取失败返回 undefined → 调用方 fail-closed(不写授权,不派发)。
//
// 判定本身(decideModelExecution)只在 maker-core 的 model-execution-policy.ts
// 里有一份实现;本文件只负责"组装快照",不重复实现规则。
import os from 'node:os';
import type {
  AllowedModelRoute,
  ModelExecutionApproval,
  ModelExecutionPolicySnapshot,
  ModelRouteTier,
} from '@cindy/maker-core';
import { signExecutionPolicySnapshot, parseModelExecutionPolicy } from '@cindy/maker-core';
import { readBotModelChainSettings } from './bot-model-chain-settings-store.js';
import { readSubagentModelApprovals } from './subagent-model-approvals-store.js';
import { readSubagentModelExecutionSettings, isSessionForcedLocalOnly } from './subagent-model-execution-settings-store.js';
import type { TrustedLanEntry } from './subagent-model-execution-settings-store.js';
import { getOrCreateSubagentModelSigningKey } from './subagent-model-signing-key-store.js';
import { getDesktopProviderService } from './createDesktopProviderService.js';
import { desktopMakerLogger } from './logger-adapter.js';

const log = desktopMakerLogger.child('subagent-model-execution-policy-host');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

let ownAddressCache: { at: number; addresses: ReadonlySet<string> } | undefined;

/**
 * 本机网卡地址集合(排除 loopback,这些由 LOOPBACK_HOSTS 单独覆盖)。
 * 30 秒 TTL:地址DHCP变化不会长期滞留,但批量组装快照时不重复取值。
 */
function machineOwnAddresses(): ReadonlySet<string> {
  const now = Date.now();
  if (!ownAddressCache || now - ownAddressCache.at > 30_000) {
    const addresses = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const entry of list ?? []) {
        if (entry && !entry.internal && entry.address) addresses.add(entry.address.toLowerCase());
      }
    }
    ownAddressCache = { at: now, addresses };
  }
  return ownAddressCache.addresses;
}

/**
 * 经验证的本地执行端点:URL 主机是 loopback,或者是**当前这台机器自己的**网卡
 * 地址。私有 IP 本身不是本地 —— LAN 上另一台机器的 endpoint 只在这台机器的网卡
 * 表里才成立;远程机器的 192.168.x.x 不会命中,不被误判 local。
 */
export function isVerifiedLocalEndpoint(upstream: string | undefined): boolean {
  if (!upstream) return false;
  try {
    const host = new URL(upstream).hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(host)) return true;
    return machineOwnAddresses().has(host);
  } catch {
    return false;
  }
}

type ModelCostLike = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

function isProviderDeclaredFree(cost: ModelCostLike | undefined): boolean {
  if (!cost) return false;
  const parts = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].filter(
    (part): part is number => typeof part === 'number' && Number.isFinite(part),
  );
  // 至少存在一个价格分量且全部为 0(免费模型是 provider 声明的零价,
  // 不是我们猜的)。未知价格(cost 缺失或分量缺失)绝不推断为免费。
  return parts.length > 0 && parts.every((part) => part === 0);
}

function endpointOrigin(upstream: string | undefined): string | null {
  if (!upstream) return null;
  try {
    const url = new URL(upstream);
    return url.origin;
  } catch {
    return null;
  }
}

function isTrustedLanRoute(
  providerId: string,
  modelId: string,
  upstream: string | undefined,
  trustedLan: ReadonlyArray<TrustedLanEntry>,
): boolean {
  if (trustedLan.length === 0) return false;
  const origin = endpointOrigin(upstream);
  if (!origin) return false;
  return trustedLan.some((entry) =>
    entry.provider === providerId && entry.endpoint === origin && entry.models.includes(modelId),
  );
}

function classifyTier(
  providerId: string,
  modelId: string,
  localProviderIds: ReadonlySet<string>,
  modelCosts: ReadonlyMap<string, ModelCostLike | undefined>,
  upstream?: string,
  trustedLan?: ReadonlyArray<TrustedLanEntry>,
): ModelRouteTier {
  if (localProviderIds.has(providerId)) return 'local';
  if (trustedLan && isTrustedLanRoute(providerId, modelId, upstream, trustedLan)) return 'trusted-lan';
  return isProviderDeclaredFree(modelCosts.get(`${providerId}\u0000${modelId}`)) ? 'free' : 'paid';
}

export interface ExecutionPolicyContext {
  sessionId: string;
  projectRoot?: string;
  projectId?: string;
  model: string;
  provider: string;
  /** 当前会话模型在 provider 目录中的来源 id(可能与 runtime provider 名不同)。 */
  sourceProviderId?: string;
}

type ChainRoute = { harness?: string; providerId?: string | null; model?: string };

interface ProviderContext {
  chain: ReadonlyArray<ChainRoute>;
  localProviderIds: Set<string>;
  modelCosts: Map<string, ModelCostLike | undefined>;
  upstreamByProvider: Map<string, string>;
}

let chainRequest: { key: string; promise: Promise<ProviderContext> } | undefined;

/**
 * 读一次路由链 + 本地 provider 集合 + 模型价格表,同次并发调用复用在途请求
 * (快照每次 setModel 都要写,避免每次都全量读 provider)。
 */
function readChainProviderContext(): Promise<ProviderContext> {
  const key = 'current';
  if (chainRequest?.key === key) return chainRequest.promise;
  const promise = (async () => {
    const settings = await readBotModelChainSettings({ availableAgents: new Set(['pi', 'claude', 'codex']) });
    const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
    const localProviderIds = new Set<string>();
    const modelCosts = new Map<string, ModelCostLike | undefined>();
    const upstreamByProvider = new Map<string, string>();
    for (const provider of providers) {
      const upstream = provider.routing?.pi?.upstream ?? provider.routing?.['claude-code']?.upstream;
      if (upstream) upstreamByProvider.set(provider.id, upstream);
      if (isVerifiedLocalEndpoint(upstream)) localProviderIds.add(provider.id);
      for (const agent of Object.keys(provider.models ?? {}) as Array<'pi' | 'claude' | 'codex'>) {
        for (const model of provider.models[agent] ?? []) {
          if (model.cost) modelCosts.set(`${provider.id}\u0000${model.id}`, model.cost);
        }
      }
    }
    return { chain: settings.modelChain, localProviderIds, modelCosts, upstreamByProvider };
  })();
  chainRequest = { key, promise };
  promise.finally(() => {
    if (chainRequest?.promise === promise) chainRequest = undefined;
  });
  return promise;
}

function assembleAllowedRoutes(
  chain: ReadonlyArray<ChainRoute>,
  parent: ExecutionPolicyContext,
  harness: 'pi' | 'claude' | 'codex' | 'any',
  localProviderIds: ReadonlySet<string>,
  modelCosts: ReadonlyMap<string, ModelCostLike | undefined>,
  upstreamByProvider?: ReadonlyMap<string, string>,
  trustedLan?: ReadonlyArray<TrustedLanEntry>,
): AllowedModelRoute[] {
  const allowedRoutes = new Map<string, AllowedModelRoute>();
  for (const route of chain) {
    if (harness !== 'any' && route.harness && route.harness !== harness) continue;
    const providerId = route.providerId ?? 'pi';
    const modelId = route.model;
    if (!providerId.trim() || !modelId?.trim()) continue;
    // 链路由的 providerId 就是来源 id:source 显式写出,拒绝检查时做精确归属匹配。
    allowedRoutes.set(`${providerId}\u0000${modelId}`, {
      provider: providerId.trim(),
      model: modelId.trim(),
      sourceProviderId: providerId.trim(),
      tier: classifyTier(providerId.trim(), modelId.trim(), localProviderIds, modelCosts, upstreamByProvider?.get(providerId.trim()), trustedLan),
    });
  }
  // 当前父路由:这个 session 自己正在用的模型,子代理/Worker 继承它必须能跑。
  // runtime provider 名与来源 id 两种 id 形态各加一条(取决于调用方用哪种 id
  // 表示 provider):pi 子代理用 runtime 名,Orca Worker 用来源 id。
  const parentSource = parent.sourceProviderId?.trim() || parent.provider.trim();
  if (parent.provider.trim() && parent.model.trim()) {
    const tier = classifyTier(parent.provider.trim(), parent.model.trim(), localProviderIds, modelCosts, upstreamByProvider?.get(parent.provider.trim()), trustedLan);
    allowedRoutes.set(`${parent.provider}\u0000${parent.model}`, {
      provider: parent.provider.trim(),
      model: parent.model.trim(),
      sourceProviderId: parentSource,
      tier,
    });
    if (parentSource && parentSource !== parent.provider.trim()) {
      allowedRoutes.set(`${parentSource}\u0000${parent.model}`, {
        provider: parentSource,
        model: parent.model.trim(),
        sourceProviderId: parentSource,
        tier,
      });
    }
  }
  return [...allowedRoutes.values()];
}

async function buildSnapshot(
  context: ExecutionPolicyContext,
  harness: 'pi' | 'claude' | 'codex' | 'any',
  label: string,
): Promise<ModelExecutionPolicySnapshot | undefined> {
  try {
    const [{ chain, localProviderIds, modelCosts, upstreamByProvider }, approvals, settings] = await Promise.all([
      readChainProviderContext(),
      readSubagentModelApprovals(),
      readSubagentModelExecutionSettings(),
    ]);
    const now = Date.now();
    // 私人数据强制 local-only:设置里的 mode 对这类会话不生效。
    const forcedLocalOnly = isSessionForcedLocalOnly(settings, context);
    const mode = forcedLocalOnly ? 'local-only' : settings.mode;
    const allowedRoutes = assembleAllowedRoutes(chain, context, harness, localProviderIds, modelCosts, upstreamByProvider, settings.trustedLan ?? []);
    // 只下发仍有效的 approval(过期不进快照,避免快照里躺着过期授权)。
    const liveApprovals = approvals.filter((approval) => approval.expiresAt > now && approval.grantedAt <= now);
    const unsigned: ModelExecutionPolicySnapshot = {
      version: 1,
      sessionId: context.sessionId,
      ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
      mode,
      allowedRoutes,
      approvals: liveApprovals,
      issuedAt: now,
    };
    // 快照在 pi 扩展 / durable runner 中按 parseModelExecutionPolicy 归一化后再验签,
    // 故签发前先归一化,保证签出的对象与验签的对象字节级一致(P1-8)。
    const parsed = parseModelExecutionPolicy(unsigned);
    if (!parsed) return undefined;
    // 授权判断只在可信 Host 边界(Desktop 主进程)做出:私钥只在此处使用(P0-B)。
    const { secretKey } = getOrCreateSubagentModelSigningKey();
    return { ...parsed, signature: signExecutionPolicySnapshot(parsed, secretKey) };
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

/** Claude Code 逐调用授权:同口径快照,claude 链上路由 + 当前父路由。 */
export async function resolveDesktopClaudeSubagentModelExecutionPolicy(
  context: ExecutionPolicyContext,
): Promise<ModelExecutionPolicySnapshot | undefined> {
  return buildSnapshot(context, 'claude', 'claude subagent');
}

/** Codex 授权快照(当前 Codex 默认固定继承,不做跨模型派发):同口径,codex 链上路由。 */
export async function resolveDesktopCodexSubagentModelExecutionPolicy(
  context: ExecutionPolicyContext,
): Promise<ModelExecutionPolicySnapshot | undefined> {
  return buildSnapshot(context, 'codex', 'codex subagent');
}
