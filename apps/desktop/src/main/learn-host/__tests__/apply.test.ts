import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-learn-apply-test-'));

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
vi.mock('../../authManager', () => ({
  getCurrentUserId: vi.fn(() => 'user-1'),
}));
vi.mock('../../skillhub/registry', () => ({
  registryService: { addInstall: vi.fn(async () => {}) },
}));
vi.mock('../../skillhub/folderHash', () => ({
  computeFolderHash: vi.fn(async () => 'hash-abc'),
}));
vi.mock('../../skillhub/installService', () => ({
  ensureSymlinkToShared: vi.fn(async () => {}),
}));
vi.mock('../../maker-host/shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: vi.fn(async () => ({ warnings: [] })),
  prepareSharedProjectSkillLinks: vi.fn(async () => ({ warnings: [] })),
}));

import { applyProposal } from '../apply';
import { registryService } from '../../skillhub/registry';

// apply.ts 里 globalSkillsDir 基于 os.homedir() —— 测试里改写 HOME 不可靠,
// 直接 mock os.homedir 到测试根。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => path.join(TEST_ROOT, 'home') },
    homedir: () => path.join(TEST_ROOT, 'home'),
  };
});

const HOME = path.join(TEST_ROOT, 'home');
const SKILLS_DIR = path.join(HOME, '.agents', 'skills');

const provenance = {
  method: 'learn' as const,
  sourceKind: 'freetext' as const,
  usedSessionEvidence: true,
  personal: true,
  learnedAt: 1750000000,
  runId: 'run-1',
};

