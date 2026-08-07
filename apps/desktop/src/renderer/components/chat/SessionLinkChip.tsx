/**
 * SessionLinkChip — 聊天正文里 `cindy://session/<id>[?message=<clientId>]`(历史 xdt-maker:// 同)
 * 深链的行内 chip 渲染:整段会话显示跳转图标 + 会话标题;带 `?message=`
 * 锚点时直接显示目标消息正文的单行摘要,hover 展开全文,点击后定位并高亮
 * 目标消息(复用会话搜索的 searchJump 机制)。
 *
 * 标题解析三级降级:
 *   1. 作者显式给的 label(`[自定义文案](cindy://…)`)——作者意图优先,不查库;
 *   2. 异步查本地库(sessionService.get),miss 再查 device-link 远程会话镜像;
 *   3. 都查不到 → shortSessionId 短 ID(未知 / 离线设备的会话)。
 * 查询期间先显示短 ID,拿到标题后原地刷新——chip 宽度变化是行内文本流的自然
 * 重排,不产生视觉跳变(规则 7 的"先显示已有内容再增量刷新"口径)。
 *
 * 样式与 UserMessage 的 @file chip 同一套 token(--chat-input-chip-*),
 * inline-flex 不打断文本流;不硬编码颜色(规则 16)。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';

import { cn } from '@/lib/utils';
import { parseSessionDeepLinkHref } from '@/lib/deepLink';
import { getSessionRouteOwnerId, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { shortSessionId } from '@/lib/sessionId';
import { resolveSessionMessageText } from '@/lib/sessionMessageText';
import * as sessionService from '@/lib/sessionService';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import {
  useSessionNavigationIntent,
  useSessionNavigationMode,
} from '@/features/cc-agent/embeddedSessionNavigation';
import { InlineReferenceChip } from './InlineReferenceChip';
import { QuoteChip } from './QuoteChip';
import type { PersistedSessionReferenceMetadata } from '../../../shared/sessionReferenceMetadata';

const MESSAGE_LINK_LABEL_MAX = 240;

export interface SessionLinkChipProps {
  href: string;
  /** 作者显式链接文案(`[label](…)`,label ≠ href 时传入);有值则不查标题。 */
  label?: string;
  /** Resolved, persisted range summary for this link. */
  referenceMetadata?: PersistedSessionReferenceMetadata;
}

function compactMessageLinkLabel(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MESSAGE_LINK_LABEL_MAX) return compact;
  return `${compact.slice(0, MESSAGE_LINK_LABEL_MAX - 1)}…`;
}

