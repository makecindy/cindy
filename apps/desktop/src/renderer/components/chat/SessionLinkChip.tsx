/**
 * SessionLinkChip — 聊天正文里 `cindy://session/<id>[?message=<clientId>]`(历史 xdt-maker:// 同)
 * 深链的行内 chip 渲染:整段会话显示跳转图标 + 会话标题;带 `?message=`
 * 锚点时直接显示目标消息正文的单行摘要,hover 展开全文,点击后定位并高亮
 * 目标消息(复用会话搜索的 searchJump 机制)。
 *
 * 标题解析三级降级:
 *   1. 作者显式给的 label(`[自定义文案](cindy://…)`)——作者意图优先,不查库;
 *   2. 异步查本地库(sessionService.get),miss 再查 device-link 远程会话镜像;
 *   3. 都查不到 → 中性占位文字(未知 / 离线设备的会话),不露内部 ID。
 * 查询期间先显示占位文字,拿到标题后原地刷新——chip 宽度变化是行内文本流的自然
 * 重排,不产生视觉跳变(规则 7 的"先显示已有内容再增量刷新"口径)。
 *
 * 样式与 UserMessage 的 @file chip 同一套 token(--chat-input-chip-*),
 * inline-flex 不打断文本流;不硬编码颜色(规则 16)。
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { AppWindow, CornerDownRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';

import { cn } from '@/lib/utils';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { parseSessionDeepLinkHref } from '@/lib/deepLink';
import { getSessionRouteOwnerId, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { resolveSessionMessageText } from '@/lib/sessionMessageText';
import * as sessionService from '@/lib/sessionService';
import {
  remoteProjectsStore,
  useRemoteProjectSessions,
} from '@/features/device-link/remoteProjectsStore';
import {
  useSessionNavigationIntent,
  useSessionNavigationMode,
} from '@/features/cc-agent/embeddedSessionNavigation';
import { InlineReferenceChip } from './InlineReferenceChip';
import { QuoteChip } from './QuoteChip';
import { toast } from '@/lib/toast';
import { useLinkContextMenu } from './useLinkContextMenu';
import { activateInlineLinkFromKeyboard, isSeparateLinkActivation } from './linkInteraction';

const MESSAGE_LINK_LABEL_MAX = 240;

export interface SessionLinkChipProps {
  href: string;
  /** 作者显式链接文案(`[label](…)`,label ≠ href 时传入);有值则不查标题。 */
  label?: string;
}

function compactMessageLinkLabel(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MESSAGE_LINK_LABEL_MAX) return compact;
  return `${compact.slice(0, MESSAGE_LINK_LABEL_MAX - 1)}…`;
}

