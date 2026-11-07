/**
 * 项目资源漂移检测 —— 纯 fs 单测(不 spawn pi)。
 *
 * 契约:snapshotPiProjectResourceLaunch 冻结"路径集合 + watch root mtime 基线";
 * piProjectResourcesDrifted 两级判定 —— mtime 全等 → 无漂移(stat 快检,零扫描);
 * mtime 变化 → 全量重扫按路径集合判定(集合相同不回收,路径集合才是 argv 的输入)。
 * watch roots 必须覆盖 collector 枚举的每个资源目录及其父目录,否则"目录从无到有"
 * 的创建事件会被漏掉。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectPiProjectResourceCliPaths,
  collectPiProjectResourceWatchRootMtimes,
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

function snapshot() {
  return snapshotPiProjectResourceLaunch(project, collectPiProjectResourceCliPaths(project));
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
    const baseline = snapshotPiProjectResourceLaunch(nested, collectPiProjectResourceCliPaths(nested));
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

  it('missing directories baseline as -1 and compare against real mtimes', () => {
    const roots = collectPiProjectResourceWatchRootMtimes(project);
    expect(roots.get(path.join(project, '.pi'))).toBe(-1);
  });
});
