// @vitest-environment jsdom

/**
 * Agent 资源占用设置面板的渲染与交互回归:
 *   1. 默认态(全速)下预设条高亮 full,三个字段回显默认值;
 *   2. 点预设按三键顺序写入组合值(maxConcurrentCommands → processPriority →
 *      capToolchainThreads),UI 用最后一次返回的 wire 状态;
 *   3. 与任何预设不匹配的值组合 → 预设条不高亮,提示 custom;
 *   4. 单字段修改走 agentResourceSettingsSet 且不写档位名。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentResourceSection } from '../AgentResourceSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: (props: { checked: boolean; onCheckedChange: (next: boolean) => void; ['aria-label']?: string }) => (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props['aria-label']}
      onClick={() => props.onCheckedChange(!props.checked)}
    />
  ),
}));

type WireShape = {
  maxConcurrentCommands: number;
  processPriority: 'normal' | 'low' | 'lowest';
  capToolchainThreads: boolean;
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: {
    maxConcurrentCommands: number;
    processPriority: 'normal' | 'low' | 'lowest';
    capToolchainThreads: boolean;
  };
};

const DEFAULT_WIRE: WireShape = {
  maxConcurrentCommands: 0,
  processPriority: 'normal',
  capToolchainThreads: false,
  isCustomized: false,
  customizedKeys: [],
  defaults: { maxConcurrentCommands: 0, processPriority: 'normal', capToolchainThreads: false },
};

function installElectronApi(initial: WireShape) {
  let current = { ...initial };
  const settingsGet = vi.fn(async () => current);
  const settingsSet = vi.fn(async (key: string, value: number | string | boolean) => {
    current = { ...current, [key]: value, isCustomized: true };
    return current;
  });
  const settingsReset = vi.fn(async () => {
    current = { ...DEFAULT_WIRE };
    return current;
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      agentResourceSettingsGet: settingsGet,
      agentResourceSettingsSet: settingsSet,
      agentResourceSettingsReset: settingsReset,
    },
  };
  return { settingsGet, settingsSet, settingsReset };
}

describe('AgentResourceSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders defaults with the full-speed preset highlighted', async () => {
    installElectronApi(DEFAULT_WIRE);
    render(<AgentResourceSection />);

    await waitFor(() => {
      expect(screen.getByText('settings.agentResource.title')).toBeTruthy();
    });
    const fullBtn = screen.getByText('settings.agentResource.presets.full');
    expect(fullBtn.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('settings.agentResource.presetHints.full')).toBeTruthy();
    const numberInput = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(numberInput.value).toBe('0');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('applies a preset by writing all three fields', async () => {
    const api = installElectronApi(DEFAULT_WIRE);
    render(<AgentResourceSection />);
    await waitFor(() => screen.getByText('settings.agentResource.presets.background'));

    fireEvent.click(screen.getByText('settings.agentResource.presets.background'));

    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledTimes(3);
    });
    expect(api.settingsSet).toHaveBeenNthCalledWith(1, 'maxConcurrentCommands', 2);
    expect(api.settingsSet).toHaveBeenNthCalledWith(2, 'processPriority', 'lowest');
    expect(api.settingsSet).toHaveBeenNthCalledWith(3, 'capToolchainThreads', true);
    await waitFor(() => {
      expect(
        screen
          .getByText('settings.agentResource.presets.background')
          .getAttribute('aria-checked'),
      ).toBe('true');
    });
  });

  it('shows the custom hint when values match no preset', async () => {
    installElectronApi({
      ...DEFAULT_WIRE,
      maxConcurrentCommands: 7,
      processPriority: 'lowest',
      capToolchainThreads: false,
      isCustomized: true,
      customizedKeys: ['maxConcurrentCommands', 'processPriority'],
    });
    render(<AgentResourceSection />);

    await waitFor(() => {
      expect(screen.getByText('settings.agentResource.presetHints.custom')).toBeTruthy();
    });
    for (const preset of ['full', 'balanced', 'background']) {
      expect(
        screen.getByText(`settings.agentResource.presets.${preset}`).getAttribute('aria-checked'),
      ).toBe('false');
    }
  });

  it('refetches authoritative state when a preset write fails mid-sequence', async () => {
    const api = installElectronApi(DEFAULT_WIRE);
    // 第 2 键(processPriority)写失败 → 只落了 maxConcurrentCommands
    api.settingsSet.mockImplementationOnce(async (key: string, value: number | string | boolean) => {
      return { ...DEFAULT_WIRE, [key]: value, isCustomized: true };
    });
    api.settingsSet.mockImplementationOnce(async () => {
      throw new Error('write failed');
    });
    render(<AgentResourceSection />);
    await waitFor(() => screen.getByText('settings.agentResource.presets.background'));
    const getCallsBefore = api.settingsGet.mock.calls.length;

    fireEvent.click(screen.getByText('settings.agentResource.presets.background'));

    // 失败后必须重新拉权威状态,不能让乐观值假装写成功
    await waitFor(() => {
      expect(api.settingsGet.mock.calls.length).toBeGreaterThan(getCallsBefore);
    });
  });

  it('ignores a second preset click while the first three-key sequence is in flight', async () => {
    const api = installElectronApi(DEFAULT_WIRE);
    let releaseFirstWrite: (() => void) | null = null;
    api.settingsSet.mockImplementationOnce(
      (key: string, value: number | string | boolean) =>
        new Promise((resolve) => {
          releaseFirstWrite = () =>
            resolve({ ...DEFAULT_WIRE, [key]: value, isCustomized: true });
        }),
    );
    render(<AgentResourceSection />);
    await waitFor(() => screen.getByText('settings.agentResource.presets.background'));

    fireEvent.click(screen.getByText('settings.agentResource.presets.background'));
    fireEvent.click(screen.getByText('settings.agentResource.presets.full')); // in-flight 期间的点击被闸掉

    releaseFirstWrite!();
    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledTimes(3); // 只有第一次点击的三键序列
    });
    expect(api.settingsSet.mock.calls.map((c) => c[0])).toEqual([
      'maxConcurrentCommands',
      'processPriority',
      'capToolchainThreads',
    ]);
  });

  it('discards a late failure-refetch snapshot when a newer write landed meanwhile', async () => {
    const api = installElectronApi(DEFAULT_WIRE);
    // 预设第 2 键写失败 → 触发失败回读;把回读 GET 挂起,晚于用户的下一次成功写返回
    api.settingsSet.mockImplementationOnce(async (key: string, value: number | string | boolean) => {
      return { ...DEFAULT_WIRE, [key]: value, isCustomized: true };
    });
    api.settingsSet.mockImplementationOnce(async () => {
      throw new Error('write failed');
    });
    let releaseStaleGet: (() => void) | null = null;
    api.settingsGet.mockImplementationOnce(async () => DEFAULT_WIRE); // 初始加载
    api.settingsGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // 回读返回"失败预设的部分状态"旧快照
          releaseStaleGet = () => resolve({ ...DEFAULT_WIRE, maxConcurrentCommands: 2 });
        }),
    );
    render(<AgentResourceSection />);
    await waitFor(() => screen.getByText('settings.agentResource.presets.background'));

    fireEvent.click(screen.getByText('settings.agentResource.presets.background'));
    // 等预设序列失败、操作闸解除(回读 GET 仍挂起)
    await waitFor(() => {
      expect(api.settingsGet).toHaveBeenCalledTimes(2);
    });

    // 用户随后的成功修改
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
    fireEvent.blur(screen.getByRole('spinbutton')); // 提交制:blur 落盘
    await waitFor(() => {
      expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7');
    });

    // 迟到的旧快照返回:必须被丢弃,不得覆盖用户的新值
    releaseStaleGet!();
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7');
  });

  it('keeps concurrency edits as draft and only commits valid values on blur', async () => {
    const api = installElectronApi({
      ...DEFAULT_WIRE,
      maxConcurrentCommands: 10,
      isCustomized: true,
    });
    render(<AgentResourceSection />);
    await waitFor(() => screen.getByRole('spinbutton'));

    // 编辑中间态一律不写盘:"10"删掉首位剩"0"若被提交,会瞬间解除限制放行排队命令
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } });
    expect(api.settingsSet).not.toHaveBeenCalled();

    // blur = 提交点:只落最终值
    fireEvent.blur(screen.getByRole('spinbutton'));
    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledTimes(1);
    });
    expect(api.settingsSet).toHaveBeenCalledWith('maxConcurrentCommands', 20);

    // 非法草稿(负值/小数/越界/空)blur 时作废,回显权威值,不写盘
    for (const bad of ['-1', '3.5', '99', '']) {
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: bad } });
      fireEvent.blur(screen.getByRole('spinbutton'));
    }
    expect(api.settingsSet).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('20');

    // 与当前值相同的提交不产生冗余写
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } });
    fireEvent.blur(screen.getByRole('spinbutton'));
    expect(api.settingsSet).toHaveBeenCalledTimes(1);
  });

  it('persists single-field edits through the settings IPC', async () => {
    const api = installElectronApi(DEFAULT_WIRE);
    render(<AgentResourceSection />);
    await waitFor(() => screen.getByRole('spinbutton'));

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    fireEvent.blur(screen.getByRole('spinbutton')); // 提交制:blur 落盘
    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith('maxConcurrentCommands', 5);
    });

    fireEvent.click(screen.getByText('settings.agentResource.priorityOptions.low'));
    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith('processPriority', 'low');
    });

    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(api.settingsSet).toHaveBeenCalledWith('capToolchainThreads', true);
    });
  });
});
