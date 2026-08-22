import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isCustomizationPathInside } from '../../shared/customization-scanner.js';
import {
  MAX_PI_CUSTOMIZATION_SCAN_ENTRIES,
  piUserSkillRoot,
  scanPiCustomizations,
  scanPiRuntimeUserSkillSources,
} from '../customization-scanner.js';

const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } = fs;

const roots: string[] = [];

function canCreateSymlink(kind: 'dir' | 'file'): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), `pi-customization-${kind}-link-probe-`));
  try {
    const target = path.join(probe, `target-${kind}`);
    if (kind === 'dir') mkdirSync(target);
    else writeFileSync(target, 'probe');
    symlinkSync(
      target,
      path.join(probe, `link-${kind}`),
      process.platform === 'win32' && kind === 'dir' ? 'junction' : kind,
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const canLinkDirectory = canCreateSymlink('dir');
const canLinkFile = canCreateSymlink('file');

function canDistinguishEntrypointCase(): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), 'pi-customization-case-probe-'));
  try {
    writeFileSync(path.join(probe, 'skill.md'), 'probe');
    return !fs.existsSync(path.join(probe, 'SKILL.md'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const caseSensitiveEntrypoints = canDistinguishEntrypointCase();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-customizations-'));
  roots.push(root);
  return root;
}

function writeSkill(root: string, relativeDir: string, name: string): string {
  const skillDir = path.join(root, relativeDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`,
  );
  return skillDir;
}

function canonical(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function projectItems(result: Awaited<ReturnType<typeof scanPiCustomizations>>) {
  return result.items.filter((item) => item.scope === 'repo');
}

describe('scanPiCustomizations', () => {
  it('rejects runtime provenance when a user Skill is replaced during catalog capture', async () => {
    const root = canonical(tempRoot());
    const baseDir = path.join(root, '.agents');
    const skillDir = writeSkill(baseDir, 'skills', 'demo');
    const mdPath = path.join(skillDir, 'SKILL.md');
    const replacement = writeSkill(root, '', 'replacement');
    const original = path.join(root, 'original');
    const open = vi.spyOn(fs.promises, 'open');
    const realOpen = open.getMockImplementation();
    let replaced = false;
    open.mockImplementation(async (candidate, flags, mode) => {
      if (!replaced && path.resolve(String(candidate)) === path.resolve(mdPath)) {
        replaced = true;
        fs.renameSync(skillDir, original);
        fs.renameSync(replacement, skillDir);
      }
      return realOpen
        ? realOpen(candidate, flags, mode)
        : vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
          .then((actual) => actual.open(candidate, flags, mode));
    });
    try {
      await expect(scanPiRuntimeUserSkillSources(
        [baseDir],
        Date.now() + 5_000,
      )).resolves.toEqual([]);
      expect(replaced).toBe(true);
      expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('replacement');
    } finally {
      open.mockRestore();
    }
  });

  it('fails closed on its deadline when an async filesystem probe hangs', async () => {
    const root = tempRoot();
    const cwd = path.join(root, 'repo');
    mkdirSync(cwd, { recursive: true });
    const blockedStat = vi.fn(() => new Promise<fs.Stats>(() => {}));

    vi.useFakeTimers();
    try {
      const pending = scanPiCustomizations(
        { workingDirs: [cwd] },
        { stat: blockedStat, deadlineMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(10);

      await expect(pending).resolves.toMatchObject({
        items: [],
        errors: [{ message: 'Pi customization scan deadline expired' }],
      });
      expect(blockedStat).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed at the shared entry budget before probing discovered children', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const lexicalSkillRoot = path.join(repo, '.pi', 'skills');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(lexicalSkillRoot, { recursive: true });
    const skillRoot = canonical(lexicalSkillRoot);
    const originalStat = fs.promises.stat;
    const stat = vi.fn((candidate: string) => {
      if (candidate === piUserSkillRoot()) {
        return Promise.reject(Object.assign(new Error('missing user root'), { code: 'ENOENT' }));
      }
      return originalStat(candidate) as Promise<fs.Stats>;
    });
    let index = 0;
    const read = vi.fn(async () => {
      if (index > MAX_PI_CUSTOMIZATION_SCAN_ENTRIES) return null;
      index += 1;
      return {
        name: `entry-${index}`,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as fs.Dirent;
    });
    const close = vi.fn(async () => {});
    const openDirectory = vi.fn(async (candidate: string) => {
      if (candidate !== skillRoot) return fs.promises.opendir(candidate);
      return { read, close } as unknown as fs.Dir;
    });

    const result = await scanPiCustomizations(
      { workingDirs: [repo] },
      { stat, openDirectory },
    );

    expect(result).toEqual({
      items: [],
      errors: [{ message: 'Pi customization scan entry budget exceeded' }],
    });
    expect(read).toHaveBeenCalledTimes(MAX_PI_CUSTOMIZATION_SCAN_ENTRIES + 1);
    expect(close).toHaveBeenCalledOnce();
    expect(stat.mock.calls.some(([candidate]) => String(candidate).includes('entry-'))).toBe(false);
  });

  it('charges streamed bytes when SKILL.md exceeds its reported size', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const skillDirs = Array.from({ length: 5 }, (_, index) => (
      writeSkill(repo, path.join('.pi', 'skills'), `aggregate-${index}`)
    ));
    const mdPaths = new Set(skillDirs.map((dir) => path.join(canonical(dir), 'SKILL.md')));
    const actualStat = await fs.promises.stat([...mdPaths][0]);
    const reservedStat = {
      ...actualStat,
      size: 1,
      isFile: () => true,
    } as fs.Stats;
    const streamedChunk = Buffer.alloc(16 * 1024 * 1024);
    const originalStat = fs.promises.stat;
    const stat = vi.fn((candidate: string) => {
      if (candidate === piUserSkillRoot()) {
        return Promise.reject(Object.assign(new Error('missing user root'), { code: 'ENOENT' }));
      }
      if (mdPaths.has(String(candidate))) return Promise.resolve(reservedStat);
      return originalStat(candidate) as Promise<fs.Stats>;
    });
    const close = vi.fn(async () => {});
    const openFile = vi.fn(async (candidate: string) => {
      if (!mdPaths.has(String(candidate))) return fs.promises.open(candidate, 'r');
      return {
        stat: vi.fn(async () => reservedStat),
        createReadStream: vi.fn(() => ({
          [Symbol.asyncIterator]: () => [streamedChunk][Symbol.iterator](),
        })),
        close,
      } as unknown as FileHandle;
    });

    const result = await scanPiCustomizations(
      { workingDirs: [repo] },
      { stat, openFile },
    );

    expect(result).toEqual({
      items: [],
      errors: [{ message: 'Pi customization scan byte budget exceeded' }],
    });
    expect(openFile).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it('bounds project Skill frontmatter parsing and retains only supported scalar fields', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const largeSkill = writeSkill(repo, path.join('.pi', 'skills'), 'large-frontmatter');
    const filteredSkill = writeSkill(repo, path.join('.pi', 'skills'), 'filtered-frontmatter');
    writeFileSync(
      path.join(largeSkill, 'SKILL.md'),
      `---\nname: large-frontmatter\ndescription: ${'x'.repeat(20 * 1024)}\n---\n# body\n`,
    );
    writeFileSync(
      path.join(filteredSkill, 'SKILL.md'),
      [
        '---',
        'name: filtered-frontmatter',
        'description: safe description',
        'version: 1.2.3',
        'metadata:',
        '  nested:',
        '    retained: false',
        '---',
        '# body',
        '',
      ].join('\n'),
    );

    const result = await scanPiCustomizations({ workingDirs: [repo] });
    const large = projectItems(result).find((item) => item.name === 'large-frontmatter');
    const filtered = projectItems(result).find((item) => item.name === 'filtered-frontmatter');

    expect(large).toMatchObject({
      frontmatter: undefined,
      parseError: 'Pi Skill frontmatter exceeds the bounded parser budget',
    });
    expect(filtered?.frontmatter).toEqual({
      name: 'filtered-frontmatter',
      description: 'safe description',
      version: '1.2.3',
    });
    expect(filtered?.frontmatter).not.toHaveProperty('metadata');
  });

  it('stops streaming a growing project SKILL.md at the byte budget', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const skillDir = writeSkill(repo, path.join('.pi', 'skills'), 'growing');
    const mdPath = path.join(canonical(skillDir), 'SKILL.md');
    const mdStat = await fs.promises.stat(mdPath);
    const next = vi.fn(async () => ({
      done: false as const,
      value: Buffer.alloc(4 * 1024 * 1024),
    }));
    const finish = vi.fn(async () => ({ done: true as const, value: undefined }));
    const close = vi.fn(async () => {});
    const handle = {
      stat: vi.fn(async () => mdStat),
      createReadStream: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({ next, return: finish }),
      })),
      close,
    } as unknown as FileHandle;

    const result = await scanPiCustomizations(
      { workingDirs: [repo] },
      {
        openFile: (candidate) => candidate === mdPath
          ? Promise.resolve(handle)
          : fs.promises.open(candidate, 'r'),
      },
    );

    expect(result).toEqual({
      items: [],
      errors: [{ message: 'Pi Skill entrypoint exceeded the byte budget' }],
    });
    expect(next).toHaveBeenCalledTimes(5);
    expect(finish).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('opens SKILL.md non-blocking before validating its file identity', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const skillDir = writeSkill(repo, path.join('.pi', 'skills'), 'non-blocking');
    const mdPath = path.join(canonical(skillDir), 'SKILL.md');
    const openSpy = vi.spyOn(fs.promises, 'open');

    try {
      const result = await scanPiCustomizations({ workingDirs: [repo] });

      expect(projectItems(result).map((item) => item.name)).toContain('non-blocking');
      const entrypointOpen = openSpy.mock.calls.find(
        ([candidate]) => String(candidate) === mdPath,
      );
      expect(entrypointOpen?.[1]).toBe(
        fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it('aborts a hanging project SKILL.md stream at the shared deadline', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const skillDir = writeSkill(repo, path.join('.pi', 'skills'), 'hanging');
    const mdPath = path.join(canonical(skillDir), 'SKILL.md');
    const mdStat = await fs.promises.stat(mdPath);
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const next = vi.fn(() => {
      markReadStarted();
      return new Promise<IteratorResult<Buffer>>(() => {});
    });
    const finish = vi.fn(async () => ({ done: true as const, value: undefined }));
    const close = vi.fn(async () => {});
    let aborted = false;
    const handle = {
      stat: vi.fn(async () => mdStat),
      createReadStream: vi.fn((options: { signal?: AbortSignal }) => {
        options.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return {
          [Symbol.asyncIterator]: () => ({ next, return: finish }),
        };
      }),
      close,
    } as unknown as FileHandle;

    vi.useFakeTimers();
    try {
      const pending = scanPiCustomizations(
        { workingDirs: [repo] },
        {
          openFile: (candidate) => candidate === mdPath
            ? Promise.resolve(handle)
            : fs.promises.open(candidate, 'r'),
          deadlineMs: 1_000,
        },
      );
      await readStarted;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({
        items: [],
        errors: [{ message: 'Pi customization scan deadline expired' }],
      });
      expect(aborted).toBe(true);
      expect(finish).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a project SKILL.md whose open-file identity changes while reading', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const skillDir = writeSkill(repo, path.join('.pi', 'skills'), 'replaced');
    const mdPath = path.join(canonical(skillDir), 'SKILL.md');
    const mdStat = await fs.promises.stat(mdPath);
    const changedStat = {
      ...mdStat,
      mtimeMs: mdStat.mtimeMs + 1,
      isFile: () => true,
    } as fs.Stats;
    const stats = [mdStat, changedStat];
    const iterator = [Buffer.from('# safe\n')][Symbol.iterator]();
    const close = vi.fn(async () => {});
    const handle = {
      stat: vi.fn(async () => stats.shift() ?? changedStat),
      createReadStream: vi.fn(() => ({
        [Symbol.asyncIterator]: () => iterator,
      })),
      close,
    } as unknown as FileHandle;

    const result = await scanPiCustomizations(
      { workingDirs: [repo] },
      {
        openFile: (candidate) => candidate === mdPath
          ? Promise.resolve(handle)
          : fs.promises.open(candidate, 'r'),
      },
    );

    expect(result).toEqual({
      items: [],
      errors: [{ message: 'Pi Skill entrypoint changed while reading' }],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses Windows path semantics for drive and UNC containment', () => {
    expect(isCustomizationPathInside(
      'C:\\Repo',
      'c:\\repo\\.pi\\skills\\demo',
      path.win32,
    )).toBe(true);
    expect(isCustomizationPathInside(
      'C:\\Repo',
      'D:\\Repo\\.pi\\skills\\demo',
      path.win32,
    )).toBe(false);
    expect(isCustomizationPathInside(
      '\\\\server\\share\\repo',
      '\\\\server\\share\\repo\\.pi\\skills\\demo',
      path.win32,
    )).toBe(true);
    expect(isCustomizationPathInside(
      '\\\\server\\share\\repo',
      '\\\\server\\other\\repo\\.pi\\skills\\demo',
      path.win32,
    )).toBe(false);
  });

  it('keeps only the shared user skill root', () => {
    expect(piUserSkillRoot()).toBe(path.join(homedir(), '.agents', 'skills'));
    expect(piUserSkillRoot()).not.toContain(path.join('.pi', 'agent'));
  });

  it('discovers .pi/skills and .agents/skills through the nearest Git root', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'packages', 'app');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const piSkill = writeSkill(cwd, path.join('.pi', 'skills'), 'pi-project');
    const localShared = writeSkill(cwd, path.join('.agents', 'skills'), 'local-shared');
    const ancestorShared = writeSkill(repo, path.join('.agents', 'skills'), 'ancestor-shared');
    writeSkill(root, path.join('.agents', 'skills'), 'above-repo');
    writeSkill(cwd, path.join('.pi', 'agent', 'skills'), 'legacy-path');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const items = projectItems(result);

    expect(items.map((item) => canonical(item.absolutePath))).toEqual(expect.arrayContaining([
      canonical(piSkill),
      canonical(localShared),
      canonical(ancestorShared),
    ]));
    expect(items.map((item) => item.name)).not.toContain('above-repo');
    expect(items.map((item) => item.name)).not.toContain('legacy-path');
    expect(items.every((item) => item.runtimeStatus === 'discovered')).toBe(true);
    expect(items.every((item) => item.workingDir === path.resolve(cwd))).toBe(true);
  });

  it('stops ancestor discovery at a nested repository root', async () => {
    const root = tempRoot();
    const outer = path.join(root, 'outer');
    const nested = path.join(outer, 'nested');
    const cwd = path.join(nested, 'src');
    mkdirSync(path.join(outer, '.git'), { recursive: true });
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeSkill(outer, path.join('.agents', 'skills'), 'outer-skill');
    writeSkill(nested, path.join('.agents', 'skills'), 'nested-skill');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const names = projectItems(result).map((item) => item.name);

    expect(names).toContain('nested-skill');
    expect(names).not.toContain('outer-skill');
  });

  it('treats a worktree-style .git file as the repository boundary', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'worktree');
    const cwd = path.join(repo, 'src');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(repo, '.git'), 'gitdir: /tmp/example-git-dir\n');
    writeSkill(repo, path.join('.agents', 'skills'), 'worktree-skill');
    writeSkill(root, path.join('.agents', 'skills'), 'above-worktree');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const names = projectItems(result).map((item) => item.name);

    expect(names).toContain('worktree-skill');
    expect(names).not.toContain('above-worktree');
  });

  it('treats an unreadable .git marker as a repository boundary', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'src');
    mkdirSync(cwd, { recursive: true });
    const canonicalRepo = canonical(repo);
    const canonicalCwd = canonical(cwd);
    const originalStat = fs.promises.stat;
    const stat = vi.fn(async (candidate: string) => {
      if (String(candidate) === path.join(canonicalRepo, '.git')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return originalStat(candidate) as Promise<fs.Stats>;
    });

    writeSkill(cwd, path.join('.pi', 'skills'), 'cwd-pi');
    writeSkill(cwd, path.join('.agents', 'skills'), 'cwd-agents');
    writeSkill(repo, path.join('.agents', 'skills'), 'repo-agents');
    writeSkill(root, path.join('.agents', 'skills'), 'above-repo');
    const result = await scanPiCustomizations({ workingDirs: [cwd] }, { stat });
    const projectDirs = projectItems(result).map((item) => path.dirname(item.absolutePath));

    expect(projectDirs.sort()).toEqual([
      path.join(canonicalCwd, '.pi', 'skills'),
      path.join(canonicalCwd, '.agents', 'skills'),
      path.join(canonicalRepo, '.agents', 'skills'),
    ].sort());
  });

  it('scans only the working directory .agents path outside Git repositories', async () => {
    const root = tempRoot();
    const cwd = path.join(root, 'parent', 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeSkill(root, path.join('parent', '.agents', 'skills'), 'parent-skill');
    writeSkill(cwd, path.join('.agents', 'skills'), 'cwd-skill');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const names = projectItems(result).map((item) => item.name);

    expect(names).toContain('cwd-skill');
    expect(names).not.toContain('parent-skill');
  });

  it('handles a Git root working directory and missing skill directories', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeSkill(repo, path.join('.agents', 'skills'), 'root-skill');

    const result = await scanPiCustomizations({ workingDirs: [repo] });

    expect(projectItems(result).filter((item) => item.name === 'root-skill')).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('returns an empty project result when every project skill directory is missing', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'src');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const result = await scanPiCustomizations({ workingDirs: [cwd] });

    expect(projectItems(result)).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('does not inherit ancestor skills for a missing working directory', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const missingCwd = path.join(repo, 'deleted-project');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeSkill(repo, path.join('.agents', 'skills'), 'ancestor-skill');

    const result = await scanPiCustomizations({ workingDirs: [missingCwd] });

    expect(projectItems(result)).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('keeps same-name skills from distinct project sources', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const cwd = path.join(repo, 'src');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const first = writeSkill(repo, path.join('.agents', 'skills'), 'duplicate');
    const second = writeSkill(cwd, path.join('.pi', 'skills'), 'duplicate');

    const result = await scanPiCustomizations({ workingDirs: [cwd] });
    const duplicates = projectItems(result).filter((item) => item.name === 'duplicate');

    expect(duplicates.map((item) => canonical(item.absolutePath))).toEqual(
      [canonical(first), canonical(second)].sort(),
    );
  });

  it.skipIf(!caseSensitiveEntrypoints)('does not advertise a project skill with only lowercase skill.md', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const skillDir = path.join(repo, '.pi', 'skills', 'lowercase');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'skill.md'), '# lowercase entrypoint\n');

    const result = await scanPiCustomizations({ workingDirs: [repo] });

    expect(projectItems(result)).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it.skipIf(!caseSensitiveEntrypoints)('prefers canonical SKILL.md when both entrypoint spellings exist', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const skillDir = writeSkill(repo, path.join('.pi', 'skills'), 'both');
    writeFileSync(path.join(skillDir, 'skill.md'), '# lowercase fallback\n');

    const result = await scanPiCustomizations({ workingDirs: [repo] });
    const found = projectItems(result).find((item) => item.name === 'both');

    expect(found?.mdPath).toBe(path.join(canonical(skillDir), 'SKILL.md'));
    expect(found?.description).toBe('both description');
  });

  it.skipIf(!canLinkDirectory)('rejects project skill folders that resolve outside the repository', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const outsideSkill = writeSkill(root, 'outside', 'linked-folder');
    const skillsDir = path.join(repo, '.pi', 'skills');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(
      outsideSkill,
      path.join(skillsDir, 'linked-folder'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await scanPiCustomizations({ workingDirs: [repo] });

    expect(projectItems(result).map((item) => item.name)).not.toContain('linked-folder');
    expect(result.errors).toEqual([]);
  });

  it.skipIf(!canLinkFile)('rejects project SKILL.md files that resolve outside the repository', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const skillDir = path.join(repo, '.pi', 'skills', 'linked-file');
    const outsideMd = path.join(root, 'outside-SKILL.md');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(outsideMd, '---\ndescription: external description\n---\n# External\n');
    symlinkSync(outsideMd, path.join(skillDir, 'SKILL.md'));

    const result = await scanPiCustomizations({ workingDirs: [repo] });

    expect(projectItems(result).map((item) => item.name)).not.toContain('linked-file');
    expect(result.errors).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('resolves a symlinked working directory for scanning while preserving its ownership path', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const physicalCwd = path.join(repo, 'src');
    const linkedCwd = path.join(root, 'linked-cwd');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(physicalCwd, { recursive: true });
    symlinkSync(physicalCwd, linkedCwd, 'dir');
    writeSkill(repo, path.join('.agents', 'skills'), 'repo-skill');

    const result = await scanPiCustomizations({ workingDirs: [linkedCwd] });
    const found = projectItems(result).find((item) => item.name === 'repo-skill');

    expect(found?.workingDir).toBe(path.resolve(linkedCwd));
    expect(canonical(found?.absolutePath ?? '')).toBe(canonical(path.join(repo, '.agents', 'skills', 'repo-skill')));
  });

  it.skipIf(process.platform === 'win32')('keeps lexical project aliases distinct for the same physical checkout', async () => {
    const root = tempRoot();
    const repo = path.join(root, 'repo');
    const linkedRepo = path.join(root, 'linked-repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    symlinkSync(repo, linkedRepo, 'dir');
    writeSkill(repo, path.join('.pi', 'skills'), 'aliased-skill');

    const items = projectItems(await scanPiCustomizations({ workingDirs: [repo, linkedRepo] }))
      .filter((item) => item.name === 'aliased-skill');

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.workingDir).sort()).toEqual([
      path.resolve(repo),
      path.resolve(linkedRepo),
    ].sort());
  });
});
