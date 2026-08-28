import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-learn-staging-test-'));

// Windows 未开发者模式/无特权时创建文件 symlink 会 EPERM(junction 只适用于目录);
// 探测一次,不可用则跳过依赖文件 symlink 的用例。
const canSymlink = (() => {
  const probe = path.join(os.tmpdir(), `xdt-symlink-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.symlinkSync(`${probe}-target`, probe, 'file');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => path.join(TEST_ROOT, 'userData')) },
}));
vi.mock('../../appSessionState', () => ({
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(TEST_ROOT, 'userData', 'owners', 'test-owner', ...parts),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  maskPath: (p: string) => p,
}));

import {
  cleanupStaging,
  collectProposalFiles,
  computeTargetDirFingerprint,
  freezeProposal,
  scanStaging,
  stagingDirForRun,
  stripUnreviewedEntries,
  unfreezeProposal,
} from '../staging';
import { MAX_PROPOSAL_FILES } from '../stagingValidation.pure';

beforeEach(async () => {
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
});

async function seedSkill(runId: string, name: string): Promise<string> {
  const dir = path.join(stagingDirForRun(runId), name);
  await fs.promises.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: t.\n---\nBody`, 'utf8');
  await fs.promises.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi', 'utf8');
  return dir;
}

describe('scanStaging 审查集一致性', () => {
  it.skipIf(!canSymlink)('symlink 记为 violation 且不进文件清单', async () => {
    const dir = await seedSkill('run-1', 'my-skill');
    await fs.promises.symlink('/etc/hosts', path.join(dir, 'scripts', 'evil-link'));

    const { candidates } = await scanStaging('run-1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].violations).toEqual(['scripts/evil-link']);
    expect(candidates[0].files.map((f) => f.relPath).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
  });

  it('噪声目录与打包忽略路径(.env 等敏感文件)不进审查集', async () => {
    const dir = await seedSkill('run-2', 'my-skill');
    await fs.promises.mkdir(path.join(dir, '.git'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, '.git', 'config'), 'x', 'utf8');
    await fs.promises.writeFile(path.join(dir, '.env'), 'SECRET=1', 'utf8');

    const { candidates } = await scanStaging('run-2');
    expect(candidates[0].violations).toEqual([]);
    expect(candidates[0].files.map((f) => f.relPath).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
  });
});

describe('stripUnreviewedEntries(apply 落盘剥除)', () => {
  it.skipIf(!canSymlink)('删除噪声目录、忽略路径与 symlink,保留审查过的文件', async () => {
    const dir = await seedSkill('run-3', 'my-skill');
    await fs.promises.mkdir(path.join(dir, '.git'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, '.git', 'config'), 'x', 'utf8');
    await fs.promises.writeFile(path.join(dir, '.env'), 'SECRET=1', 'utf8');
    await fs.promises.symlink('/etc/hosts', path.join(dir, 'link'));

    await stripUnreviewedEntries(dir);

    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'scripts', 'run.sh'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'link'))).toBe(false);
  });

  it('未审查路径删除失败时拒绝 apply 继续落盘', async () => {
    const dir = await seedSkill('run-3b', 'my-skill');
    const ignored = path.join(dir, '.env');
    await fs.promises.writeFile(ignored, 'SECRET=1', 'utf8');

    const realRm = fs.promises.rm.bind(fs.promises);
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === ignored) throw new Error('locked');
      return realRm(target, options);
    });
    try {
      await expect(stripUnreviewedEntries(dir)).rejects.toThrow('failed to strip unreviewed entry .env');
      expect(fs.existsSync(ignored)).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });
});

describe('freezeProposal / unfreezeProposal(apply 的 TOCTOU 防线)', () => {
  it('冻结把提案目录 rename 出 staging;此后 staging 写入不影响冻结副本', async () => {
    const dir = await seedSkill('run-4', 'my-skill');
    const frozen = await freezeProposal('run-4', 'my-skill');

    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(frozen, 'SKILL.md'))).toBe(true);

    // 模拟修订回合的迟到写入:staging 里重建同名目录 + 塞新文件
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'late.md'), 'unreviewed', 'utf8');
    const { files } = await collectProposalFiles(frozen);
    expect(files.map((f) => f.relPath).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
  });

  it('unfreeze 放回 staging;staging 已有更新的同名目录时以会话产物为准', async () => {
    const dir = await seedSkill('run-5', 'my-skill');
    const frozen = await freezeProposal('run-5', 'my-skill');
    await unfreezeProposal(frozen, 'run-5');
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(frozen)).toBe(false);

    // 再冻结,此间会话重建了同名目录 → unfreeze 丢弃冻结副本,保留新产物
    const frozen2 = await freezeProposal('run-5', 'my-skill');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'SKILL.md'), 'newer', 'utf8');
    await unfreezeProposal(frozen2, 'run-5');
    expect(await fs.promises.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe('newer');
    expect(fs.existsSync(path.dirname(frozen2))).toBe(false);
  });
});

