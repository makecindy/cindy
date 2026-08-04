import type { ProviderWireProtocol } from '@cindy/model-providers';

export type CustomProviderCodexWireProtocol = Extract<
  ProviderWireProtocol,
  'openai-responses' | 'openai-chat' | 'anthropic-messages'
>;

interface CustomProviderWireProtocolOption {
  value: CustomProviderCodexWireProtocol;
  labelKey: string;
  helpKey: string;
  defaultRequestPath: string;
}

export const CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS = [
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

export function customProviderCodexWireProtocolOption(
  protocol: ProviderWireProtocol,
): (typeof CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS)[number] {
  return CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.find((option) => option.value === protocol)
    ?? CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS[0];
}
