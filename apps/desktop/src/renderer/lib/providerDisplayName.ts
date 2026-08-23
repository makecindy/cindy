/**
 * 供应商展示名 —— 三个内置 id 复用设置页 i18n 标题 (settings.providers.<id>.title),
 * 自定义供应商回退目录里的 provider.name, 都拿不到时才回退裸 id。
 *
 * 从 ModelSelector 提取到这里: 用量历史的任务表也要把 Session.providerId 渲染成人话,
 * 两处必须同源, 否则同一个 'xd' 在模型选择器里是「Cindy AI」、在用量页却是「xd」。
 */

import type { ProviderView } from '@cindy/model-providers';

export const PROVIDER_TITLE_KEY: Record<string, string> = {
  anthropic: 'settings.providers.anthropic.title',
  openai: 'settings.providers.openai.title',
  xd: 'settings.providers.xd.title',
};

type TFunc = (key: string) => string;

export function providerDisplayName(provider: ProviderView, t: TFunc): string {
  const key = PROVIDER_TITLE_KEY[provider.id];
  return key ? t(key) : provider.name;
}

/**
 * 只有 id 时的展示名 (会话行记的是 providerId, 目录未必包含它 —— 例如未登录时
 * 网关供应商不在目录里, 或用户删掉了那个自定义供应商)。
 */
export function providerDisplayNameById(
  providerId: string,
  providers: readonly ProviderView[],
  t: TFunc,
): string {
  const key = PROVIDER_TITLE_KEY[providerId];
  if (key) return t(key);
  return providers.find((provider) => provider.id === providerId)?.name ?? providerId;
}
