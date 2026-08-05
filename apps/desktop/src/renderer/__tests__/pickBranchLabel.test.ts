/**
 * pickBranchLabel 单测 — 分支 chip 的来源优先级。
 * 重点回归:branchSource='workingDir' 且会话有 PR 引用时,PR 分支还没加载出来
 * (no-token / 加载中 / fetch 失败,prBranch=null)绝不能退回共享 working_dir 分支。
 */

import { describe, it, expect } from 'vitest';

import { pickBranchLabel } from '../features/cc-agent/gitContextPrVisuals';

describe('pickBranchLabel', () => {
  it('遥测目录可信:显示其分支,即使有 PR 也优先', () => {
    expect(
      pickBranchLabel({ localBranch: 'fix/a', prBranch: 'pr/b', branchSource: 'telemetry', hasPrRefs: true }),
    ).toBe('fix/a');
  });

  it('worktree 来源可信:显示其分支', () => {
    expect(
      pickBranchLabel({ localBranch: 'feat/wt', prBranch: null, branchSource: 'worktree', hasPrRefs: false }),
    ).toBe('feat/wt');
  });

  it('workingDir + 无 PR 引用:显示 working_dir 分支(最后兜底)', () => {
    expect(
      pickBranchLabel({ localBranch: 'main', prBranch: null, branchSource: 'workingDir', hasPrRefs: false }),
    ).toBe('main');
  });

  it('workingDir + 有 PR + PR 分支已加载:显示 PR 分支', () => {
    expect(
      pickBranchLabel({ localBranch: 'main', prBranch: 'fix/voice', branchSource: 'workingDir', hasPrRefs: true }),
    ).toBe('fix/voice');
  });

  it('【回归】workingDir + 有 PR + PR 分支未加载(null):留空,不退回共享分支', () => {
    expect(
      pickBranchLabel({ localBranch: 'perf/shared', prBranch: null, branchSource: 'workingDir', hasPrRefs: true }),
    ).toBeNull();
  });

  it('无可解析目录(source=null):留空', () => {
    expect(
      pickBranchLabel({ localBranch: null, prBranch: null, branchSource: null, hasPrRefs: false }),
    ).toBeNull();
  });

  it('source=null 但有 PR 分支:显示 PR 分支(worktree 删了的会话)', () => {
    expect(
      pickBranchLabel({ localBranch: null, prBranch: 'fix/gone', branchSource: null, hasPrRefs: true }),
    ).toBe('fix/gone');
  });
});
