/**
 * 主力电脑离线时的伙伴视图（docs/product-rules/cloud-companions.md §3.1）：保留伙伴头部，
 * 横幅说明哪台主力电脑离线并提供「在这台电脑继续」，下方只读显示云端保存的对话。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CHAT_BODY_CLASS } from '@/components/chat/chatChrome';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { toast } from '@/lib/toast';
import type { CompanionTranscriptMessage, CompanionTranscriptPage } from '../../../shared/companionCloud';
import type { BotGroupAttachment } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { BotSessionContentHeaderRegistration, type BotChatIdentity } from './BotSessionContentHeader';
import { ensureBotProfilesLoaded } from './botStore';
import { companionCloudApi, refreshCompanionCloud } from './companionCloudStore';

export interface CloudCompanionOfflineViewProps {
  botId: string;
  deviceId: string;
  name: string;
  avatar?: string | null;
  avatarColor?: string | null;
  /** Home computer name; empty when this device never saw it. */
  deviceName: string;
  /** The home is online but has not opened remote control; otherwise it is simply not reachable. */
  controlOff?: boolean;
}

type TakeOverState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'conflict'; device: string }
  | { kind: 'error'; key: string };

let transcriptOwner = getDataOwnerGeneration();
const transcriptPages = new Map<string, CompanionTranscriptPage>();
export function CloudCompanionOfflineView(props: CloudCompanionOfflineViewProps) {
  const owner = getDataOwnerGeneration();
  if (!owner.dataOwnerId || !isDataOwnerGenerationCurrent(transcriptOwner)) { transcriptOwner = owner; transcriptPages.clear(); }
  return <CloudCompanionOfflineContent key={JSON.stringify([owner, props.botId, props.deviceId])} {...props} />;
}
function CloudCompanionOfflineContent({ botId, deviceId, name, avatar, avatarColor, deviceName, controlOff = false }: CloudCompanionOfflineViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const devices = useDeviceLinkDeviceList();
  const device = deviceName.trim() || t('bots.cloud.unknownDevice');
  const identity = useMemo<BotChatIdentity>(() => ({ id: botId, deviceId, deviceName: device, name, avatar, avatarColor, sessionId: null }),
    [botId, deviceId, device, name, avatar, avatarColor]);
  const [messages, setMessages] = useState<CompanionTranscriptMessage[]>(() => transcriptPages.get(botId)?.messages ?? []);
  const [nextBefore, setNextBefore] = useState<string | undefined>(() => transcriptPages.get(botId)?.nextBefore);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, setState] = useState<TakeOverState>({ kind: 'idle' });
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const stickToBottom = useRef(true);
  const loadingRef = useRef(false);
  const revision = useRef(0);
  const alive = useRef(true);
  const latest = useRef({ messages, nextBefore }); latest.current = { messages, nextBefore };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (before?: string) => {
    const api = companionCloudApi();
    if (!api || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadFailed(false);
    const owner = getDataOwnerGeneration();
    try {
      const page = await api.getCompanionTranscript(botId, before);
      while (!before && page.nextBefore && page.messages.length < latest.current.messages.length) {
        if (!alive.current || !isDataOwnerGenerationCurrent(owner)) return;
        const cursor = page.nextBefore;
        const older = await api.getCompanionTranscript(botId, cursor);
        const ids = new Set(page.messages.map(row => row.id));
        page.messages = [...older.messages.filter(row => !ids.has(row.id)), ...page.messages];
        page.nextBefore = older.nextBefore;
        if (page.nextBefore === cursor) throw new Error('INVALID_CHAT_PAGE');
      }
      if (!alive.current || !isDataOwnerGenerationCurrent(owner)) return;
      revision.current++;
      if (before && scroller.current) anchor.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop };
      const next = { messages: before ? [...page.messages.filter(m => !latest.current.messages.some(c => c.id === m.id)), ...latest.current.messages] : page.messages,
        nextBefore: page.nextBefore };
      transcriptPages.set(botId, next);
      void api.chatDisplayCache?.({ action: 'write', key: `companion:${botId}`, owner, value: next }).catch(() => undefined);
      setMessages(next.messages); setNextBefore(next.nextBefore);
    } catch (error) {
      if (alive.current && isDataOwnerGenerationCurrent(owner)) {
        if (/FORBIDDEN|PERMISSION_DENIED/.test(String(error))) {
          revision.current++; transcriptPages.delete(botId); setMessages([]); setNextBefore(undefined);
        }
        setLoadFailed(true);
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    const owner = getDataOwnerGeneration();
    const version = revision.current;
    void companionCloudApi()?.chatDisplayCache?.({ action: 'read', key: `companion:${botId}`, owner }).then(value => {
      const page = value as CompanionTranscriptPage | null;
      if (!alive.current || !isDataOwnerGenerationCurrent(owner) || revision.current !== version
        || !page || !Array.isArray(page.messages) || !page.messages.every(row => row && typeof row.id === 'string' && typeof row.text === 'string' && Number.isFinite(row.createdAt))) return;
      transcriptPages.set(botId, page); setMessages(page.messages); setNextBefore(page.nextBefore);
    }).catch(() => undefined);
    stickToBottom.current = true;
    void load();
  }, [botId, load]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (anchor.current) {
      // Older messages were prepended: keep the reader on the same message.
      node.scrollTop = node.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    } else if (stickToBottom.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages]);

  const takeOver = async () => {
    const api = companionCloudApi();
    if (!api || state.kind === 'running') return;
    setState({ kind: 'running' });
    const owner = getDataOwnerGeneration();
    try {
      const result = await api.takeOverCompanion(botId);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (result.ok) {
        await ensureBotProfilesLoaded(true).catch(() => undefined);
        refreshCompanionCloud();
        navigate(`/bots/${encodeURIComponent(botId)}`);
        return;
      }
      refreshCompanionCloud();
      if (result.code === 'HOME_CONFLICT') {
        const winner = devices?.find((candidate) => candidate.deviceId === result.homeDeviceId)?.name?.trim() || t('bots.cloud.unknownDevice');
        if (result.homeDeviceId && result.homeDeviceId !== deviceId) {
          // Another computer already continued: show the companion where it runs now.
          toast.info(t('bots.cloud.takeOverConflict', { name, device: winner }));
          setState({ kind: 'idle' });
          navigate(`/bots/remote/${encodeURIComponent(result.homeDeviceId)}/${encodeURIComponent(botId)}`);
        } else setState({ kind: 'conflict', device: winner });
      } else setState({ kind: 'error', key: result.code === 'OFFLINE' ? 'bots.cloud.takeOverOffline'
        : result.code === 'NOT_ENABLED' ? 'bots.cloud.notEnabled' : 'bots.cloud.takeOverFailed' });
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setState({ kind: 'error', key: 'bots.cloud.takeOverFailed' });
    }
  };

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--surface)]" data-testid="cloud-companion-offline">
      <BotSessionContentHeaderRegistration bot={identity} />
      <section
        role="status"
        className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
      >
        <BotAvatar bot={identity} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-14 font-medium text-[var(--text-primary)]">
            {t(controlOff ? 'bots.cloud.homeControlOff' : 'bots.cloud.homeOffline', { device })}
          </p>
          <p className="mt-0.5 text-12 text-[var(--text-secondary)]">
            {state.kind === 'running' ? t('bots.cloud.takingOver', { name })
              : state.kind === 'conflict' ? t('bots.cloud.takeOverConflict', { name, device: state.device })
                : state.kind === 'error' ? t(state.key, { name })
                  : t('bots.cloud.takeOverHint', { name })}
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          type="button"
          loading={state.kind === 'running'}
          disabled={state.kind === 'running'}
          onClick={() => void takeOver()}
        >
          {t('bots.cloud.continueHere')}
        </Button>
      </section>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          if (node.scrollTop < 40 && nextBefore && !loadingRef.current) void load(nextBefore);
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {nextBefore ? (
            <Button variant="secondary" tone="quiet" compact type="button" className="self-center" disabled={loading} onClick={() => void load(nextBefore)}>
              {t('bots.cloud.loadOlder')}
            </Button>
          ) : null}
          {loading && messages.length === 0 ? <Spinner size={18} className="self-center" /> : null}
          {loadFailed ? (
            <div role="alert" className="flex flex-col items-center gap-2 text-13 text-[var(--text-secondary)]">
              <p>{t('bots.cloud.loadFailed')}</p>
              <Button variant="secondary" compact type="button" onClick={() => void load(messages.length ? nextBefore : undefined)}>
                {t('bots.cloud.reload')}
              </Button>
            </div>
          ) : null}
          {!loading && !loadFailed && messages.length === 0 ? (
            <p className="text-center text-13 text-[var(--text-tertiary)]">{t('bots.cloud.empty')}</p>
          ) : null}
          {messages.map((message) => message.role === 'user' ? (
            <article key={message.id} className="flex flex-col items-end gap-2">
              {message.text ? (
                <div className={`max-w-[72%] whitespace-pre-wrap break-words rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2.5 text-[var(--msg-user-text)] ${CHAT_BODY_CLASS}`}>
                  {message.text}
                </div>
              ) : null}
              {message.attachments?.length ? <CloudMessageAttachments botId={botId} files={message.attachments} align="end" /> : null}
            </article>
          ) : (
            <article key={message.id} className={`flex min-w-0 flex-col gap-2 text-[var(--msg-assistant-text)] ${CHAT_BODY_CLASS}`}>
              {message.text ? <MarkdownRenderer renderRichAnswers streamFadeKey={`cloud:${botId}:${message.id}`} workingDir="" content={message.text} allowPrivilegedLinks={false} /> : null}
              {message.attachments?.length ? <CloudMessageAttachments botId={botId} files={message.attachments} align="start" /> : null}
            </article>
          ))}
        </div>
      </div>
      <p className="border-t border-[var(--border-default)] px-6 py-3 text-center text-12 text-[var(--text-tertiary)]">
        {t('bots.cloud.readOnlyNote')}
      </p>
    </main>
  );
}

