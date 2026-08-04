import { describe, expect, it } from 'vitest';

import {
  CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS,
  customProviderCodexWireProtocolOption,
} from '../customProviderWireProtocols';

describe('custom provider Codex wire protocols', () => {
  it('offers every supported Codex route including the Anthropic Messages bridge', () => {
    expect(CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.map((option) => option.value)).toEqual([
      'openai-responses',
      'openai-chat',
      'anthropic-messages',
    ]);
  });

  it('uses the Anthropic Messages endpoint as its default request path', () => {
    expect(customProviderCodexWireProtocolOption('anthropic-messages')).toMatchObject({
      helpKey: 'settings.providers.custom.wireProtocol.anthropicHelp',
      defaultRequestPath: '/v1/messages',
    });
  });
});
