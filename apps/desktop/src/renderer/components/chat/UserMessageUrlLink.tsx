/**
 * 用户消息中自动识别出的 http(s) URL。
 *
 * 左键遵循“链接打开方式”偏好(外部网页 / 内部网页两套默认)；Cmd/Ctrl
 * 点击与无会话上下文场景保留系统浏览器 fallback。sidebar-embedded
 * 场景通过可见会话 bucket 打开。
 */

import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import { toast } from '@/lib/toast';
import { openUrlByPreference, useOpenWithMenu } from './useOpenWithMenu';

export function UserMessageUrlLink({ url, sessionId }: { url: string; sessionId?: string }) {
  const { t } = useTranslation();
  const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId);
  const openWith = useOpenWithMenu({ sessionId });

  async function handleClick(event: MouseEvent<HTMLAnchorElement>): Promise<void> {
    event.preventDefault();

    if (sidebarTargetSessionId && !(event.metaKey || event.ctrlKey)) {
      await openUrlByPreference(sidebarTargetSessionId, url, t);
      return;
    }

    const res = await window.electronAPI.openExternal(url);
    if (!res.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
  }

  return (
    <>
      <a
        href={url}
        // 可点 = 正文色 + 常显下划线(见 MarkdownRenderer.MARKDOWN_LINK_CLASS 的
        // 规则说明)。改前是 --msg-link + hover:underline —— 静止状态下只有颜色、
        // 悬停才出下划线,而用户消息气泡里同样需要「不动鼠标就能看出哪个能点」。
        className="underline underline-offset-2 cursor-pointer"
        onClick={handleClick}
        onContextMenu={(event) => {
          if (!openWith.isEnabled) return;
          event.preventDefault();
          event.stopPropagation();
          openWith.openAt(event.clientX, event.clientY, url);
        }}
      >
        {url}
      </a>
      {openWith.menu}
    </>
  );
}
