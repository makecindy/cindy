import { describe, expect, it } from 'vitest';

import { parseBotDeliveryDiagnostic } from '../botDeliveryDiagnostic.js';

describe('Bot delivery diagnostic', () => {
  it('projects multipart progress without exposing the raw receipt', () => {
    expect(parseBotDeliveryDiagnostic(JSON.stringify({
      externalDispatch: { retrySafe: false, transport: 'local-adapter', startedAt: 10 },
      progress: {
        textMessageId: 'text-1',
        sentMediaCount: 2,
        attachmentMessageIds: ['file-1', 'file-2'],
      },
      providerSecret: 'must-not-cross-ipc',
    }))).toEqual({
      retrySafe: false,
      transport: 'local-adapter',
      startedAt: 10,
      textMessageId: 'text-1',
      sentMediaCount: 2,
      committedFinal: false,
      attachmentMessageIds: ['file-1', 'file-2'],
    });
  });

  it('returns no diagnostic for malformed or empty receipts', () => {
    expect(parseBotDeliveryDiagnostic('{bad')).toBeUndefined();
    expect(parseBotDeliveryDiagnostic('{}')).toBeUndefined();
  });
});
