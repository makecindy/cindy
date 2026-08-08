import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');
const makerHostSource = readFileSync(resolve(__dirname, '..', 'maker-host', 'index.ts'), 'utf8');

describe('chat embedding availability wiring', () => {
  it('reconciles the runtime whenever provider access changes', () => {
    expect(makerHostSource).toContain('providerAccessRuntimeRefreshListener?.();');
    expect(bootstrapSource).toContain(
      'setProviderAccessRuntimeRefreshListener(scheduleChatEmbeddingRuntimeReconcile);',
    );
  });

  it('stops unavailable consumers and restores an enabled preference when access returns', () => {
    expect(bootstrapSource).toContain(
      'if (!isChatEmbeddingAvailable()) setChatEmbeddingEnabled(false);',
    );
    expect(bootstrapSource).toContain(
      'if (isChatEmbeddingAvailable() && readChatEmbeddingSettings().enabled)',
    );
    expect(bootstrapSource).toContain('await shutdownChatEmbeddingConsumer();');
  });
});
