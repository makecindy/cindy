import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { REMOTE_RESOURCE_CHANGED_CHANNEL, parseRemoteResourceChangedPayload } from '@cindy/device-link';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
import type { BotSettingsOp } from '../../../shared/botRemoteSettings';
import { BotPronounProvider } from './botPronounContext';
import { BotSettings } from './BotsHomeView';
import { BotSettingsTargetContext } from './botSettingsTarget';
import { RemoteBotSettings } from './RemoteBotSettings';
import { createRemoteBotSettingsTarget, type RemoteBotSettingsHandle } from './remoteBotSettingsTarget';
import { hostDeclaresBotSettings, readBotSettingsCaps } from './remoteBotSettingsClient';
import type { RemoteBot } from './remoteBotRoster';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import type { BotProfile } from './botStore';

interface Props {
  bot: RemoteBot;
  initialPage?: 'home' | 'memory' | 'capabilities' | 'model' | 'voice' | 'channels';
  beforeCloseRef: MutableRefObject<(() => Promise<boolean>) | null>;
  onBack: () => void;
  onDeleted: () => void;
}

type Support =
  | { state: 'checking' }
  | { state: 'unsupported' }
  | { state: 'failed' }
  | { state: 'ready'; ops: ReadonlySet<BotSettingsOp> };

/** Re-read trailing edge: a chat full of replies changes the teammate row constantly. */
const REFRESH_DELAY_MS = 400;

/**
 * Teammate settings for a teammate on another computer. The pages are the local ones (`BotSettings`);
 * their reads and writes run on the teammate's computer. A computer that predates the settings host
 * keeps the generic form page.
 */
export function RemoteTeammateSettings(props: Props) {
  const owner = getDataOwnerGeneration();
  return <RemoteTeammateSettingsContent key={`${owner.dataOwnerId}:${owner.generation}:${props.bot.deviceId}:${props.bot.id}`} {...props} />;
}

function RemoteTeammateSettingsContent(props: Props) {
  const { bot } = props;
  const { t } = useTranslation();
  const [support, setSupport] = useState<Support>({ state: 'checking' });
  const [attempt, setAttempt] = useState(0);
  // Probe while the computer is reachable; going offline keeps what was already learned.
  useEffect(() => {
    if (!bot.online) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!(await hostDeclaresBotSettings(bot.deviceId))) return !cancelled && setSupport({ state: 'unsupported' });
        const caps = await readBotSettingsCaps(bot.deviceId);
        // Reconnecting re-probes; an unchanged answer keeps the open pages (and their drafts) as they are.
        if (!cancelled)
          setSupport((previous) =>
            previous.state === 'ready' && previous.ops.size === caps.ops.length && caps.ops.every((op) => previous.ops.has(op))
              ? previous
              : { state: 'ready', ops: new Set(caps.ops) });
      } catch (error) {
        // An older host rejects the unknown action; anything else is a failed read the person can retry.
        // Pages that are already open are never taken away by a failed re-probe.
        if (!cancelled)
          setSupport((previous) =>
            previous.state === 'ready'
              ? previous
              : extractIpcError(error)?.code === 'UNSUPPORTED_CAPABILITY' ? { state: 'unsupported' } : { state: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bot.deviceId, bot.online, attempt]);

  if (support.state === 'unsupported')
    return <RemoteBotSettings bot={bot} initialPage={props.initialPage === 'memory' || props.initialPage === 'capabilities' ? props.initialPage : undefined} beforeCloseRef={props.beforeCloseRef} onDeleted={props.onDeleted} />;
  if (support.state === 'ready') return <RemoteSettingsPages {...props} ops={support.ops} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5 text-13 text-[var(--text-primary)]">
      {!bot.online ? (
        <p role="status">{t('bots.remote.offlineDescription', { name: bot.name, device: bot.deviceName })}</p>
      ) : support.state === 'failed' ? (
        <div role="alert" className="space-y-2">
          <p>{t('bots.remoteSettings.loadFailed')}</p>
          <Button variant="secondary" compact onClick={() => { setSupport({ state: 'checking' }); setAttempt((value) => value + 1); }}>{t('bots.retry')}</Button>
        </div>
      ) : (
        <Spinner size={18} />
      )}
    </div>
  );
}

