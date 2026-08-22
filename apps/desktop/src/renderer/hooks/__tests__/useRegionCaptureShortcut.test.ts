import { describe, expect, it } from 'vitest';

import { NEW_MAKER_DRAFT_KEY } from '../../features/cc-agent/newMakerDraftKeys';
import { resolveRegionCaptureTargetFromPath } from '../useRegionCaptureShortcut';

describe('resolveRegionCaptureTargetFromPath', () => {
  it('session route → that session (draft key = session id)', () => {
    expect(resolveRegionCaptureTargetFromPath('/cc-agent/abc-123')).toEqual({
      sessionId: 'abc-123',
      draftKey: 'abc-123',
    });
  });

  it('new-maker draft route → NEW_MAKER_DRAFT_KEY, no session id (base64 attachment path)', () => {
    expect(resolveRegionCaptureTargetFromPath('/cc-agent/new')).toEqual({
      sessionId: null,
      draftKey: NEW_MAKER_DRAFT_KEY,
    });
  });

  // 无主内容区 composer 的路由不消费按键(触发端据 null 返回 false, 按键保持
  // 原生行为)。files 段是文档浏览(rail composer 不作为目标, 归属对用户不可
  // 预期); boot/new-dialogue/scheduled 是非会话段。
  it('routes without a main-area composer → null', () => {
    for (const pathname of [
      '/settings',
      '/issues',
      '/cc-agent/files/some-doc',
      '/cc-agent/boot',
      '/cc-agent/new-dialogue',
      '/cc-agent/scheduled',
      '/cc-agent/orca/some-lead',
      '/',
    ]) {
      expect(resolveRegionCaptureTargetFromPath(pathname)).toBeNull();
    }
  });
});
