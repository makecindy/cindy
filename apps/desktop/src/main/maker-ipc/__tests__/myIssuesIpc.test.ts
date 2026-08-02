/**
 * 「我的 Issue」IPC adapter —— 失败时只回稳定脱敏码。
 *
 * 原始 Error.message 可能带 userData 绝对路径(electron-store 初始化失败)或上游响应
 * 片段,不得跨 Main/Renderer 边界(engineering-conventions §2)。
 */

import { describe, expect, it } from 'vitest';

import type { MyIssuesResult } from '../../../shared/myIssues';
import { handleMyIssuesList } from '../my-issues';

function emptyResult(): MyIssuesResult {
  return {
    items: [],
    githubEnhancement: null,
    githubEnhancementFailed: false,
    degraded: null,
    truncated: false,
  };
}

describe('handleMyIssuesList', () => {
  it('成功时原样透传服务结果', async () => {
    const res = await handleMyIssuesList({}, { list: async () => (emptyResult()) });
    expect(res).toMatchObject({ success: true, items: [], degraded: null });
  });

  it('force 透传给服务', async () => {
    let seen: { force?: boolean } | null = null;
    await handleMyIssuesList(
      { force: true },
      {
        list: async (options) => {
          seen = options;
          return emptyResult();
        },
      },
    );
    expect(seen).toEqual({ force: true });
  });

  it('非法 / 缺省入参一律按 force=false 处理', async () => {
    for (const raw of [undefined, null, 'nope', {}, { force: 'yes' }]) {
      let seen: { force?: boolean } | null = null;
      await handleMyIssuesList(raw, {
        list: async (options) => {
          seen = options;
          return emptyResult();
        },
      });
      expect(seen).toEqual({ force: false });
    }
  });

  it('意外错误只回 unexpected,不泄漏路径与原文', async () => {
    const leaky = new Error(
      "ENOENT: no such file or directory, open '/Users/someone/Library/Application Support/Cindy/owners/abc/submitted-issues.json'",
    );
    const res = await handleMyIssuesList({}, {
      list: async () => {
        throw leaky;
      },
    });
    expect(res).toEqual({
      success: false,
      error: 'unexpected',
      items: [],
      githubEnhancement: null,
      githubEnhancementFailed: false,
      degraded: null,
      truncated: false,
    });
    // 任何形式的原始文本都不得出现在回给 renderer 的响应里。
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('ENOENT');
    expect(serialized).not.toContain('Application Support');
    expect(serialized).not.toContain('submitted-issues.json');
  });

  it('切号导致结果作废时回专用码,便于 renderer 静默重取', async () => {
    const stale = Object.assign(new Error('active account changed'), {
      myIssuesErrorCode: 'stale-account-scope',
    });
    const res = await handleMyIssuesList({}, {
      list: async () => {
        throw stale;
      },
    });
    expect(res).toMatchObject({ success: false, error: 'stale-account-scope' });
  });
});
