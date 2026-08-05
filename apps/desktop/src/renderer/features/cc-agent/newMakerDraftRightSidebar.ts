import type { CSSProperties } from 'react';

import { NEW_MAKER_DRAFT_KEY } from './newMakerDraftKeys';

const PROJECT_DRAFT_RSB_SESSION_PREFIX = '__new_maker_project_draft__:';

export interface NewMakerDraftRightSidebarInput {
  workingDir: string | null | undefined;
  remoteHostId: string | null | undefined;
  deviceLinkDeviceId: string | null | undefined;
}

export interface NewMakerDraftRightSidebarState {
  available: boolean;
  sessionId: string | null;
  workdir: string | null;
  remoteHostId: string | null;
}

export const DRAFT_RIGHT_SIDEBAR_TOGGLE_DRAG_STYLE = {
  WebkitAppRegion: 'no-drag',
} as CSSProperties;

/**
 * 项目草稿还没有真实 sessionId，但 RSB store/布局都以 sessionId 分桶。
 * 用 workdir 做内存态临时桶，避免项目 A 的右栏 tab 泄漏到项目 B。
 */
export function makeProjectDraftRightSidebarSessionId(workdir: string): string {
  return `${PROJECT_DRAFT_RSB_SESSION_PREFIX}local:${workdir}`;
}

/**
 * RSB bucket sessionId → 该 bucket 可见 composer 的 composerDraftStore 键。
 *
 * 项目草稿页的 RSB bucket 是合成 id(上面的 prefix),但页面上挂载的 composer
 * 用 `NEW_MAKER_DRAFT_KEY` 存草稿 —— 页面评论(browser-comment-chip)等"从
 * RSB 写进 composer 草稿"的功能必须经本函数换算,直接拿 bucket id 当草稿键
 * 会写进没有任何 ChatInput 读取的键(toast 成功但胶囊不出现)。真实会话的
 * sessionId 原样返回(会话页 composer 的草稿键就是 sessionId)。
 */
export function composerDraftKeyForRightSidebarSession(sessionId: string): string {
  return sessionId.startsWith(PROJECT_DRAFT_RSB_SESSION_PREFIX)
    ? NEW_MAKER_DRAFT_KEY
    : sessionId;
}

export function resolveNewMakerDraftRightSidebar(
  input: NewMakerDraftRightSidebarInput,
): NewMakerDraftRightSidebarState {
  const workdir = input.workingDir?.trim() || null;
  const remoteHostId = input.remoteHostId ?? null;
  const deviceLinkDeviceId = input.deviceLinkDeviceId ?? null;

  // 草稿页只暴露本机项目的完整 RSB。SSH / device-link 草稿没有真实 session 映射，
  // 且 terminal tab 目前只会在控制端创建本机 PTY，不能拿远端路径当 cwd。
  if (!workdir || remoteHostId || deviceLinkDeviceId) {
    return {
      available: false,
      sessionId: null,
      workdir: null,
      remoteHostId: null,
    };
  }

  return {
    available: true,
    sessionId: makeProjectDraftRightSidebarSessionId(workdir),
    workdir,
    remoteHostId: null,
  };
}
