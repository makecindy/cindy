// @vitest-environment jsdom

/**
 * 「协同」设置面板的渲染与写入回归。
 *
 * 这一段的落盘语义与「Agent 资源占用」相反 —— 它是 onChange 即写盘 + clamp(而不是
 * onBlur 提交制 + 拒绝非法值)。这里把该口径钉住,重点覆盖软/硬上限的耦合:软上限的
 * 上界是当前硬上限,不是常量。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CollaborationSection } from '../CollaborationSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

type Wire = {
  workerSoftLimit: number;
  workerHardLimit: number;
  workerIdleReleaseMinutes: number;
  isCustomized?: boolean;
};

const DEFAULT_WIRE: Wire = {
  workerSoftLimit: 5,
  workerHardLimit: 8,
  workerIdleReleaseMinutes: 0,
  isCustomized: false,
};

function installElectronApi(initial: Wire) {
  let current = { ...initial };
  const getCollaborationSettings = vi.fn(async () => current);
  const setCollaborationSetting = vi.fn(async (key: string, value: number) => {
    current = { ...current, [key]: value, isCustomized: true };
    return current;
  });
  const resetCollaborationSettings = vi.fn(async () => {
    current = { ...DEFAULT_WIRE };
    return current;
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: {
      orcaWorkflows: {
        getCollaborationSettings,
        setCollaborationSetting,
        resetCollaborationSettings,
      },
    },
  };
  return { getCollaborationSettings, setCollaborationSetting, resetCollaborationSettings };
}

/** 三个数字框按 DOM 顺序 = 软上限 / 硬上限 / 空闲释放。 */
function limitInputs(): HTMLInputElement[] {
  return screen.getAllByRole('spinbutton') as HTMLInputElement[];
}

describe('CollaborationSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the three worker limits', async () => {
    installElectronApi(DEFAULT_WIRE);
    render(<CollaborationSection />);

    await waitFor(() => {
      expect(screen.getByText('settings.collaboration.title')).toBeTruthy();
    });
    expect(limitInputs().map((i) => i.value)).toEqual(['5', '8', '0']);
  });

  it('writes the soft limit on change without waiting for blur', async () => {
    const api = installElectronApi(DEFAULT_WIRE);
    render(<CollaborationSection />);
    await waitFor(() => limitInputs());

    fireEvent.change(limitInputs()[0]!, { target: { value: '6' } });
    await waitFor(() => {
      expect(api.setCollaborationSetting).toHaveBeenCalledWith('workerSoftLimit', 6);
    });
  });

  it('clamps the soft limit to the current hard limit', async () => {
    const api = installElectronApi(DEFAULT_WIRE); // hard = 8
    render(<CollaborationSection />);
    await waitFor(() => limitInputs());

    // 软上限的上界是硬上限(8),不是常量 —— 越界值被夹到 8 而不是原样落盘
    fireEvent.change(limitInputs()[0]!, { target: { value: '99' } });
    await waitFor(() => {
      expect(api.setCollaborationSetting).toHaveBeenCalledWith('workerSoftLimit', 8);
    });
  });

  it('clamps the hard limit between the current soft limit and 20', async () => {
    const api = installElectronApi(DEFAULT_WIRE); // soft = 5
    render(<CollaborationSection />);
    await waitFor(() => limitInputs());

    // 上界是常量 20
    fireEvent.change(limitInputs()[1]!, { target: { value: '99' } });
    await waitFor(() => {
      expect(api.setCollaborationSetting).toHaveBeenCalledWith('workerHardLimit', 20);
    });

    // 下界是当前软上限(5),不是 1 —— 硬上限必须 >= 软上限
    fireEvent.change(limitInputs()[1]!, { target: { value: '1' } });
    await waitFor(() => {
      expect(api.setCollaborationSetting).toHaveBeenCalledWith('workerHardLimit', 5);
    });
  });

  it('clamps the idle-release minutes into range and truncates decimals', async () => {
    const api = installElectronApi(DEFAULT_WIRE);
    render(<CollaborationSection />);
    await waitFor(() => limitInputs());

    fireEvent.change(limitInputs()[2]!, { target: { value: '999' } });
    await waitFor(() => {
      expect(api.setCollaborationSetting).toHaveBeenCalledWith('workerIdleReleaseMinutes', 120);
    });

    fireEvent.change(limitInputs()[2]!, { target: { value: '7.9' } });
    await waitFor(() => {
      expect(api.setCollaborationSetting).toHaveBeenCalledWith('workerIdleReleaseMinutes', 7);
    });
  });
});
