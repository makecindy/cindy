import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import { readInstalledGhostManual } from '../ghostManual';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ghost-manual-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

function manifest(): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'manual-demo',
    name: 'Manual Demo',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'run', description: 'Run the demo' }],
    manual: {
      items: [
        {
          dir: 'docs/physical-dir',
          name: 'logical-name',
          description: '完整工作流',
        },
      ],
    },
  };
}

function ghost(manualDir = 'docs/physical-dir'): InstalledGhost {
  const ghostManifest = manifest();
  ghostManifest.manual!.items[0]!.dir = manualDir;
  return {
    manifest: ghostManifest,
    dir: workDir,
    enabled: true,
    trust: {
      level: 'unverified',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: false,
    },
  };
}

async function write(relativePath: string, content: string | Buffer): Promise<void> {
  const target = path.join(workDir, relativePath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, content);
}

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`private ${code} detail`), { code });
}

describe('readInstalledGhostManual', () => {
  it('根索引只投影逻辑 name，逻辑路径映射到不同的物理 dir', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    expect(await readInstalledGhostManual(ghost())).toEqual({
      ok: true,
      manual: [{ name: 'logical-name', description: '完整工作流' }],
      content: '',
    });
    expect(await readInstalledGhostManual(ghost(), 'logical-name')).toEqual({
      ok: true,
      manual: [],
      content: '# 入口',
    });
  });

  it('深层路径不做 URL decode，且不能越过声明单元读取插件其它文件', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write('docs/physical-dir/references/%2e%2e.md', '# 百分号文件');
    await write('main.js', 'PRIVATE');
    expect(
      await readInstalledGhostManual(ghost(), 'logical-name/references/%2e%2e.md'),
    ).toMatchObject({ ok: true, content: '# 百分号文件' });
    const escaped = await readInstalledGhostManual(ghost(), 'logical-name/../main.js');
    expect(escaped).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
    });
    expect(JSON.stringify(escaped)).not.toContain('PRIVATE');
    expect(JSON.stringify(escaped)).not.toContain(workDir);
  });

  it('未知单元返回根索引；普通子文件写错返回可直接回填的完整逻辑路径', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write('docs/physical-dir/references/flow.md', '# 流程');
    const unknown = await readInstalledGhostManual(ghost(), 'unknown');
    expect(unknown).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
      manual: [{ name: 'logical-name' }],
    });
    const missing = await readInstalledGhostManual(ghost(), 'logical-name/references/missing.md');
    expect(missing).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
      manual: expect.arrayContaining([
        { name: 'logical-name', description: '完整工作流' },
        {
          name: 'logical-name/references/flow.md',
          description: expect.any(String),
        },
      ]),
    });
    expect(missing.manual.map((candidate) => candidate.name)).toEqual([
      'logical-name',
      'logical-name/references/flow.md',
    ]);
    for (const candidate of missing.manual) {
      expect(await readInstalledGhostManual(ghost(), candidate.name)).toMatchObject({ ok: true });
    }
  });

  it('只有省略 path 才返回成功根索引，已知单元下的非法路径返回该单元候选', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    expect(await readInstalledGhostManual(ghost(), '')).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
    });
    const invalid = await readInstalledGhostManual(ghost(), 'logical-name/../main.md');
    expect(invalid).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
      manual: [{ name: 'logical-name' }],
    });
    for (const invalidPath of [
      `logical-name/bad${String.fromCharCode(1)}name.md`,
      `logical-name/bad${String.fromCharCode(0x7f)}name.md`,
      'logical-name\\windows.md',
      `logical-name/${'a'.repeat(1025)}`,
    ]) {
      expect(await readInstalledGhostManual(ghost(), invalidPath), invalidPath).toMatchObject({
        ok: false,
        errorCode: 'MANUAL_PATH_NOT_FOUND',
        manual: [{ name: 'logical-name' }],
      });
    }
  });

  it('候选同时受条数与字节预算限制，并显式标注截断', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    for (let index = 0; index < 50; index += 1) {
      await write(
        `docs/physical-dir/references/very-long-candidate-${String(index).padStart(2, '0')}.md`,
        '# 候选',
      );
    }
    const result = await readInstalledGhostManual(ghost(), 'logical-name/missing.md');
    expect(result).toMatchObject({ ok: false, errorCode: 'MANUAL_PATH_NOT_FOUND' });
    expect(result.manual.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify(result.manual), 'utf8')).toBeLessThanOrEqual(4096);
    expect(result.manual.some((candidate) => candidate.description.includes('候选已截断'))).toBe(
      true,
    );
    expect(result.manual.every((candidate) => candidate.name.startsWith('logical-name'))).toBe(
      true,
    );
  });

  it('声明目录的中间层符号链接不能逃出插件安装根', async () => {
    if (process.platform === 'win32') return;
    const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-manual-outside-'));
    try {
      await fs.promises.mkdir(path.join(workDir, 'docs'), { recursive: true });
      await fs.promises.writeFile(path.join(outsideDir, 'MANUAL.md'), '# 根外私密正文');
      await fs.promises.symlink(outsideDir, path.join(workDir, 'docs/physical-dir'));
      const result = await readInstalledGhostManual(ghost(), 'logical-name');
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'MANUAL_UNAVAILABLE',
        manual: [],
        content: '',
      });
      expect(JSON.stringify(result)).not.toContain('根外私密正文');
      expect(JSON.stringify(result)).not.toContain(outsideDir);
    } finally {
      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('item.dir 任一中间组件是根内或根外 symlink 都不可用，普通中间目录可读', async () => {
    if (process.platform === 'win32') return;
    await write('docs/plain/unit/MANUAL.md', '# 普通中间目录');
    expect(await readInstalledGhostManual(ghost('docs/plain/unit'), 'logical-name')).toMatchObject({
      ok: true,
      content: '# 普通中间目录',
    });

    const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-manual-parent-'));
    try {
      await write('real-inside/unit/MANUAL.md', '# 根内正文');
      await fs.promises.mkdir(path.join(outsideDir, 'unit'), { recursive: true });
      await fs.promises.writeFile(path.join(outsideDir, 'unit/MANUAL.md'), '# 根外正文');
      await fs.promises.mkdir(path.join(workDir, 'docs'), { recursive: true });
      for (const [target, secret] of [
        [path.join(workDir, 'real-inside'), '根内正文'],
        [outsideDir, '根外正文'],
      ] as const) {
        const linkPath = path.join(workDir, 'docs/link');
        await fs.promises.rm(linkPath, { force: true });
        await fs.promises.symlink(target, linkPath);
        const result = await readInstalledGhostManual(ghost('docs/link/unit'), 'logical-name');
        expect(result).toMatchObject({
          ok: false,
          errorCode: 'MANUAL_UNAVAILABLE',
          manual: [],
          content: '',
        });
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(target);
      }
    } finally {
      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('入口缺失、超限、非法 UTF-8 与符号链接都返回 MANUAL_UNAVAILABLE 且不给候选', async () => {
    const assertUnavailable = async (): Promise<void> => {
      for (const requestedPath of ['logical-name', 'logical-name/references/missing.md']) {
        expect(await readInstalledGhostManual(ghost(), requestedPath)).toMatchObject({
          ok: false,
          errorCode: 'MANUAL_UNAVAILABLE',
          manual: [],
          content: '',
        });
      }
    };

    await fs.promises.mkdir(path.join(workDir, 'docs/physical-dir'), { recursive: true });
    await assertUnavailable();

    await write('docs/physical-dir/MANUAL.md', 'x'.repeat(64 * 1024 + 1));
    await assertUnavailable();

    await write('docs/physical-dir/MANUAL.md', Buffer.from([0xff, 0xfe, 0xfd]));
    await assertUnavailable();

    if (process.platform !== 'win32') {
      const target = path.join(workDir, 'outside.md');
      await fs.promises.writeFile(target, '# outside');
      await fs.promises.rm(path.join(workDir, 'docs/physical-dir/MANUAL.md'));
      await fs.promises.symlink(target, path.join(workDir, 'docs/physical-dir/MANUAL.md'));
      await assertUnavailable();
    }
  });

  it('单元内的中间目录符号链接无论指向根内还是根外都不可读取', async () => {
    if (process.platform === 'win32') return;
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write('docs/physical-dir/real-inside/private.md', '# 根内私密正文');
    const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-manual-child-'));
    try {
      await fs.promises.writeFile(path.join(outsideDir, 'private.md'), '# 根外私密正文');
      for (const [linkName, target, secret] of [
        ['inside-link', path.join(workDir, 'docs/physical-dir/real-inside'), '根内私密正文'],
        ['outside-link', outsideDir, '根外私密正文'],
      ] as const) {
        await fs.promises.symlink(target, path.join(workDir, `docs/physical-dir/${linkName}`));
        const result = await readInstalledGhostManual(
          ghost(),
          `logical-name/${linkName}/private.md`,
        );
        expect(result).toMatchObject({
          ok: false,
          errorCode: 'MANUAL_UNAVAILABLE',
          manual: [],
          content: '',
        });
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(target);
      }
    } finally {
      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it.each(['EIO', 'EACCES'])(
    '目标文件 lstat 返回 %s 时归 MANUAL_UNAVAILABLE 且不回填候选',
    async (code) => {
      await write('docs/physical-dir/MANUAL.md', '# 入口');
      await write('docs/physical-dir/references/flow.md', '# 流程');
      const originalLstat = fs.promises.lstat.bind(fs.promises);
      vi.spyOn(fs.promises, 'lstat').mockImplementation(
        ((target: fs.PathLike, options?: fs.StatOptions) => {
          if (String(target).endsWith(path.join('references', 'blocked.md'))) {
            return Promise.reject(fsError(code));
          }
          return originalLstat(target, options as never);
        }) as typeof fs.promises.lstat,
      );
      const result = await readInstalledGhostManual(ghost(), 'logical-name/references/blocked.md');
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'MANUAL_UNAVAILABLE',
        manual: [],
        content: '',
      });
      expect(JSON.stringify(result)).not.toContain(code);
      expect(JSON.stringify(result)).not.toContain(workDir);
    },
  );

  it('目标文件 lstat 返回 ENOTDIR 仍按普通未命中返回候选，且不回填原错误路径', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write('docs/physical-dir/references/flow.md', '# 流程');
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(
      ((target: fs.PathLike, options?: fs.StatOptions) => {
        if (String(target).endsWith(path.join('references', 'missing.md'))) {
          return Promise.reject(fsError('ENOTDIR'));
        }
        return originalLstat(target, options as never);
      }) as typeof fs.promises.lstat,
    );
    const requested = 'logical-name/references/missing.md';
    const result = await readInstalledGhostManual(ghost(), requested);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
    });
    expect(result.manual.map((candidate) => candidate.name)).toContain(
      'logical-name/references/flow.md',
    );
    expect(result.manual.some((candidate) => candidate.name === requested)).toBe(false);
  });

  it('请求的中间父段是普通文件时按错误调用返回候选', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write('docs/physical-dir/topic.md', '# 主题');
    const requested = 'logical-name/topic.md/child.md';
    const result = await readInstalledGhostManual(ghost(), requested);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
    });
    expect(result.manual.map((candidate) => candidate.name)).toContain('logical-name/topic.md');
    expect(result.manual.some((candidate) => candidate.name === requested)).toBe(false);
  });

  it('请求的中间父段是特殊文件时仍归 MANUAL_UNAVAILABLE', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(
      ((target: fs.PathLike, options?: fs.StatOptions) => {
        if (String(target).endsWith(path.join('physical-dir', 'special-parent'))) {
          return Promise.resolve({
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => false,
          } as fs.Stats);
        }
        return originalLstat(target, options as never);
      }) as typeof fs.promises.lstat,
    );
    const result = await readInstalledGhostManual(ghost(), 'logical-name/special-parent/child.md');
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_UNAVAILABLE',
      manual: [],
      content: '',
    });
    expect(JSON.stringify(result)).not.toContain(workDir);
  });

  it('最终目标是普通目录时按错误调用返回该单元候选', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write('docs/physical-dir/chapter.md/next.md', '# 下一章');
    const requested = 'logical-name/chapter.md';
    const result = await readInstalledGhostManual(ghost(), requested);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_PATH_NOT_FOUND',
    });
    expect(result.manual.map((candidate) => candidate.name)).toContain(
      'logical-name/chapter.md/next.md',
    );
    expect(result.manual.some((candidate) => candidate.name === requested)).toBe(false);
  });

  it('最终目标是符号链接或特殊文件时仍归 MANUAL_UNAVAILABLE', async () => {
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write('docs/physical-dir/target.md', '# 正文');
    if (process.platform !== 'win32') {
      await fs.promises.symlink(
        path.join(workDir, 'docs/physical-dir/target.md'),
        path.join(workDir, 'docs/physical-dir/link.md'),
      );
      expect(await readInstalledGhostManual(ghost(), 'logical-name/link.md')).toMatchObject({
        ok: false,
        errorCode: 'MANUAL_UNAVAILABLE',
        manual: [],
      });
    }

    const originalLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(
      ((target: fs.PathLike, options?: fs.StatOptions) => {
        if (String(target).endsWith(path.join('physical-dir', 'special.md'))) {
          return Promise.resolve({
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => false,
          } as fs.Stats);
        }
        return originalLstat(target, options as never);
      }) as typeof fs.promises.lstat,
    );
    const special = await readInstalledGhostManual(ghost(), 'logical-name/special.md');
    expect(special).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_UNAVAILABLE',
      manual: [],
      content: '',
    });
    expect(JSON.stringify(special)).not.toContain(workDir);
  });

  it.each(['ENOENT', 'ENOTDIR'])(
    '候选递归 readdir 返回 %s 时按普通未命中处理，并保留同单元其它候选',
    async (code) => {
      await write('docs/physical-dir/MANUAL.md', '# 入口');
      await write('docs/physical-dir/a-disappeared/old.md', '# 消失');
      await write('docs/physical-dir/z-surviving/flow.md', '# 流程');
      const originalReaddir = fs.promises.readdir.bind(fs.promises);
      vi.spyOn(fs.promises, 'readdir').mockImplementation(async (target, options) => {
        if (String(target).endsWith(path.join('physical-dir', 'a-disappeared'))) {
          throw fsError(code);
        }
        return originalReaddir(target, options as never) as never;
      });
      const requested = 'logical-name/missing.md';
      const result = await readInstalledGhostManual(ghost(), requested);
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'MANUAL_PATH_NOT_FOUND',
      });
      expect(result.manual.map((candidate) => candidate.name)).toContain(
        'logical-name/z-surviving/flow.md',
      );
      expect(result.manual.some((candidate) => candidate.name === requested)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(code);
      expect(JSON.stringify(result)).not.toContain(workDir);
    },
  );

  it.each(['EIO', 'EACCES'])(
    '候选 readdir 返回 %s 时归 MANUAL_UNAVAILABLE，不吞错误或返回候选',
    async (code) => {
      await write('docs/physical-dir/MANUAL.md', '# 入口');
      await write('docs/physical-dir/references/flow.md', '# 流程');
      vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(fsError(code));
      const result = await readInstalledGhostManual(ghost(), 'logical-name/references/missing.md');
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'MANUAL_UNAVAILABLE',
        manual: [],
        content: '',
      });
      expect(JSON.stringify(result)).not.toContain(code);
      expect(JSON.stringify(result)).not.toContain(workDir);
    },
  );

  it('候选扫描发现不可调用的制品路径时归 MANUAL_UNAVAILABLE', async () => {
    if (process.platform === 'win32') return;
    await write('docs/physical-dir/MANUAL.md', '# 入口');
    await write(`docs/physical-dir/bad${String.fromCharCode(1)}name.md`, '# invalid');
    const result = await readInstalledGhostManual(ghost(), 'logical-name/missing.md');
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_UNAVAILABLE',
      manual: [],
      content: '',
    });
  });

  it('64KB 正文可完整穿过固定 JSON 信封，64KB+1 被拒', async () => {
    const content = '甲'.repeat(Math.floor((64 * 1024) / 3));
    await write('docs/physical-dir/MANUAL.md', content);
    const result = await readInstalledGhostManual(ghost(), 'logical-name');
    expect(result).toMatchObject({ ok: true, content });
    const wire = JSON.stringify(result);
    expect(Buffer.byteLength(wire, 'utf8')).toBeGreaterThan(Buffer.byteLength(content, 'utf8'));
    expect(JSON.parse(wire)).toEqual(result);

    await write('docs/physical-dir/MANUAL.md', 'x'.repeat(64 * 1024 + 1));
    expect(await readInstalledGhostManual(ghost(), 'logical-name')).toMatchObject({
      ok: false,
      errorCode: 'MANUAL_UNAVAILABLE',
    });
  });
});
