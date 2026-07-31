import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  addSessionExtraDir,
  aiRenameFailureText,
  buildSessionInfoWorkspace,
  buildSessionMenuActions,
  buildSessionMenuHeader,
  removeSessionExtraDir,
  sessionInfoShowsExtraDirs,
  sessionMenuCopyLink,
  settleSessionMenuBack,
} from '@/session/sessionMenu';
import type { RemoteSession } from '@/session/types';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: '83639512-9c1f-4b6e-b1de-0a1b2c3d7ed0',
    userId: 'u1',
    title: '修复语音输入丢字',
    workingDir: '/Users/alice/Code/Tools/xdt-maker',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('sessionMenu header', () => {
  it('builds title, meta line and usage summary for a plain session', () => {
    const header = buildSessionMenuHeader(session({
      totalMoney: {
        amount: 2.312,
        currency: 'CNY',
        approximate: false,
        kind: 'actual-cost',
      },
      totalCostUsd: 99,
      contextTokens: 90000,
      contextWindow: 200000,
    }), {});
    expect(header.title).toBe('修复语音输入丢字');
    expect(header.chips).toEqual([]);
    expect(header.metaLine).toBe('Claude · xdt-maker');
    expect(header.usageSummary).toBe('¥2.31 · 上下文 45%');
  });

  it('falls back to workspace name when the session has no title', () => {
    expect(buildSessionMenuHeader(session({ title: '' }), {}).title).toBe('xdt-maker');
    expect(buildSessionMenuHeader(session({ title: '', workingDir: null }), {}).title).toBe('远程对话');
  });

  it('未起名会话显示本地化兜底,不回落工作目录名', () => {
    // 哨兵若按「无标题」处理会回落 workspaceName 显示目录名,与 desktop 的
    // 「未命名对话」不一致(PR #1031 review P1)。
    expect(buildSessionMenuHeader(session({ title: 'New Maker' }), {}).title).toBe('未命名对话');
  });

  it('prefers the worktree name in the meta line', () => {
    const header = buildSessionMenuHeader(session({
      agentKind: 'codex',
      worktreePath: '/repo/.xdt-worktrees/voice-fix',
    }), {});
    expect(header.metaLine).toBe('Codex · worktree voice-fix');
  });

  it('collects status chips in a stable order', () => {
    const header = buildSessionMenuHeader(session({
      pinnedAt: '2026-01-02T00:00:00.000Z',
      status: 'archived',
      orcaRole: 'lead',
    }), { readOnlyReason: '协作只读' });
    expect(header.chips.map((chip) => chip.id)).toEqual(['pinned', 'archived', 'readonly', 'collab']);
    expect(header.chips[3]?.label).toBe('协作 Lead');
  });

  it('hides the usage summary when no cost and no context data exist', () => {
    expect(buildSessionMenuHeader(session(), {}).usageSummary).toBeNull();
  });
});

describe('sessionMenu actions', () => {
  it('builds the primary action list with state-aware labels', () => {
    const actions = buildSessionMenuActions({
      archived: false,
      pinned: false,
      busy: false,
      writeDisabled: false,
    });
    expect(actions.map((action) => action.id)).toEqual(['rename', 'copyLink', 'pin', 'archive', 'delete']);
    expect(actions.find((action) => action.id === 'copyLink')?.label).toBe('复制对话链接');
    expect(actions.find((action) => action.id === 'pin')?.label).toBe('置顶');
    expect(actions.find((action) => action.id === 'archive')?.testID).toBe('session.archiveButton');
    expect(actions.find((action) => action.id === 'delete')?.tone).toBe('danger');
  });

  it('flips pin and archive labels by session state', () => {
    const actions = buildSessionMenuActions({
      archived: true,
      pinned: true,
      busy: false,
      writeDisabled: false,
    });
    expect(actions.find((action) => action.id === 'pin')?.label).toBe('取消置顶');
    expect(actions.find((action) => action.id === 'archive')?.label).toBe('恢复');
    expect(actions.find((action) => action.id === 'archive')?.testID).toBe('session.restoreButton');
  });

  it('disables write actions in read-only mode but keeps copy link usable', () => {
    const actions = buildSessionMenuActions({
      archived: false,
      pinned: false,
      busy: false,
      writeDisabled: true,
    });
    expect(actions.find((action) => action.id === 'rename')?.disabled).toBe(true);
    expect(actions.find((action) => action.id === 'delete')?.disabled).toBe(true);
    expect(actions.find((action) => action.id === 'copyLink')?.disabled).toBe(false);
  });
});