function RemoteSettingsPages({ bot, ops, initialPage: requestedPage = 'home', beforeCloseRef, onBack }: Props & { ops: ReadonlySet<BotSettingsOp> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const online = useRef(bot.online);
  online.current = bot.online;
  const handle = useMemo<RemoteBotSettingsHandle>(
    () => createRemoteBotSettingsTarget({ deviceId: bot.deviceId, deviceName: bot.deviceName, botId: bot.id, ops, online: () => online.current }),
    // The computer's display name is not identity: renaming it must not reload the open pages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bot.deviceId, bot.id, ops],
  );
  const profile = useSyncExternalStore(handle.profiles.subscribe, handle.profiles.get);
  // A page this computer cannot serve falls back to the settings home.
  const initialPage = requestedPage === 'home' || handle.target.pages.has(requestedPage) ? requestedPage : 'home';
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed' | 'gone'>('loading');
  const load = useCallback(() => {
    setStatus('loading');
    // A profile already on screen is re-read (and yields to a write in flight), never replaced blindly.
    void (handle.profiles.get() ? handle.profiles.refresh() : handle.profiles.load()).then(
      () => setStatus('ready'),
      (error) => setStatus(extractIpcError(error)?.code === 'NOT_FOUND' ? 'gone' : 'failed'),
    );
  }, [handle]);
  useEffect(() => {
    if (bot.online) load();
    // Reload on (re)connect; a profile that was already read stays on screen while offline.
  }, [handle, bot.online, load]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () =>
      window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
        const payload = parseRemoteResourceChangedPayload(push.payload);
        if (push.deviceId === bot.deviceId && push.channel === REMOTE_RESOURCE_CHANGED_CHANNEL && payload?.collectionId === 'routines' && isDeviceLinkRemotePushCurrent(push, stamp)) {
          handle.changed('routines');
          return;
        }
        if (
          push.deviceId !== bot.deviceId ||
          push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL ||
          payload?.collectionId !== 'teammates' ||
          (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.kind === 'bot' && ref.id === bot.id)) ||
          !isDeviceLinkRemotePushCurrent(push, stamp)
        )
          return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => handle.changed(), REFRESH_DELAY_MS);
      }),
    [bot.deviceId, bot.id, handle],
  );
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onOpenSession = useCallback(
    (sessionId: string, searchJump?: ConversationSearchJump) => {
      navigate(standardSessionRoute(sessionId, bot.deviceId), { state: searchJump ? { searchJump } : undefined });
    },
    [bot.deviceId, navigate],
  );

  if (!profile) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5 text-13 text-[var(--text-primary)]">
        {!bot.online ? (
          <p role="status">{t('bots.remote.offlineDescription', { name: bot.name, device: bot.deviceName })}</p>
        ) : status === 'failed' || status === 'gone' ? (
          <div role="alert" className="space-y-2">
            <p>{t('bots.remoteSettings.loadFailed')}</p>
            <Button variant="secondary" compact onClick={load}>{t('bots.retry')}</Button>
          </div>
        ) : (
          <Spinner size={18} />
        )}
      </div>
    );
  }
  return (
    <BotSettingsTargetContext.Provider value={handle.target}>
      <BotPronounProvider bot={profile as BotProfile}>
        {/* The pages sit exactly where the local ones do; the offline note floats over their bottom edge so neither its appearance nor its absence moves anything. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {!bot.online ? (
            <p role="status" className="absolute inset-x-0 bottom-0 z-10 border-t border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 py-2 text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.remote.offlineDescription', { name: bot.name, device: bot.deviceName })}
            </p>
          ) : null}
          <BotSettings
            key={`${bot.deviceId}:${bot.id}:${initialPage}`}
            initialPage={initialPage}
            beforeCloseRef={beforeCloseRef}
            bot={profile}
            onBack={onBack}
            onOpenSession={onOpenSession}
          />
        </div>
      </BotPronounProvider>
    </BotSettingsTargetContext.Provider>
  );
}
