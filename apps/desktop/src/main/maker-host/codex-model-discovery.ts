/**
 * codex-model-discovery —— 从 codex 的 `models_cache.json` 派生出规范化的 Codex 模型快照。
 * active-catalog 再把同一份快照投影到 Codex 与 Claude bridge,避免两边名称、排序各维护一套。
 *
 * 数据源:codex app-server / CLI 维护的 `<codexHome>/models_cache.json`(与 live 端点
 * `chatgpt.com/backend-api/codex/models` 同结构)。筛选完全依赖后端自带的可见性字段:
 *   visibility === 'list' && supported_in_api === true
 * ——自动挡掉内部 / 隐藏模型(codex-auto-review=hide、gpt-5.3-codex-spark=api:false)。
 *
 * 只读、纯派生。读取失败返回 null(保留上次快照 / 静态兜底),合法空 cache 返回 []。
 * mapper 与 fs 读分离:`mapCodexModelsToCatalog` 是纯函数(单测覆盖),`readCodexDiscoveredModels`
 * 只负责验证 Cindy OAuth 边界并读自管 cache。
 */

import { app } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { CatalogModel } from '@cindy/model-providers';
import type { CodexModelListItem } from '@cindy/maker-core';

import { shouldSuppressLocalCodexAuth } from './codex-auth-invalidation.js';

interface CodexModelRaw {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  context_window?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  priority?: unknown;
  /** [{id:'priority', name:'Fast', ...}] —— 含 priority 即支持 Fast(bridge 映射 service_tier)。 */
  service_tiers?: unknown;
}

/** service_tiers 里是否声明了 priority(=Fast)档。 */
function hasPriorityTier(tiers: unknown): boolean {
  return (
    Array.isArray(tiers) &&
    tiers.some((t) => t && typeof t === 'object' && (t as { id?: unknown }).id === 'priority')
  );
}

/**
 * Codex runtime 可透传的推理档位(issue #352 起含 max/ultra)。
 * 这是「客户端能透传哪些档」的白名单,不是「某模型支持哪些档」——后者由每个模型
 * 自报的 supported_reasoning_levels 决定,过滤后只保留该模型真正声明的子集。
 */
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * 默认收起的 slug(旧产品目录 defaultEnabled:false 的延续):清单动态化后注册表不带
 * 可见性梯度(list/hide 之外),legacy 模型的「默认隐藏」是客户端展示策略,不能因
 * 静态段退役而静默漂移成全部可见。用户仍可在设置里手动开启(override 语义不变)。
 */
