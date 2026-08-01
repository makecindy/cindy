/**
 * 新建会话 worktree 纯决策逻辑测试(newSessionWorktree):
 *  - 资格判定:detect-cwd 回包按 gitInstalled → isGitRepo → isInsideWorktree 短路,
 *    eligible 携带 baseRepo(repoRoot 缺失回落 workingDir)与 sourceBranch(detached 回落 HEAD);
 *  - 探测结果绑定 device/cwd,切目标后的同步 render 不暴露旧 eligible;
 *  - 探测抛错归并:CHANNEL_NOT_ALLOWED(老被控端)→ unsupported 整行隐藏,其余 detect-failed;
 *  - 播种归并:worktreeEnabled 严格 === true 才算勾选;
 *  - 两步流第一步入参:suggest-name 结果归一(空/非法走 auto- 兜底,过工作端名字白名单);
 *  - 失败展示:message + hint 拼装。
 */
import { describe, expect, it } from 'vitest';
import type { MobileWorktreeDetectCwdResult } from '@/device-link/mobileMakerTransport';
import {
  buildWorktreeCreateRequest,
  fallbackWorktreeName,
  formatWorktreeCreateFailure,
  normalizeSuggestedWorktreeName,
  resolveWorktreeEligibility,
  seedWorktreeEnabled,
  shouldShowWorktreeToggle,
  worktreeEligibilityForTarget,
  worktreeEligibilityCaptionKey,
  worktreeEligibilityFromError,
  type NewSessionWorktreeEligibility,
} from '@/session/newSessionWorktree';

const DETECT_OK: MobileWorktreeDetectCwdResult = {
  isGitRepo: true,
  isInsideWorktree: false,
  gitInstalled: true,
  currentBranch: 'feature/x',
  repoRoot: '/repo/root',
  supportsRecoveryKeyDiscard: true,
};

describe('resolveWorktreeEligibility', () => {
  it('git 未安装 → ineligible gitMissing(优先于其它判定)', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, gitInstalled: false, isGitRepo: false },
      '/repo/app',
    )).toEqual({ status: 'ineligible', reason: 'gitMissing' });
  });

  it('非 git 仓库 → ineligible notGitRepo', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, isGitRepo: false },
      '/repo/app',
    )).toEqual({ status: 'ineligible', reason: 'notGitRepo' });
  });

  it('已在 worktree 内 → ineligible alreadyInWorktree(禁止嵌套)', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, isInsideWorktree: true },
      '/repo/app',
    )).toEqual({ status: 'ineligible', reason: 'alreadyInWorktree' });
  });

  it('资格通过:baseRepo 取 repoRoot、sourceBranch 取当前分支', () => {
    expect(resolveWorktreeEligibility(DETECT_OK, '/repo/app')).toEqual({
      status: 'eligible',
      baseRepo: '/repo/root',
      sourceBranch: 'feature/x',
    });
  });

  it('repoRoot 缺失回落 workingDir;detached HEAD 回落 HEAD(不猜 main)', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, repoRoot: undefined, currentBranch: undefined },
      '/repo/app',
    )).toEqual({ status: 'eligible', baseRepo: '/repo/app', sourceBranch: 'HEAD' });
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, repoRoot: '  ', currentBranch: '' },
      '/repo/app',
    )).toEqual({ status: 'eligible', baseRepo: '/repo/app', sourceBranch: 'HEAD' });
  });

  it('旧 Desktop 省略 recoveryKey discard 能力时，在创建副作用前 fail closed', () => {
    const { supportsRecoveryKeyDiscard: _ignored, ...legacyResult } = DETECT_OK;
    expect(resolveWorktreeEligibility(legacyResult, '/repo/app')).toEqual({
      status: 'unsupported',
    });
  });
});

describe('worktreeEligibilityForTarget', () => {
  const snapshot = {
    target: { deviceId: 'dev-a', workingDir: '/repo/a' },
    eligibility: {
      status: 'eligible' as const,
      baseRepo: '/repo/a',
      sourceBranch: 'feature/a',
    },
  };

  it('只向同设备 + 同 cwd 暴露探测结果', () => {
    expect(worktreeEligibilityForTarget(snapshot, {
      deviceId: 'dev-a',
      workingDir: ' /repo/a ',
    })).toEqual(snapshot.eligibility);
  });

  it('切项目或设备后的首帧同步回落 probing,不等待 effect 重置', () => {
    expect(worktreeEligibilityForTarget(snapshot, {
      deviceId: 'dev-a',
      workingDir: '/repo/b',
    })).toEqual({ status: 'probing' });
    expect(worktreeEligibilityForTarget(snapshot, {
      deviceId: 'dev-b',
      workingDir: '/repo/a',
    })).toEqual({ status: 'probing' });
  });
});

