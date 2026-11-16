/**
 * 项目资源漂移检测 —— 纯 fs 单测(不 spawn pi)。
 *
 * 契约:启动快照只存「argv 实际使用的路径集合」;piProjectResourcesDrifted 用
 * 同一个 collector 重新采集一遍后逐项比较。**没有任何基线镜像**(无 mtime、无条目
 * 指纹、无逐 key 解析身份),因此不存在「镜像与 collector 分歧」导致的漏检:
 * 同一 tick 内的增删、清单后落地、软链改指同 mtime 孪生树都直接反映为集合变化。
 *
 * 下面每个用例都不再需要手工推 mtime —— 过去那层依赖正是盲区的来源。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectPiProjectResourceCliPaths,
  type PiProjectResourceCliPaths,
  piProjectResourcesDrifted,
  snapshotPiProjectResourceLaunch,
} from '../project-resource-cli.js';

let project = '';

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

/** 生产调用点同序:快照 = 当前采集结果(采集即 argv)。 */
function snapshot(toCliPaths?: (paths: PiProjectResourceCliPaths) => PiProjectResourceCliPaths) {
  return snapshotPiProjectResourceLaunch(project, collectPiProjectResourceCliPaths(project), toCliPaths);
}

function real(target: string): string {
  return realpathSync(target);
}