const DEFAULT_HIDDEN_SLUGS: ReadonlySet<string> = new Set(['gpt-5.4-mini']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * 把上游 priority 映射到静态目录已占用的排序锚点。锚点来自当前官方 cache 顺序：
 * Sol(1)→17、Terra(2)→18、Luna(3)→19、5.5(7)→20、5.4(16)→21、Mini(23)→22。
 * 区间线性插值让未来模型真实落在相邻静态模型之间，而不是一律塞到 GPT-5.5 后面。
 */
function sortOrderForPriority(priority: number): number {
  const anchors = [
    [1, 17],
    [2, 18],
    [3, 19],
    [7, 20],
    [16, 21],
    [23, 22],
  ] as const;
  if (priority <= anchors[0][0]) return anchors[0][1] + (priority - anchors[0][0]) / 1000;
  for (let i = 1; i < anchors.length; i += 1) {
    const [rightPriority, rightOrder] = anchors[i];
    if (priority > rightPriority) continue;
    const [leftPriority, leftOrder] = anchors[i - 1];
    const ratio = (priority - leftPriority) / (rightPriority - leftPriority);
    return leftOrder + (rightOrder - leftOrder) * ratio;
  }
  const [lastPriority, lastOrder] = anchors[anchors.length - 1];
  return lastOrder + (priority - lastPriority) / 1000;
}

/**
 * codex models_cache 原始 JSON → 规范化的 Codex CatalogModel[]。纯函数。
 *
 * 只收 visibility:'list' && supported_in_api:true 的模型;缺关键字段(slug / efforts)则跳过。
 * sortOrder 由 codex 的 priority 派生到 gpt 分组的一个子带内(纯展示,不影响路由 / 去重)。
 */
export function mapCodexModelsToCatalog(raw: unknown): CatalogModel[] {
  const models =
    raw && typeof raw === 'object' && Array.isArray((raw as { models?: unknown }).models)
      ? ((raw as { models: unknown[] }).models as CodexModelRaw[])
      : [];
  const out: CatalogModel[] = [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    if (m.visibility !== 'list' || m.supported_in_api !== true) continue;
    const slug = str(m.slug);
    if (!slug) continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((e) => (e && typeof e === 'object' ? str((e as { effort?: unknown }).effort) : null))
          .filter((e): e is string => e != null && CODEX_EFFORTS.has(e))
      : [];
    const displayName = str(m.display_name) ?? slug;
    // cache 明示了才算真实上限;缺字段时补的 272k 只够展示(见下方 app-server mapper 注释)。
    const contextWindowVerified = typeof m.context_window === 'number';
    const contextWindow = contextWindowVerified ? (m.context_window as number) : 272_000;
    const defaultEffort =
      str(m.default_reasoning_level) && CODEX_EFFORTS.has(m.default_reasoning_level as string)
        ? (m.default_reasoning_level as CatalogModel['defaultEffort'])
        : efforts.length > 0
          ? (efforts[efforts.length - 1] as CatalogModel['defaultEffort'])
          : null;
    const priority = typeof m.priority === 'number' && Number.isFinite(m.priority) ? m.priority : 50;

    const model: CatalogModel = {
      id: slug,
      name: displayName,
      group: 'gpt',
      // 以静态模型的已知 priority/order 为锚点插值；active-catalog 对新增项做稳定排序。
      sortOrder: sortOrderForPriority(priority),
      description: str(m.description) ?? undefined,
      contextWindow,
      ...(contextWindowVerified ? { contextWindowVerified: true } : {}),
      efforts: efforts as CatalogModel['efforts'],
      defaultEffort,
      status: 'active',
      // 新发现的模型默认可见(用户抱怨过看不到模型);legacy 模型沿用旧目录的默认隐藏策略。
      defaultEnabled: !DEFAULT_HIDDEN_SLUGS.has(slug),
    };
    if (efforts.includes('xhigh')) model.effortDisplayNames = { xhigh: 'Extra High' };
    if (hasPriorityTier(m.service_tiers)) model.supportsFastMode = true;
    out.push(model);
  }
  return out;
}

/**
 * app-server `model/list` 快照 → 规范化目录。
 *
 * live 协议不暴露 cache 的 context_window / priority，故上下文使用 Codex 当前统一窗口
 * 272k，排序严格保留 app-server 返回顺序。后续 `models_cache.json` 可读时仍可用上面的
 * mapper 提供更细元数据；首次 OAuth 的关键是绝不能因为 cache 尚未落盘而发布空目录。
 */
export function mapCodexAppServerModelsToCatalog(
  models: readonly CodexModelListItem[],
): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of models.entries()) {
    if (!raw || raw.hidden === true) continue;
    const slug = str(raw.model) ?? str(raw.id);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
          .map((item) => (item && typeof item === 'object' ? str(item.reasoningEffort) : null))
          .filter((effort): effort is string => effort != null && CODEX_EFFORTS.has(effort))
      : [];
    const requestedDefault = str(raw.defaultReasoningEffort);
    const defaultEffort =
      requestedDefault && efforts.includes(requestedDefault)
        ? (requestedDefault as CatalogModel['defaultEffort'])
        : efforts.length > 0
          ? (efforts[efforts.length - 1] as CatalogModel['defaultEffort'])
          : null;
    const tiers = [
      ...(Array.isArray(raw.serviceTiers) ? raw.serviceTiers.map((tier) => tier?.id) : []),
      ...(Array.isArray(raw.additionalSpeedTiers) ? raw.additionalSpeedTiers : []),
    ];
    const supportsFastMode = tiers.some((tier) => tier === 'priority' || tier === 'fast');
    const model: CatalogModel = {
      id: slug,
      name: str(raw.displayName) ?? slug,
      group: 'gpt',
      // app-server 已按官方 picker 顺序返回；给每项稳定的小数锚点保住该顺序。
      sortOrder: 17 + index / 1000,
      ...(str(raw.description) ? { description: raw.description } : {}),
      // 刻意**不**设 contextWindowVerified: live 协议不给 context_window, 这 272k 是
      // 统一兜底而非该模型的真实上限。标了它就会被拿去收敛运行期上报的窗口, 把真实
      // 更大的窗口(例如 400k 的 gpt-5.6)压成 272k, 上下文占比与 memory flush 全偏早。
      contextWindow: 272_000,
      efforts: efforts as CatalogModel['efforts'],
      defaultEffort,
      status: 'active',
      defaultEnabled: !DEFAULT_HIDDEN_SLUGS.has(slug),
      ...(supportsFastMode ? { supportsFastMode: true } : {}),
    };
    if (efforts.includes('xhigh')) model.effortDisplayNames = { xhigh: 'Extra High' };
    out.push(model);
  }
  return out;
}

