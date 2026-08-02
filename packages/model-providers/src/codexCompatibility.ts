import type {
  AgentKind,
  CatalogModel,
  CodexCompatibilityWireProtocol,
  Provider,
  ProviderWireProtocol,
} from './types.js';

function isCodexCompatibilityWireProtocol(
  protocol: ProviderWireProtocol | undefined,
): protocol is CodexCompatibilityWireProtocol {
  return protocol === 'openai-chat' || protocol === 'anthropic-messages';
}

/**
 * 解析某个 (provider, agent, model) 是否通过本地 bridge 兼容 Codex。
 *
 * Provider 级 wire protocol 是常规来源；模型级覆盖仅用于 XD 这类同一 Provider 内
 * 同时存在原生 Responses 与桥接模型的情况。Renderer、远程设备视图与其它展示面应
 * 复用本函数，避免按 Provider id 或模型名复制路由判断。
 */
export function resolveCodexCompatibilityWireProtocol(
  provider: Pick<Provider, 'routing'>,
  agent: AgentKind | null | undefined,
  model: Pick<CatalogModel, 'codexCompatibilityWireProtocol'> | null | undefined,
): CodexCompatibilityWireProtocol | null {
  if (agent !== 'codex') return null;
  if (model?.codexCompatibilityWireProtocol) {
    return model.codexCompatibilityWireProtocol;
  }
  const providerProtocol = provider.routing.codex?.wireProtocol;
  return isCodexCompatibilityWireProtocol(providerProtocol) ? providerProtocol : null;
}