describe('worktreeEligibilityFromError', () => {
  it('CHANNEL_NOT_ALLOWED(老被控端)→ unsupported(整行隐藏降级)', () => {
    // 真实 wire 形状:DeviceLinkError 的 code 在 .code 字段,message **不含**该字面量
    // (被控端 dispatch 回 "channel '...' not allowed remotely")——必须靠结构化 code 命中。
    expect(worktreeEligibilityFromError(
      Object.assign(new Error("channel 'worktree:detect-cwd' not allowed remotely"), {
        code: 'CHANNEL_NOT_ALLOWED',
      }),
    )).toEqual({ status: 'unsupported' });
    // relay 层包装变体同样命中(先例 sessionReferences 对 DEVICE_LINK_ 前缀的容忍)。
    expect(worktreeEligibilityFromError(
      Object.assign(new Error('remote rejected'), { code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' }),
    )).toEqual({ status: 'unsupported' });
    // 字符串/文本内嵌 code 的兜底路径仍然保留。
    expect(worktreeEligibilityFromError('IPC_ERROR CHANNEL_NOT_ALLOWED'))
      .toEqual({ status: 'unsupported' });
  });

  it('其它错误(断连/超时)→ detect-failed(行保留、开关禁用)', () => {
    expect(worktreeEligibilityFromError(new Error('INVOKE_TIMEOUT')))
      .toEqual({ status: 'detect-failed' });
    expect(worktreeEligibilityFromError(undefined)).toEqual({ status: 'detect-failed' });
  });
});

describe('seedWorktreeEnabled', () => {
  it('只有 worktreeEnabled === true 才播种为勾选;缺字段/异常形状一律 false', () => {
    expect(seedWorktreeEnabled({ worktreeEnabled: true })).toBe(true);
    expect(seedWorktreeEnabled({ worktreeEnabled: false })).toBe(false);
    expect(seedWorktreeEnabled({})).toBe(false);
    expect(seedWorktreeEnabled(null)).toBe(false);
    expect(seedWorktreeEnabled(undefined)).toBe(false);
    expect(seedWorktreeEnabled({ worktreeEnabled: 1 as unknown as boolean })).toBe(false);
  });
});

describe('shouldShowWorktreeToggle / caption key', () => {
  const eligible: NewSessionWorktreeEligibility = {
    status: 'eligible', baseRepo: '/repo', sourceBranch: 'main',
  };

  it('project + 已选目录且通道可用才显示;dialogue / 空目录 / unsupported 隐藏', () => {
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '/repo', eligibility: eligible })).toBe(true);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'dialogue', workingDir: '/repo', eligibility: eligible })).toBe(false);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '  ', eligibility: eligible })).toBe(false);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '/repo', eligibility: { status: 'unsupported' } })).toBe(false);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '/repo', eligibility: { status: 'probing' } })).toBe(true);
  });

  it('caption key 覆盖探测中 / 三种不合格原因 / 探测失败;eligible 无 caption', () => {
    expect(worktreeEligibilityCaptionKey({ status: 'probing' })).toBe('session.new.worktreeDetecting');
    expect(worktreeEligibilityCaptionKey({ status: 'ineligible', reason: 'gitMissing' })).toBe('session.new.worktreeGitMissing');
    expect(worktreeEligibilityCaptionKey({ status: 'ineligible', reason: 'notGitRepo' })).toBe('session.new.worktreeNotGitRepo');
    expect(worktreeEligibilityCaptionKey({ status: 'ineligible', reason: 'alreadyInWorktree' })).toBe('session.new.worktreeAlreadyInWorktree');
    expect(worktreeEligibilityCaptionKey({ status: 'detect-failed' })).toBe('session.new.worktreeDetectFailed');
    expect(worktreeEligibilityCaptionKey(eligible)).toBeNull();
    expect(worktreeEligibilityCaptionKey({ status: 'unsupported' })).toBeNull();
  });
});

describe('worktree 名与 create 入参', () => {
  it('suggest-name 非空取 trim;空/非字符串走 auto- 兜底(过工作端 [a-z0-9-]、≤20 白名单)', () => {
    expect(normalizeSuggestedWorktreeName('  fix-login  ')).toBe('fix-login');
    for (const value of ['', '   ', null, undefined, 42]) {
      const name = normalizeSuggestedWorktreeName(value, 1_750_000_000_000);
      expect(name).toMatch(/^auto-[a-z0-9]{1,6}$/);
      expect(name.length).toBeLessThanOrEqual(20);
    }
  });

  it('fallbackWorktreeName 稳定可复现(时间戳 base36 后 6 位)', () => {
    const now = 1_750_000_000_000;
    expect(fallbackWorktreeName(now)).toBe(`auto-${now.toString(36).slice(-6)}`);
  });

  it('buildWorktreeCreateRequest 组装 sessionId + baseRepo + name + sourceBranch + recoveryKey', () => {
    expect(buildWorktreeCreateRequest({
      sessionId: 's-1',
      eligibility: { status: 'eligible', baseRepo: '/repo/root', sourceBranch: 'develop' },
      suggestedName: 'fix-login',
      recoveryKey: 'recovery-key-1234567890',
    })).toEqual({
      sessionId: 's-1',
      baseRepo: '/repo/root',
      name: 'fix-login',
      sourceBranch: 'develop',
      recoveryKey: 'recovery-key-1234567890',
    });
  });

  it('suggest-name 失败(null)时 create 入参用 auto- 兜底名', () => {
    const request = buildWorktreeCreateRequest({
      sessionId: 's-1',
      eligibility: { status: 'eligible', baseRepo: '/repo/root', sourceBranch: 'main' },
      suggestedName: null,
      recoveryKey: 'recovery-key-1234567890',
      now: 1_750_000_000_000,
    });
    expect(request.name).toMatch(/^auto-[a-z0-9]{1,6}$/);
  });
});

describe('formatWorktreeCreateFailure', () => {
  it('仅 message;有 hint 时另起一行补充', () => {
    expect(formatWorktreeCreateFailure({ message: '分支已存在' })).toBe('分支已存在');
    expect(formatWorktreeCreateFailure({ message: '分支已存在 ', hint: ' 换个名字重试 ' }))
      .toBe('分支已存在\n换个名字重试');
    expect(formatWorktreeCreateFailure({ message: '失败', hint: '' })).toBe('失败');
  });
});