describe('collectFiles 内容哈希', () => {
  it('二进制文件带 contentHash(同尺寸换字节可被 apply 指纹识别)', async () => {
    const dir = await seedSkill('run-6', 'my-skill');
    await fs.promises.writeFile(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));

    const { candidates } = await scanStaging('run-6');
    const bin = candidates[0].files.find((f) => f.relPath === 'logo.bin');
    expect(bin?.text).toBeNull();
    expect(bin?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const text = candidates[0].files.find((f) => f.relPath === 'SKILL.md');
    expect(text?.contentHash).toBeUndefined();
  });
});

describe('cleanupStaging 冻结区收尾 / 超大文件防线', () => {
  it('cleanupStaging 连同 apply 冻结区 wrapper 一起清(成功路径不留空壳)', async () => {
    await seedSkill('run-7', 'my-skill');
    const frozen = await freezeProposal('run-7', 'my-skill');
    // 模拟 applyProposal 把冻结提案 moveDir 走,只剩 wrapper 空壳
    await fs.promises.rm(frozen, { recursive: true, force: true });
    await cleanupStaging('run-7');
    expect(fs.existsSync(stagingDirForRun('run-7'))).toBe(false);
    expect(fs.existsSync(path.dirname(frozen))).toBe(false);
  });

  it('单文件超过提案总量上限:不读整文件,记违规拒绝', async () => {
    const dir = await seedSkill('run-8', 'my-skill');
    const big = path.join(dir, 'huge.bin');
    // 稀疏写:seek 到上限+1 处写 1 字节,不真占 20MB 磁盘
    const fd = await fs.promises.open(big, 'w');
    await fd.write(Buffer.from([1]), 0, 1, 20 * 1024 * 1024);
    await fd.close();

    const { candidates } = await scanStaging('run-8');
    expect(candidates[0].violations).toEqual(['huge.bin']);
    expect(candidates[0].files.map((f) => f.relPath)).not.toContain('huge.bin');
  });

  it('文件数超过上限后停止读取后续文件,记违规拒绝', async () => {
    const dir = await seedSkill('run-9', 'my-skill');
    const assets = path.join(dir, 'assets');
    await fs.promises.mkdir(assets, { recursive: true });
    for (let i = 0; i < MAX_PROPOSAL_FILES + 5; i += 1) {
      await fs.promises.writeFile(path.join(assets, `f-${String(i).padStart(3, '0')}.txt`), 'x', 'utf8');
    }

    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const { candidates } = await scanStaging('run-9');
    const readCalls = readSpy.mock.calls.length;
    readSpy.mockRestore();

    expect(candidates[0].violations).toHaveLength(1);
    expect(candidates[0].files.length).toBeLessThanOrEqual(MAX_PROPOSAL_FILES);
    expect(readCalls).toBeLessThanOrEqual(MAX_PROPOSAL_FILES);
  });
});

describe('collectFiles 累计帽 / 目标目录指纹', () => {
  it('文件数超帽即停读并记违规(不为注定被拒的提案做全量读盘)', async () => {
    const dir = await seedSkill('run-9', 'my-skill');
    for (let i = 0; i < 205; i += 1) {
      await fs.promises.writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.md`), 'x', 'utf8');
    }
    const { candidates } = await scanStaging('run-9');
    // 超帽即记违规(实现记录首个超帽文件的相对路径)并停止收集
    expect(candidates[0].violations.length).toBeGreaterThan(0);
    expect(candidates[0].files.length).toBeLessThanOrEqual(200);
  });

  it('computeTargetDirFingerprint 覆盖 package-ignored 条目(.env 变化必须动指纹)', async () => {
    const dir = await seedSkill('run-10', 'my-skill');
    const target = path.join(dir); // 任意目录即可
    const fp1 = await computeTargetDirFingerprint(target);
    await fs.promises.writeFile(path.join(target, '.env'), 'SECRET=1', 'utf8');
    const fp2 = await computeTargetDirFingerprint(target);
    expect(fp2).not.toBe(fp1);
    await fs.promises.writeFile(path.join(target, '.env'), 'SECRET=22', 'utf8');
    const fp3 = await computeTargetDirFingerprint(target);
    expect(fp3).not.toBe(fp2);
  });
});
