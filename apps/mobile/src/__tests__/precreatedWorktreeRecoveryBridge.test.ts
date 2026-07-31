import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('precreated worktree recovery bridge', () => {
  it('fences stable Device Link callbacks by the current account owner generation', () => {
    const layout = readFileSync(
      resolve(process.cwd(), 'app/_layout.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(layout).toContain(
      "const ownerGenerationRef = useRef({ accountId: '', generation: 0 });",
    );
    expect(layout).toContain(
      'ownerGenerationRef.current.accountId === accountId',
    );
    expect(layout).toContain(
      'ownerGenerationRef.current.generation === ownerGeneration',
    );
    expect(layout).toContain('isCurrent: () => (');
  });
});
