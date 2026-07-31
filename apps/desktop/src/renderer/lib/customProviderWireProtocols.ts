import type { ProviderWireProtocol } from '@cindy/model-providers';

/**
 * 自定义供应商的 wire 协议选项 —— Claude Code 与 Codex 共用同一份列表:
 * 任一 agent 的 runtime 都可选 Anthropic Messages / OpenAI Responses / Chat Completions,
 * 运行时按协议走对应通道(原生直连 / responses bridge / chat bridge)。
 */
export type CustomProviderWireProtocol = ProviderWireProtocol;

interface CustomProviderWireProtocolOption {
  value: CustomProviderWireProtocol;
  labelKey: string;
  helpKey: string;
  defaultRequestPath: string;
}

export const CUSTOM_PROVIDER_WIRE_PROTOCOLS = [
  {
    value: 'openai-responses',
    labelKey: 'settings.providers.custom.wireProtocol.responses',
    helpKey: 'settings.providers.custom.wireProtocol.responsesHelp',
    defaultRequestPath: '/responses',
  },
  {
    value: 'openai-chat',
    labelKey: 'settings.providers.custom.wireProtocol.chat',
    helpKey: 'settings.providers.custom.wireProtocol.chatHelp',
    defaultRequestPath: '/chat/completions',
  },
  {
    value: 'anthropic-messages',
    labelKey: 'settings.providers.custom.wireProtocol.anthropic',
    helpKey: 'settings.providers.custom.wireProtocol.anthropicHelp',
    defaultRequestPath: '/v1/messages',
  },
] as const satisfies readonly CustomProviderWireProtocolOption[];

export function customProviderWireProtocolOption(
  protocol: ProviderWireProtocol,
): (typeof CUSTOM_PROVIDER_WIRE_PROTOCOLS)[number] {
  return CUSTOM_PROVIDER_WIRE_PROTOCOLS.find((option) => option.value === protocol)
    ?? CUSTOM_PROVIDER_WIRE_PROTOCOLS[0];
}
