// @vitest-environment jsdom

/**
 * LoginFirstLaunchLightGateBridge 回归测试(主题跟随 §16.5 / Greptile Finding 2):
 * 认证恢复后已登录(canEnterApp)时结束首启亮色门,避免 renderer localStorage 被清空
 * 但主进程仍持有会话时整个已登录会话被永久锁亮色;未登录或 auth 未恢复时不结束门,
 * 保持登录全程亮色的设计语义(门仍由 LoginPage 卸载结束)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/hooks/useTheme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTheme')>();
  return { ...actual, endLoginFirstLaunchLightGate: vi.fn() };
});

import { endLoginFirstLaunchLightGate } from '@/hooks/useTheme';
import { LoginFirstLaunchLightGateBridge } from '../LoginFirstLaunchLightGateBridge';

const endSpy = endLoginFirstLaunchLightGate as unknown as ReturnType<typeof vi.fn>;

describe('LoginFirstLaunchLightGateBridge', () => {
  beforeEach(() => {
    endSpy.mockClear();
  });

  it('认证恢复且已可进入应用时结束首启亮色门', () => {
    const { rerender } = render(
      <LoginFirstLaunchLightGateBridge authResolved={false} canEnterApp={false} />,
    );
    expect(endSpy).not.toHaveBeenCalled();

    rerender(<LoginFirstLaunchLightGateBridge authResolved={true} canEnterApp={true} />);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('认证未恢复时不结束门(等 auth resolved)', () => {
    render(<LoginFirstLaunchLightGateBridge authResolved={false} canEnterApp={true} />);
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('未登录(canEnterApp=false)不结束门,保持登录全程亮色语义', () => {
    render(<LoginFirstLaunchLightGateBridge authResolved={true} canEnterApp={false} />);
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('props 保持 true 时不重复结束(幂等,rerender 不再触发)', () => {
    const { rerender } = render(
      <LoginFirstLaunchLightGateBridge authResolved={true} canEnterApp={true} />,
    );
    expect(endSpy).toHaveBeenCalledTimes(1);
    rerender(<LoginFirstLaunchLightGateBridge authResolved={true} canEnterApp={true} />);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});
