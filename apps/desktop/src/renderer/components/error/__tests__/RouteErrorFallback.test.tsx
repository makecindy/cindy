// @vitest-environment jsdom
/**
 * RouteErrorFallback 回归测试(2026-07-09 React #130 事故)。
 *
 * 验证:路由子树渲染抛错时,errorElement 渲染出产品自己的可恢复错误页
 * (标题 / 重新加载 / 回主界面 / 错误详情),而不是 react-router 的
 * 开发者默认错误页,也不会把错误继续往上抛炸掉整个应用。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

// 仓库同款 i18n mock:t 返回 key 本身,断言直接用 key;带插值时把参数附在后面以便断言。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { clearDraft, getDraft } from '@/lib/composerDraftStore';
import { RouteErrorFallback } from '../RouteErrorFallback';

function Bomb(): never {
  // 模拟事故场景:组件渲染期抛错(真实事故是渲染 <undefined/> 抛 React #130)
  throw new Error('boom: element type is invalid');
}

function renderWithError(variant?: 'fullscreen' | 'section') {
  const router = createMemoryRouter([
    {
      path: '/',
      errorElement: <RouteErrorFallback variant={variant} />,
      element: <Bomb />,
    },
  ]);
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  clearDraft(NEW_MAKER_DRAFT_KEY);
});

describe('RouteErrorFallback', () => {
  it('子树渲染抛错时展示可恢复错误页(标题 + 两个动作 + 详情折叠)', () => {
    // React 会把渲染期错误重复打到 console.error,静音以免测试输出刷屏
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWithError();
      expect(screen.getByText('appError.title')).toBeTruthy();
      expect(screen.getByText('appError.reload')).toBeTruthy();
      expect(screen.getByText('appError.backHome')).toBeTruthy();
      expect(screen.queryByText(/boom: element type is invalid/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
      // 错误详情里能看到原始 message(给用户复制反馈用)
      expect(screen.getByText(/boom: element type is invalid/)).toBeTruthy();
    } finally {
      silence.mockRestore();
    }
  });

  it('section 变体同样渲染完整动作(挂在 MainLayout 内容区的场景)', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWithError('section');
      expect(screen.getByText('appError.title')).toBeTruthy();
      expect(screen.getByText('appError.reload')).toBeTruthy();
    } finally {
      silence.mockRestore();
    }
  });

  // 2026-11-26:任务页渲染死循环(React #185)只给了「重新加载」,用户无法像任务错误那样一键诊断。
  // 诊断必须把错误与出错任务带进新建任务草稿,并在路由内离开崩溃页(草稿不跨 reload)。
  // 伙伴任务页同样挂载任务视图;远程伙伴的链接要保留所属电脑。
  it.each([
    { path: '/cc-agent/crashed-session', link: 'session/crashed-session' },
    { path: '/bots/remote/device-1/bot-1/session/bot-session', link: 'session/bot-session?device=device-1' },
  ])('诊断把崩溃详情和出错任务链接预填进新建任务并离开崩溃页: $path', ({ path, link }) => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const router = createMemoryRouter([
        {
          path: '/',
          errorElement: <RouteErrorFallback variant="section" />,
          children: [
            { path: 'cc-agent/new', element: <div>new-task-page</div> },
            { path: 'cc-agent/:sessionId', element: <Bomb /> },
            { path: 'bots/remote/:deviceId/:botId/session/:sessionId', element: <Bomb /> },
          ],
        },
      ], { initialEntries: [path] });
      render(<RouterProvider router={router} />);
      fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
      fireEvent.click(screen.getByRole('button', { name: /chat\.errorBanner\.diagnose/ }));

      expect(screen.getByText('new-task-page')).toBeTruthy();
      expect(screen.queryByText('appError.title')).toBeNull();
      const prompt = JSON.stringify(getDraft(NEW_MAKER_DRAFT_KEY)?.text);
      expect(prompt).toContain('chat.errorBanner.diagnosePrompt');
      expect(prompt).toContain(link);
      expect(prompt).toContain('boom: element type is invalid');
      expect(prompt).toContain(`page: ${path}`);
    } finally {
      silence.mockRestore();
    }
  });
});
