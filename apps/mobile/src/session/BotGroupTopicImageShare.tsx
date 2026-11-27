import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupAttachment, BotGroupMessageView } from '@cindy/maker-shared/botGroupChat';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useUserBubbleAppearance } from '@/theme/userBubblePreference';
import { useTheme } from '@/theme';
import { ShareSelectionBar } from './ShareSelectionBar';
import { ConversationShareSvg, type ConversationShareSvgHandle } from './ConversationShareSvg';
import { buildConversationShareContentWidth, type ConversationShareMessage, type ConversationShareWebViewColors } from './conversationShareWebViewHtml';
import { prepareConversationShareImages } from './conversationShareImages';
import { cleanupConversationSharePngTemps, deleteConversationSharePngTemp, writeConversationSharePngTemp } from './ConversationShareWebView';
import { withDownloadedRemoteMediaFile } from './remoteMediaDiskCacheExpo';
import { shareSelectionStore, useShareSelectionActive } from './shareSelectionStore';

/** Exports selected messages through the system image share sheet. */
export function BotGroupTopicImageShare({ messages, allIds, resolveMedia, selectionScope, onBusyChange }: {
  messages: BotGroupMessageView[]; allIds: string[];
  selectionScope: string; onBusyChange(busy: boolean): void;
  resolveMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>;
}) {
  const { t } = useTranslation(); const { colors, mode } = useTheme(); const dimensions = useWindowDimensions();
  const { colors: ownUserBubble } = useUserBubbleAppearance();
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<ConversationShareMessage[] | null>(null);
  const selectionActive = useShareSelectionActive(selectionScope);
  const svg = useRef<ConversationShareSvgHandle>(null);
  const job = useRef<{ controller: AbortController; owner: ReturnType<typeof getMobileAuthOwner>; handedOff: boolean } | null>(null);
  const signature = JSON.stringify(messages);
  const currentSignature = useRef(signature); currentSignature.current = signature;
  const stop = () => { job.current?.controller.abort(); job.current = null; };
  useEffect(() => stop, [selectionScope]);
  useEffect(() => { if (job.current?.handedOff) return; stop(); setBusy(false); setPrepared(null); }, [signature, selectionActive]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const palette = useMemo<ConversationShareWebViewColors>(() => ({ background: colors.surface, ownUserBubble, border: colors.border,
    codeSurface: colors.chatCodeSurface, inlineCode: colors.chatInlineCodeText, surfaceChip: colors.surfaceChip, surfaceElevated: colors.surfaceElevated,
    textPrimary: colors.textPrimary, textSecondary: colors.textSecondary, textTertiary: colors.textTertiary, dark: mode === 'dark',
    syntax: { comment: colors.syntaxComment, function: colors.syntaxFunction, keyword: colors.syntaxKeyword,
      number: colors.syntaxNumber, property: colors.syntaxProperty, string: colors.syntaxString },
  }), [colors, mode, ownUserBubble]);
  const start = async () => {
    if (job.current || !messages.length || !shareSelectionStore.isActive(selectionScope)) return;
    const active = { controller: new AbortController(), owner: getMobileAuthOwner(), handedOff: false }; job.current = active; setBusy(true);
    const valid = () => job.current === active && !active.controller.signal.aborted && isMobileAuthOwnerCurrent(active.owner)
      && signature === currentSignature.current && shareSelectionStore.isActive(selectionScope);
    try {
      const authorized = new Map<string, BotGroupAttachment>();
      const projected: ConversationShareMessage[] = [];
      for (const message of messages) {
        if (!valid()) return;
        const source = message.threadShare;
        if (message.deleted || source && source.status !== 'available') continue;
        const attachments = [];
        for (const attachment of source?.attachments ?? message.attachments ?? []) {
          // Reauthorize each media ID at the user's export action; never export a saved signed URL.
          const media = resolveMedia ? await resolveMedia(attachment.id, active.controller.signal) : attachment;
          if (!valid()) return;
          const image = media.mimeType.startsWith('image/');
          if (image && resolveMedia && media.url) authorized.set(media.url, media);
          attachments.push({ kind: image ? 'image' as const : 'file' as const, name: media.name,
            ...(image && resolveMedia && media.url ? { uri: media.url } : {}) });
        }
        projected.push({ clientId: message.id, kind: message.authorKind === 'user' ? 'user' : 'assistant',
          ownUserBubble: message.isSelf === true, body: source?.content ?? message.content, attachments });
      }
      const result = await prepareConversationShareImages(projected, async url => {
        const media = authorized.get(url);
        if (!valid() || !media || media.size <= 0 || media.size > 8 * 1024 * 1024) return null;
        return withDownloadedRemoteMediaFile(url, media.mimeType, 8 * 1024 * 1024, async file => {
          if (!valid()) return null;
          const size = await Image.getSize(file.uri);
          if (!valid()) return null;
          const data = await file.base64();
          return valid() ? { ...size, uri: `data:${media.mimeType};base64,${data}` } : null;
        }, active.controller.signal);
      }, {}, valid);
      if (valid()) setPrepared(result);
    } catch {
      if (valid()) { stop(); setBusy(false); Alert.alert(t('session.screen.shareFailedTitle'), t('session.screen.shareImageFailed')); }
    }
  };
  useEffect(() => {
    const active = job.current;
    if (!prepared || !active) return;
    const valid = () => job.current === active && !active.controller.signal.aborted && isMobileAuthOwnerCurrent(active.owner)
      && (active.handedOff || signature === currentSignature.current && shareSelectionStore.isActive(selectionScope));
    void (async () => {
      let uri: string | null = null, shared = false;
      let restoreSelection: (() => boolean) | undefined;
      try {
        await cleanupConversationSharePngTemps(); if (!valid()) return;
        const image = await svg.current?.exportPng(); if (!valid() || !image) return;
        uri = await writeConversationSharePngTemp(image); if (!valid()) return;
        if (!uri) throw new Error('SHARE_EXPORT_FAILED');
        const sharing = await import('expo-sharing'); if (!valid()) return;
        active.handedOff = true;
        restoreSelection = shareSelectionStore.exitForShare();
        await sharing.shareAsync(uri, { mimeType: 'image/png' }); shared = true;
      } catch { if (valid() && (!restoreSelection || restoreSelection())) Alert.alert(t('session.screen.shareFailedTitle'), t('session.screen.shareImageFailed')); }
      finally { if (!shared && uri) await deleteConversationSharePngTemp(uri); if (valid()) { stop(); setBusy(false); setPrepared(null); } }
    })();
  }, [prepared]);
  return <>
    {selectionActive ? <ShareSelectionBar busy={busy} count={messages.length} onCancel={() => { stop(); shareSelectionStore.exit(); }} onShare={() => void start()} /> : null}
    {prepared ? <ConversationShareSvg ref={svg} allShareableIds={allIds} messages={prepared} colors={palette} width={buildConversationShareContentWidth(dimensions)} /> : null}
  </>;
}
