import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectContext } from './project-context.js';

describe('project context parity', () => {
  it('wraps the same TOC source used by Cindy Desktop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'headless-project-context-'));
    const knowledge = path.join(root, '.cindy', 'project-knowledge');
    await mkdir(knowledge, { recursive: true });
    await writeFile(path.join(knowledge, 'TOC.md'), '# Project\n\n- [Core](modules/core.md)\n');
    const result = await readProjectContext(root, true);
    expect(result.injected).toBe(true);
    expect(result.content).toBe('<project-context-toc>\n# Project\n\n- [Core](modules/core.md)\n</project-context-toc>');
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not read project knowledge when the profile disables it', async () => {
    const result = await readProjectContext('missing', false);
    expect(result).toMatchObject({ injected: false, reason: 'disabled', digest: null });
  });
});
