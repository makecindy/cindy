/**
 * AppCrashScreen — 渲染崩溃兜底页的纯展示层。
 *
 * 两个消费方(共用同一套视觉与动作,避免两份漂移):
 *   - RouteErrorFallback:react-router errorElement,路由子树渲染崩溃兜底;
 *   - TopLevelErrorBoundary:RouterProvider 之上 provider 链的同步渲染崩溃兜底。
 *
 * 依赖约束:本组件必须能在 App 的 provider 链**全部缺席**时安全渲染——
 *   - 颜色只用 CSS 变量(index.tsx 模块级 themeService.applyTheme 已把初始主题
 *     变量写到 documentElement,不依赖 ThemeProvider 存活);
 *   - 文案走 useTranslation,它读的是 '@/i18n' 模块级同步 init 的全局 i18next
 *     实例,不需要 I18nextProvider / LocaleProvider;
 *   - 不使用任何 Context(Tooltip / ConfirmDialog 等)。
 */

import { useTranslation } from 'react-i18next';
import { TriangleAlert, RotateCcw, House } from 'lucide-react';

import { cn } from '@/lib/utils';
import { clearLastView } from '@/features/cc-agent/lib/lastViewStore';

export function AppCrashScreen({
  message,
  stack,
  variant = 'fullscreen',
}: {
  message: string;
  stack?: string;
  variant?: 'fullscreen' | 'section';
}) {
  const { t } = useTranslation();

  const handleReload = () => {
    window.location.reload();
  };

  // 崩溃后组件树状态不可信,回主界面走"重置 hash + 整页 reload"而不是 navigate,
  // 保证从干净状态重新启动(也能逃出"当前路由数据必崩"的死循环)。
  // 先清 lastView——否则 /cc-agent 的 CCAgentIndexRedirect 会 loadLastChatView()
  // 还原到刚才崩溃的那个 session,形成 "back home → restore → crash" 死循环。
  const handleBackHome = () => {
    clearLastView();
    window.location.hash = '#/cc-agent';
    window.location.reload();
  };

  return (
    <div
      className={cn(
        'flex items-center justify-center',
        variant === 'fullscreen'
          ? 'h-screen w-screen bg-[hsl(var(--background))]'
          : 'h-full w-full',
      )}
    >
      <div className="mx-6 flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-8 py-10">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
          <TriangleAlert size={20} />
        </span>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h2 className="text-15 font-medium text-[var(--text-primary)]">
            {t('appError.title')}
          </h2>
          <p className="text-13 leading-relaxed text-[var(--text-secondary)]">
            {t('appError.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReload}
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-13 font-medium transition-opacity hover:opacity-90"
            style={{
              backgroundColor: 'var(--accent-cta-bg)',
              color: 'var(--accent-pure-cta-fg)',
            }}
          >
            <RotateCcw size={13} />
            {t('appError.reload')}
          </button>
          <button
            type="button"
            onClick={handleBackHome}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-4 text-13 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <House size={13} />
            {t('appError.backHome')}
          </button>
        </div>
        {(stack ?? message) && (
          <details className="w-full">
            <summary className="cursor-pointer text-12 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]">
              {t('appError.details')}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-[var(--surface-chip)] p-3 font-mono text-11 leading-relaxed whitespace-pre-wrap break-all text-[var(--text-secondary)]">
              {stack ?? message}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
