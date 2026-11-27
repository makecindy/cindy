/**
 * Built-in provider model-list refresh protocol shared by main, preload, and renderer.
 *
 * Custom providers keep their existing endpoint-driven additions-only refresh flow.
 */
export const BUILTIN_REFRESHABLE_PROVIDER_IDS = ['xd', 'anthropic', 'openai', 'xai'] as const;

export type BuiltinRefreshableProviderId = (typeof BUILTIN_REFRESHABLE_PROVIDER_IDS)[number];

export function isBuiltinRefreshableProviderId(
  value: unknown,
): value is BuiltinRefreshableProviderId {
  return (
    typeof value === 'string' &&
    (BUILTIN_REFRESHABLE_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export interface ProviderModelRefreshResult {
  ok: true;
  providerId: BuiltinRefreshableProviderId;
}

/** Renderer 只能上报明确的用户界面时机与网络恢复；前台恢复由 Main 自己判断。 */
export const PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS = [
  'providers-open',
  'model-selector-open',
  /**
   * 网络恢复（window `online`，或读不到的订阅账号重新读到）。只让**上次失败**的来源跳过
   * 失败冷却立刻重试；上次成功的来源照常服从 30 分钟冷却，重复上报不会放大请求
   * （2026-11-20：断网恢复后模型列表要等 5 分钟才回来）。
   */
  'network-restored',
] as const;

export type ProviderModelAutoRefreshRendererTrigger =
  (typeof PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS)[number];

export type ProviderModelAutoRefreshTrigger =
  | ProviderModelAutoRefreshRendererTrigger
  | 'foreground'
  | 'system-resume'
  | 'screen-unlock'
  /**
   * 账号数据就绪后的启动期主动发现（Main 自己触发，renderer 不可上报）。
   *
   * 它是唯一**强制**的自动触发：其余时机都服从冷却，而启动期恰恰不能服从 —— 全新机器
   * 首启时 splash 期可能已经因别的时机跑过一次（那会儿 owner 绑定还没认领、网关凭证还没
   * 下发，什么都发现不到），冷却就此生效 30 分钟，用户只能靠打开设置页或模型选择器把清单
   * 逼出来。强制放行让清单在进入主界面时就是最新的。
   */
  | 'startup';

/** 无视冷却的触发时机（理由见 `'startup'` 的注释）。 */
export const PROVIDER_MODEL_FORCED_AUTO_REFRESH_TRIGGERS: readonly ProviderModelAutoRefreshTrigger[] =
  ['startup'];

export function isForcedProviderModelAutoRefreshTrigger(
  trigger: ProviderModelAutoRefreshTrigger,
): boolean {
  return PROVIDER_MODEL_FORCED_AUTO_REFRESH_TRIGGERS.includes(trigger);
}

/** 跳过失败冷却（不跳过成功后的正常冷却）的触发时机。 */
export function isFailureRetryProviderModelAutoRefreshTrigger(
  trigger: ProviderModelAutoRefreshTrigger,
): boolean {
  return trigger === 'network-restored';
}

export function isProviderModelAutoRefreshRendererTrigger(
  value: unknown,
): value is ProviderModelAutoRefreshRendererTrigger {
  return (
    typeof value === 'string' &&
    (PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS as readonly string[]).includes(value)
  );
}

export interface ProviderModelAutoRefreshResult {
  ok: true;
}
