/**
 * 供应商组(同账号)：组所在电脑把某个供应商的多台电脑合成一组，同账号的其他电脑选这个供应商时，
 * 先经本通道问组所在电脑「该用哪台」，再自己直接连到那台运行 Agent。
 * 产品规则见 docs/product-rules/provider-groups.md。
 *
 * 只进同账号 allowlist：供应商分享的受邀者与共享任务访客一律拒绝(被控端 dispatch 拦截执行，
 * 不落 ipcMain handler)。请求与回包的结构由 Desktop 两端共同维护(apps/desktop/src/shared/providerGroup.ts)，
 * 旧版电脑回 `CHANNEL_NOT_ALLOWED`，控制端当作那台没有组。
 */
export const PROVIDER_GROUP_REMOTE_CHANNEL = 'provider-group:remote';

/**
 * 同账号电脑读的 `maker:provider:list` 里，每个允许被远程调用的供应商带上这台电脑上用它正在运行一轮的
 * 任务数(`runningTurns`)：本机的任务加上替其他电脑运行的远程 Agent 任务，不论是谁发起的。组所在电脑据此
 * 显示组里这台在跑几个。只给同账号电脑：分享出去的目录里去掉(scrubSharedProvider)，受邀者看不到分享者
 * 电脑上的使用情况。
 */
export const PROVIDER_RUNNING_TURNS_FIELD = 'runningTurns';
/** 远高于一台电脑实际能跑的任务数，只用来挡异常值。 */
const MAX_PROVIDER_RUNNING_TURNS = 4096;

/** 读目录里一条供应商带的运行数；没有或不是合理的非负整数时返回 null。 */
export function readProviderRunningTurns(provider: unknown): number | null {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
  const value = (provider as Record<string, unknown>)[PROVIDER_RUNNING_TURNS_FIELD];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PROVIDER_RUNNING_TURNS
    ? value
    : null;
}
