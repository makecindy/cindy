import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const makerHostSource = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(
  /\s+/g,
  ' ',
);

describe('Codex model backfill wiring', () => {
  it('routes OAuth startup discovery through the isolated control-plane host', () => {
    expect(makerHostSource).toContain(
      "refreshLive: () => makerRef.refreshAgentLocalModels('codex', { credentialMode: 'oauth-bearer', }),",
    );
  });
});
