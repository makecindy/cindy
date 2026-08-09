import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('sanitizes filesystem error diagnostics without exposing the source path', async () => {
    const root = await makeRoot();
    await writeAutomation(
      root,
      'blocked',
      [
        'version = 1',
        'id = "blocked"',
        'name = "blocked"',
        'prompt = "read only"',
        'status = "ACTIVE"',
        'rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"',
      ].join('\n'),
    );

    const sourcePath = path.join(root, 'blocked', 'automation.toml');
    const readFile = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, open '${sourcePath}'`), {
        code: 'EACCES',
      }),
    );
    try {
      const item = await createCodexAutomationReader({ rootDir: root }).get('blocked');
      expect(item?.diagnostics).toEqual(['cannot read automation.toml: EACCES']);
      expect(item?.diagnostics.join(' ')).not.toContain(sourcePath);
    } finally {
      readFile.mockRestore();
    }
  });

  it('reports string length violations accurately', async () => {
    const root = await makeRoot();
    await writeAutomation(
      root,
      'length-limits',
      [
        'version = 1',
        'id = "length-limits"',
        `prompt = ${JSON.stringify('p'.repeat(200_001))}`,
        `model = ${JSON.stringify('m'.repeat(1_001))}`,
        'status = "ACTIVE"',
        'rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"',
      ].join('\n'),
    );

    const item = await createCodexAutomationReader({ rootDir: root }).get('length-limits');

    expect(item?.diagnostics).toContain('prompt exceeds maximum length of 200000 characters');
    expect(item?.diagnostics).toContain('model exceeds maximum length of 1000 characters');
  });

  it('refuses non-regular automation.toml paths', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'directory-file', 'automation.toml'), { recursive: true });

    const reader = createCodexAutomationReader({ rootDir: root });
    const item = await reader.get('directory-file');

    expect(item?.diagnostics).toContain('automation.toml must be a regular file');
  });

  it('refuses oversized automation.toml files before parsing', async () => {
    const root = await makeRoot();
    const dir = path.join(root, 'oversized');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'automation.toml'), Buffer.alloc(1_000_001, 0x20));

    const reader = createCodexAutomationReader({ rootDir: root });
    const item = await reader.get('oversized');

    expect(item?.diagnostics.join(' ')).toContain('exceeds 1000000 bytes');
  });

  it('uses the directory name as the stable id when TOML declares a different id', async () => {
    const root = await makeRoot();
    await writeAutomation(
      root,
      'stable-directory',
      [
        'version = 1',
        'id = "declared-id"',
        'name = "Mismatched id"',
        'prompt = "read only"',
        'status = "ACTIVE"',
        'rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"',
      ].join('\n'),
    );

    const reader = createCodexAutomationReader({ rootDir: root });
    const [listed] = await reader.list();

    expect(listed.id).toBe('stable-directory');
    expect(listed.diagnostics).toContain('id does not match its automation directory');
    await expect(reader.get(listed.id)).resolves.toMatchObject({
      id: 'stable-directory',
      name: 'Mismatched id',
    });
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

  it('rejects the root directory alias instead of reading root automation.toml', async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, 'automation.toml'), 'name = "root file"', 'utf8');

    await expect(createCodexAutomationReader({ rootDir: root }).get('.')).resolves.toBeNull();
  });

  it('sanitizes root filesystem errors without exposing the root path', async () => {
    const root = await makeRoot();
    const sourcePath = path.join(root, 'automation.toml');
    const readdir = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, scandir '${sourcePath}'`), {
        code: 'EACCES',
      }),
    );
    try {
      const error = await createCodexAutomationReader({ rootDir: root })
        .list()
        .then(
          () => null,
          (reason) => reason as Error,
        );
      expect(error?.message).toBe('cannot list Codex automations: EACCES');
      expect(error?.message).not.toContain(root);
    } finally {
      readdir.mockRestore();
    }
  });

  it('sanitizes get access errors without exposing the source path', async () => {
    const root = await makeRoot();
    const sourcePath = path.join(root, 'blocked', 'automation.toml');
    const access = vi.spyOn(fs, 'access').mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, access '${sourcePath}'`), {
        code: 'EACCES',
      }),
    );
    try {
      const error = await createCodexAutomationReader({ rootDir: root })
        .get('blocked')
        .then(
          () => null,
          (reason) => reason as Error,
        );
      expect(error?.message).toBe('cannot read automation.toml: EACCES');
      expect(error?.message).not.toContain(root);
    } finally {
      access.mockRestore();
    }
  });
});
