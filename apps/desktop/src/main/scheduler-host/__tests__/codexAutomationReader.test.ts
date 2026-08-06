import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCodexAutomationReader,
  type CodexAutomationDetail,
} from '../codex-automation-reader.js';

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-codex-automations-'));
  tempRoots.push(root);
  return root;
}

async function writeAutomation(root: string, dirName: string, content: string): Promise<void> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'automation.toml'), content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('createCodexAutomationReader', () => {
  it('reads a UTF-8 automation and preserves the complete prompt', async () => {
    const root = await makeRoot();
    const prompt =
      '\u8bfb\u53d6 AGENTS.md，\u8f93\u51fa\u7ed9 MTT \u7684\u4e2d\u6587\u63d0\u9192。';
    await writeAutomation(
      root,
      'ddl',
      [
        'version = 1',
        'id = "ddl"',
        'kind = "cron"',
        'name = "DDL patrol"',
        `prompt = ${JSON.stringify(prompt)}`,
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=11;BYMINUTE=20;BYSECOND=0"',
        'model = "gpt-5.5"',
        'reasoning_effort = "medium"',
        'execution_environment = "local"',
        'target = { type = "project", project_id = "local-project" }',
        'cwds = ["C:\\\\newlife"]',
      ].join('\n'),
    );

    const reader = createCodexAutomationReader({ rootDir: root });
    const items = await reader.list();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'ddl',
      name: 'DDL patrol',
      prompt,
      status: 'ACTIVE',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      cwds: ['C:\\newlife'],
      diagnostics: [],
    });
    expect(items[0].sourcePath).toBe(path.join(root, 'ddl', 'automation.toml'));
  });

  it('returns a diagnostic instead of dropping malformed automations', async () => {
    const root = await makeRoot();
    await writeAutomation(root, 'broken', 'version = 1\nid = 42\n');

    const reader = createCodexAutomationReader({ rootDir: root });
    const items = await reader.list();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'broken', name: 'broken', prompt: '' });
    expect(items[0].diagnostics.join(' ')).toContain('id');
  });

  it('diagnoses unsupported interval rules without rewriting them', async () => {
    const root = await makeRoot();
    await writeAutomation(
      root,
      'review-only',
      [
        'version = 1',
        'id = "review-only"',
        'kind = "cron"',
        'name = "review-only"',
        'prompt = "read only"',
        'status = "ACTIVE"',
        'rrule = "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=15;BYMINUTE=0"',
        'model = "gpt-5.5"',
        'reasoning_effort = "medium"',
        'execution_environment = "local"',
        'cwds = ["C:\\\\newlife"]',
      ].join('\n'),
    );

    const reader = createCodexAutomationReader({ rootDir: root });
    const item = (await reader.get('review-only')) as CodexAutomationDetail;

    expect(item.rrule).toContain('INTERVAL=2');
    expect(item.diagnostics.join(' ')).toContain('INTERVAL');
  });

  it('returns null for an unknown id and an empty list for a missing root', async () => {
    const root = path.join(os.tmpdir(), 'cindy-codex-automations-missing-root');
    const reader = createCodexAutomationReader({ rootDir: root });

    await expect(reader.get('missing')).resolves.toBeNull();
    await expect(reader.list()).resolves.toEqual([]);
  });
});
