/**
 * ProjectLinkChip — 聊天正文里 `cindy://project/<urlencoded-workingDir>`(历史 xdt-maker:// 同)
 * 深链的行内 chip 渲染(FolderOpen 图标 + 项目目录名),点击聚焦侧边栏对应
 * project 节点(展开 + 滚动;不在 ExpandedView 路由时先跳回 /cc-agent——
 * 与 MainLayout 处理 OS 级 project 深链完全同一套信号:pendingProjectFocus)。
 *
 * 文案:作者显式 label(`[自定义文案](…)`)优先,否则取 workingDir 末段
 * 目录名——纯字符串推导,无需查库(与 SessionLinkChip 的异步标题解析不同,
 * project 深链自带全部展示信息)。项目不存在于本机时点击由 sidebar 侧
 * toast 提示(pendingProjectFocus 消费方兜底),chip 本身不做存在性校验
 * ——深链可能指向其它设备的目录,渲染永远可用。
 *
 * 样式与 SessionLinkChip / @file chip 同一套 token(--chat-input-chip-*)。
 */

import { useMemo } from 'react';
import { FolderOpen } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { parseProjectDeepLinkHref, projectDisplayName } from '@/lib/deepLink';
import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';
import { requestProjectFocus } from '@/state/pendingProjectFocus';
import { InlineReferenceChip } from './InlineReferenceChip';
import { useLinkContextMenu } from './useLinkContextMenu';

export interface ProjectLinkChipProps {
  href: string;
  /** 作者显式链接文案(`[label](…)`,label ≠ href 时传入);有值则优先展示。 */
  label?: string;
}

export function ProjectLinkChip({ href, label }: ProjectLinkChipProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationMode = useSessionNavigationMode();
  const target = useMemo(() => parseProjectDeepLinkHref(href), [href]);

  const handleClick = () => {
    if (!target || navigationMode === 'sidebar-embedded') return;
    // 与 MainLayout.handleDeepLinkPayload 的 project 分支同语义:发一次性
    // focus 信号,消费方(CCAgentSidebarUpper → ExpandedView)不在挂载态时
    // 信号沉淀,先 navigate 回 /cc-agent 促其 mount。
    requestProjectFocus(target.workingDir);
    const path = location.pathname;
    const inExpandedView = path.startsWith('/cc-agent') && !path.startsWith('/cc-agent/files/');
    if (!inExpandedView) navigate('/cc-agent');
  };
  const linkMenu = useLinkContextMenu(
    href,
    navigationMode === 'sidebar-embedded'
      ? []
      : [
          {
            label: t('chat.markdownRenderer.locateProject'),
            icon: <FolderOpen className="mr-2 h-4 w-4" />,
            run: handleClick,
          },
        ],
  );
  if (!target) return <span>{label ?? href}</span>;
  const display = label?.trim() || projectDisplayName(target.workingDir);

  return (
    <>
      <InlineReferenceChip
        label={display}
        icon={<FolderOpen aria-hidden />}
        tooltip={display}
        ariaLabel={display}
        onClick={navigationMode === 'sidebar-embedded' ? undefined : handleClick}
        onContextMenu={linkMenu.onContextMenu}
        className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
      />
      {linkMenu.menu}
    </>
  );
}
