import { useContext, useEffect, useRef } from 'react';
import { MainViewHistoryContext } from '@/contexts/MainViewHistoryContext';
import { Outlet, useOutletContext, useParams, useLocation, useNavigate } from 'react-router-dom';

import { useRegisterCCAgentSidebar } from '../cc-agent/useRegisterCCAgentSidebar';
import { BotSettingsDrawer } from './BotSettingsDrawer';
import { BotGroupSettingsDrawer } from './BotGroupSettingsDrawer';
import { useBotProfiles } from './botStore';
import { useBotGroupSummary } from './botGroupStore';

/**
 * 伙伴路由与任务共用同一个侧栏(伙伴段在置顶上方,2026-10-13 定稿):这里只注册
 * 任务侧栏,不再整栏切换成伙伴列表。设置抽屉仍挂在本布局,按自身路由自判开关。
 */
export function BotsFeatureLayout() {
  useRegisterCCAgentSidebar();
  const history = useContext(MainViewHistoryContext);
  const { botId, deviceId, groupId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  const selectedGroup = useBotGroupSummary(groupId ?? null);
  const previousGroup = useRef(selectedGroup);
  useEffect(() => {
    const previous = previousGroup.current;
    previousGroup.current = selectedGroup;
    // Both archive entry points refresh this summary. Only clear a group that
    // became archived while selected; opening archived history stays supported.
    if (selectedGroup?.archived && previous?.id === selectedGroup.id && !previous.archived) {
      navigate('/bots/list', { replace: true });
    }
  }, [selectedGroup, navigate]);
  useEffect(() => {
    if (!history || deviceId || !botId || history.current.ignoredLocationKey === location.key) return;
    const bot = bots.find(candidate => candidate.id === botId);
    if (bot && bot.status !== 'archived' && bot.status !== 'deleting') {
      history.current.lastBotId = bot.id;
    }
  }, [history, botId, deviceId, bots, location.key]);
  const shellContext = useOutletContext<{
    sidebarWidth?: number;
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    setRightSidebarSessionId?: (
      sessionId: string | null,
      opts?: { initialCollapsed?: boolean; writeInitialCollapsedRecord?: boolean },
    ) => void;
    setRightSidebarWorkdir?: (
      workdir: string,
      remoteHostId?: string | null,
      deviceLinkDeviceId?: string | null,
    ) => void;
  } | null>();
  return (
    <>
      <Outlet context={shellContext} />
      <BotSettingsDrawer />
      <BotGroupSettingsDrawer />
    </>
  );
}
