/**
 * IssueTrackerFeatureLayout — 「我的 Issue」页
 * ---------------------------------------------------------------------------
 * Issue 本体在 GitHub 上;本页解决的是「提交完就再也看不到了」。
 *
 * 口径:看自己的 issue 与提交 issue 走**同一条公共能力**,只要 Cindy 登录态,
 * 不要求用户有 GitHub 账号 —— 所以本页任何状态下都**不得**提示「你需要连接
 * GitHub」。用户自己的 GitHub 身份只是可选增强(把他直接在 GitHub 上提的也并进来),
 * 没有它页面照常工作,界面上也不提。
 *
 * 一条都没有时,页面退回原来的引导形态(告诉用户怎么用 /issue 提交)。
 *
 * **取数期间不换界面**(engineering-conventions §7):首屏加载不显示 loading 文案,
 * 正文保持引导内容 —— 平台通道的总 deadline 可达 12s,换成一行「加载中」会造成
 * 引导 → loading → 列表 两次跳变;而一条都没有的用户(最常见)看到的引导页更是
 * 从头到尾不该动过。进度反馈只放在 header 的刷新图标上(零布局变化)。
 *
 * 左侧 app 侧栏沿用 cc-agent 项目/对话列表(显式注册,避免冷启动直接进 /issues
 * 时左栏空白,详见 useRegisterCCAgentSidebar)。
 */