/** Windows 无软链特权:目录软链用 junction,其余平台用 dir。 */
function linkDir(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
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

  it('returns to no drift when the added skill is removed again (no baseline to refresh)', () => {
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

  it('detects a project extension file added after launch', () => {
    const baseline = snapshot();
    mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(project, '.pi', 'extensions', 'hook.ts'), 'export {};\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects index.ts added inside an existing extension dir', () => {
    mkdirSync(path.join(project, '.pi', 'extensions', 'myext'), { recursive: true });
    const baseline = snapshot();
    writeFileSync(path.join(project, '.pi', 'extensions', 'myext', 'index.ts'), 'export {};\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a skill created in a missing .pi/skills (dir from nothing)', () => {
    const baseline = snapshot();
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a skill created in a missing .agents/skills ancestor (dir from nothing)', () => {
    writeFileSync(path.join(project, '.git'), '');
    const nested = path.join(project, 'sub');
    mkdirSync(nested, { recursive: true });
    const baseline = snapshotPiProjectResourceLaunch(
      nested, collectPiProjectResourceCliPaths(nested));
    writeSkill(path.join('.agents', 'skills'), 'gamma');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
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

  it('detects a manifest installed into an in-repo direct-linked skill after launch', () => {
    // 直链 skill 指向仓内真实的空目录,之后才落地 SKILL.md:集合由空变非空,
    // 必须检出(过去靠清单指纹才能在同一 tick 内发现,现在集合比较天然覆盖)。
    writeFileSync(path.join(project, '.git'), '');
    mkdirSync(path.join(project, '.pi', 'skills'), { recursive: true });
    mkdirSync(path.join(project, 'target-dir'), { recursive: true });
    linkDir(path.join(project, 'target-dir'), path.join(project, '.pi', 'skills', 'foo'));
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    writeFileSync(path.join(project, 'target-dir', 'SKILL.md'), '---\nname: foo\ndescription: t\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('does not recycle for a symlinked namespace retarget to a twin tree (collector never walks it)', () => {
    // collector 明文不走进软链 namespace(可越界/成环)→ 改指前后集合都为空 →
    // 运行时消费的资源没有变,不触发回收。
    const targetA = path.join(project, 'ns-a');
    const targetB = path.join(project, 'ns-b');
    mkdirSync(path.join(project, '.pi', 'skills'), { recursive: true });
    writeSkill('ns-a', 'alpha');
    linkDir(targetA, path.join(project, '.pi', 'skills', '@scope'));
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    writeSkill('ns-b', 'alpha');
    rmSync(path.join(project, '.pi', 'skills', '@scope'));
    linkDir(targetB, path.join(project, '.pi', 'skills', '@scope'));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('does not recycle when entries change inside a symlinked namespace target', () => {
    const target = path.join(project, 'ns-target');
    mkdirSync(path.join(project, '.pi', 'skills'), { recursive: true });
    writeSkill('ns-target', 'alpha');
    linkDir(target, path.join(project, '.pi', 'skills', '@scope'));
    const baseline = snapshot();
    writeSkill('ns-target', 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('detects a symlinked .pi retarget even when the twin tree is structurally identical', () => {
    // 采集按 realpath 出路径:改指后 argv 里的路径全部换成另一棵树的真实路径,
    // 集合必然不同 —— 与 mtime 是否相等无关。
    writeSkill(path.join('workspaces', 'real-a', '.pi', 'skills'), 'alpha-a');
    writeSkill(path.join('workspaces', 'real-b', '.pi', 'skills'), 'alpha-b');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    linkDir(path.join(project, 'workspaces', 'real-a'), path.join(project, 'wd'));
    const baseline = snapshotPiProjectResourceLaunch(
      path.join(project, 'wd'), collectPiProjectResourceCliPaths(path.join(project, 'wd')));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    rmSync(path.join(project, 'wd'));
    linkDir(path.join(project, 'workspaces', 'real-b'), path.join(project, 'wd'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('does not collect or watch pruned generated dirs (node_modules/dist)', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    mkdirSync(path.join(project, '.pi', 'skills', 'node_modules', 'big'), { recursive: true });
    for (let i = 0; i < 40; i += 1) writeFileSync(path.join(project, '.pi', 'skills', 'node_modules', 'big', `f${i}.js`), '');
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 剪枝目录内部的变化不会进 argv,即使里面出现 SKILL.md 也不收集
    writeFileSync(path.join(project, '.pi', 'skills', 'node_modules', 'big', 'SKILL.md'), '---\nname: nope\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('detects a dangling prompt symlink whose target lands later', () => {
    mkdirSync(path.join(project, '.pi', 'prompts'), { recursive: true });
    const target = path.join(project, 'later.md');
    symlinkSync(target, path.join(project, '.pi', 'prompts', 'opsx.md'));
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    writeFileSync(target, '---\ndescription: t\n---\n');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('disabled skills do not affect argv, so their removal is not drift', () => {
    // argv 只含未被停用的项目技能;删掉一个从未加载的停用技能不应触发冷启动。
    // 停用清单在 spawn 时冻结,启动与比较共用同一口径(toCliPaths)。
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    writeSkill(path.join('.pi', 'skills'), 'disabled');
    const disabled = [real(path.join(project, '.pi', 'skills', 'disabled'))];
    const toCliPaths = (paths: PiProjectResourceCliPaths): PiProjectResourceCliPaths => ({
      ...paths,
      skills: Object.freeze(paths.skills.filter((entry) => !disabled.includes(entry))),
    });
    const collected = collectPiProjectResourceCliPaths(project);
    const baseline = snapshotPiProjectResourceLaunch(project, toCliPaths(collected), toCliPaths);
    expect(baseline.paths.skills).toEqual([real(path.join(project, '.pi', 'skills', 'alpha'))]);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    rmSync(path.join(project, '.pi', 'skills', 'disabled'), { recursive: true, force: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 未被停用的技能变化仍然必须检出
    writeSkill(path.join('.pi', 'skills'), 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('guest restriction: outside-scope set change is not drift, inside-scope is', () => {
    // 受邀者 argv 只含 guestRoot 裁剪后的集合,比较必须用同一口径;否则镜像外
    // 任何变化恒判漂移 → 回收死循环。
    writeFileSync(path.join(project, '.git'), '');
    writeSkill(path.join('mirror', 'sub', '.pi', 'skills'), 'alpha');
    writeSkill(path.join('.agents', 'skills'), 'global'); // 枚举链越过 mirror:收集到但被裁剪
    const wd = path.join(project, 'mirror', 'sub');
    const scope = path.join(real(project), 'mirror') + path.sep;
    const restrict = (paths: PiProjectResourceCliPaths): PiProjectResourceCliPaths => ({
      skills: Object.freeze(paths.skills.filter((entry) => entry.startsWith(scope))),
      promptTemplates: Object.freeze(paths.promptTemplates.filter((entry) => entry.startsWith(scope))),
      extensions: Object.freeze([] as readonly string[]),
    });
    const collected = collectPiProjectResourceCliPaths(wd);
    expect(collected.skills.some((entry) => !entry.startsWith(scope))).toBe(true);
    const baseline = snapshotPiProjectResourceLaunch(wd, restrict(collected), restrict);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    writeSkill(path.join('.agents', 'skills'), 'global-2');
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    writeSkill(path.join('mirror', 'sub', '.pi', 'skills'), 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a nearer git boundary that cuts a previously collected skill', () => {
    mkdirSync(path.join(project, 'outer', '.agents', 'skills'), { recursive: true });
    writeFileSync(path.join(project, 'outer', '.git'), '');
    writeSkill(path.join('outer', '.agents', 'skills'), 'outer-skill');
    const nested = path.join(project, 'outer', 'sub');
    mkdirSync(nested, { recursive: true });
    const baseline = snapshotPiProjectResourceLaunch(nested, collectPiProjectResourceCliPaths(nested));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('does not recycle for a git boundary change that excludes no resources', () => {
    mkdirSync(path.join(project, 'outer'), { recursive: true });
    writeFileSync(path.join(project, 'outer', '.git'), '');
    const nested = path.join(project, 'outer', 'sub');
    writeSkill(path.join('outer', 'sub', '.pi', 'skills'), 'alpha');
    const baseline = snapshotPiProjectResourceLaunch(nested, collectPiProjectResourceCliPaths(nested));
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('reports collected paths as realpaths so duplicates across roots collapse', () => {
    writeFileSync(path.join(project, '.git'), '');
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    writeSkill(path.join('.agents', 'skills'), 'beta');
    const collected = collectPiProjectResourceCliPaths(project);
    expect(collected.skills).toEqual([
      real(path.join(project, '.agents', 'skills', 'beta')),
      real(path.join(project, '.pi', 'skills', 'alpha')),
    ]);
  });
});
