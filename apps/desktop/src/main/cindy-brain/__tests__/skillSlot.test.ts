import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import { packGhostDir } from '../forge';
import { GhostManager } from '../GhostManager';
import {
  checkSkillMdConsistency,
  ghostSkillLinkName,
  reconcileGhostSkillLinks as reconcileGhostSkillLinksRaw,
} from '../skillSlot';

/** 规则 23:测试路径一律 os.tmpdir;伪 home + 伪 brainRoot,互不污染。 */
let workDir: string;
let homeDir: string;
let brainRoot: string;
/** 与 GhostManager 缺省状态根同名(`<安装根>-install-state`),判据口径一致。 */
let approvalStateRoot: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-slot-test-'));
  homeDir = path.join(workDir, 'home');
  brainRoot = path.join(workDir, 'owners', 'aaa', 'cindy-brain');
  approvalStateRoot = path.join(workDir, 'owners', 'aaa', 'cindy-brain-install-state');
  await fs.promises.mkdir(homeDir, { recursive: true });
  await fs.promises.mkdir(brainRoot, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

const sharedDir = () => path.join(homeDir, '.agents', 'skills');
const claudeDir = () => path.join(homeDir, '.claude', 'skills');

/**
 * 结构对账用例默认把夹具视为已经过完整快照摘要校验；摘要失配的安全回归单独
 * 调 raw reconciler，避免每个链接行为用例重复搭 receipt。
 */
function reconcileGhostSkillLinks(
  options: Omit<
    Parameters<typeof reconcileGhostSkillLinksRaw>[0],
    'validateApprovedSkillSnapshot'
  >,
) {
  return reconcileGhostSkillLinksRaw({
    ...options,
    validateApprovedSkillSnapshot: async () => true,
  });
}

/** reconciler 只消费 manifest 数据,不跑校验——手工拼最小清单即可。 */
function ghost(
  id: string,
  skills: Array<{ dir: string; name: string; description?: string }>,
  opts: { enabled?: boolean } = {},
): InstalledGhost {
  const manifest = {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['skill'],
    skill: {
      items: skills.map((s) => ({ ...s, description: s.description ?? '说明' })),
    },
  } as unknown as GhostManifest;
  return {
    manifest,
    dir: path.join(brainRoot, id),
    enabled: opts.enabled ?? true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    approvedSkillRoot: path.join(brainRoot, id),
  };
}

/** 在 brainRoot 下造一个真实技能目录(含 SKILL.md)。 */
async function writeSkillDir(ghostId: string, rel: string, name = 'skill'): Promise<string> {
  const dir = path.join(brainRoot, ghostId, ...rel.split('/'));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 说明\n---\n\n正文\n`,
  );
  return dir;
}

function sameRealPath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const real = fs.realpathSync(p);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

describe('skillSlot · checkSkillMdConsistency', () => {
  const item = { dir: 'skills/foo', name: 'foo', description: '教 Agent 用 foo' };
  const md = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;

  it('逐字一致 → null;name/description 漂移 → 报错', () => {
    expect(checkSkillMdConsistency(md('foo', '教 Agent 用 foo'), item)).toBeNull();
    expect(checkSkillMdConsistency(md('bar', '教 Agent 用 foo'), item)).toContain('name');
    expect(checkSkillMdConsistency(md('foo', '换了说明'), item)).toContain('description');
  });

  it('frontmatter 缺字段/不可解析 → 报错', () => {
    expect(checkSkillMdConsistency('---\nname: foo\n---\n正文', item)).not.toBeNull();
    expect(checkSkillMdConsistency('没有 frontmatter', item)).not.toBeNull();
    expect(checkSkillMdConsistency('---\nname: [broken\n---\n', item)).not.toBeNull();
  });

  it('frontmatter 值两侧空白容忍(trim 后比对)', () => {
    expect(
      checkSkillMdConsistency(md(' foo ', ' 教 Agent 用 foo '), item),
    ).toBeNull();
  });
});

describe('skillSlot · reconcileGhostSkillLinks', () => {
  it('启用插件 → 建链进共享根并扇出 .claude;二次对账幂等', async () => {
    await writeSkillDir('my-ghost', 'skills/foo', 'foo');
    const ghosts = [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }])];

    const first = await reconcileGhostSkillLinks({ ghosts, brainRoot, approvalStateRoot, homeDir });
    expect(first.changed).toBe(true);
    expect(first.warnings).toEqual([]);
    const linkName = ghostSkillLinkName('my-ghost', 'foo');
    const sharedLink = path.join(sharedDir(), linkName);
    const target = path.join(brainRoot, 'my-ghost', 'skills', 'foo');
    expect(sameRealPath(sharedLink, target)).toBe(true);
    // .claude 兼容扇出(经 prepareSharedGlobalSkillLinks)
    expect(sameRealPath(path.join(claudeDir(), linkName), target)).toBe(true);

    const second = await reconcileGhostSkillLinks({ ghosts, brainRoot, approvalStateRoot, homeDir });
    expect(second.changed).toBe(false);
    expect(second.actions.filter((a) => a.op !== 'kept')).toEqual([]);
  });

  it('停用/卸载 → 撤链,.claude 悬空兼容链接一并回收', async () => {
    await writeSkillDir('my-ghost', 'skills/foo', 'foo');
    const enabled = [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }])];
    await reconcileGhostSkillLinks({ ghosts: enabled, brainRoot, approvalStateRoot, homeDir });
    const linkName = ghostSkillLinkName('my-ghost', 'foo');

    // 停用:期望态清空 → 双侧链接消失
    const disabled = [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }], { enabled: false })];
    const result = await reconcileGhostSkillLinks({ ghosts: disabled, brainRoot, approvalStateRoot, homeDir });
    expect(result.changed).toBe(true);
    expect(fs.existsSync(path.join(sharedDir(), linkName))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir(), linkName))).toBe(false);

    // 卸载(清单里没有它)语义相同:再建再收敛一次验证
    await reconcileGhostSkillLinks({ ghosts: enabled, brainRoot, approvalStateRoot, homeDir });
    const gone = await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(gone.changed).toBe(true);
    expect(fs.existsSync(path.join(sharedDir(), linkName))).toBe(false);
  });

  it('目标目录被删(异常残留)→ 断链回收', async () => {
    await writeSkillDir('my-ghost', 'skills/foo', 'foo');
    const ghosts = [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }])];
    await reconcileGhostSkillLinks({ ghosts, brainRoot, approvalStateRoot, homeDir });
    // 模拟崩溃残留:插件目录整个没了,链接悬空
    await fs.promises.rm(path.join(brainRoot, 'my-ghost'), { recursive: true, force: true });
    const result = await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(fs.existsSync(path.join(sharedDir(), ghostSkillLinkName('my-ghost', 'foo')))).toBe(false);
    expect(result.changed).toBe(true);
  });

  it('技能改名/换目录 → 旧链撤、新链立', async () => {
    await writeSkillDir('my-ghost', 'skills/foo', 'foo');
    await reconcileGhostSkillLinks({
      ghosts: [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }])],
      brainRoot,
      approvalStateRoot,
      homeDir,
    });
    await writeSkillDir('my-ghost', 'skills/bar', 'bar');
    const result = await reconcileGhostSkillLinks({
      ghosts: [ghost('my-ghost', [{ dir: 'skills/bar', name: 'bar' }])],
      brainRoot,
      approvalStateRoot,
      homeDir,
    });
    expect(result.changed).toBe(true);
    expect(fs.existsSync(path.join(sharedDir(), ghostSkillLinkName('my-ghost', 'foo')))).toBe(false);
    expect(
      sameRealPath(
        path.join(sharedDir(), ghostSkillLinkName('my-ghost', 'bar')),
        path.join(brainRoot, 'my-ghost', 'skills', 'bar'),
      ),
    ).toBe(true);
  });

  it('真实目录占位 → 不覆盖 + warning(保护 SkillHub 实体技能与用户手放目录)', async () => {
    await writeSkillDir('my-ghost', 'skills/foo', 'foo');
    const linkName = ghostSkillLinkName('my-ghost', 'foo');
    const occupied = path.join(sharedDir(), linkName);
    await fs.promises.mkdir(occupied, { recursive: true });
    await fs.promises.writeFile(path.join(occupied, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');

    const result = await reconcileGhostSkillLinks({
      ghosts: [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }])],
      brainRoot,
      approvalStateRoot,
      homeDir,
    });
    expect(result.warnings.some((w) => w.includes(linkName))).toBe(true);
    // 真实目录原样保留,不是链接
    const st = await fs.promises.lstat(occupied);
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
  });

  it('漏传批准状态根在类型层就被挡住(否则指向快照的活链接会被判成外来链接而永不撤链)', () => {
    const missingStateRoot = () =>
      // @ts-expect-error approvalStateRoot 必填:这行编译不报错就说明保护没了。
      reconcileGhostSkillLinksRaw({
        ghosts: [],
        brainRoot,
        homeDir,
        validateApprovedSkillSnapshot: async () => true,
      });
    expect(typeof missingStateRoot).toBe('function');
  });

  it('完整摘要校验不通过时撤掉已有托管链接，不因目标未变而 kept', async () => {
    await writeSkillDir('my-ghost', 'skills/foo', 'foo');
    const ghosts = [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }])];
    await reconcileGhostSkillLinks({ ghosts, brainRoot, approvalStateRoot, homeDir });
    const linkName = ghostSkillLinkName('my-ghost', 'foo');
    expect(fs.existsSync(path.join(sharedDir(), linkName))).toBe(true);

    const result = await reconcileGhostSkillLinksRaw({
      ghosts,
      brainRoot,
      approvalStateRoot,
      homeDir,
      validateApprovedSkillSnapshot: async () => false,
    });

    expect(result.changed).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('字节不可信'))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir(), linkName))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir(), linkName))).toBe(false);
  });

  it('外来链接(目标不在任何受管根内)→ 活链断链都不碰', async () => {
    const foreignTarget = path.join(workDir, 'foreign-skill');
    await fs.promises.mkdir(foreignTarget, { recursive: true });
    await fs.promises.writeFile(
      path.join(foreignTarget, 'SKILL.md'),
      '---\nname: f\ndescription: d\n---\n',
    );
    await fs.promises.mkdir(sharedDir(), { recursive: true });
    const foreignLink = path.join(sharedDir(), 'user-made-link');
    await fs.promises.symlink(
      foreignTarget,
      foreignLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(fs.existsSync(foreignLink)).toBe(true);

    // 变成断链(目标删除)也不碰:目标路径不含 cindy-brain 段
    await fs.promises.rm(foreignTarget, { recursive: true, force: true });
    await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(fs.lstatSync(foreignLink).isSymbolicLink()).toBe(true);
  });

  it('外来 skill-snapshots 目录下的断链不碰(判据要求状态根名相邻,不认通用目录名)', async () => {
    // 用户自己在别处建的 `skill-snapshots/` —— 名字撞上我们的内部目录名,但不在
    // 批准状态根下,回收判据不能只看这一段就删。
    const foreignTarget = path.join(workDir, 'my-notes', 'skill-snapshots', 'x', 'y');
    await fs.promises.mkdir(foreignTarget, { recursive: true });
    await fs.promises.mkdir(sharedDir(), { recursive: true });
    const foreignLink = path.join(sharedDir(), 'looks--managed');
    await fs.promises.symlink(
      foreignTarget,
      foreignLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.promises.rm(path.join(workDir, 'my-notes'), { recursive: true, force: true });

    await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(fs.lstatSync(foreignLink).isSymbolicLink()).toBe(true);

    // 对照:真正落在批准状态根下的同形断链要回收。
    const managedLink = path.join(sharedDir(), 'managed--skill');
    await fs.promises.symlink(
      path.join(approvalStateRoot, 'skill-snapshots', 'managed', 'rev', 'skills', 'demo'),
      managedLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(fs.existsSync(managedLink)).toBe(false);
  });

  it('他 owner 的活链接不碰(多账号隔离);他 owner 的断链回收(防积尘)', async () => {
    // 另一个 owner 的 brainRoot 与真实技能
    const otherBrainRoot = path.join(workDir, 'owners', 'bbb', 'cindy-brain');
    const otherSkill = path.join(otherBrainRoot, 'other-ghost', 'skills', 'foo');
    await fs.promises.mkdir(otherSkill, { recursive: true });
    await fs.promises.writeFile(
      path.join(otherSkill, 'SKILL.md'),
      '---\nname: foo\ndescription: d\n---\n',
    );
    await fs.promises.mkdir(sharedDir(), { recursive: true });
    const liveLink = path.join(sharedDir(), 'other-ghost--foo');
    await fs.promises.symlink(
      otherSkill,
      liveLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(fs.existsSync(liveLink)).toBe(true); // 活链保留

    await fs.promises.rm(path.join(otherBrainRoot, 'other-ghost'), { recursive: true, force: true });
    await reconcileGhostSkillLinks({ ghosts: [], brainRoot, approvalStateRoot, homeDir });
    expect(fs.existsSync(liveLink)).toBe(false); // 断链回收(目标带 cindy-brain 段)
  });

  it('目标缺 SKILL.md(如更新备份窗口)→ skip + warning,不建半截链', async () => {
    const bare = path.join(brainRoot, 'my-ghost', 'skills', 'foo');
    await fs.promises.mkdir(bare, { recursive: true }); // 故意不放 SKILL.md
    const result = await reconcileGhostSkillLinks({
      ghosts: [ghost('my-ghost', [{ dir: 'skills/foo', name: 'foo' }])],
      brainRoot,
      approvalStateRoot,
      homeDir,
    });
    expect(fs.existsSync(path.join(sharedDir(), ghostSkillLinkName('my-ghost', 'foo')))).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.actions.some((a) => a.op === 'skipped' && a.reason === 'target-missing-skill-md')).toBe(true);
  });

  it('撞名兜底:同一链接名两处声明 first-wins + warning(校验层已保证不可达,防御纵深)', async () => {
    await writeSkillDir('my-ghost', 'skills/a', 'dup');
    await writeSkillDir('my-ghost', 'skills/b', 'dup');
    // 手工拼重复 name 的清单(合法清单被校验层拒,这里直测 reconciler 兜底)
    const result = await reconcileGhostSkillLinks({
      ghosts: [
        ghost('my-ghost', [
          { dir: 'skills/a', name: 'dup' },
          { dir: 'skills/b', name: 'dup' },
        ]),
      ],
      brainRoot,
      approvalStateRoot,
      homeDir,
    });
    expect(result.warnings.some((w) => w.includes('冲突'))).toBe(true);
    expect(
      sameRealPath(
        path.join(sharedDir(), ghostSkillLinkName('my-ghost', 'dup')),
        path.join(brainRoot, 'my-ghost', 'skills', 'a'),
      ),
    ).toBe(true);
  });
});

describe('skillSlot · 全链路(打包 → 装入 → 对账 → 双端可见)', () => {
  it('forge 打包的 skill 插件装入后,对账把技能链进 .agents 与 .claude;卸载即撤', async () => {
    // 1) 源码目录 → packGhostDir
    const srcDir = path.join(workDir, 'src');
    const write = async (rel: string, content: string) => {
      const abs = path.join(srcDir, rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content);
    };
    await write(
      'ghost.json',
      JSON.stringify({
        schemaVersion: 2,
        id: 'e2e-ghost',
        name: '全链路演示',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        slots: ['tool', 'skill'],
        tools: [{ name: 'do_thing', description: '做点事' }],
        skill: { items: [{ dir: 'skills/demo', name: 'demo', description: '演示技能' }] },
      }),
    );
    await write('main.js', '// brain');
    await write('skills/demo/SKILL.md', '---\nname: demo\ndescription: 演示技能\n---\n\n用法正文\n');
    const packed = await packGhostDir(srcDir);
    expect(packed.ok, JSON.stringify(packed)).toBe(true);
    if (!packed.ok) return;

    // 2) 装入(与真实链路同一 GhostManager.install)
    const manager = new GhostManager({ getRootDir: () => brainRoot });
    const installed = await manager.install(packed.cindyPath);
    expect('ghost' in installed, JSON.stringify(installed)).toBe(true);

    // 3) 对账:共享根与 .claude 双端可见,realpath 落在批准快照目录
    await reconcileGhostSkillLinksRaw({
      ghosts: manager.list(),
      brainRoot,
      approvalStateRoot: manager.approvalStateRoot(),
      homeDir,
      validateApprovedSkillSnapshot: (candidate) =>
        manager.verifyApprovedSkillSnapshot(candidate),
    });
    const linkName = ghostSkillLinkName('e2e-ghost', 'demo');
    const approvedSkillRoot = manager.list()[0].approvedSkillRoot;
    expect(approvedSkillRoot).toBeTruthy();
    const target = path.join(approvedSkillRoot!, 'skills', 'demo');
    expect(sameRealPath(path.join(sharedDir(), linkName), target)).toBe(true);
    expect(sameRealPath(path.join(claudeDir(), linkName), target)).toBe(true);
    // 链接指向的 SKILL.md 就是包里那份
    expect(
      await fs.promises.readFile(path.join(sharedDir(), linkName, 'SKILL.md'), 'utf8'),
    ).toContain('演示技能');
    await fs.promises.writeFile(
      path.join(brainRoot, 'e2e-ghost', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: 演示技能\n---\n\n篡改后的指令\n',
    );
    expect(
      await fs.promises.readFile(path.join(sharedDir(), linkName, 'SKILL.md'), 'utf8'),
    ).not.toContain('篡改后的指令');

    // 改写批准状态根里的快照正文，保持 frontmatter 不变。下一轮正常对账必须重算
    // 整棵快照摘要并撤链，不能因链接目标没变而直接 kept。
    await fs.promises.writeFile(
      path.join(target, 'SKILL.md'),
      '---\nname: demo\ndescription: 演示技能\n---\n\n篡改批准快照\n',
    );
    const tampered = await reconcileGhostSkillLinksRaw({
      ghosts: manager.list(),
      brainRoot,
      approvalStateRoot: manager.approvalStateRoot(),
      homeDir,
      validateApprovedSkillSnapshot: (candidate) =>
        manager.verifyApprovedSkillSnapshot(candidate),
    });
    expect(tampered.warnings.some((warning) => warning.includes('字节不可信'))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir(), linkName))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir(), linkName))).toBe(false);

    // 4) 卸载 → 对账 → 双端链接消失
    const removed = await manager.uninstall('e2e-ghost');
    expect(removed).toMatchObject({ ok: true });
    await reconcileGhostSkillLinks({
      ghosts: manager.list(),
      brainRoot,
      approvalStateRoot: manager.approvalStateRoot(),
      homeDir,
    });
    expect(fs.existsSync(path.join(sharedDir(), linkName))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir(), linkName))).toBe(false);
  });
});