export function SessionLinkChip({ href, label }: SessionLinkChipProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const localDeviceId = useOptionalAuthDeviceId();
  const navigationMode = useSessionNavigationMode();
  const reportSessionNavigation = useSessionNavigationIntent();
  const target = useMemo(() => parseSessionDeepLinkHref(href), [href]);
  const remoteSessions = useRemoteProjectSessions();
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);
  const [messageText, setMessageText] = useState<string | null>(null);
  const navigationRequestVersionRef = useRef(0);

  const sessionId = target?.sessionId ?? null;
  const messageClientId = target?.messageClientId ?? null;
  const targetDeviceId = target?.deviceId ?? null;
  const targetsOtherDevice = !!targetDeviceId && targetDeviceId !== localDeviceId;
  const explicitLabel = label?.trim() || null;

  useEffect(
    () => () => {
      navigationRequestVersionRef.current += 1;
    },
    [sessionId, messageClientId, targetDeviceId, navigationMode],
  );

  useEffect(() => {
    // 先清旧值:同一实例被复用渲染另一个 href(虚拟列表 / 消息 patch)时,
    // 不能让上一个会话的标题串到新链接上(Codex review P2)。
    setFetchedTitle(null);
    if (!sessionId || messageClientId || explicitLabel || targetsOtherDevice) return;
    let cancelled = false;
    sessionService
      .get(sessionId)
      .then((session) => {
        if (!cancelled && session.title?.trim()) setFetchedTitle(session.title.trim());
      })
      .catch(() => {
        // 本地库没有(远程 / 未知会话)→ 静默,走 remote 镜像 / 短 ID 降级。
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, messageClientId, explicitLabel, targetsOtherDevice]);

  useEffect(() => {
    setMessageText(null);
    if (!sessionId || !messageClientId) return;
    let cancelled = false;
    resolveSessionMessageText(sessionId, messageClientId)
      .then((text) => {
        if (!cancelled && text) setMessageText(text);
      })
      .catch(() => {
        // Missing/offline target: keep the compact client-id fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, messageClientId]);

  const remoteSession = remoteSessions.find((s) =>
    s.id === sessionId && (!targetDeviceId || s.deviceLinkDeviceId === targetDeviceId)) ?? null;
  const remoteTitle = fetchedTitle ? null : remoteSession?.title?.trim() || null;
  const openTarget = async (separate: boolean) => {
    if (!target || !sessionId) return;
    const navigationRequestVersion = ++navigationRequestVersionRef.current;
    const resolveTargetRoute = async () => {
      let deviceId = targetDeviceId ?? remoteProjectsStore.getSessionDeviceId(sessionId);
      if (deviceId) {
        const selfDeviceId = localDeviceId ?? (await window.electronAPI.getDeviceId());
        if (navigationRequestVersionRef.current !== navigationRequestVersion) return null;
        // 归档任务可能尚未进入远程镜像；先登记链接的归属，再由现有传输层按设备读取。
        if (deviceId !== selfDeviceId) {
          remoteProjectsStore.pinSessionOrigin(deviceId, sessionId);
        } else {
          deviceId = undefined;
        }
      }
      if (separate) {
        await window.electronAPI.maker.openSessionInNewWindow(sessionId, deviceId, messageClientId);
        return null;
      }
      return resolveSessionRoute(sessionId, remoteSession, { remote: !!deviceId });
    };
    // device-link 远程会话本地无 row,resolveSessionRoute 内部的 sessionService.get
    // 会 miss → 远程 Orca 会话被当普通会话路由,后续 redirect 会丢 searchJump 锚点。
    // 把远程镜像里的 session 对象直接传入,让 Orca 路由一步到位(Codex review P2)。
    await resolveTargetRoute().then((route) => {
      if (!route || navigationRequestVersionRef.current !== navigationRequestVersion) return;
      reportSessionNavigation?.(sessionId, getSessionRouteOwnerId(route) ?? sessionId);
      navigate(
        route,
        target.messageClientId
          ? {
              state: {
                searchJump: {
                  kind: 'conversation-search',
                  sessionId,
                  messageId: target.messageClientId,
                  messageIdKind: 'clientId',
                  messageClientId: target.messageClientId,
                },
              },
            }
          : undefined,
      );
    });
  };
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void openTarget(isSeparateLinkActivation(event) || navigationMode === 'sidebar-embedded').catch(
      () => toast.error(t('chat.markdownRenderer.openLinkFailed')),
    );
  };
  const linkMenu = useLinkContextMenu(href, [
    ...(navigationMode === 'sidebar-embedded'
      ? []
      : [
          {
            label: t('chat.markdownRenderer.openInCurrentWindow'),
            icon: <CornerDownRight className="mr-2 h-4 w-4" />,
            run: () => openTarget(false),
          },
        ]),
    {
      label: t('ccAgent.sidebar.sessionMenu.openInNewWindow'),
      shortcut: t('chat.markdownRenderer.shiftClick'),
      icon: <AppWindow className="mr-2 h-4 w-4" />,
      run: () => openTarget(true),
    },
  ]);
  if (!target || !sessionId) return <span>{label ?? href}</span>;
  // 未起名会话过投影再显示:chip 直接摆在消息流里,原样会露出内部哨兵 "New Maker"。
  const resolvedTitle = fetchedTitle ?? remoteTitle;
  const display =
    explicitLabel ??
    (resolvedTitle
      ? projectDraftSessionTitle(resolvedTitle, t('ccAgent.common.unnamedSession'))
      : null) ??
    t('chat.userMessage.sessionLinkFallback');

  if (messageClientId) {
    // 原文读不到(对端离线 / 已删除 / 尚未加载)时给中性文字,不露内部 ID。
    const fullText = messageText ?? t('chat.userMessage.messageLinkFallback');
    const messageLabel = compactMessageLinkLabel(fullText);
    // An explicit markdown label is the author's chosen display text, even for
    // anchored links; the resolved message remains the navigation target.
    const visibleMessageLabel = explicitLabel ?? messageLabel;
    // 发给模型的上下文范围(条数 / 是否截断)不在气泡里展示:用户无从理解也无从操作。
    const messageContent = (
      <span className="inline-flex min-w-0 max-w-[min(240px,55vw)]">
        <QuoteChip quote={{ text: visibleMessageLabel }} interactive={false} className="underline underline-offset-2" />
      </span>
    );
    // items-center 保证 pill 保持自身高度(不被 align-items: stretch 撑成椭圆)。
    const messageClass = 'inline-flex max-w-full items-center align-middle';
    return (
      <>
        <button
          type="button"
          data-session-message-link=""
          data-split-pane-route-action=""
          aria-label={visibleMessageLabel}
          title={display}
          onClick={handleClick}
          onAuxClick={(event) => {
            if (event.button === 1) handleClick(event);
          }}
          onKeyDown={activateInlineLinkFromKeyboard}
          onContextMenu={linkMenu.onContextMenu}
          className={cn(messageClass, 'cursor-pointer')}
        >
          {messageContent}
        </button>
        {linkMenu.menu}
      </>
    );
  }

  return (
    <>
      <InlineReferenceChip
        label={display}
        icon={<CornerDownRight aria-hidden />}
        tooltip={display}
        ariaLabel={display}
        onClick={handleClick}
        onAuxClick={(event) => {
          if (event.button === 1) handleClick(event);
        }}
        onContextMenu={linkMenu.onContextMenu}
        splitPaneRouteAction
        className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
      />
      {linkMenu.menu}
    </>
  );
}
