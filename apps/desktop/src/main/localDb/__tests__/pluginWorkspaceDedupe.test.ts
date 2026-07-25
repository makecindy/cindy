/** pluginWorkspaceDedupe.test — workspace 槽判重纯函数单测。 */

import { describe, expect, it } from 'vitest';

import { pickSessionForWorkdir } from '../pluginWorkspaceDedupe';

const row = (id: string, workingDir: string | null, updatedAt = 1000) => ({
  id,
  workingDir,
  updatedAt,
});

describe('pickSessionForWorkdir', () => {
  it('精确命中同目录的会话;查无返回 null', () => {
    const rows = [row('a', '/Users/me/proj'), row('b', '/Users/me/other')];
    expect(pickSessionForWorkdir(rows, '/Users/me/proj')).toBe('a');
    expect(pickSessionForWorkdir(rows, '/Users/me/nowhere')).toBeNull();
  });

  it('目标路径经存储归一化再比较(反斜杠/尾斜杠/长路径前缀)', () => {
    const rows = [row('a', 'C:/work/app')];
    expect(pickSessionForWorkdir(rows, 'C:\\work\\app\\')).toBe('a');
    expect(pickSessionForWorkdir(rows, '\\\\?\\C:\\work\\app')).toBe('a');
  });

  it('worktree 子目录折叠到主仓(与侧边栏"同一工作区"口径一致)', () => {
    const rows = [row('a', '/Users/me/proj')];
    expect(pickSessionForWorkdir(rows, '/Users/me/proj/.worktrees/feat-x')).toBe('a');
    expect(pickSessionForWorkdir(rows, '/Users/me/proj/.claude/worktrees/feat-y')).toBe('a');
  });

  it('多条命中取 updatedAt 最新;null workingDir 行被跳过', () => {
    const rows = [
      row('old', '/p/app', 1000),
      row('new', '/p/app', 2000),
      row('none', null, 9000),
    ];
    expect(pickSessionForWorkdir(rows, '/p/app')).toBe('new');
  });

  it('与全仓现状一致:比较不做大小写折叠(大小写不同 = 不同工作区)', () => {
    const rows = [row('a', 'C:/Work/App')];
    expect(pickSessionForWorkdir(rows, 'c:/work/app')).toBeNull();
  });

  it('空白/空目标返回 null,不误配', () => {
    expect(pickSessionForWorkdir([row('a', '/p')], '')).toBeNull();
    expect(pickSessionForWorkdir([row('a', '/p')], '   ')).toBeNull();
  });
});
