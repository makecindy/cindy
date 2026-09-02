import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { claudeStructuredWriteTarget, isWorkspaceWritePathAllowed } from './workspace-write-policy.js';

describe('workspace write policy', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows exact files and directory subtrees but rejects siblings', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-bot-write-'));
    temporaryRoots.push(root);
    const allowedDir = path.join(root, 'allowed');
    const allowedFile = path.join(root, 'single.txt');
    mkdirSync(allowedDir);
    writeFileSync(allowedFile, 'ok');
    expect(isWorkspaceWritePathAllowed('allowed/new.txt', root, [allowedDir])).toBe(true);
    expect(isWorkspaceWritePathAllowed('single.txt', root, [allowedFile])).toBe(true);
    expect(isWorkspaceWritePathAllowed('other.txt', root, [allowedDir, allowedFile])).toBe(false);
  });

  it('follows parent symlinks before applying the grant', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-bot-write-link-'));
    temporaryRoots.push(root);
    const allowedDir = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    mkdirSync(allowedDir);
    mkdirSync(outside);
    symlinkSync(outside, path.join(allowedDir, 'escape'));
    expect(isWorkspaceWritePathAllowed('allowed/escape/file.txt', root, [allowedDir])).toBe(false);
  });

  it('keeps workspace control directories read-only even under a root grant', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-bot-write-control-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, '.agents'));
    mkdirSync(path.join(root, '.codex'));
    expect(isWorkspaceWritePathAllowed('src/new.ts', root, [root])).toBe(true);
    expect(isWorkspaceWritePathAllowed('.git/config', root, [root])).toBe(false);
    expect(isWorkspaceWritePathAllowed('.agents/policy.md', root, [root])).toBe(false);
    expect(isWorkspaceWritePathAllowed('.codex/config.toml', root, [root])).toBe(false);
  });

  it('extracts structured Claude write targets', () => {
    expect(claudeStructuredWriteTarget('Edit', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(claudeStructuredWriteTarget('NotebookEdit', { notebook_path: 'n.ipynb' })).toBe('n.ipynb');
    expect(claudeStructuredWriteTarget('Bash', { command: 'touch x' })).toBeNull();
  });
});