/** Cindy 自管的 Codex home；系统 ~/.codex 属于独立登录边界，不能混读其账号缓存。 */
function desktopCodexHome(): string {
  return path.join(app.getPath('userData'), 'codex-home');
}

/** 仅在 Cindy 当前确有未被 disconnect marker 抑制的 OAuth token 时读取模型 cache。 */
async function hasActiveDesktopCodexOAuth(codexHome: string): Promise<boolean> {
  const authPath = path.join(codexHome, 'auth.json');
  if (shouldSuppressLocalCodexAuth(codexHome, authPath)) return false;
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(authPath, 'utf-8'));
    const accessToken = (raw as { tokens?: { access_token?: unknown } } | null)?.tokens
      ?.access_token;
    return typeof accessToken === 'string' && accessToken.length > 0;
  } catch {
    return false;
  }
}

/**
 * 读 codex models_cache.json 并派生规范化快照。失败(文件缺失 / 非 JSON / 非 cache 结构)
 * 返回 null;合法 cache 即使 models 为空也返回 [],让调用方区分「上游空」与「没读到」。
 * cache 本身没有账号 ID，不能回退读取系统 ~/.codex 的 cache；否则 Cindy 登出或切换
 * ChatGPT 账号后会把系统/上一账号的有效旧 cache 重新发布为当前模型。
 * 异步读 —— 调用点在 catalog 加载的 promise 链里,不在 splash 关键路径塞同步 IO。
 */
export async function readCodexDiscoveredModels(): Promise<CatalogModel[] | null> {
  const codexHome = desktopCodexHome();
  if (!(await hasActiveDesktopCodexOAuth(codexHome))) return [];
  try {
    const raw: unknown = JSON.parse(
      await fsp.readFile(path.join(codexHome, 'models_cache.json'), 'utf-8'),
    );
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { models?: unknown }).models)) {
      return null;
    }
    return mapCodexModelsToCatalog(raw);
  } catch {
    return null;
  }
}

/**
 * 鉴权边界重读的安全语义：cache 缺失或读取异常都回空快照，不能沿用上一账号的动态模型。
 * 启动期仍直接调用 readCodexDiscoveredModels，以保留“读取失败不抹内存快照”的容错语义。
 */
export async function readCodexDiscoveredModelsForAuthRefresh(
  read: () => Promise<CatalogModel[] | null> = readCodexDiscoveredModels,
): Promise<CatalogModel[]> {
  try {
    return (await read()) ?? [];
  } catch {
    return [];
  }
}
