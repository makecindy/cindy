import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tryInjectProjectContext } from '../projectContextInject.js';

const tempDirs: string[] = [];

async function makeProject(toc?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-project-context-'));
  tempDirs.push(dir);
  if (toc !== undefined) {
    const knowledgeDir = path.join(dir, '.cindy', 'project-knowledge');
    await fs.mkdir(knowledgeDir, { recursive: true });
    await fs.writeFile(path.join(knowledgeDir, 'TOC.md'), toc, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('tryInjectProjectContext', () => {
  it('injects one compact on-demand pointer instead of the TOC body', async () => {
    const sentinel = 'LARGE_TOC_BODY_MUST_NOT_ENTER_STARTUP_CONTEXT';
    const workingDir = await makeProject(`# Project Knowledge\n\n${sentinel}\n${'x'.repeat(20_000)}`);

    const result = await tryInjectProjectContext(workingDir);

    expect(result.injected).toBe(true);
    expect(result.content).toContain('.cindy/project-knowledge/TOC.md');
    expect(result.content).toContain('read that file');
    expect(result.content).not.toContain(sentinel);
    expect(result.content?.length).toBeLessThan(300);
    expect(result).toEqual({
      injected: true,
      content: [
        '<project-context-toc>',
        'Project Knowledge is available at .cindy/project-knowledge/TOC.md.',
        'When project or module knowledge is relevant, read that file and follow its links on demand.',
        '</project-context-toc>',
      ].join('\n'),
    });
  });

  it('skips missing and empty TOC files without blocking session creation', async () => {
    const missing = await tryInjectProjectContext(await makeProject());
    const empty = await tryInjectProjectContext(await makeProject('  \n'));

    expect(missing).toEqual({ injected: false, reason: 'no-toc-file' });
    expect(empty).toEqual({ injected: false, reason: 'empty-toc-file' });
  });
});
