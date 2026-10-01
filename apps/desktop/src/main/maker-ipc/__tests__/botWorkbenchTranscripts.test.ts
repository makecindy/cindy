import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
vi.mock('../../maker-host/claude-local-sessions.js', () => ({
  findExternalClaudeCodeSessionFile: vi.fn(),
  parseClaudeCodeMessageLine: vi.fn(() => []),
}));
vi.mock('../../maker-host/codex-local-sessions.js', () => ({
  findExternalCodexRolloutFile: vi.fn(),
  parseCodexRolloutMessageLine: vi.fn(() => null),
}));

import { boundTranscript, readTailLines } from '../botWorkbenchTranscripts.js';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('boundTranscript', () => {
  it('strips instruction blocks, drops empty messages and keeps the most recent within the budget', () => {
    const items = [
      { role: 'user' as const, text: 'old '.repeat(400), at: 1 },
      { role: 'assistant' as const, text: '<system-reminder>internal</system-reminder>', at: 2 },
      { role: 'user' as const, text: '把图标导出来', at: 3 },
      { role: 'assistant' as const, text: '导好了 mdpi,还差 xxhdpi', at: 4 },
    ];
    const bounded = boundTranscript(items, 200);
    expect(bounded.items.map((item) => item.at)).toEqual([1, 3, 4]);
    expect(bounded.items[0].text.startsWith('…')).toBe(true);
    expect(bounded.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(200);
    expect(bounded.truncated).toBe(true);
    expect(boundTranscript(items.slice(2)).truncated).toBe(false);
  });
});

describe('readTailLines', () => {
  it('reads only the tail of a transcript and drops the cut first line', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wb-tail-'));
    const file = path.join(root, 's.jsonl');
    await writeFile(file, ['first-line-is-long', 'second', 'third', ''].join('\n'), 'utf8');
    expect(await readTailLines(file, 14)).toEqual(['second', 'third']);
    expect(await readTailLines(file, 10_000)).toEqual(['first-line-is-long', 'second', 'third']);
  });
});
