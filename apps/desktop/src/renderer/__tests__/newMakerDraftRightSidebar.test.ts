import { describe, expect, it } from 'vitest';

import {
  DRAFT_RIGHT_SIDEBAR_TOGGLE_DRAG_STYLE,
  composerDraftKeyForRightSidebarSession,
  makeProjectDraftRightSidebarSessionId,
  resolveNewMakerDraftRightSidebar,
} from '@/features/cc-agent/newMakerDraftRightSidebar';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';

describe('New Maker draft right sidebar', () => {
  it('enables the right sidebar for local project-backed drafts', () => {
    const state = resolveNewMakerDraftRightSidebar({
      workingDir: '  C:\\Work\\XDMaker  ',
      remoteHostId: null,
      deviceLinkDeviceId: null,
    });

    expect(state).toEqual({
      available: true,
      sessionId: makeProjectDraftRightSidebarSessionId('C:\\Work\\XDMaker'),
      workdir: 'C:\\Work\\XDMaker',
      remoteHostId: null,
      deviceLinkDeviceId: null,
    });
  });

  it('uses a per-project memory bucket instead of reusing one draft session id', () => {
    expect(makeProjectDraftRightSidebarSessionId('/repo/a')).not.toBe(
      makeProjectDraftRightSidebarSessionId('/repo/b'),
    );
  });

  it('does not expose the full sidebar for dialogue or remote drafts', () => {
    expect(
      resolveNewMakerDraftRightSidebar({
        workingDir: null,
        remoteHostId: null,
        deviceLinkDeviceId: null,
      }),
    ).toMatchObject({ available: false, sessionId: null, workdir: null });

    expect(
      resolveNewMakerDraftRightSidebar({
        workingDir: '   ',
        remoteHostId: null,
        deviceLinkDeviceId: null,
      }),
    ).toMatchObject({ available: false, sessionId: null, workdir: null });

    expect(
      resolveNewMakerDraftRightSidebar({
        workingDir: '/srv/app',
        remoteHostId: 'ssh-host',
        deviceLinkDeviceId: null,
      }),
    ).toMatchObject({ available: false, sessionId: null, workdir: null });

    expect(
      resolveNewMakerDraftRightSidebar({
        workingDir: '/remote/app',
        remoteHostId: null,
        deviceLinkDeviceId: 'device-id',
      }),
    ).toMatchObject({ available: false, sessionId: null, workdir: null });
  });

  it('keeps the Windows toggle outside the Electron drag region', () => {
    expect(DRAFT_RIGHT_SIDEBAR_TOGGLE_DRAG_STYLE).toMatchObject({
      WebkitAppRegion: 'no-drag',
    });
  });

  // browser-comment-chip:草稿页 bucket 的评论必须路由到可见 composer 的草稿键,
  // 真实会话原样返回(写错键 = toast 成功但胶囊不出现)。
  it('maps the project-draft bucket to NEW_MAKER_DRAFT_KEY and passes real sessions through', () => {
    expect(
      composerDraftKeyForRightSidebarSession(
        makeProjectDraftRightSidebarSessionId('/srv/app'),
      ),
    ).toBe(NEW_MAKER_DRAFT_KEY);
    expect(composerDraftKeyForRightSidebarSession('session-uuid-1')).toBe('session-uuid-1');
  });
});
