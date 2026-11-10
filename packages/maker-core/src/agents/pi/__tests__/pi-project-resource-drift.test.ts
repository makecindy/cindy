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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectPiProjectResourceCliPaths,
  collectPiProjectResourceLaunchWatch,
  piProjectResourcesDrifted,
  resolvePiResourceRepoRoot,
  snapshotPiProjectResourceLaunch,
} from '../project-resource-cli.js';
import type { PiProjectResourceCliPaths } from '../project-resource-cli.js';

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

/** 实现内部以 realpath(scanRoot) 作键前缀、未创建尾段词法拼接（macOS 的 os.tmpdir() 是 /var/folders 软链）：断言必须同语义查键，否则键恒缺失（MagicLizi P1 两轮）。canon 向上走到最深存在祖先做 realpath，再把不存在的尾段按原序拼回 —— 对已存在路径等价于 realpathSync。 */
function canon(target: string): string {
  const abs = path.isAbsolute(target) ? target : path.resolve(target);
  const missingTail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...missingTail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      missingTail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// Windows 文件时间戳有粒度(最粗 ~15.6ms):同一 tick 内的连续 mkdir/write 不改
// 父目录 mtime,快检判不出漂移就不触发重扫 —— 断言依赖漂移判定的步骤必须显式
// 推 mtime,否则 Windows CI 会偶发假失败(2026-11-08 run 42406651024 实报)。
function bumpMtime(target: string): void {
  const t = new Date(statSync(target).mtimeMs + 50);
  utimesSync(target, t, t);
}

function snapshot(restrict?: (paths: PiProjectResourceCliPaths) => PiProjectResourceCliPaths) {
  // 与生产调用点同序:watch 采样(含解析身份)先于路径收集(见 snapshotPiProjectResourceLaunch)。
  const repoRoot = resolvePiResourceRepoRoot(project);
  const watch = collectPiProjectResourceLaunchWatch(project, repoRoot);
  return snapshotPiProjectResourceLaunch(project, collectPiProjectResourceCliPaths(project, repoRoot), repoRoot, watch, restrict);
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
    bumpMtime(path.join(project, '.pi', 'skills'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('returns to no-drift when the added skill is removed again', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    writeSkill(path.join('.pi', 'skills'), 'beta');
    bumpMtime(path.join(project, '.pi', 'skills'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
    rmSync(path.join(project, '.pi', 'skills', 'beta'), { recursive: true, force: true });
    bumpMtime(path.join(project, '.pi', 'skills'));
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
    const nestedRepoRoot = resolvePiResourceRepoRoot(nested);
    const nestedWatch = collectPiProjectResourceLaunchWatch(nested, nestedRepoRoot);
    const baseline = snapshotPiProjectResourceLaunch(
      nested, collectPiProjectResourceCliPaths(nested, nestedRepoRoot), nestedRepoRoot, nestedWatch);
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
    const roots = collectPiProjectResourceLaunchWatch(nested).mtimes;
    expect(roots.has(canon(path.join(nested, '.pi')))).toBe(true);
    expect(roots.has(canon(path.join(nested, '.agents')))).toBe(true);
    expect(roots.has(canon(path.join(nested, '.agents', 'skills')))).toBe(true);
    expect(roots.has(canon(path.join(project, '.agents')))).toBe(true);
    expect(roots.has(canon(path.join(project, '.agents', 'skills')))).toBe(true);
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
    const mtimeAtLaunch = baseline.watchRootMtimes.get(canon(skillsDir))!;
    // 无关子目录:改了 skills 根 mtime,但不改变路径集合
    mkdirSync(path.join(skillsDir, 'unrelated'), { recursive: true });
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 基线已就地刷新:下一次快检恢复零扫描,且真实漂移仍能检出
    expect(baseline.watchRootMtimes.get(canon(skillsDir))).toBe(statMtime(skillsDir));
    expect(baseline.watchRootMtimes.get(canon(skillsDir))).not.toBe(mtimeAtLaunch);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    writeSkill(path.join('.pi', 'skills'), 'beta');
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('watch roots cover namespace and nested skill levels plus extension child dirs', () => {
    writeSkill(path.join('.pi', 'skills', '@scope'), 'alpha');
    mkdirSync(path.join(project, '.pi', 'skills', '@scope', 'plain'), { recursive: true });
    mkdirSync(path.join(project, '.pi', 'extensions', 'myext'), { recursive: true });
    const roots = collectPiProjectResourceLaunchWatch(project).mtimes;
    const ns = path.join(project, '.pi', 'skills', '@scope');
    expect(roots.has(canon(ns))).toBe(true);
    expect(roots.has(canon(path.join(ns, 'alpha')))).toBe(true);
    expect(roots.has(canon(path.join(ns, 'plain')))).toBe(true);
    expect(roots.has(canon(path.join(project, '.pi', 'extensions', 'myext')))).toBe(true);
  });

  it('launch snapshot samples watch roots before path collection (race-safe order)', () => {
    // 生产调用点先采基线后收集路径。基线采样与路径收集之间新增的资源已在集合
    // 里且基线较旧:首次快检多一次重扫确认集合一致后刷新基线 —— 既不误报漂移,
    // 也不会静默漏检(反序才会漏)。
    const repoRoot = resolvePiResourceRepoRoot(project);
    const watch = collectPiProjectResourceLaunchWatch(project, repoRoot);
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshotPiProjectResourceLaunch(
      project, collectPiProjectResourceCliPaths(project, repoRoot), repoRoot, watch);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    expect(baseline.watchRootMtimes.get(canon(path.join(project, '.pi', 'skills'))))
      .toBe(statMtime(path.join(project, '.pi', 'skills')));
  });

  it('samples resolved identity before collecting paths (launch-window retarget is drift)', () => {
    // 回归(Codex P2,2026-11-10):身份基线若在 argv 收集之后采样,「采基线前的
    // 改指」会被固化成一致基线(mtime 孪生树碰撞时无任何信号)→ 永久漏检。
    // 按生产序复刻:① 采 watch(含解析身份)→ ② 收集 argv → ③ 窗口内改指孪生树
    // → ④ 建快照。快检必须凭身份信号判漂移。
    const realA = path.join(project, 'workspaces', 'real-a');
    const realB = path.join(project, 'workspaces', 'real-b');
    writeSkill(path.join('workspaces', 'real-a', '.pi', 'skills'), 'alpha-a');
    writeSkill(path.join('workspaces', 'real-b', '.pi', 'skills'), 'alpha-b');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    // mtime 孪生:两树各层对齐到整秒,排除 mtime 信号,身份是唯一信号
    const aligned = new Date(Math.floor(Date.now() / 1000) * 1000);
    for (const [root, skill] of [[realA, 'alpha-a'], [realB, 'alpha-b']] as const) {
      for (const dir of [root, path.join(root, '.pi'), path.join(root, '.pi', 'skills'), path.join(root, '.pi', 'skills', skill)]) {
        utimesSync(dir, aligned, aligned);
      }
    }
    const link = path.join(project, 'wd-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(realA, link, linkType);
    const launchRepoRoot = resolvePiResourceRepoRoot(link);
    const watch = collectPiProjectResourceLaunchWatch(link, launchRepoRoot); // ① 采 watch
    const paths = collectPiProjectResourceCliPaths(link, launchRepoRoot); // ② argv 来自 A
    rmSync(link);
    symlinkSync(realB, link, linkType); // ③ 窗口内改指 B(mtime 已对齐)
    const baseline = snapshotPiProjectResourceLaunch(link, paths, launchRepoRoot, watch); // ④ 建快照
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a skill added within the same timestamp tick (entry fingerprint signal)', () => {
    // NTFS/FAT 时间戳量化:基线采样后同一 tick 内新增,mtime 与基线逐位相等 ——
    // 只看 mtime 会永久漏检(集合不变则基线永不刷新)。条目名指纹是第二信号。
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const aligned = new Date(Math.floor(Date.now() / 1000) * 1000);
    const skillsDir = path.join(project, '.pi', 'skills');
    utimesSync(skillsDir, aligned, aligned);
    const baseline = snapshot();
    writeSkill(path.join('.pi', 'skills'), 'beta');
    // 显式把 mtime 恢复到基线值,模拟「同一 tick」的量化等值
    utimesSync(skillsDir, aligned, aligned);
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('guest restriction: outside-scope set change is not drift (no recycle loop), inside-scope is', () => {
    // 受邀者:argv 只含 guestRoot 裁剪后的集合,漂移必须按同一口径比较(fresh 先
    // 裁剪再比)。裁剪缺失时拿全量比裁剪基线,镜像外任何变化恒判漂移 → 回收死
    // 循环;快照缺失(旧行为)时镜像内新增永不生效。
    writeFileSync(path.join(project, '.git'), '');
    writeSkill(path.join('mirror', 'sub', '.pi', 'skills'), 'alpha');
    writeSkill(path.join('.agents', 'skills'), 'global'); // 枚举链越过 mirror:收集到但被裁剪
    const wd = path.join(project, 'mirror', 'sub');
    const scope = canon(path.join(project, 'mirror')) + path.sep;
    const restrict = (p: PiProjectResourceCliPaths): PiProjectResourceCliPaths => ({
      skills: Object.freeze(p.skills.filter((s) => s.startsWith(scope))),
      promptTemplates: Object.freeze(p.promptTemplates.filter((s) => s.startsWith(scope))),
      extensions: Object.freeze([] as readonly string[]),
    });
    const launchRepoRoot = resolvePiResourceRepoRoot(wd);
    const collected = collectPiProjectResourceCliPaths(wd, launchRepoRoot);
    // 前提:全量收集含 mirror 外的技能(链上 .agents 越过 guestRoot)
    expect(collected.skills.some((s) => !s.startsWith(scope))).toBe(true);
    const watch = collectPiProjectResourceLaunchWatch(wd, launchRepoRoot);
    const baseline = snapshotPiProjectResourceLaunch(wd, restrict(collected), launchRepoRoot, watch, restrict);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // mirror 外新增:有信号(链上 .agents 被盯),裁剪口径下集合未变 → 不回收
    writeSkill(path.join('.agents', 'skills'), 'global-2');
    bumpMtime(path.join(project, '.agents'));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // mirror 内新增:受邀者 argv 真会变 → 漂移
    writeSkill(path.join('mirror', 'sub', '.pi', 'skills'), 'beta');
    bumpMtime(path.join(wd, '.pi', 'skills'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('stores null entries baseline for collector-excluded keys (symlink namespace to outside-repo target)', () => {
    // Greptile P2:collector 不枚举越界/软链 namespace 子树,条目基线存 null ——
    // 快检不 readdir 其目标(readdir 跟随软链,外部大目录完整列表是每条消息一次
    // 的纯开销);改指信号由解析身份承担。
    mkdirSync(path.join(project, 'repo'), { recursive: true });
    writeFileSync(path.join(project, 'repo', '.git'), '');
    writeSkill(path.join('repo', '.pi', 'skills'), 'alpha');
    writeSkill(path.join('outside', 'big'), 'huge'); // repoRoot 外的目标树
    mkdirSync(path.join(project, 'repo', '.pi', 'skills'), { recursive: true });
    symlinkSync(path.join(project, 'outside', 'big'), path.join(project, 'repo', '.pi', 'skills', '@scope'), 'junction');
    const wd = path.join(project, 'repo');
    const launchRepoRoot = resolvePiResourceRepoRoot(wd);
    const watch = collectPiProjectResourceLaunchWatch(wd, launchRepoRoot);
    // 前提:软链 namespace 键的条目基线为 null(快检将跳读)。键是链接路径本体,
    // 不能用 canon 查(canonical 化会把键解析成目标路径)
    expect(watch.entries.get(path.join(realpathSync(wd), '.pi', 'skills', '@scope'))).toBeNull();
    const baseline = snapshotPiProjectResourceLaunch(
      wd, collectPiProjectResourceCliPaths(wd, launchRepoRoot), launchRepoRoot, watch);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 目标树内部增删:集合不变 → 不漂移(mtime 跟随目标会触发一次重扫后收敛)
    writeSkill(path.join('outside', 'big'), 'more');
    bumpMtime(path.join(project, 'outside', 'big'));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
  });

  it('rebuilds the watch map after an unchanged rescan so new child dirs are watched', () => {
    mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
    const baseline = snapshot();
    // 重扫窗口内新建的空扩展目录:集合未变,但必须从此纳入盯视
    mkdirSync(path.join(project, '.pi', 'extensions', 'newext'), { recursive: true });
    bumpMtime(path.join(project, '.pi', 'extensions'));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    expect(baseline.watchRootMtimes.has(canon(path.join(project, '.pi', 'extensions', 'newext')))).toBe(true);
    // 若不重建基线,这里的 index.ts 只改未盯视的新子目录 mtime,永远检不出
    writeFileSync(path.join(project, '.pi', 'extensions', 'newext', 'index.ts'), 'export {};\n');
    bumpMtime(path.join(project, '.pi', 'extensions', 'newext'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('treats a missing .pi/extensions appearing as an empty dir as no drift (resolution null→path)', () => {
    writeSkill(path.join('.pi', 'skills'), 'alpha');
    const baseline = snapshot();
    // 前提:缺失的扩展根已在监测表中,基线解析为 null(Greptile P2)
    expect(baseline.watchRootsResolved.get(canon(path.join(project, '.pi', 'extensions')))).toBeNull();
    // 仅创建空目录:资源路径集合仍相同,不得误报漂移触发多余冷启动
    mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
    bumpMtime(path.join(project, '.pi', 'extensions'));
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 空目录已纳入盯视:之后真正的扩展落地必须检出
    writeFileSync(path.join(project, '.pi', 'extensions', 'hook.ts'), 'export {};\n');
    bumpMtime(path.join(project, '.pi', 'extensions'));
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('detects a nearer git boundary appearing after launch (repo root identity)', () => {
    mkdirSync(path.join(project, 'outer', '.agents', 'skills'), { recursive: true });
    writeFileSync(path.join(project, 'outer', '.git'), '');
    writeSkill(path.join('outer', '.agents', 'skills'), 'outer-skill');
    const nested = path.join(project, 'outer', 'sub');
    mkdirSync(nested, { recursive: true });
    const nestedRepoRoot = resolvePiResourceRepoRoot(nested);
    const nestedWatch = collectPiProjectResourceLaunchWatch(nested, nestedRepoRoot);
    const baseline = snapshotPiProjectResourceLaunch(
      nested, collectPiProjectResourceCliPaths(nested, nestedRepoRoot), nestedRepoRoot, nestedWatch);
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 子目录自己 git init:枚举链截断,outer skill 不再属于本项目边界
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    bumpMtime(nested);
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('does not recycle for a git boundary change that excludes no resources', () => {
    mkdirSync(path.join(project, 'outer'), { recursive: true });
    writeFileSync(path.join(project, 'outer', '.git'), '');
    const nested = path.join(project, 'outer', 'sub');
    mkdirSync(path.join(nested, '.pi', 'skills', 'alpha'), { recursive: true });
    writeFileSync(path.join(nested, '.pi', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: t\n---\n');
    const nestedRepoRoot = resolvePiResourceRepoRoot(nested);
    const nestedWatch = collectPiProjectResourceLaunchWatch(nested, nestedRepoRoot);
    const baseline = snapshotPiProjectResourceLaunch(
      nested, collectPiProjectResourceCliPaths(nested, nestedRepoRoot), nestedRepoRoot, nestedWatch);
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
    expect([...collectPiProjectResourceLaunchWatch(project, hint).mtimes.keys()])
      .toEqual([...collectPiProjectResourceLaunchWatch(project).mtimes.keys()]);
  });

  it('missing directories baseline as -1 and compare against real mtimes', () => {
    const roots = collectPiProjectResourceLaunchWatch(project).mtimes;
    expect(roots.get(canon(path.join(project, '.pi')))).toBe(-1);
  });
  it('detects a symlinked workingDir retargeted within the same repo (resolved scan root in drift key)', () => {
    // 回归(Codex P2):workingDir 经软链启动、软链改指同仓另一目录时,repoRoot
    // 与解析后旧物理根的 mtime 均不变,快检会放行旧 argv。漂移键必须含解析后
    // 的 scanRoot:改指即漂移。junction 在 Windows CI 无特权可用。
    const realA = path.join(project, 'workspaces', 'real-a');
    const realB = path.join(project, 'workspaces', 'real-b');
    writeSkill(path.join('workspaces', 'real-a', '.pi', 'skills'), 'alpha-a');
    writeSkill(path.join('workspaces', 'real-b', '.pi', 'skills'), 'alpha-b');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    const link = path.join(project, 'wd-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(realA, link, linkType);
    const launchRepoRoot = resolvePiResourceRepoRoot(link);
    const launchWatch = collectPiProjectResourceLaunchWatch(link, launchRepoRoot);
    const baseline = snapshotPiProjectResourceLaunch(
      link,
      collectPiProjectResourceCliPaths(link, launchRepoRoot),
      launchRepoRoot,
      launchWatch,
    );
    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    rmSync(link);
    symlinkSync(realB, link, linkType);
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('retargeting the `.pi` junction to a same-mtime twin tree is drift (resolved pi-root identity)', () => {
    // 回归(Codex P2):`.pi` 本体是仓内软链时,改指结构相同、mtime 碰巧一致的
    // 另一资源树 —— watch 面取的是解析后目标的 mtime,碰撞时快检放行旧 argv;
    // 唯一信号是资源根的解析身份(realpath)。
    const targetA = path.join(project, 'pi-a');
    const targetB = path.join(project, 'pi-b');
    const piLink = path.join(project, '.pi');
    writeSkill(path.join('pi-a', 'skills'), 'alpha');
    // Windows utimes 有精度截断:先把 A 的各层目录对齐到整秒,让快照值与 B 的
    // 对齐值可以逐位相等(mtime 碰撞前提才成立)。
    const aligned = new Date(Math.floor(Date.now() / 1000) * 1000);
    for (const dir of [[] as string[], ['skills'], ['skills', 'alpha']]) {
      utimesSync(path.join(targetA, ...dir), aligned, aligned);
    }
    symlinkSync(targetA, piLink, 'junction');
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);

    // B:同名结构、不同内容;目录 mtime 调成与 A 逐层一致(watch 面失明的碰撞前提)。
    // 同名结构:让 mtime 碰撞成为唯一干扰源,解析身份才是本用例的信号。
    writeSkill(path.join('pi-b', 'skills'), 'alpha');
    // 根目录也要对齐:watch 面包含 `.pi` 解析后的目标目录自身。B 的对齐值复用
    // A 的整秒时间,让 watch 面逐位相等(mtime 碰撞前提)。
    for (const dir of [[] as string[], ['skills'], ['skills', 'alpha']]) {
      utimesSync(path.join(targetB, ...dir), aligned, aligned);
    }
    rmSync(piLink);
    symlinkSync(targetB, piLink, 'junction');


    // 改指后 lexical watch 面与 mtime 全等,唯一信号是 `.pi` 解析身份变化。
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('retargeting the `.agents` junction to a same-mtime twin tree is drift (uniform resolved identity)', () => {
    // 根治回归(Codex P2 族第三击):`.agents` 链根改指。统一解析身份基线后,
    // 任意层级改指同 mtime 的孪生树都必然触发,不再需要逐点枚举。
    const targetA = path.join(project, 'agents-a');
    const targetB = path.join(project, 'agents-b');
    const agentsLink = path.join(project, '.agents');
    writeSkill(path.join('agents-a', 'skills'), 'alpha');
    // Windows utimes 精度截断:先整秒对齐 A,快照值与 B 的对齐值才能逐位相等。
    const aligned = new Date(Math.floor(Date.now() / 1000) * 1000);
    for (const dir of [[] as string[], ['skills'], ['skills', 'alpha']]) {
      utimesSync(path.join(targetA, ...dir), aligned, aligned);
    }
    symlinkSync(targetA, agentsLink, 'junction');
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);

    // B:同名结构;三层 mtime 与 A 全等(watch 面失明的碰撞前提)。
    writeSkill(path.join('agents-b', 'skills'), 'alpha');
    for (const dir of [[] as string[], ['skills'], ['skills', 'alpha']]) {
      utimesSync(path.join(targetB, ...dir), aligned, aligned);
    }
    rmSync(agentsLink);
    symlinkSync(targetB, agentsLink, 'junction');

    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });

  it('retargeting a nested namespace junction to a same-mtime twin tree leaves the set unchanged (identity is signal, not verdict)', () => {
    // 通用性验证的另一面:collector 明文不走进软链 namespace(symlinked namespace
    // is intentionally not walked),改指前后集合都不含它 —— 按集合契约这不是漂移,
    // 不触发多余冷启动;解析身份变化只负责触发重扫(本用例的信号隔离仍成立)。
    const targetA = path.join(project, 'ns-a');
    const targetB = path.join(project, 'ns-b');
    const nsLink = path.join(project, '.pi', 'skills', '@scope');
    mkdirSync(path.dirname(nsLink), { recursive: true });
    writeSkill('ns-a', 'alpha');
    const aligned = new Date(Math.floor(Date.now() / 1000) * 1000);
    const skillsDir = path.join(project, '.pi', 'skills');
    for (const dir of [[] as string[], ['alpha']]) {
      utimesSync(path.join(targetA, ...dir), aligned, aligned);
    }
    utimesSync(skillsDir, aligned, aligned);
    symlinkSync(targetA, nsLink, 'junction');
    const baseline = snapshot();
    expect(piProjectResourcesDrifted(baseline)).toBe(false);

    writeSkill('ns-b', 'alpha');
    for (const dir of [[] as string[], ['alpha']]) {
      utimesSync(path.join(targetB, ...dir), aligned, aligned);
    }
    rmSync(nsLink);
    symlinkSync(targetB, nsLink, 'junction');
    // rm/symlink 弄脏了 `.pi/skills` 的 mtime,恢复到快照值以隔离信号。
    utimesSync(skillsDir, aligned, aligned);

    expect(piProjectResourcesDrifted(baseline)).toBe(false);
    // 契约的另一端不放松:软链 namespace 换成真目录,集合真正变化,必须检出。
    rmSync(nsLink);
    writeSkill(path.join('.pi', 'skills', '@scope'), 'alpha');
    bumpMtime(skillsDir);
    expect(piProjectResourcesDrifted(baseline)).toBe(true);
  });
});
