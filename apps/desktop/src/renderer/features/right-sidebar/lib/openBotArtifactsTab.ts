import { ensureSingletonTab, getBucket, patchTabState, setActiveTab } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/**
 * 打开/聚焦某个伙伴任务的「交付物」页签(每会话单例)。
 *
 * 与 openBotDelegationsTab 同构:先让 main 裁决宿主(主窗 or detached 右侧栏窗口),
 * 归属在中途搬走时重路由。`focusArtifactId` 用于从对话里的交付物卡「在仓库中查看」
 * 跳过来时高亮那一件。
 */
export async function openBotArtifactsTab(
  sessionId: string,
  opts?: {
    focusArtifactId?: string;
    userInitiated?: boolean;
    focusTab?: boolean;
    revealSidebar?: boolean;
  },
): Promise<void> {
  const focusTab = opts?.focusTab !== false;
  const revealSidebar = opts?.revealSidebar !== false;
  const command = {
    type: 'open-bot-artifacts-tab' as const,
    sessionId,
    focusArtifactId: opts?.focusArtifactId ?? null,
    focusTab,
    revealSidebar,
  };
  const routeOptions = {
    allowOpen: revealSidebar,
    userInitiated: opts?.userInitiated !== false,
  };
  const handleRouted = (result: Awaited<ReturnType<typeof routeSidebarCommand>>): boolean => {
    if (result === 'attached') return false;
    if (result === 'routed' && revealSidebar) {
      requestRightSidebarVisibility('open', {
        sessionId,
        userInitiated: opts?.userInitiated !== false,
      });
    }
    return true;
  };
  const rerouteIfOwnershipMoved = async (): Promise<boolean> =>
    handleRouted(await routeSidebarCommand(command, routeOptions));

  const routeResult = await routeSidebarCommand(command, routeOptions);
  if (routeResult !== 'attached') {
    handleRouted(routeResult);
    return;
  }

  let tab = await ensureSingletonTab(sessionId, 'bot-artifacts', {
    filter: 'all',
    focusArtifactId: null,
  });
  if (await rerouteIfOwnershipMoved()) return;

  let bucket = getBucket(sessionId);
  if (!bucket.tabs.some((candidate) => candidate.id === tab.id)) {
    tab = await ensureSingletonTab(sessionId, 'bot-artifacts', {
      filter: 'all',
      focusArtifactId: null,
    });
    bucket = getBucket(sessionId);
  }
  if (opts?.focusArtifactId) {
    await patchTabState(sessionId, tab.id, (current) => ({
      ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}),
      focusArtifactId: opts.focusArtifactId,
    }));
    if (await rerouteIfOwnershipMoved()) return;
  }
  if ((focusTab || bucket.activeTabId === null) && bucket.activeTabId !== tab.id) {
    await setActiveTab(sessionId, tab.id);
    if (await rerouteIfOwnershipMoved()) return;
  }
  if (revealSidebar) {
    requestRightSidebarVisibility('open', {
      sessionId,
      userInitiated: opts?.userInitiated !== false,
    });
  }
}
