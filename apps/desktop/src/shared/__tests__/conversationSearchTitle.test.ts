/**
 * conversationSearchTitle —— 会话搜索「匹配串 = 渲染串」的唯一出口。
 *
 * main 用它算 titleMatchIndices、renderer 用它渲染结果行,两端必须逐字一致,
 * 否则未起名会话的高亮下标会落在别的字上。这里锁住那份契约。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import { conversationSearchTitle } from '../conversationSearch';

describe('conversationSearchTitle', () => {
  it('哨兵标题换成调用方给的本地化文案', () => {
    expect(conversationSearchTitle(DEFAULT_DRAFT_SESSION_TITLE, '未命名对话')).toBe('未命名对话');
  });

  it('普通标题原样返回(不受 label 影响)', () => {
    expect(conversationSearchTitle('修 Orca 心跳', '未命名对话')).toBe('修 Orca 心跳');
  });

  it('没传 label(旧 renderer 构建)时退回原始标题,不静默变成空串', () => {
    expect(conversationSearchTitle(DEFAULT_DRAFT_SESSION_TITLE)).toBe(DEFAULT_DRAFT_SESSION_TITLE);
    expect(conversationSearchTitle(DEFAULT_DRAFT_SESSION_TITLE, null)).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });

  it('投影结果与哨兵长度无关:高亮下标按返回串算,两端调同一函数即对齐', () => {
    const label = 'Untitled session';
    const projected = conversationSearchTitle(DEFAULT_DRAFT_SESSION_TITLE, label);
    expect(projected).toBe(label);
    // 原始哨兵长度 9、label 长度 16 —— 若一端用原串一端用投影串,下标必然越界/错位。
    expect(DEFAULT_DRAFT_SESSION_TITLE.length).not.toBe(projected.length);
  });
});
