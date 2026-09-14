/**
 * 模型连接自发现分两段：先确定经过授权的凭证来源并绑定 owner，再用该来源读取账号模型。
 *
 * 授权来源不能被供应商刷新总线抹平：Claude Code / Codex 是 Cindy 支持的原生 Harness，
 * 可以继承各自 CLI 已登录凭证；xAI 是下游 provider，只能使用用户在 Cindy 内明确完成的
 * OAuth；API-key provider 同样只接受用户明确保存的 key。授权完成后，三者才共同进入
 * authoritative account snapshot → Harness projection → metadata overlay。
 */
export type ConnectionSourceKind =
  'native-harness-inherited' | 'explicit-provider-oauth' | 'explicit-api-key';

export type NativeProviderId = 'anthropic' | 'openai' | 'xai';
export type NativeHarnessInheritedProviderId = 'anthropic' | 'openai';

export const NATIVE_PROVIDER_CONNECTION_SOURCE = {
  anthropic: 'native-harness-inherited',
  openai: 'native-harness-inherited',
  xai: 'explicit-provider-oauth',
} as const satisfies Record<NativeProviderId, ConnectionSourceKind>;

export function isNativeHarnessInheritedProvider(
  provider: NativeProviderId,
): provider is NativeHarnessInheritedProviderId {
  return NATIVE_PROVIDER_CONNECTION_SOURCE[provider] === 'native-harness-inherited';
}

export function isConnectionSourceKind(value: unknown): value is ConnectionSourceKind {
  return (
    value === 'native-harness-inherited' ||
    value === 'explicit-provider-oauth' ||
    value === 'explicit-api-key'
  );
}

/**
 * 账号模型发现的公共提交形态。成功空表同样是 authoritative，调用方不得用静态目录复活成员。
 * 各 provider 可以保留自己的授权刷新与上游协议 adapter，但成员语义从这里开始一致。
 */
export interface AuthoritativeAccountModelSnapshot<TModel> {
  source: ConnectionSourceKind;
  authoritative: true;
  models: readonly TModel[];
}
