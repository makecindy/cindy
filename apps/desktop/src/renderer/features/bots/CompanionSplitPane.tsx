import {
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createPath,
  Outlet,
  Route,
  Routes,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
  useLocation,
  useOutletContext,
  matchPath,
  type To,
} from 'react-router-dom';
import { splitGroupStore, getSplitPanes } from '../cc-agent/splitGroupStore';
import { SplitPaneFocusContext } from '../cc-agent/splitPaneFocus';
import { companionChatTarget } from './companionChatTarget';
import { useBotGroupSummary } from './botGroupStore';
import { useBotProfiles } from './botStore';
import { useRemoteBots } from './useRemoteBots';
import { useCompanionCloud } from './companionCloudStore';
import { useTranslation } from 'react-i18next';
import { BotsFeatureLayout } from './BotsFeatureLayout';

const GroupChat = lazy(() =>
  import('./BotGroupChatView').then((m) => ({ default: m.BotGroupChatView })),
);
const BotHome = lazy(() => import('./BotsHomeView').then((m) => ({ default: m.BotsHomeView })));
const BotChat = lazy(() => import('./BotSessionView').then((m) => ({ default: m.BotSessionView })));
const RemoteChat = lazy(() =>
  import('./RemoteBotSessionView').then((m) => ({ default: m.RemoteBotSessionView })),
);
const rootMatch = { matches: [], outlet: null, isDataRoute: false };

/** Each visible chat needs its own params and query (thread jumps, settings, etc.).
 * Only the focused pane navigates the window; background canonical-session redirects
 * resolve inside their own pane, including when restoring a saved layout. */
export default function CompanionSplitPane({
  target,
  focused,
  children,
}: {
  target: string;
  focused: boolean;
  children: (title: string, route: string, chat: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const pathname = target.split('?')[0];
  const groupId = matchPath('/bots/groups/:id', pathname)?.params.id;
  const remote = matchPath('/bots/remote/:deviceId/:id', pathname)?.params;
  const botId = matchPath('/bots/:id', pathname)?.params.id;
  const group = useBotGroupSummary(groupId ?? null);
  const local = useBotProfiles().find((bot) => bot.id === botId);
  const remoteBot = useRemoteBots().find(
    (bot) => bot.id === remote?.id && bot.deviceId === remote.deviceId,
  );
  const cloud = useCompanionCloud();
  const title = groupId
    ? (group?.name ?? t('bots.groupChat.sidebar.title'))
    : (local?.name ??
      remoteBot?.name ??
      cloud.actors.find((actor) => actor.externalId === remote?.id)?.name ??
      t('bots.title'));
  const location = useLocation();
  const navigation = useContext(UNSAFE_NavigationContext);
  const shell = useOutletContext();
  const [background, setBackground] = useState(target);
  const ownsLocation =
    focused && companionChatTarget(location.pathname, location.search) === target;
  useLayoutEffect(() => {
    if (ownsLocation) setBackground(createPath(location));
  }, [location, ownsLocation]);
  const paneNavigation = useMemo(() => {
    if (ownsLocation) return navigation;
    const redirect = (to: To) => {
      const path = typeof to === 'string' ? to : createPath(to);
      const [pathname, search] = path.split('?');
      const nextTarget = companionChatTarget(pathname, search);
      if (nextTarget === target) {
        setBackground(path);
        return;
      }
      // Validated companion gates may follow the same companion to its new
      // computer, including a completed arrival on this computer.
      const nextBotId = matchPath('/bots/remote/:deviceId/:id', nextTarget ?? '')?.params.id
        ?? matchPath('/bots/:id', nextTarget ?? '')?.params.id;
      if (!nextTarget || !nextBotId || nextBotId !== (remote?.id ?? botId)) return;
      const panes = getSplitPanes(splitGroupStore.getSnapshot().root);
      if (panes.some(pane => pane.sessionId === nextTarget)) {
        splitGroupStore.removeSession(target);
      } else {
        splitGroupStore.replaceSession(target, nextTarget);
      }
    };
    return {
      ...navigation,
      navigator: { ...navigation.navigator, go: () => {}, push: redirect, replace: redirect },
    };
  }, [navigation, ownsLocation, target, remote?.id, botId]);
  return children(
    title,
    background,
    <SplitPaneFocusContext.Provider value={ownsLocation}>
      <UNSAFE_NavigationContext.Provider value={paneNavigation}>
        <UNSAFE_RouteContext.Provider value={rootMatch}>
          <Suspense fallback={null}>
            <Routes location={ownsLocation ? location : background}>
              <Route element={<Outlet context={ownsLocation ? shell : null} />}>
                <Route path="/bots" element={<BotsFeatureLayout />}>
                  <Route path="groups/:groupId" element={<GroupChat />} />
                  <Route path=":botId" element={<BotHome />} />
                  <Route path=":botId/session/:sessionId" element={<BotChat />} />
                  <Route path="remote/:deviceId/:botId" element={<RemoteChat />} />
                  <Route
                    path="remote/:deviceId/:botId/session/:sessionId"
                    element={<RemoteChat />}
                  />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </UNSAFE_RouteContext.Provider>
      </UNSAFE_NavigationContext.Provider>
    </SplitPaneFocusContext.Provider>,
  );
}
