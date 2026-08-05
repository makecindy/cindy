/**
 * IssueTrackerFeatureLayout — GitHub Issues 引导页
 * ---------------------------------------------------------------------------
 * Issue 模块走 GitHub,此页面引导用户通过 /issue 命令发起 agent 对话式提交。
 * 左侧 app 侧栏沿用 cc-agent 项目/对话列表(显式注册,避免冷启动直接进 /issues
 * 时左栏空白,详见 useRegisterCCAgentSidebar)。
 */

import { Bug, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { InvisibleWindowDragStrip } from '@/components/layout/windowDrag';
import { useRegisterCCAgentSidebar } from '@/features/cc-agent/useRegisterCCAgentSidebar';

const GITHUB_ISSUES_URL = 'https://github.com/makecindy/cindy/issues';

export function IssueTrackerFeatureLayout() {
  const { t } = useTranslation();
  // 沿用 cc-agent 侧栏;冷启动直接进 /issues 时也能播种,不留空白左栏。
  useRegisterCCAgentSidebar();
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-content-area">
      {/* mac 上本页不渲染通用 ContentHeader 且顶部无交互元素,垫一条透明
          窗口拖拽条(windowDrag.tsx 约定) */}
      <InvisibleWindowDragStrip />
      <div className="flex max-w-md flex-col items-center gap-4 px-8 text-center">
        {/* Icon */}
        <div className="flex size-16 items-center justify-center rounded-full bg-sidebar-item-hover">
          <Bug size={28} className="text-sidebar-muted" strokeWidth={1.5} />
        </div>

        {/* Title */}
        <h1 className="text-lg font-medium text-foreground">
          {t('issueAgent.redirect.title')}
        </h1>

        {/* Description */}
        <p className="text-sm text-sidebar-muted">
          {t('issueAgent.redirect.descriptionBefore')}
          <code className="rounded bg-sidebar-item-hover px-1.5 py-0.5 text-foreground">
            /issue
          </code>
          {t('issueAgent.redirect.descriptionAfter')}
        </p>

        {/* CTA */}
        <button
          type="button"
          onClick={() => window.electronAPI.openExternal(GITHUB_ISSUES_URL)}
          className={cn(
            'mt-2 inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-5',
            'text-sm font-medium transition-colors',
            'bg-foreground text-background hover:opacity-90',
          )}
        >
          {t('issueAgent.redirect.cta')}
          <ExternalLink size={14} />
        </button>
      </div>
    </div>
  );
}
