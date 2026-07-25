import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const readSource = (...segments: string[]): string =>
  readFileSync(resolve(__dirname, ...segments), 'utf8');

describe('legacy Orca IPC mutation boundary', () => {
  it('does not expose unguarded Team or Worker creation through localDb', () => {
    const handlerSource = readSource('..', 'orcaTeams.ts');
    const preloadSource = readSource('..', '..', '..', '..', 'preload', 'preload.ts');
    const rendererTypesSource = readSource('..', '..', '..', '..', 'renderer', 'vite-env.d.ts');

    for (const source of [handlerSource, preloadSource, rendererTypesSource]) {
      expect(source).not.toContain('local-db:orca-workflows:create');
      expect(source).not.toContain('local-db:orca-workflows:add-worker');
    }
  });
});
