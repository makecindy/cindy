// @vitest-environment jsdom
/**
 * TopLevelErrorBoundary 测试 —— RouterProvider 之上 provider 链崩溃的白屏缺口兜底。
 *
 * 验证:
 * 1. 子树正常时透明透传 children;
 * 2. 子树同步渲染抛错时渲染 AppCrashScreen(标题 / 重新加载 / 回主界面 / 详情),
 *    而不是把错误继续往上抛炸掉 #root(白屏);
 * 3. 非 Error 抛出物(字符串等)也能正常归一化展示。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 仓库同款 i18n mock:t 返回 key 本身,断言直接用 key。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TopLevelErrorBoundary } from '../TopLevelErrorBoundary';

function Bomb(): never {
  // 模拟 provider 链某环节渲染期同步抛错(RouterProvider 之上没有任何 errorElement)
  throw new Error('provider boom');
}

function StringBomb(): never {
  throw 'string boom';
}

afterEach(() => cleanup());

describe('TopLevelErrorBoundary', () => {
  it('无错误时透传 children', () => {
    render(
      <TopLevelErrorBoundary>
        <div>healthy app</div>
      </TopLevelErrorBoundary>,
    );
    expect(screen.getByText('healthy app')).toBeTruthy();
  });

  it('子树同步渲染抛错时展示可恢复错误页,不炸掉根节点', () => {
    // React 会把渲染期错误重复打到 console.error,静音以免测试输出刷屏
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <TopLevelErrorBoundary>
          <Bomb />
        </TopLevelErrorBoundary>,
      );
      expect(screen.getByText('appError.title')).toBeTruthy();
      expect(screen.getByText('appError.reload')).toBeTruthy();
      expect(screen.getByText('appError.backHome')).toBeTruthy();
      expect(screen.queryByText(/provider boom/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
      // 错误详情里能看到原始 message(给用户复制反馈用)
      expect(screen.getByText(/provider boom/)).toBeTruthy();
    } finally {
      silence.mockRestore();
    }
  });

  it('抛出非 Error 值时归一化为字符串展示', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <TopLevelErrorBoundary>
          <StringBomb />
        </TopLevelErrorBoundary>,
      );
      expect(screen.getByText('appError.title')).toBeTruthy();
      expect(screen.queryByText(/string boom/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
      expect(screen.getByText(/string boom/)).toBeTruthy();
    } finally {
      silence.mockRestore();
    }
  });
});
