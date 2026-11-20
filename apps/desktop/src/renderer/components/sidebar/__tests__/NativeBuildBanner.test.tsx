// @vitest-environment jsdom

// NZWG-9FC9：M1 用户装了 darwin-x64 包，全程经 Rosetta 转译，启动慢约 10 倍且无任何提示。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useUpdateStatus', () => ({ useUpdateStatus: () => ({ status: 'idle' }) }));
vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({ dismissed: false }),
}));

import { NativeBuildBanner } from '../NativeBuildBanner';

function installApi(platform: string, translated: boolean) {
  const getArm64Translation = vi.fn(async () => translated);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform,
      getArm64Translation,
      clientEndpoints: { websiteUrl: 'https://cindy.example' },
    },
  });
  return getArm64Translation;
}

afterEach(cleanup);

describe('NativeBuildBanner', () => {
  it('原生运行或非 macOS 时不提示', async () => {
    const nativeCheck = installApi('darwin', false);
    render(<NativeBuildBanner isCollapsed={false} />);
    await waitFor(() => expect(nativeCheck).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    // Windows ARM 仿真同样算转译，但没有 win32-arm64 包可换，不能提示下载。
    const windowsCheck = installApi('win32', true);
    render(<NativeBuildBanner isCollapsed={false} />);
    expect(windowsCheck).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Apple 芯片上运行 Intel 包时提示，下载指向官网全部版本，关闭后本次运行内不再出现', async () => {
    const check = installApi('darwin', true);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<NativeBuildBanner isCollapsed={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'sidebar.nativeBuild.download' }));
    expect(open).toHaveBeenCalledWith('https://cindy.example/download#all-versions', '_blank');

    fireEvent.click(screen.getByRole('button', { name: 'sidebar.nativeBuild.dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    render(<NativeBuildBanner isCollapsed={false} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