describe('sessionMenu info model', () => {
  it('describes worktree sessions and plain workspace sessions', () => {
    expect(buildSessionInfoWorkspace(session({ worktreePath: '/repo/.xdt-worktrees/voice-fix' })))
      .toEqual({ label: 'Worktree', name: 'voice-fix', path: '/repo/.xdt-worktrees/voice-fix' });
    expect(buildSessionInfoWorkspace(session()))
      .toEqual({ label: '工作目录', name: 'xdt-maker', path: '/Users/alice/Code/Tools/xdt-maker' });
    expect(buildSessionInfoWorkspace(session({ workingDir: null }))).toBeNull();
  });

  it('limits the extra dirs entry to cc project sessions', () => {
    expect(sessionInfoShowsExtraDirs(session())).toBe(true);
    expect(sessionInfoShowsExtraDirs(session({ agentKind: 'codex' }))).toBe(false);
    expect(sessionInfoShowsExtraDirs(session({ workspaceKind: 'dialogue' }))).toBe(false);
    expect(sessionInfoShowsExtraDirs(session({ workingDir: null }))).toBe(false);
  });

  it('adds and removes extra dirs with dedupe', () => {
    expect(addSessionExtraDir(['/repo/docs'], '/repo/tools')).toEqual({
      dirs: ['/repo/docs', '/repo/tools'],
      changed: true,
    });
    expect(addSessionExtraDir(['/repo/docs'], '/repo/docs')).toEqual({
      dirs: ['/repo/docs'],
      changed: false,
    });
    expect(removeSessionExtraDir(['/repo/docs', '/repo/tools'], '/repo/docs')).toEqual(['/repo/tools']);
  });
});

describe('sessionMenu navigation', () => {
  it('copies the mobile deep link for the session', () => {
    expect(sessionMenuCopyLink(session({ id: 'abc' }))).toBe('cindy://session/abc');
  });

  it('settles back navigation in two stages', () => {
    expect(settleSessionMenuBack('info')).toEqual({ close: false });
    expect(settleSessionMenuBack('menu')).toEqual({ close: true });
  });
});

describe('sessionMenu ai rename failure text', () => {
  it('maps outdated controlled devices to an upgrade hint', () => {
    expect(aiRenameFailureText(new Error("[CHANNEL_NOT_ALLOWED] channel 'maker:regenerate-title' not allowed")))
      .toBe('被控设备版本过旧，暂不支持自动起名。');
    const coded = new Error('rejected');
    (coded as { code?: string }).code = 'DEVICE_LINK_VERSION_MISMATCH';
    expect(aiRenameFailureText(coded)).toBe('被控设备版本过旧，暂不支持自动起名。');
  });

  it('maps offline links by exact device-link codes and falls back to a generic failure', () => {
    expect(aiRenameFailureText(new Error('[DEVICE_OFFLINE] target device offline')))
      .toBe('被控设备不在线，稍后再试。');
    expect(aiRenameFailureText(new Error('[LINK_NOT_OPEN] link not open')))
      .toBe('被控设备不在线，稍后再试。');
    expect(aiRenameFailureText(new Error('[NOT_CONNECTED] relay not connected')))
      .toBe('被控设备不在线，稍后再试。');
    expect(aiRenameFailureText(new Error('[BACKPRESSURE] buffer full')))
      .toBe('被控设备不在线，稍后再试。');
    expect(aiRenameFailureText(new Error('[INVOKE_TIMEOUT] no invoke-result within 15000ms')))
      .toBe('被控设备不在线，稍后再试。');
    // 非链路类全大写超时码不允许误判为离线(review P2 反馈的误命中场景)。
    expect(aiRenameFailureText(new Error('[DB_QUERY_TIMEOUT] query slow'))).toBe('自动起名失败，请重试。');
    expect(aiRenameFailureText(new Error('boom'))).toBe('自动起名失败，请重试。');
  });
});
