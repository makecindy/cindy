import { useMemo } from 'react';
import { i18n } from '@/i18n';
import { useRemoteSessionMessages } from './remoteSessionStore';
import { mobileSessionMessageDisplayText, sentSessionMessageChipLabel } from './sessionMessageText';
import type { SessionDeepLinkTarget } from './sessionLinks';
import type { MobileMarkdownInline } from './messageMarkdown';

/** Shared live label and app-owned navigation for native and document links. */
export function useMarkdownSessionLink({ inline, session, sessionLinkTitles, onOpenSessionLink }: {
  inline: Extract<MobileMarkdownInline, { type: 'link' }>;
  session: SessionDeepLinkTarget;
  sessionLinkTitles?: Readonly<Record<string, string>>;
  onOpenSessionLink?: (url: string) => void;
}): { text: string; onPress?: () => void } {
  const messages = useRemoteSessionMessages(session.sessionId);
  const explicit = inline.text.trim() && inline.text.trim() !== inline.url ? inline.text.trim() : null;
  const targetMessage = session.messageClientId
    ? messages.find(message => message.clientId === session.messageClientId || message.id === session.messageClientId)
    : null;
  const messageLabel = useMemo(() => {
    const text = targetMessage ? mobileSessionMessageDisplayText(targetMessage) : null;
    return text ? sentSessionMessageChipLabel(text) : '';
  }, [targetMessage]);
  const title = session.messageClientId
    ? messageLabel || i18n.t('message.renderer.messageChipFallback')
    : explicit ?? sessionLinkTitles?.[session.sessionId] ?? i18n.t('message.renderer.sessionChipFallback');
  return { text: `${session.messageClientId ? '❝' : '↳'} ${title}`,
    onPress: onOpenSessionLink ? () => onOpenSessionLink(inline.url) : undefined };
}
