/**
 * 所有可改名连接优先显示目录中的名称；Cindy AI 保留统一的本地化产品名。
 * 缺少目录时才回退内置名称或连接 ID。
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
  return provider.id === 'xd' && key ? t(key) : provider.name || (key ? t(key) : provider.id);
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
  const provider = providers.find((item) => item.id === providerId);
  if (provider) return providerDisplayName(provider, t);
  const key = PROVIDER_TITLE_KEY[providerId];
  return key ? t(key) : providerId;
}

/** Append recognized account identity without repeating generated connection names. */
export function providerAccountLabel(label: string, identity?: string): string {
  if (!identity || label === identity) return label;
  // Independent logins already name the connection "Provider · identity".
  // OpenAI also truncates that generated name to 50 characters and may add (2).
  const baseLabel = label.replace(/ \(\d+\)$/, '');
  if (baseLabel.endsWith(` · ${identity}`)) return label;
  const separator = baseLabel.indexOf(' · ');
  if (
    separator >= 0 &&
    baseLabel.length === 50 &&
    `${baseLabel.slice(0, separator)} · ${identity}`.slice(0, 50) === baseLabel
  )
    return label;
  return `${label} · ${identity}`;
}
