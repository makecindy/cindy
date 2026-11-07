/**
 * 项目资源漂移检测 —— 纯 fs 单测(不 spawn pi)。
 *
 * 契约:snapshotPiProjectResourceLaunch 冻结"路径集合 + watch root mtime 基线";
 * piProjectResourcesDrifted 两级判定 —— mtime 全等 → 无漂移(stat 快检,零扫描);
 * mtime 变化 → 全量重扫(每次调用至多一次)按路径集合判定(集合相同不回收,
 * 路径集合才是 argv 的输入),且就地刷新基线让后续快检恢复零扫描。
 * watch roots 必须覆盖 collector 实际枚举的每一层目录:在已存在子目录内增删
 * 条目只改该子目录自身 mtime,漏盯哪层就在哪层漏检。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectPiProjectResourceCliPaths,
  collectPiProjectResourceWatchRootMtimes,
  piProjectResourcesDrifted,
  resolvePiResourceRepoRoot,
  snapshotPiProjectResourceLaunch,
} from '../project-resource-cli.js';

let project = '';

// Windows CI 无符号链接特权:软链相关用例仅在 POSIX 跑。
const itPosixOnly = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'pi-resource-drift-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function writeSkill(relativeDir: string, name: string): void {
  mkdirSync(path.join(project, relativeDir, name), { recursive: true });
  writeFileSync(path.join(project, relativeDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
}

function statMtime(target: string): number {
  return statSync(target).mtimeMs;
}

function snapshot() {
  // 与生产调用点同序:基线先采样,路径后收集(见 snapshotPiProjectResourceLaunch)。
  const watchRootMtimes = collectPiProjectResourceWatchRootMtimes(project);
  return snapshotPiProjectResourceLaunch(project, collectPiProjectResourceCliPaths(project), watchRootMtimes, resolvePiResourceRepoRoot(project));
}

describe('piProjectResourcesDrifted', () => {
  it('reports no drift for an unchanged project', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    expect(piProjectResourcesDrifted(snapshot())).toBe(false);
  });

  it('detects a skill added after launch', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    writeSkill(path.join('.pi', 'skills'), 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('returns to no-drift when the added skill is removed again', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    writeSkill(path.join('.pi', 'skills'), 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
    rmSync(path.join(project, '.pi', 'skills', 'beta'), { recursive: true, force: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('ignores skill content edits when the path set is unchanged', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    writeFileSync(path.join(project, '.pi', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: rewritten\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('ignores unrelated files dropped in the working directory root', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    writeFileSync(path.join(project, 'notes.txt'), 'unrelated');
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('detects a prompt template added after launch', () => {
    const baseline = snapshot();
    mkdirSync(path.join(project, '.pi', 'prompts'), { recursive: true });
    writeFileSync(path.join(project, '.pi', 'prompts', 'opsx-propose.md'), '---\ndescription: t\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a project extension added after launch', () => {
    const baseline = snapshot();
    mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(project, '.pi', 'extensions', 'hook.ts'), 'export {};\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a skill created in a missing .agents/skills ancestor (dir from nothing)', () => {
    writeFileSync(path.join(project, '.git'), '');
    const nested = path.join(project, 'sub');
    mkdirSync(nested, { recursive: true });
    const baseline = snapshotPiProjectResourceLaunch(
      nested, collectPiProjectResourceCliPaths(nested), collectPiProjectResourceWatchRootMtimes(nested), resolvePiResourceRepoRoot(nested));
    writeSkill(path.join('.agents', 'skills'), 'gamma');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a skill created in a missing .pi/skills (dir from nothing)', () => {
    const baseline = snapshot();
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('watch roots cover .pi and the .agents ancestor chain', () => {
    writeFileSync(path.join(project, '.git'), '');
    const nested = path.join(project, 'sub');
    mkdirSync(nested, { recursive: true });
    const roots = collectPiProjectResourceWatchRootMtimes(nested);
    expect(roots.has(path.join(nested, '.pi'))).toBe(true);
    expect(roots.has(path.join(nested, '.agents'))).toBe(true);
    expect(roots.has(path.join(nested, '.agents', 'skills'))).toBe(true);
    expect(roots.has(path.join(project, '.agents'))).toBe(true);
    expect(roots.has(path.join(project, '.agents', 'skills'))).toBe(true);
  });

  it('detects a skill added inside an existing namespace dir (nested level)', () => {
    writeSkill(path.join('.pi', 'skills', '@scope'), 'alpha');
    const baseline = snapshot();
    writeSkill(path.join('.pi', 'skills', '@scope'), 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a skill removed from an existing namespace dir (nested level)', () => {
    writeSkill(path.join('.pi', 'skills', '@scope'), 'alpha');
    writeSkill(path.join('.pi', 'skills', '@scope'), 'beta');
    const baseline = snapshot();
    rmSync(path.join(project, '.pi', 'skills', '@scope', 'beta'), { recursive: true, force: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects SKILL.md added into an existing non-skill nested dir', () => {
    mkdirSync(path.join(project, '.pi', 'skills', '@scope', 'empty'), { recursive: true });
    const baseline = snapshot();
    writeFileSync(path.join(project, '.pi', 'skills', '@scope', 'empty', 'SKILL.md'), '---\nname: empty\ndescription: t\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects SKILL.md removed from an existing top-level skill dir', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    rmSync(path.join(project, '.pi', 'skills', 'alpha', 'SKILL.md'), { force: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects index.ts added inside an existing extension dir', () => {
    mkdirSync(path.join(project, '.pi', 'extensions', 'myext'), { recursive: true });
    const baseline = snapshot();
    writeFileSync(path.join(project, '.pi', 'extensions', 'myext', 'index.ts'), 'export {};\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('refreshes the mtime baseline after a rescan finds the same path set', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    const skillsDir = path.join(project, '.pi', 'skills');
    const mtimeAtLaunch = baseline.watchRootMtimes.get(skillsDir)!;
    // 无关子目录:改了 skills 根 mtime,但不改变路径集合
    mkdirSync(path.join(skillsDir, 'unrelated'), { recursive: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 基线已就地刷新:下一次快检恢复零扫描,且真实漂移仍能检出
    expect(baseline.watchRootMtimes.get(skillsDir)).toBe(statMtime(skillsDir));
    expect(baseline.watchRootMtimes.get(skillsDir)).not.toBe(mtimeAtLaunch);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    writeSkill(path.join('.pi', 'skills'), 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('watch roots cover namespace and nested skill levels plus extension child dirs', () => {
    writeSkill(path.join('.pi', 'skills', '@scope'), 'alpha');
    mkdirSync(path.join(project, '.pi', 'skills', '@scope', 'plain'), { recursive: true });
    mkdirSync(path.join(project, '.pi', 'extensions', 'myext'), { recursive: true });
    const roots = collectPiProjectResourceWatchRootMtimes(project);
    const ns = path.join(project, '.pi', 'skills', '@scope');
    expect(roots.has(ns)).toBe(true);
    expect(roots.has(path.join(ns, 'alpha'))).toBe(true);
    expect(roots.has(path.join(ns, 'plain'))).toBe(true);
    expect(roots.has(path.join(project, '.pi', 'extensions', 'myext'))).toBe(true);
  });

  it('launch snapshot samples watch roots before path collection (race-safe order)', () => {
    // 生产调用点先采基线后收集路径。基线采样与路径收集之间新增的资源已在集合
    // 里且基线较旧:首次快检多一次重扫确认集合一致后刷新基线 —— 既不误报漂移,
    // 也不会静默漏检(反序才会漏)。
    const watchRootMtimes = collectPiProjectResourceWatchRootMtimes(project);
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshotPiProjectResourceLaunch(
      project, collectPiProjectResourceCliPaths(project), watchRootMtimes, resolvePiResourceRepoRoot(project));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    expect(baseline.watchRootMtimes.get(path.join(project, '.pi', 'skills')))
      .toBe(statMtime(path.join(project, '.pi', 'skills')));
  });

  it('rebuilds the watch map after an unchanged rescan so new child dirs are watched', () => {
    mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
    const baseline = snapshot();
    // 重扫窗口内新建的空扩展目录:集合未变,但必须从此纳入盯视
    mkdirSync(path.join(project, '.pi', 'extensions', 'newext'), { recursive: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    expect(baseline.watchRootMtimes.has(path.join(project, '.pi', 'extensions', 'newext'))).toBe(true);
    // 若不重建基线,这里的 index.ts 只改未盯视的新子目录 mtime,永远检不出
    writeFileSync(path.join(project, '.pi', 'extensions', 'newext', 'index.ts'), 'export {};\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a nearer git boundary appearing after launch (repo root identity)', () => {
    mkdirSync(path.join(project, 'outer', '.agents', 'skills'), { recursive: true });
    writeFileSync(path.join(project, 'outer', '.git'), '');
    writeSkill(path.join('outer', '.agents', 'skills'), 'outer-skill');
    const nested = path.join(project, 'outer', 'sub');
    mkdirSync(nested, { recursive: true });
    const baseline = snapshotPiProjectResourceLaunch(
      nested, collectPiProjectResourceCliPaths(nested), collectPiProjectResourceWatchRootMtimes(nested), resolvePiResourceRepoRoot(nested));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 子目录自己 git init:枚举链截断,outer skill 不再属于本项目边界
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('does not recycle for a git boundary change that excludes no resources', () => {
    mkdirSync(path.join(project, 'outer'), { recursive: true });
    writeFileSync(path.join(project, 'outer', '.git'), '');
    const nested = path.join(project, 'outer', 'sub');
    mkdirSync(path.join(nested, '.pi', 'skills', 'alpha'), { recursive: true });
    writeFileSync(path.join(nested, '.pi', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: t\n---\n');
    const baseline = snapshotPiProjectResourceLaunch(
      nested, collectPiProjectResourceCliPaths(nested), collectPiProjectResourceWatchRootMtimes(nested), resolvePiResourceRepoRoot(nested));
    // 嵌套目录 git init:被截断的上层链没有任何项目资源,集合不变,不应触发回收
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 边界持有者已就地更新:后续快检恢复零扫描,不再重复重扫判定
    expect(baseline.state.repoRoot).toBe(realpathSync(nested));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  itPosixOnly('detects the resolved symlink target of a prompt template moved away', () => {
    // Windows CI 无符号链接特权,本用例仅在 POSIX 跑(见 itPosixOnly)。
    mkdirSync(path.join(project, 'targets'), { recursive: true });
    mkdirSync(path.join(project, '.pi', 'prompts'), { recursive: true });
    writeFileSync(path.join(project, 'targets', 'opsx.md'), '---\ndescription: t\n---\n');
    symlinkSync(path.join(project, 'targets', 'opsx.md'), path.join(project, '.pi', 'prompts', 'foo.md'));
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 目标移动/删除不改变 .pi/prompts 自身的 mtime,只有盯住解析后的文件本体才能检出
    rmSync(path.join(project, 'targets', 'opsx.md'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  itPosixOnly('detects a prompt target materializing behind a dangling symlink', () => {
    mkdirSync(path.join(project, '.pi', 'prompts'), { recursive: true });
    mkdirSync(path.join(project, 'elsewhere'), { recursive: true });
    symlinkSync(path.join(project, 'elsewhere', 'target.md'), path.join(project, '.pi', 'prompts', 'foo.md'));
    const baseline = snapshot();
    // 悬空软链自身已入盯视:目标落地(改动的是未盯视的 elsewhere 目录)也能检出
    writeFileSync(path.join(project, 'elsewhere', 'target.md'), '---\ndescription: t\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  itPosixOnly('detects the symlink target of a nested skill manifest moved away', () => {
    // Windows CI 无符号链接特权,本用例仅在 POSIX 跑(见 itPosixOnly)。
    mkdirSync(path.join(project, 'targets'), { recursive: true });
    mkdirSync(path.join(project, '.pi', 'skills', '@scope', 'alpha'), { recursive: true });
    writeFileSync(path.join(project, 'targets', 'real.md'), '---\nname: alpha\ndescription: t\n---\n');
    symlinkSync(path.join(project, 'targets', 'real.md'), path.join(project, '.pi', 'skills', '@scope', 'alpha', 'SKILL.md'));
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 目标移动/删除不改变 skill 目录自身 mtime,只有盯住解析后的清单本体才能检出
    rmSync(path.join(project, 'targets', 'real.md'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  itPosixOnly('detects a nested skill manifest target materializing behind a dangling symlink', () => {
    // 嵌套候选目录的清单是悬空软链时,hasSkillFile 为 false 不入收集,但链接本体
    // 已入盯视:目标落地(改动的 elsewhere 目录未被盯视)也能检出。
    mkdirSync(path.join(project, '.pi', 'skills', '@scope', 'foo'), { recursive: true });
    mkdirSync(path.join(project, 'elsewhere'), { recursive: true });
    symlinkSync(path.join(project, 'elsewhere', 'skill.md'), path.join(project, '.pi', 'skills', '@scope', 'foo', 'SKILL.md'));
    const baseline = snapshot();
    writeFileSync(path.join(project, 'elsewhere', 'skill.md'), '---\nname: foo\ndescription: t\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  itPosixOnly('detects a second-level manifest target move for a direct symlinked skill root', () => {
    // 直链 skill 根的 SKILL.md 是二级软链:目标删除只改目标处,跟随后的目录与
    // skills 根 mtime 都不变,必须靠清单本体盯视检出。
    mkdirSync(path.join(project, '.pi', 'skills'), { recursive: true });
    mkdirSync(path.join(project, 'real-skill'), { recursive: true });
    mkdirSync(path.join(project, 'targets'), { recursive: true });
    writeFileSync(path.join(project, 'real-skill', 'SKILL.md'), '---\nname: foo\ndescription: t\n---\n');
    symlinkSync(path.join(project, 'real-skill'), path.join(project, '.pi', 'skills', 'foo'), 'dir');
    rmSync(path.join(project, 'real-skill', 'SKILL.md'));
    symlinkSync(path.join(project, 'targets', 'real.md'), path.join(project, 'real-skill', 'SKILL.md'));
    const baseline = snapshot();
    // 目标落地(悬空链的本体已入盯视,写入后 stat 由 -1 变实值)→ 判漂移
    writeFileSync(path.join(project, 'targets', 'real.md'), '---\nname: foo\ndescription: t\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('collectors honor a shared repoRootHint (launch shares one resolution)', () => {
    writeFileSync(path.join(project, '.git'), '');
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const hint = resolvePiResourceRepoRoot(project);
    expect([...collectPiProjectResourceCliPaths(project, hint).skills])
      .toEqual([...collectPiProjectResourceCliPaths(project).skills]);
    expect([...collectPiProjectResourceWatchRootMtimes(project, hint).keys()])
      .toEqual([...collectPiProjectResourceWatchRootMtimes(project).keys()]);
  });

  it('missing directories baseline as -1 and compare against real mtimes', () => {
    const roots = collectPiProjectResourceWatchRootMtimes(project);
    expect(roots.get(path.join(project, '.pi'))).toBe(-1);
  });
});