import { useCallback } from 'react';
import { Bug, ExternalLink, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { MyIssuesResult } from '@/../shared/myIssues';
import { cn } from '@/lib/utils';
import { InvisibleWindowDragStrip } from '@/components/layout/windowDrag';
import { useRegisterCCAgentSidebar } from '@/features/cc-agent/useRegisterCCAgentSidebar';

import { MyIssueList } from './MyIssueList';
import { useMyIssues } from './hooks/useMyIssues';
import { selectMyIssuesNotices } from './lib/myIssuesNotices';
import { prefillIssueCommandDraft } from './lib/startIssueChat';

const GITHUB_ISSUES_URL = 'https://github.com/makecindy/cindy/issues';

export function IssueTrackerFeatureLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // 沿用 cc-agent 侧栏;冷启动直接进 /issues 时也能播种,不留空白左栏。
  useRegisterCCAgentSidebar();
  const { data, loading, refreshing, error, refresh } = useMyIssues();

  const items = data?.items ?? [];
  const hasItems = items.length > 0;

  // 预填草稿 + 跳新建页,不自动发送 —— 用户还要在那条命令后面补描述。
  const startIssueChat = useCallback(() => {
    prefillIssueCommandDraft();
    navigate('/cc-agent/new');
  }, [navigate]);

  return (
    <div className="relative flex h-full w-full flex-col bg-content-area">
      {/* mac 上本页不渲染通用 ContentHeader,顶部垫一条透明窗口拖拽条
          (windowDrag.tsx 约定);它不吃点击,不挡下面的刷新按钮。 */}
      <InvisibleWindowDragStrip />

      <header className="flex shrink-0 items-center gap-3 px-6 pb-3 pt-8">
        <h1 className="text-15 font-medium text-foreground">{t('issueTracker.list.header')}</h1>
        {data ? <ViewerLine data={data} /> : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={refresh}
          disabled={loading || refreshing}
          title={t('issueTracker.mine.refresh')}
          aria-label={t('issueTracker.mine.refresh')}
          className={cn(
            'flex size-7 items-center justify-center rounded-full text-sidebar-muted',
            'transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {/* 动画挂外层 span,SVG 保持静态:挂在 SVG 上会每帧惊动主线程
              (engineering-conventions「常驻动画必须 compositor-only」)。
              首屏取数期间也转 —— 正文保持引导内容不动,这里是唯一的进度反馈,
              且它零布局变化、不构成跳变。 */}
          <span className={cn('inline-flex', (loading || refreshing) && 'animate-spinner')}>
            <RefreshCw size={14} />
          </span>
        </button>
      </header>

      {/* 「怎么提交」常驻在 header 下方、**滚动区之外**:issue 多的时候放列表末尾
          等于看不见。空态不渲染它 —— 那时 EmptyGuide 里已经有同一段说明。 */}
      {hasItems ? <SubmitHintBar onStartIssueChat={startIssueChat} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-2">
        {error && !hasItems ? (
          // 整页错误态只留给「从来没加载成功过」;已经有数据时刷新失败不能把列表
          // 盖掉(useMyIssues 特意保留了旧 data),否则用户点一下刷新就丢失全部内容。
          <LoadFailed onRetry={refresh} busy={refreshing} />
        ) : hasItems ? (
          <>
            {error ? <RefreshFailedNotice onRetry={refresh} busy={refreshing} /> : null}
            <Notices data={data} />
            <MyIssueList items={items} />
          </>
        ) : (
          <>
            <Notices data={data} />
            <EmptyGuide onStartIssueChat={startIssueChat} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 说明文案里的 `/issue` —— 可点击,点了直接开一个预填好该命令的新对话。
 * 两处说明(顶部条与空态)共用它,避免样式与行为各写一套;`size` 只差内边距,
 * 视觉语言(等宽字 + 浅底 + hover 加深)一致。
 */
function IssueCommandButton({
  onClick,
  size = 'sm',
}: {
  onClick: () => void;
  size?: 'sm' | 'lg';
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('issueTracker.mine.startIssueChat')}
      aria-label={t('issueTracker.mine.startIssueChat')}
      className={cn(
        'rounded-full bg-sidebar-item-hover font-mono text-foreground',
        'transition-colors hover:bg-sidebar-item-active',
        size === 'lg' ? 'px-1.5 py-0.5' : 'px-1 py-0.5',
      )}
    >
      /issue
    </button>
  );
}

/**
 * 只在「恰好配了 GitHub 身份」时说明列表额外并入了谁名下的 issue。
 * 没配时**什么都不显示** —— 提示「未连接」会重新制造「必须有 GitHub 账号」的暗示。
 */
function ViewerLine({ data }: { data: MyIssuesResult }) {
  const { t } = useTranslation();
  if (!data.githubEnhancement) return null;
  return (
    <span className="truncate text-12 text-sidebar-muted">
      {t('issueTracker.mine.viewerGithub', { login: data.githubEnhancement.login })}
    </span>
  );
}

/** 降级 / 截断提示:数据没给全时必须明说(选取规则见 lib/myIssuesNotices)。 */
function Notices({ data }: { data: MyIssuesResult | null }) {
  const { t } = useTranslation();
  if (!data) return null;
  const notices = selectMyIssuesNotices(data);
  if (notices.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-xl bg-sidebar-item-hover px-3 py-2">
      {notices.map((key) => (
        <p key={key} className="text-11 leading-relaxed text-sidebar-muted">
          {t(key)}
        </p>
      ))}
    </div>
  );
}

/**
 * 已有数据时刷新失败:降级成列表上方一条提示 + 重试,旧内容照常可读可点。
 * 与整页 LoadFailed 复用同一组文案,只是不夺走内容区。
 *
 * 重试进行中**不清掉这条提示**:清了会让它消失、失败后又出现,两次跳变
 * (engineering-conventions §7)。刷新状态由 header 图标表达,这里只把按钮禁用掉 ——
 * 否则它看着可点、点了却被 useMyIssues 的 in-flight 静默挡掉,毫无反馈。
 */
function RefreshFailedNotice({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-sidebar-item-hover px-3 py-2">
      <p className="text-11 text-sidebar-muted">{t('issueTracker.list.loadFailed')}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className={cn(
          'text-11 text-sidebar-muted underline-offset-2',
          'hover:text-foreground hover:underline',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {t('issueTracker.list.retry')}
      </button>
    </div>
  );
}

function LoadFailed({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-2">
      <p className="text-13 text-foreground">{t('issueTracker.list.loadFailed')}</p>
      {/* 刻意不展示 main 侧错误原文:它可能带 userData 绝对路径,详情只进 main 日志。 */}
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className={cn(
          'text-12 text-sidebar-muted underline-offset-2',
          'hover:text-foreground hover:underline',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {t('issueTracker.list.retry')}
      </button>
    </div>
  );
}

/**
 * 列表非空时的常驻说明条:同一段「怎么提交」的文案压成一行。
 * 与空态的 EmptyGuide 共用同一组 i18n key,只是版式一个紧凑一个居中大版 ——
 * 两处说法必须一致,不要各写一套。
 *
 * 它常驻占位,所以刻意压到最低存在感:11px 灰字 + 文字链,不用实心按钮
 * (那是空态的主 CTA)。
 */
function SubmitHintBar({ onStartIssueChat }: { onStartIssueChat: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1',
        'border-b border-border px-6 pb-2',
      )}
    >
      <p className="text-11 leading-relaxed text-sidebar-muted">
        {t('issueAgent.redirect.descriptionBefore')}
        <IssueCommandButton onClick={onStartIssueChat} />
        {t('issueAgent.redirect.descriptionAfter')}
      </p>
      <button
        type="button"
        onClick={() => window.electronAPI.openExternal(GITHUB_ISSUES_URL)}
        className={cn(
          'inline-flex items-center gap-1 text-11 text-sidebar-muted',
          'underline-offset-2 transition-colors hover:text-foreground hover:underline',
        )}
      >
        {t('issueAgent.redirect.cta')}
        <ExternalLink size={11} />
      </button>
    </div>
  );
}

/**
 * 一条都没有时的引导:怎么提、去哪看。正文与 CTA 沿用改版前的整页引导;
 * 标题换成空态该说的话 —— 原来那句「Issue 已迁移至 GitHub」是整页引导时代的说法,
 * 现在这一页本身就是能用的列表,再说「已迁移」会让人以为页面没做。
 */
function EmptyGuide({ onStartIssueChat }: { onStartIssueChat: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4 px-8 py-16 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-sidebar-item-hover">
        <Bug size={28} className="text-sidebar-muted" strokeWidth={1.5} />
      </div>

      <h2 className="text-lg font-medium text-foreground">{t('issueTracker.mine.emptyTitle')}</h2>

      <p className="max-w-md text-sm text-sidebar-muted">
        {t('issueAgent.redirect.descriptionBefore')}
        <IssueCommandButton onClick={onStartIssueChat} size="lg" />
        {t('issueAgent.redirect.descriptionAfter')}
      </p>

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
  );
}
