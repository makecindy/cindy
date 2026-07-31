import { describe, expect, it } from 'vitest';

import {
  CUSTOM_PROVIDER_WIRE_PROTOCOLS,
  customProviderWireProtocolOption,
} from '../customProviderWireProtocols';

describe('custom provider wire protocols', () => {
  it('offers every supported wire protocol route including the Anthropic Messages bridge', () => {
    expect(CUSTOM_PROVIDER_WIRE_PROTOCOLS.map((option) => option.value)).toEqual([
      'openai-responses',
      'openai-chat',
      'anthropic-messages',
    ]);
  });

  it('uses the Anthropic Messages endpoint as its default request path', () => {
    expect(customProviderWireProtocolOption('anthropic-messages')).toMatchObject({
      helpKey: 'settings.providers.custom.wireProtocol.anthropicHelp',
      defaultRequestPath: '/v1/messages',
    });
  });

  it('uses the Chat Completions endpoint as its default request path', () => {
    expect(customProviderWireProtocolOption('openai-chat')).toMatchObject({
      defaultRequestPath: '/chat/completions',
    });
  });
});
