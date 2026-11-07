/**
 * TabGroupPanel —— 左 / 上 / 下边页签组的 pane 组件(panelKind `tab-group:<边>`)。
 *
 * 右侧组仍由 MainLayout 构造的 <RightSidebar>(折叠动画、mac 浮层按钮等历史外壳)
 * 承载;其余三组是布局引擎按需挂载的通用 pane:同一个 RightSidebarShell 换个
 * `groupId`,顶栏自带「在独立窗口中打开 / 撑满」,没有折叠 —— 组里页签清空就由
 * tabGroupPanes 注销 kind,引擎把它隐藏、空间回流给聊天区。
 *
 * 宽高口径与其它 pane 一致:根横排里的左组按引擎下发的像素宽(PaneWidthContext),
 * 聊天列里的上下组填满父格(PaneFillContext)。
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { tabGroupPanelKind, type TabGroupId } from '../../../shared/layoutTree';
import { CHROME_ACTIONS_GEOMETRY } from '@/components/layout/chromeActionsGeometry';
import { usePanelMaximize } from '@/layout/panelMaximize';
import { usePaneAtWindowLeft, usePaneAtWindowTop, usePaneFill } from '@/layout/panePlacement';
import { usePanelWidth } from '@/layout/paneWidths';
import type { PanelComponentProps } from '@/panels/registry';
import { RightSidebarShell } from './RightSidebarShell';
import { useTabGroupHost } from './tabGroupHost';
import { tabGroupLabelKey } from './tabGroups';

function TabGroupPanelBody({ groupId }: { groupId: TabGroupId }): ReactNode {
  const { t } = useTranslation();
  const host = useTabGroupHost();
  const fill = usePaneFill();
  const atWindowTop = usePaneAtWindowTop();
  const atWindowLeft = usePaneAtWindowLeft();
  const maximize = usePanelMaximize();
  const kind = tabGroupPanelKind(groupId);
  const engineWidth = usePanelWidth(kind);
  if (!host) return null;
  const isMaximized = maximize?.maximizedKind === kind;
  const style: CSSProperties | undefined =
    fill || isMaximized ? undefined : { width: engineWidth ?? undefined };
  return (
    <section
      aria-label={t(tabGroupLabelKey(groupId))}
      data-panel-drag-root={kind}
      data-tab-group={groupId}
      className={
        fill || isMaximized
          ? 'relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-content-area'
          : 'relative flex h-full min-h-0 min-w-0 shrink flex-col overflow-hidden bg-content-area'
      }
      style={style}
    >
      {!host.isMac && atWindowTop && (
        // 与右侧栏保持同一条 46px 窗口标题带，避免页签操作与系统窗口按钮重叠。
        // 下方组撑满时布局引擎也会把 atWindowTop 置为 true；还原后自动收回占位。
        <div
          aria-hidden
          className="h-[46px] shrink-0 border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
          {atWindowLeft && (host.sidebarCollapsed || host.hasRailChromeActions) && (
            <div
              className="h-full"
              style={
                {
                  width: CHROME_ACTIONS_GEOMETRY.clusterWidth,
                  marginLeft: CHROME_ACTIONS_GEOMETRY.defaultLeft,
                  WebkitAppRegion: 'no-drag',
                } as CSSProperties
              }
            />
          )}
        </div>
      )}
      <RightSidebarShell
        groupId={groupId}
        sessionId={host.sessionId}
        workdir={host.workdir}
        remoteHostId={host.remoteHostId}
        deviceLinkDeviceId={host.deviceLinkDeviceId}
        subagentsAvailable={host.subagentsAvailable}
        isMac={host.isMac}
        unifiedTopbar={host.isMac && atWindowTop}
        // 贴着窗口左上角(左栏收起后左侧组 / 聊天列里的上方组都可能):给红绿灯与
        // ChromeActions 让位,否则页签与关闭按钮压在它们下面。
        reserveLeftChromeActions={
          host.isMac && atWindowTop && atWindowLeft && host.sidebarCollapsed
        }
        railChromeActionsHitHole={
          host.isMac && atWindowTop && atWindowLeft && host.hasRailChromeActions
        }
        onMaximize={maximize ? () => maximize.toggle(kind) : undefined}
        isMaximized={isMaximized}
        onDetachTab={host.onDetachTab}
        chromeWindowDrag={false}
      />
    </section>
  );
}

const panels: Partial<Record<TabGroupId, (props: PanelComponentProps) => ReactNode>> = {};

/** 某边组的 pane 组件(按组缓存,注册表拿到稳定引用)。右侧组不在此列。 */
export function tabGroupPanelComponent(
  groupId: Exclude<TabGroupId, 'right'>,
): (props: PanelComponentProps) => ReactNode {
  let component = panels[groupId];
  if (!component) {
    component = function TabGroupPanel(): ReactNode {
      return <TabGroupPanelBody groupId={groupId} />;
    };
    panels[groupId] = component;
  }
  return component;
}