async function makeProposal(name: string): Promise<string> {
  const dir = path.join(TEST_ROOT, 'staging', 'run-1', name);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: t.\n---\nBody`, 'utf8');
  return dir;
}

beforeEach(async () => {
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('applyProposal', () => {
  it('moves the proposal into ~/.agents/skills and registers provenance', async () => {
    const proposalDir = await makeProposal('new-skill');
    const result = await applyProposal({ proposalDir, skillName: 'new-skill', provenance });

    // folderHash 基于剥除后的 finalDir 计算(Greptile 修正:先算后剥会失真)
    const { computeFolderHash } = await import('../../skillhub/folderHash');
    expect(vi.mocked(computeFolderHash)).toHaveBeenCalledWith(path.join(SKILLS_DIR, 'new-skill'));

    expect(result.absolutePath).toBe(path.join(SKILLS_DIR, 'new-skill'));
    expect(fs.existsSync(path.join(SKILLS_DIR, 'new-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(proposalDir)).toBe(false);
    expect(registryService.addInstall).toHaveBeenCalledWith(
      'new-skill',
      path.join(SKILLS_DIR, 'new-skill'),
      expect.objectContaining({ origin: 'learned', provenance, authorId: 'user-1', folderHash: 'hash-abc' }),
    );
  });

  it('backs up an existing skill dir and reports the backup path', async () => {
    const existing = path.join(SKILLS_DIR, 'old-skill');
    await fs.promises.mkdir(existing, { recursive: true });
    await fs.promises.writeFile(path.join(existing, 'SKILL.md'), 'old content', 'utf8');
    const proposalDir = await makeProposal('old-skill');

    const result = await applyProposal({ proposalDir, skillName: 'old-skill', provenance });

    expect(result.replacedBackupPath).toBeDefined();
    expect(fs.readFileSync(path.join(result.replacedBackupPath!, 'SKILL.md'), 'utf8')).toBe('old content');
    expect(fs.readFileSync(path.join(SKILLS_DIR, 'old-skill', 'SKILL.md'), 'utf8')).toContain('name: old-skill');
  });

  it('Claude 侧真实 skill 目录:先挪备份再落 symlink(不让 Claude 继续加载旧版)', async () => {
    // 场景:被改进的原 skill 本体住在 ~/.claude/skills/<name>,共享链接流程把它
    // symlink 进 ~/.agents。ensureSymlinkToShared 对真实目录静默跳过 —— apply
    // 必须先把真实目录挪去备份,否则 Claude 继续加载旧版而 apply 报成功。
    const claudeDir = path.join(HOME, '.claude', 'skills', 'linked-skill');
    await fs.promises.mkdir(claudeDir, { recursive: true });
    await fs.promises.writeFile(path.join(claudeDir, 'SKILL.md'), 'old claude content', 'utf8');
    const proposalDir = await makeProposal('linked-skill');

    const sharedLink = path.join(SKILLS_DIR, 'linked-skill');
    await fs.promises.mkdir(path.dirname(sharedLink), { recursive: true });
    // 'junction':Windows 无特权也能建目录链接(POSIX 下该参数被忽略,行为不变)。
    await fs.promises.symlink(claudeDir, sharedLink, 'junction');

    const result = await applyProposal({ proposalDir, skillName: 'linked-skill', provenance });

    // 真实目录已被挪走(备份在 owner-scoped learn/backups/),symlink helper 被调用
    expect(fs.existsSync(claudeDir)).toBe(false);
    const backupsRoot = path.join(TEST_ROOT, 'userData', 'owners', 'test-owner', 'learn', 'backups');
    const backups = fs.readdirSync(backupsRoot).filter((n) => n.startsWith('linked-skill-claude-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupsRoot, backups[0], 'SKILL.md'), 'utf8')).toBe('old claude content');
    expect(result.replacedBackupPath).toBe(path.join(backupsRoot, backups[0]));
    const { ensureSymlinkToShared } = await import('../../skillhub/installService');
    expect(vi.mocked(ensureSymlinkToShared)).toHaveBeenCalledWith(
      claudeDir,
      path.join(SKILLS_DIR, 'linked-skill'),
    );
  });

  it('Claude 侧真实目录替换失败时中止 apply 并恢复旧目录', async () => {
    const { ensureSymlinkToShared } = await import('../../skillhub/installService');
    vi.mocked(ensureSymlinkToShared).mockRejectedValueOnce(new Error('link failed'));
    const claudeDir = path.join(HOME, '.claude', 'skills', 'linked-skill');
    await fs.promises.mkdir(claudeDir, { recursive: true });
    await fs.promises.writeFile(path.join(claudeDir, 'SKILL.md'), 'old claude content', 'utf8');
    const proposalDir = await makeProposal('linked-skill');

    await expect(applyProposal({ proposalDir, skillName: 'linked-skill', provenance })).rejects.toThrow('link failed');

    expect(registryService.addInstall).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(claudeDir, 'SKILL.md'), 'utf8')).toBe('old claude content');
    expect(fs.existsSync(path.join(proposalDir, 'SKILL.md'))).toBe(true);
  });

  it('Codex 侧真实 skill 目录:先挪备份再落 symlink(不留双副本让 Codex 加载旧版)', async () => {
    // 场景:被改进的原 skill 本体住在 ~/.codex/skills/<name>(scanner 认可的
    // legacy 根)。不处理的话 apply 后 .agents 新版与 Codex 旧版并存,Codex
    // 继续加载旧版 —— 与 Claude 侧真实目录同责:挪备份 + 换 symlink。
    const codexDir = path.join(HOME, '.codex', 'skills', 'codex-skill');
    await fs.promises.mkdir(codexDir, { recursive: true });
    await fs.promises.writeFile(path.join(codexDir, 'SKILL.md'), 'old codex content', 'utf8');
    const proposalDir = await makeProposal('codex-skill');

    const result = await applyProposal({ proposalDir, skillName: 'codex-skill', provenance });

    // 真实目录已被挪走(备份在 owner-scoped learn/backups/),symlink helper 被调用
    expect(fs.existsSync(codexDir)).toBe(false);
    const backupsRoot = path.join(TEST_ROOT, 'userData', 'owners', 'test-owner', 'learn', 'backups');
    const backups = fs.readdirSync(backupsRoot).filter((n) => n.startsWith('codex-skill-codex-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupsRoot, backups[0], 'SKILL.md'), 'utf8')).toBe('old codex content');
    expect(result.replacedBackupPath).toBe(path.join(backupsRoot, backups[0]));
    const { ensureSymlinkToShared } = await import('../../skillhub/installService');
    expect(vi.mocked(ensureSymlinkToShared)).toHaveBeenCalledWith(
      codexDir,
      path.join(SKILLS_DIR, 'codex-skill'),
    );
    expect(fs.existsSync(path.join(SKILLS_DIR, 'codex-skill', 'SKILL.md'))).toBe(true);
  });

  it('Codex 侧真实目录替换失败时中止 apply 并恢复旧目录', async () => {
    const { ensureSymlinkToShared } = await import('../../skillhub/installService');
    vi.mocked(ensureSymlinkToShared).mockRejectedValueOnce(new Error('codex link failed'));
    const codexDir = path.join(HOME, '.codex', 'skills', 'codex-skill');
    await fs.promises.mkdir(codexDir, { recursive: true });
    await fs.promises.writeFile(path.join(codexDir, 'SKILL.md'), 'old codex content', 'utf8');
    const proposalDir = await makeProposal('codex-skill');

    await expect(applyProposal({ proposalDir, skillName: 'codex-skill', provenance })).rejects.toThrow('codex link failed');

    expect(registryService.addInstall).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(codexDir, 'SKILL.md'), 'utf8')).toBe('old codex content');
    expect(fs.existsSync(path.join(proposalDir, 'SKILL.md'))).toBe(true);
  });

  it('rolls back files when registry write fails', async () => {
    vi.mocked(registryService.addInstall).mockRejectedValueOnce(new Error('registry io failed'));
    const existing = path.join(SKILLS_DIR, 'roll-skill');
    await fs.promises.mkdir(existing, { recursive: true });
    await fs.promises.writeFile(path.join(existing, 'SKILL.md'), 'original', 'utf8');
    const proposalDir = await makeProposal('roll-skill');

    await expect(applyProposal({ proposalDir, skillName: 'roll-skill', provenance })).rejects.toThrow(
      'registry io failed',
    );
    // 旧目录恢复原位,提案回到 staging 原位(可重试)
    expect(fs.readFileSync(path.join(SKILLS_DIR, 'roll-skill', 'SKILL.md'), 'utf8')).toBe('original');
    expect(fs.existsSync(path.join(proposalDir, 'SKILL.md'))).toBe(true);
  });

  it('strips ignored proposal entries before EXDEV fallback copies the directory', async () => {
    const proposalDir = await makeProposal('copy-skill');
    await fs.promises.writeFile(path.join(proposalDir, '.env'), 'SECRET=1', 'utf8');
    await fs.promises.mkdir(path.join(proposalDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.promises.writeFile(path.join(proposalDir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');

    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    const realCp = fs.promises.cp.bind(fs.promises);
    const cpSpy = vi.spyOn(fs.promises, 'cp').mockImplementation(async (src, dest, opts) => {
      expect(fs.existsSync(path.join(String(src), '.env'))).toBe(false);
      expect(fs.existsSync(path.join(String(src), 'node_modules'))).toBe(false);
      return realCp(src, dest, opts);
    });

    try {
      await applyProposal({ proposalDir, skillName: 'copy-skill', provenance });
      expect(cpSpy).toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
      cpSpy.mockRestore();
    }

    expect(fs.existsSync(path.join(SKILLS_DIR, 'copy-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(SKILLS_DIR, 'copy-skill', '.env'))).toBe(false);
    expect(fs.existsSync(path.join(SKILLS_DIR, 'copy-skill', 'node_modules'))).toBe(false);
  });
});

describe('EXDEV 回退路径(规则 14 回归)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cp 半途失败:清掉部分 finalDir 并回滚被替换的旧目录', async () => {
    const existing = path.join(SKILLS_DIR, 'exdev-skill');
    await fs.promises.mkdir(existing, { recursive: true });
    await fs.promises.writeFile(path.join(existing, 'SKILL.md'), 'original', 'utf8');
    const proposalDir = await makeProposal('exdev-skill');

    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (src, dst) => {
      if (String(src).includes('staging')) {
        const e = new Error('cross-device') as NodeJS.ErrnoException;
        e.code = 'EXDEV';
        throw e;
      }
      return realRename(src, dst);
    });
    vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      applyProposal({ proposalDir, skillName: 'exdev-skill', provenance }),
    ).rejects.toThrow('disk full');
    // 旧目录复位,无部分复制的残渣
    expect(fs.readFileSync(path.join(SKILLS_DIR, 'exdev-skill', 'SKILL.md'), 'utf8')).toBe('original');
  });

  it('提案 move 的源删除失败 = move 失败:原状复位(staging 完整,finalDir 不产生)', async () => {
    // 此前的"容忍 rm(src) 失败保留 dst"给 rollback 埋雷:src 未删时后续 fatal
    // 步骤触发回滚,finalDir 移不回已存在的 proposalDir(#484 合并后 Codex
    // follow-up)。现在 moveDir 自含原子性:失败即原状,可重试。
    const proposalDir = await makeProposal('tolerant-skill');
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (src, dst) => {
      if (String(src).includes('staging')) {
        const e = new Error('cross-device') as NodeJS.ErrnoException;
        e.code = 'EXDEV';
        throw e;
      }
      return realRename(src, dst);
    });
    const realRm = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target).includes('staging') && String(target).includes('tolerant-skill')) {
        throw new Error('EBUSY: locked');
      }
      return realRm(target, opts);
    });

    await expect(
      applyProposal({ proposalDir, skillName: 'tolerant-skill', provenance }),
    ).rejects.toThrow('EBUSY');
    // 原状:staging 提案完整可重试,安装目录没有半成品
    expect(fs.existsSync(path.join(proposalDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(SKILLS_DIR, 'tolerant-skill'))).toBe(false);
  });

  it('rm(src) 失败触发后续回滚时,被替换的旧目录仍能完整复位(rollback 不被残留 src 卡死)', async () => {
    // 完整回滚链:EXDEV + rm(src) 失败 → moveDir 失败(finalDir 已清)→
    // rollback 复位 replaceDir → 旧 skill 原样恢复。
    const existing = path.join(SKILLS_DIR, 'rollback-skill');
    await fs.promises.mkdir(existing, { recursive: true });
    await fs.promises.writeFile(path.join(existing, 'SKILL.md'), 'original content', 'utf8');
    const proposalDir = await makeProposal('rollback-skill');

    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (src, dst) => {
      if (String(src).includes('staging')) {
        const e = new Error('cross-device') as NodeJS.ErrnoException;
        e.code = 'EXDEV';
        throw e;
      }
      return realRename(src, dst);
    });
    const realRm = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target).includes('staging') && String(target).includes('rollback-skill')) {
        throw new Error('EBUSY: locked');
      }
      return realRm(target, opts);
    });

    await expect(
      applyProposal({ proposalDir, skillName: 'rollback-skill', provenance }),
    ).rejects.toThrow('EBUSY');
    expect(fs.readFileSync(path.join(SKILLS_DIR, 'rollback-skill', 'SKILL.md'), 'utf8')).toBe('original content');
    expect(fs.existsSync(path.join(proposalDir, 'SKILL.md'))).toBe(true);
  });

  it('回滚回拷后 rm(finalDir) 被锁:保留刚复制回来的提案,不亲手销毁(#585 Codex P1)', async () => {
    // 链路:registry 写入失败 → rollback 把 finalDir 移回 staging → EXDEV 回拷
    // 成功但 rm(finalDir) 被 Windows 文件锁挡住。默认"失败清 dst"会把完整的
    // 提案副本再删掉(提案丢失且不可重试);preserveDstOnSrcRemovalFailure 模式
    // 下 dst 保留,finalDir 只作残渣。
    vi.mocked(registryService.addInstall).mockRejectedValueOnce(new Error('registry io failed'));
    const existing = path.join(SKILLS_DIR, 'preserve-skill');
    await fs.promises.mkdir(existing, { recursive: true });
    await fs.promises.writeFile(path.join(existing, 'SKILL.md'), 'original', 'utf8');
    const proposalDir = await makeProposal('preserve-skill');
    const finalDir = path.join(SKILLS_DIR, 'preserve-skill');

    // 只让"回滚方向"(dst 在 staging)走 EXDEV;正向 rename 正常成功。
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (src, dst) => {
      if (String(dst).includes('staging')) {
        const e = new Error('cross-device') as NodeJS.ErrnoException;
        e.code = 'EXDEV';
        throw e;
      }
      return realRename(src, dst);
    });
    const realRm = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target) === finalDir) throw new Error('EBUSY: locked');
      return realRm(target, opts);
    });

    await expect(
      applyProposal({ proposalDir, skillName: 'preserve-skill', provenance }),
    ).rejects.toThrow('registry io failed');
    // 关键资产:回拷出的提案完整保留(可重试),没有被"失败清 dst"销毁
    expect(fs.readFileSync(path.join(proposalDir, 'SKILL.md'), 'utf8')).toContain('name: preserve-skill');
    // 旧版本仍可找回:finalDir 被锁占位挡住复位,但内容完好地留在 .xdt-replacing- 侧
    const stranded = fs.readdirSync(SKILLS_DIR).filter((n) => n.startsWith('.xdt-replacing-learn-preserve-skill-'));
    expect(stranded).toHaveLength(1);
    expect(fs.readFileSync(path.join(SKILLS_DIR, stranded[0], 'SKILL.md'), 'utf8')).toBe('original');
  });

  it('Claude 真实目录备份的源删除失败 → apply 失败(不留"Claude 仍加载旧版"的假成功)', async () => {
    const claudeDir = path.join(HOME, '.claude', 'skills', 'locked-skill');
    await fs.promises.mkdir(claudeDir, { recursive: true });
    await fs.promises.writeFile(path.join(claudeDir, 'SKILL.md'), 'old claude content', 'utf8');
    const proposalDir = await makeProposal('locked-skill');

    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (src, dst) => {
      if (String(src).includes('.claude')) {
        const e = new Error('cross-device') as NodeJS.ErrnoException;
        e.code = 'EXDEV';
        throw e;
      }
      return realRename(src, dst);
    });
    const realRm = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target).includes('.claude')) throw new Error('EBUSY: locked');
      return realRm(target, opts);
    });

    await expect(
      applyProposal({ proposalDir, skillName: 'locked-skill', provenance }),
    ).rejects.toThrow();
    // 原 Claude 目录原封不动;半拷贝备份已被清理
    expect(fs.readFileSync(path.join(claudeDir, 'SKILL.md'), 'utf8')).toBe('old claude content');
    const backupsRoot = path.join(TEST_ROOT, 'userData', 'owners', 'test-owner', 'learn', 'backups');
    const leftovers = fs.existsSync(backupsRoot)
      ? fs.readdirSync(backupsRoot).filter((n) => n.startsWith('locked-skill-claude-'))
      : [];
    expect(leftovers).toEqual([]);
  });
});