export function SessionLinkChip({ href, label, referenceMetadata }: SessionLinkChipProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const reportSessionNavigation = useSessionNavigationIntent();
  const target = useMemo(() => parseSessionDeepLinkHref(href), [href]);
  const remoteSessions = useRemoteProjectSessions();
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);
  const [messageText, setMessageText] = useState<string | null>(null);
  const navigationRequestVersionRef = useRef(0);

  const sessionId = target?.sessionId ?? null;
  const messageClientId = target?.messageClientId ?? null;
  const explicitLabel = label?.trim() || null;

  useEffect(
    () => () => {
      navigationRequestVersionRef.current += 1;
    },
    [sessionId, messageClientId, navigationMode],
  );

  useEffect(() => {
    // 先清旧值:同一实例被复用渲染另一个 href(虚拟列表 / 消息 patch)时,
    // 不能让上一个会话的标题串到新链接上(Codex review P2)。
    setFetchedTitle(null);
    if (!sessionId || messageClientId || explicitLabel) return;
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
  }, [sessionId, messageClientId, explicitLabel]);

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

  // 深链形状不合法(理论上被 tokenizer / 渲染分支挡住,防御性兜底)→ 纯文本。
  if (!target || !sessionId) return <span>{label ?? href}</span>;

  const remoteSession = remoteSessions.find((s) => s.id === sessionId) ?? null;
  const remoteTitle = fetchedTitle ? null : remoteSession?.title?.trim() || null;
  const handleClick = () => {
    const navigationRequestVersion = ++navigationRequestVersionRef.current;
    // device-link 远程会话本地无 row,resolveSessionRoute 内部的 sessionService.get
    // 会 miss → 远程 Orca 会话被当普通会话路由,后续 redirect 会丢 searchJump 锚点。
    // 把远程镜像里的 session 对象直接传入,让 Orca 路由一步到位(Codex review P2)。
    void resolveSessionRoute(sessionId, remoteSession).then((route) => {
      if (navigationRequestVersionRef.current !== navigationRequestVersion) return;
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
  // 未起名会话过投影再显示:chip 直接摆在消息流里,原样会露出内部哨兵 "New Maker"。
  const resolvedTitle = fetchedTitle ?? remoteTitle;
  const display =
    explicitLabel ??
    (resolvedTitle
      ? projectDraftSessionTitle(resolvedTitle, t('ccAgent.common.unnamedSession'))
      : null) ??
    shortSessionId(sessionId);
  const referenceDetails = referenceMetadata
    ? [
        t(
          referenceMetadata.range === 'around-anchor'
            ? 'chat.userMessage.sessionReference.aroundAnchor'
            : 'chat.userMessage.sessionReference.recent',
        ),
        t('chat.userMessage.sessionReference.messageCount', {
          count: referenceMetadata.messageCount,
        }),
        ...(referenceMetadata.truncated ? [t('chat.userMessage.sessionReference.truncated')] : []),
      ]
    : [];
  const tooltip =
    referenceDetails.length > 0 ? `${display}\n${referenceDetails.join(' · ')}` : display;

  if (messageClientId) {
    const fullText = messageText ?? shortSessionId(messageClientId);
    const messageLabel = compactMessageLinkLabel(fullText);
    // An explicit markdown label is the author's chosen display text, even for
    // anchored links; the resolved message remains the navigation target.
    // A Markdown label is explicit author intent and must survive anchored
    // links even when no persisted reference metadata is available yet.
    const visibleMessageLabel = explicitLabel ?? messageLabel;
    // 宽度上限只能加在 pill 这一侧:pill 和 summary 是同一 flex 行的两个 item,
    // 把 240px 加在外层会让两者抢同一份宽度——summary 没有 nowrap,会被压到
    // min-content(中文逐字换行)竖成一列,再把 pill 沿 stretch 拉成大椭圆。
    const messageContent = (
      <span className="inline-flex min-w-0 max-w-[min(240px,55vw)]">
        <QuoteChip quote={{ text: visibleMessageLabel }} />
      </span>
    );
    // summary 单行截断:窄气泡里退化成省略号,完整内容仍在 title / aria-label。
    const referenceSummary =
      referenceDetails.length > 0 ? (
        <span
          data-session-reference-summary=""
          className="ml-1 min-w-0 truncate text-[11px] text-[var(--text-tertiary)]"
        >
          {referenceDetails.join(' · ')}
        </span>
      ) : null;
    // items-center 保证 pill 保持自身高度(不被 align-items: stretch 撑成椭圆)。
    const messageClass = 'inline-flex max-w-full items-center align-middle';
    if (navigationMode === 'sidebar-embedded') {
      return (
        <span
          data-session-message-link=""
          title={tooltip}
          className={cn(messageClass, 'cursor-default')}
        >
          {messageContent}
          {referenceSummary}
        </span>
      );
    }
    return (
      <button
        type="button"
        data-session-message-link=""
        data-split-pane-route-action=""
        aria-label={
          referenceDetails.length > 0
            ? `${visibleMessageLabel} (${referenceDetails.join(' · ')})`
            : visibleMessageLabel
        }
        title={tooltip}
        onClick={handleClick}
        className={cn(messageClass, 'cursor-pointer')}
      >
        {messageContent}
        {referenceSummary}
      </button>
    );
  }

  if (navigationMode === 'sidebar-embedded') {
    return (
      <InlineReferenceChip
        label={display}
        icon={<CornerDownRight aria-hidden />}
        tooltip={tooltip}
        ariaLabel={display}
        className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] cursor-default align-middle"
      />
    );
  }

  return (
    <InlineReferenceChip
      label={display}
      icon={<CornerDownRight aria-hidden />}
      tooltip={tooltip}
      ariaLabel={display}
      onClick={handleClick}
      splitPaneRouteAction
      className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
    />
  );
}