/** At most this many room files come down at once (each can be up to 25 MB). */
export const CLOUD_ATTACHMENT_LOADS = 2;
let attachmentLoads = 0;
const attachmentQueue: Array<() => void> = [];

/** Run `load` when a slot is free; a load whose message left the view before its turn is skipped. */
function queuedAttachmentLoad(load: () => Promise<void>, wanted: () => boolean): void {
  const start = () => {
    if (!wanted()) { attachmentQueue.shift()?.(); return; }
    attachmentLoads += 1;
    void load().finally(() => { attachmentLoads -= 1; attachmentQueue.shift()?.(); });
  };
  if (attachmentLoads < CLOUD_ATTACHMENT_LOADS) start();
  else attachmentQueue.push(start);
}

/** True once the element is near the visible part of the conversation (always, without an observer). */
function useNearView(ref: { current: Element | null }): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: '600px 0px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/**
 * Files of a cloud message, brought to this computer from the companion's room once the message
 * is near the view, a few at a time: opening a long conversation never starts every download.
 */
function CloudMessageAttachments({ botId, files, align }: {
  botId: string;
  files: ReadonlyArray<{ mediaId: string; name: string }>;
  align: 'start' | 'end';
}) {
  const [loaded, setLoaded] = useState<Record<string, BotGroupAttachment | 'unavailable'>>({});
  const key = files.map((file) => file.mediaId).join(',');
  const box = useRef<HTMLDivElement | null>(null);
  const near = useNearView(box);
  useEffect(() => {
    if (!near) return;
    const api = companionCloudApi();
    let live = true;
    const owner = getDataOwnerGeneration();
    for (const file of files) {
      const settle = (value: BotGroupAttachment | 'unavailable') => {
        if (live && isDataOwnerGenerationCurrent(owner)) setLoaded((current) => ({ ...current, [file.mediaId]: value }));
      };
      if (!api || typeof api.getCompanionAttachment !== 'function') { settle('unavailable'); continue; }
      queuedAttachmentLoad(() => api.getCompanionAttachment(botId, file.mediaId)
        .then((value) => settle({ ...value, id: file.mediaId }), () => settle('unavailable')),
      () => live && isDataOwnerGenerationCurrent(owner));
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the files' ids
  }, [botId, key, near]);
  const attachments: BotGroupAttachment[] = files.map((file) => {
    const value = loaded[file.mediaId];
    if (value && value !== 'unavailable') return value;
    return { id: file.mediaId, name: file.name, category: 'file', mimeType: '', size: 0, url: null, path: null,
      state: value === 'unavailable' ? 'unavailable' : 'loading' };
  });
  return <div ref={box} className="min-w-0 max-w-full"><BotGroupMessageAttachments attachments={attachments} align={align} /></div>;
}
