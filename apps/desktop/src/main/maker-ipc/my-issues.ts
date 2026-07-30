/**
 * 「我的 Issue」列表 IPC —— /issues 页面的唯一数据入口。
 *
 * 本文件只做 adapter:参数校验 + 调 myIssuesRuntime 的服务。业务逻辑(两路数据合并、
 * 降级、缓存)在 github-issue/myIssuesService.ts,单测直接打那一层。
 *
 * 返回 { success } 风格:查询失败时 renderer 仍要能渲染(至少给出错误态与空列表),
 * 属于 engineering-conventions §2 明确允许的查询型例外。
 */

import { ipcMain } from 'electron';

import type { MyIssuesResult } from '../../shared/myIssues.js';
import { getMyIssuesService } from '../github-issue/myIssuesRuntime.js';
import { createLogger } from '../logger.js';
import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/my-issues');

export type MyIssuesListResponse =
  | ({ success: true } & MyIssuesResult)
  | {
      success: false;
      error: string;
      items: [];
      githubEnhancement: null;
      degraded: null;
      truncated: false;
    };

export async function handleMyIssuesList(raw: unknown): Promise<MyIssuesListResponse> {
  const force = !!(raw && typeof raw === 'object' && (raw as { force?: unknown }).force === true);
  try {
    const result = await getMyIssuesService().list({ force });
    return { success: true, ...result };
  } catch (err) {
    // 服务内部已对每条子查询降级;走到这里说明是意外错误,如实告诉 renderer。
    const error = err instanceof Error ? err.message : String(err);
    log.warn('my issues list failed', { error });
    return {
      success: false,
      error,
      items: [],
      githubEnhancement: null,
      degraded: null,
      truncated: false,
    };
  }
}

export function registerMyIssuesIpc(): void {
  ipcMain.handle(MAKER_INVOKE.MY_ISSUES_LIST, (_e, raw: unknown) => handleMyIssuesList(raw));
}
