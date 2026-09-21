import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { fetchHubSkillReference, type HubSkillReferenceReader } from '../hubReference';

function makeReader(overrides: Partial<HubSkillReferenceReader> = {}): HubSkillReferenceReader {
  return {
    info: vi.fn(async () => ({ info: { description: 'demo description' } })),
    readPublishedFile: vi.fn(async ({ path }) => ({
      file: {
        path,
        size: path === 'SKILL.md' ? 10 : 5,
        language: 'markdown',
        truncated: false,
        content: path === 'SKILL.md' ? '# Skill' : '# Extra',
      },
    })),
    getPublishedFiles: vi.fn(async () => ({
      files: [
        { path: 'SKILL.md', size: 10, language: 'markdown', truncated: false },
        { path: 'scripts/run.py', size: 5, language: 'python', truncated: false },
      ],
    })),
    ...overrides,
  };
}

describe('fetchHubSkillReference', () => {
  it('rejects a truncated primary SKILL.md reference', async () => {
    const reader = makeReader({
      readPublishedFile: vi.fn(async () => ({
        file: {
          path: 'SKILL.md',
          size: 1024,
          language: 'markdown',
          truncated: true,
          content: '# Partial',
        },
      })),
    });

    await expect(fetchHubSkillReference(reader, 'demo-skill')).resolves.toBeNull();
    expect(reader.getPublishedFiles).not.toHaveBeenCalled();
  });

  it('keeps complete auxiliary files and skips truncated ones', async () => {
    const reader = makeReader({
      getPublishedFiles: vi.fn(async () => ({
        files: [
          { path: 'scripts/ok.py', size: 5, language: 'python', truncated: false },
          { path: 'scripts/large.py', size: 5, language: 'python', truncated: true },
        ],
      })),
      readPublishedFile: vi.fn(async ({ path }) => ({
        file: {
          path,
          size: 5,
          language: 'markdown',
          truncated: path === 'scripts/large.py',
          content: path === 'SKILL.md' ? '# Skill' : `content:${path}`,
        },
      })),
    });

    const ref = await fetchHubSkillReference(reader, 'demo-skill');

    expect(ref).toMatchObject({
      name: 'demo-skill',
      description: 'demo description',
      content: '# Skill',
      files: [{ path: 'scripts/ok.py', content: 'content:scripts/ok.py' }],
      omittedFiles: [{ path: 'scripts/large.py', reason: 'metadata marked the file as truncated' }],
    });
    expect(reader.readPublishedFile).not.toHaveBeenCalledWith({ name: 'demo-skill', path: 'scripts/large.py' });
  });

  it('keeps the originating catalog scope on every Hub read', async () => {
    const reader = makeReader();

    await fetchHubSkillReference(reader, 'demo-skill', 'team');

    expect(reader.info).toHaveBeenCalledWith('demo-skill', 'team');
    expect(reader.getPublishedFiles).toHaveBeenCalledWith({ name: 'demo-skill', catalogScope: 'team' });
    expect(reader.readPublishedFile).toHaveBeenCalledWith({
      name: 'demo-skill',
      path: 'SKILL.md',
      catalogScope: 'team',
    });
    expect(reader.readPublishedFile).toHaveBeenCalledWith({
      name: 'demo-skill',
      path: 'scripts/run.py',
      catalogScope: 'team',
    });
  });

  it('surfaces files omitted by the reference file cap', async () => {
    const auxFiles = Array.from({ length: 42 }, (_, i) => ({
      path: `scripts/${i}.py`,
      size: 5,
      language: 'python',
      truncated: false,
    }));
    const reader = makeReader({
      getPublishedFiles: vi.fn(async () => ({
        files: [
          { path: 'SKILL.md', size: 10, language: 'markdown', truncated: false },
          ...auxFiles,
        ],
      })),
      readPublishedFile: vi.fn(async ({ path }) => ({
        file: {
          path,
          size: 5,
          language: 'markdown',
          truncated: false,
          content: path === 'SKILL.md' ? '# Skill' : `content:${path}`,
        },
      })),
    });

    const ref = await fetchHubSkillReference(reader, 'demo-skill');

    expect(ref?.files).toHaveLength(40);
    expect(ref?.omittedFiles).toEqual([
      { path: 'scripts/40.py', reason: 'not fetched; reference file limit is 40' },
      { path: 'scripts/41.py', reason: 'not fetched; reference file limit is 40' },
    ]);
    expect(reader.readPublishedFile).not.toHaveBeenCalledWith({ name: 'demo-skill', path: 'scripts/40.py' });
  });

  it('caps the omission list itself and summarizes the overflow (huge skill package)', async () => {
    // 500 个辅助文件:内容取前 40,省略清单逐条列到 40 条为止,
    // 其余 420 条收敛成一条「+N more」汇总 —— 注入 prompt 的清单尺寸有上界。
    const auxFiles = Array.from({ length: 500 }, (_, i) => ({
      path: `scripts/${i}.py`,
      size: 5,
      language: 'python',
      truncated: false,
    }));
    const reader = makeReader({
      getPublishedFiles: vi.fn(async () => ({
        files: [{ path: 'SKILL.md', size: 10, language: 'markdown', truncated: false }, ...auxFiles],
      })),
      readPublishedFile: vi.fn(async ({ path }) => ({
        file: {
          path,
          size: 5,
          language: 'markdown',
          truncated: false,
          content: path === 'SKILL.md' ? '# Skill' : `content:${path}`,
        },
      })),
    });

    const ref = await fetchHubSkillReference(reader, 'demo-skill');

    expect(ref?.files).toHaveLength(40);
    // 40 条逐文件 + 1 条汇总 = 41,不随包体膨胀
    expect(ref?.omittedFiles).toHaveLength(41);
    expect(ref?.omittedFiles?.at(-1)).toEqual({
      path: '(+420 more files)',
      reason: 'omission list capped at 40 entries',
    });
  });
});

describe('主 SKILL.md 大小上限', () => {
  it('主文件超 512KB(未标 truncated)按不可用处理,不进蒸馏 prompt', async () => {
    const big = 'x'.repeat(512 * 1024 + 1);
    const reader: HubSkillReferenceReader = {
      info: async () => ({ info: { description: 'd' } }),
      readPublishedFile: async () => ({
        file: { path: 'SKILL.md', size: big.length, language: 'md', truncated: false, content: big },
      }),
      getPublishedFiles: async () => ({ files: [] }),
    };
    const result = await fetchHubSkillReference(reader, 'big-skill');
    expect(result).toBeNull();
  });
});
