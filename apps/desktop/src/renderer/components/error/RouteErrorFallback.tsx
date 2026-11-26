/**
 * RouteErrorFallback — 路由级渲染崩溃兜底页(react-router errorElement)。
 *
 * 背景(2026-07-09 事故):release 端某组件在特定数据下渲染出 <undefined/>
 * (React #130),而路由树没有任何 errorElement,用户看到的是 react-router
 * 自带的开发者默认错误页("Hey developer 👋"),且整个应用锁死无法恢复。
 * 本组件保证:任何路由子树渲染崩溃时,用户看到的是符合产品视觉的可恢复页面。
 *
 * 两个挂载位置(见 router.tsx):
 *   - variant='fullscreen':挂在根路由('/'、'/login'),MainLayout 自身崩溃时全屏兜底。
 *   - variant='section'  :挂在 MainLayout children 的 pathless wrapper 上,
 *     内容区崩溃时保住外层导航 chrome,错误页只占内容区。
 *
 * RouterProvider **之上**的 provider 链崩溃由 TopLevelErrorBoundary 兜底(index.tsx),
 * 两者共用 AppCrashScreen 展示层。
 *
 * 崩溃详情通过统一 logger 上报进 main-*.log(此前 renderer 渲染崩溃在
 * release 日志里完全无痕,只能靠用户截图定位)。
 *
 * 「诊断」与任务错误卡同一入口:把错误、出错任务链接与崩溃时间预填进新建任务草稿,
 * 在路由内跳到新建任务页(草稿只在内存里,不能整页 reload)。跳转会清掉路由错误状态。
 */

import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isRouteErrorResponse,
  matchPath,
  useLocation,
  useNavigate,
  useRouteError,
} from 'react-router-dom';

import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { buildSessionDeepLink } from '@/lib/deepLink';
import { buildErrorDiagnosisPrompt, prefillErrorDiagnosisDraft } from '@/lib/errorDiagnosisPrompt';
import { createLogger } from '@/lib/logger';
import { AppCrashScreen } from './AppCrashScreen';

const log = createLogger('route-error-fallback');

interface NormalizedError {
  message: string;
  stack?: string;
}

function normalizeRouteError(error: unknown): NormalizedError {
  if (isRouteErrorResponse(error)) {
    return { message: `${error.status} ${error.statusText}` };
  }
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

const NON_SESSION_SEGMENTS = new Set(['new', 'new-dialogue', 'boot', 'scheduled']);

/** 崩溃发生在某个任务页时返回该任务 id,供诊断附上任务链接。 */
function crashedSessionId(pathname: string): string | null {
  const match = matchPath('/cc-agent/orca/:sessionId', pathname)
    ?? matchPath('/cc-agent/files/:sessionId', pathname)
    ?? matchPath('/cc-agent/:sessionId', pathname);
  const sessionId = match?.params.sessionId;
  return sessionId && !NON_SESSION_SEGMENTS.has(sessionId) ? sessionId : null;
}

export function RouteErrorFallback({
  variant = 'fullscreen',
}: {
  variant?: 'fullscreen' | 'section';
}) {
  const { t } = useTranslation();
  const error = useRouteError();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { message, stack } = useMemo(() => normalizeRouteError(error), [error]);
  // 诊断时据此到日志里找同一次崩溃。
  const crashedAt = useMemo(() => new Date().toISOString(), [error]);

  useEffect(() => {
    log.error('route render crashed', { variant, message, stack });
  }, [variant, message, stack]);

  const handleDiagnose = () => {
    const sessionId = crashedSessionId(pathname);
    const sessionUrl = sessionId
      ? buildSessionDeepLink(sessionId, { deviceId: getStickySessionDeviceId(sessionId) })
      : null;
    prefillErrorDiagnosisDraft(buildErrorDiagnosisPrompt(t, sessionUrl, {
      message: t('appError.title'),
      details: `${stack ?? message}\n\npage: ${pathname}\ntime: ${crashedAt}`,
    }));
    navigate('/cc-agent/new');
  };

  return (
    <AppCrashScreen variant={variant} message={message} stack={stack} onDiagnose={handleDiagnose} />
  );
}
