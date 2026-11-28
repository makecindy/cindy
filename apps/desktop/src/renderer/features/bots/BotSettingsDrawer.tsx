import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { matchPath, useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';

import { BotPronounProvider, useBotTranslation } from './botPronounContext';
import { BotSettings } from './BotsHomeView';
import { canonicalBotSessionId, useBotProfiles } from './botStore';
import { useCompanionCloud } from './companionCloudStore';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { cloudCompanionAt, homeControlOff, cloudRemoteBots } from './companionCloudPresentation';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';
import { useRemoteBots } from './useRemoteBots';
import { RemoteTeammateSettings } from './RemoteTeammateSettings';
import * as sessionService from '@/lib/sessionService';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { openFileInSidebarFileBrowser } from '@/features/right-sidebar/lib/openInSidebarFileBrowser';

/** Route-owned compact drawer that keeps the current teammate chat mounted below it. */
export function BotSettingsDrawer() {
  const { t } = useBotTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const bots = useBotProfiles();
  const cloud = useCompanionCloud();
  const devices = useDeviceLinkDeviceList();
  // Resolve the same rows as the list, including companions whose home was never discovered.
  const remoteBots = cloudRemoteBots(cloud, useRemoteBots());
  const remoteMatch = matchPath('/bots/remote/:deviceId/:botId', location.pathname);
  const remoteBot = remoteBots.find(
    (item) =>
      item.id === remoteMatch?.params.botId && item.deviceId === remoteMatch?.params.deviceId,
  );
  // Group routes stay on /bots/groups/:id. A generic /bots/:botId match would
  // treat "groups" as a teammate and replace the chat with a private route.
  const groupMatch = matchPath('/bots/groups/:groupId', location.pathname);
  const match =
    remoteMatch || groupMatch
      ? null
      : (matchPath('/bots/:botId/*', location.pathname) ??
        matchPath('/bots/:botId', location.pathname));
  const settingsBotId = groupMatch ? searchParams.get('settingsBot') : null;
  const localBot = remoteMatch
    ? null
    : (bots.find((candidate) => candidate.id === (settingsBotId ?? match?.params.botId)) ?? null);
  // A demoted copy (the companion runs on another computer) is read-only: edits here would never
  // reach the companion. Its settings live on the main computer (the banner on its task links there).
  const bot = localBot && cloud.demotedBotIds.includes(localBot.id) ? null : localBot;
  const open = searchParams.get('settings') === '1' && (bot !== null || !!remoteBot);
  const rulesBotId = open && bot?.capabilities.projectMode && bot.status === 'active'
    ? bot.id
    : undefined;
  const rulesSessionId = rulesBotId && bot ? canonicalBotSessionId(bot) : undefined;
  const [rulesCheck, setRulesCheck] = useState(0);
  const [rulesAction, setRulesAction] = useState<{
    botId: string;
    sessionId: string;
    routeKey: string;
    open?: () => Promise<void>;
  } | null>(null);

  const requestedPage = searchParams.get('settingsPage');
  const initialPage = requestedPage === 'memory' || requestedPage === 'capabilities' ? requestedPage : 'home';
  // 「模型」「语音」「消息平台」可直接深链；远程伙伴同样，所在电脑不支持的页会回到设置首页。
  const localInitialPage =
    requestedPage === 'model' || requestedPage === 'voice' || requestedPage === 'channels'
      ? requestedPage
      : initialPage;
  const allowNavigation = useRef(false);
  const pendingGuard = useRef<Promise<boolean> | null>(null);
  const beforeCloseRef = useRef<(() => Promise<boolean>) | null>(null);
  useEffect(() => {
    setRulesAction(null);
    const workspaceApi = window.electronAPI?.localDb?.bots?.workspaceMigration;
    if (!rulesBotId || !rulesSessionId || !workspaceApi) return;
    const owner = getDataOwnerGeneration();
    let active = true;
    let opening = false;
    const isCurrent = () => active && isDataOwnerGenerationCurrent(owner);
    const target = { botId: rulesBotId, sessionId: rulesSessionId, routeKey: location.key };
    const markUnavailable = () => {
      if (isCurrent()) setRulesAction(target);
    };
    const isReady = async () => {
      const [workspace, session] = await Promise.all([
        workspaceApi.getStatus(rulesBotId),
        sessionService.get(rulesSessionId),
      ]);
      return workspace.workspaceAvailable && session.status === 'active' &&
        session.source === 'bot' && session.workspaceKind === 'project' &&
        session.companion?.id === rulesBotId && session.companion.role === 'canonical' &&
        !session.remoteHostId && !session.worktreePath &&
        session.workingDir === workspace.source;
    };
    void isReady().then((ready) => {
      if (!isCurrent()) return;
      if (!ready) {
        markUnavailable();
        return;
      }
      setRulesAction({
        ...target,
        open: async () => {
          if (opening || !isCurrent()) return;
          opening = true;
          try {
            if (!(await beforeCloseRef.current?.() ?? true) || !isCurrent()) return;
            if (!await isReady()) {
              markUnavailable();
              return;
            }
            if (!isCurrent()) return;
            allowNavigation.current = true;
            navigate(`/bots/${rulesBotId}/session/${rulesSessionId}`, { replace: true, flushSync: true });
            await openFileInSidebarFileBrowser(rulesSessionId, 'AGENTS.md');
          } catch {
            markUnavailable();
          } finally {
            opening = false;
          }
        },
      });
    }, markUnavailable);
    return () => { active = false; };
  }, [location.key, navigate, rulesBotId, rulesSessionId, rulesCheck]);
  const currentRulesAction = rulesAction?.botId === rulesBotId &&
    rulesAction?.sessionId === rulesSessionId && rulesAction?.routeKey === location.key
    ? rulesAction
    : null;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (allowNavigation.current) {
      allowNavigation.current = false;
      return false;
    }
    return (
      open &&
      beforeCloseRef.current !== null &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search)
    );
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let active = true;
    const check =
      pendingGuard.current ?? Promise.resolve().then(() => beforeCloseRef.current?.() ?? true);
    pendingGuard.current = check;
    void check
      .then(
        (allowed) => {
          if (!active) return;
          if (allowed) blocker.proceed();
          else blocker.reset();
        },
        () => {
          if (active) blocker.reset();
        },
      )
      .finally(() => {
        if (pendingGuard.current === check) pendingGuard.current = null;
      });
    return () => {
      active = false;
    };
  }, [blocker]);

  const clearSettingsParams = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('settings');
        next.delete('settingsPage');
        next.delete('settingsBot');
        return next;
      },
      { replace: true },
    );
  };
  const performClose = (alreadyChecked = true) => {
    // These callers already passed BotSettings' async save/draft guard.
    allowNavigation.current = alreadyChecked;
    // Opened over a group: the chat underneath is the group, not this teammate's
    // private page. Closing must not follow the paused/archived redirects.
    if (groupMatch) {
      clearSettingsParams();
      return;
    }
    if (bot?.status === 'archived') {
      navigate('/bots', { replace: true });
      return;
    }
    // A paused or failed teammate has no chat behind the drawer: its page reopens
    // settings, so dropping the query alone would bounce straight back. Close to the list.
    if (bot && bot.status !== 'active') {
      navigate('/bots/list', { replace: true });
      return;
    }
    clearSettingsParams();
  };

  // Header, Escape and overlay dismissal take the same route guard as Back
  // and sidebar navigation. BotSettings' own Back action already checked it.
  const close = () => performClose(false);

  if (!bot && !remoteBot) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        {/* Keep portaled controls inside the overlay’s React tree so its scroll lock allows them. */}
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal">
          <Dialog.Content
            aria-describedby={undefined}
            // CJK IME: Escape during composition only cancels the candidate.
            onEscapeKeyDown={(event) => {
              if (event.isComposing || event.keyCode === 229) event.preventDefault();
            }}
            className="fixed inset-y-0 right-0 z-float flex w-full max-w-md flex-col border-l border-[var(--border-default)] bg-[var(--surface)] outline-none"
            // The header shares the window title strip; without no-drag the page's drag
            // regions underneath swallow the close button's clicks (see windowDrag.tsx).
            style={WINDOW_NO_DRAG_STYLE}
          >
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
              <Dialog.Title className="text-15 font-medium text-[var(--text-primary)]">
                {t('bots.settings')}
              </Dialog.Title>
              <Dialog.Close
                className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                aria-label={t('bots.close')}
              >
                <X size={17} />
              </Dialog.Close>
            </header>
            {groupMatch && bot ? (
              <p className="shrink-0 border-b border-[var(--border-default)] px-5 py-3 text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.groupChat.server.settings.capabilityScope', { name: bot.name })}
              </p>
            ) : null}
            {remoteBot ? (
              <RemoteTeammateSettings
                key={`${remoteBot.deviceId}:${remoteBot.id}:${open}:${localInitialPage}`}
                bot={remoteBot}
                controlOff={homeControlOff(cloudCompanionAt(cloud, remoteBot.deviceId, remoteBot.id) ?? undefined, devices)}
                initialPage={localInitialPage}
                beforeCloseRef={beforeCloseRef}
                onBack={performClose}
                onDeleted={() => {
                  allowNavigation.current = true;
                  navigate('/bots', { replace: true });
                }}
              />
            ) : bot ? (
              <BotPronounProvider bot={bot}>
                <BotSettings
                  key={`${bot.id}:${open}:${localInitialPage}`}
                  initialPage={localInitialPage}
                  beforeCloseRef={beforeCloseRef}
                  bot={bot}
                  onBack={performClose}
                  onOpenWorkRules={currentRulesAction?.open}
                  onRetryWorkRules={currentRulesAction && !currentRulesAction.open
                    ? () => setRulesCheck((value) => value + 1)
                    : undefined}
                  onOpenSession={(sessionId, searchJump) => {
                    navigate(standardSessionRoute(sessionId), { state: searchJump ? { searchJump } : undefined });
                  }}
                />
              </BotPronounProvider>
            ) : null}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
