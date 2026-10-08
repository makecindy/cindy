// @vitest-environment jsdom
/**
 * Agent 在另一台电脑运行(任务在本机)的标识:Agent 图标右上角加模型选择器同款的单波纹 + 点,
 * 替代标题后的芯片图标(2026-10-07 用户裁决)。
 *
 * 锁四件事:波纹不改 Agent 图标本身的大小;只有本机任务 + agentDeviceId 才画;右上角正显示
 * 状态点时由状态点占位;悬停说明在哪台电脑、是否离线。
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const devices = vi.hoisted(() => ({
  list: [{ deviceId: 'device-b', name: 'Studio Mac', online: true }] as Array<{
    deviceId: string;
    name: string;
    online: boolean;
  }>,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: { device?: string }) => (opts?.device ? `${key}:${opts.device}` : key),
  }),
}));
vi.mock('@/hooks/useComposerDraftPresence', () => ({ useComposerDraftPresence: () => false }));
vi.mock('@/hooks/useSessionPausedQueue', () => ({ useSessionPausedQueue: () => false }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => devices.list,
}));

import { RemoteSourceMark } from '@/components/icons/RemoteSourceMark';
import { VendorIcon } from '@/components/sidebar/VendorIcon';
import { SessionStatusIcon } from '@/features/cc-agent/sidebar/SessionStatusIcon';

const SIGNAL_ARC = 'M12 1.4A2.6 2.6 0 0 1 14.6 4';

function signal(container: HTMLElement): Element | null {
  return container.querySelector(`path[d="${SIGNAL_ARC}"]`);
}

function attentionDot(container: HTMLElement): Element | undefined {
  return Array.from(container.querySelectorAll('span')).find((node) =>
    (node.getAttribute('class') ?? '').includes('bg-[var(--card-status-'),
  );
}

function renderStatus(
  session: Partial<Session>,
  props: { hasAttentionNotification?: boolean; showAttentionDot?: boolean } = {},
) {
  return render(
    <SessionStatusIcon
      session={{ id: 's1', agentKind: 'cc', status: 'active', ...session } as Session}
      isRunning={false}
      isAttached={false}
      hasAttentionNotification={props.hasAttentionNotification ?? false}
      isActive={false}
      showAttentionDot={props.showAttentionDot}
    />,
  );
}

afterEach(() => {
  cleanup();
  devices.list = [{ deviceId: 'device-b', name: 'Studio Mac', online: true }];
});

describe('VendorIcon remote signal', () => {
  it('adds the signal outside the glyph without resizing the Agent glyph', () => {
    const local = render(<VendorIcon vendor="cc" size={13} />);
    expect(signal(local.container)).toBeNull();
    cleanup();

    const { container } = render(<VendorIcon vendor="cc" size={13} remote />);
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute('width')).toBe('13');
    expect(signal(container)).not.toBeNull();
    // 波纹绝对定位、跟随图标取色(currentColor),不占布局。
    expect(svgs[1].getAttribute('class')).toContain('absolute');
    expect(svgs[1].getAttribute('stroke')).toBe('currentColor');
  });

  it('runs the signal through the same running color and breathing as the glyph', () => {
    const { container } = render(<VendorIcon vendor="codex" size={12} remote running />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('text-[var(--warning-accent)]');
    expect(wrapper.className).toContain('session-status-breathing');
    expect(wrapper.contains(signal(container))).toBe(true);
  });
});

describe('RemoteSourceMark', () => {
  // 2026-10-08 用户裁决:远程供应商 Logo 与远程 Agent 图标同一种做法 —— 早先把品牌缩进方框
  // 左下的做法让模型选择器里的 Logo 比文字低。
  it('keeps the provider logo at its own size and spot, with the signal outside its top-right', () => {
    const { container } = render(
      <RemoteSourceMark>
        <svg data-brand width={13} height={13} />
      </RemoteSourceMark>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const brand = container.querySelector('[data-brand]') as SVGElement;
    // 品牌直接放在外层里:没有缩放 / 定位层，外层也不定宽高(大小跟着品牌走)。
    expect(brand.parentElement).toBe(wrapper);
    expect(wrapper.style.width).toBe('');
    expect(wrapper.style.height).toBe('');
    expect(wrapper.querySelector('[style*="scale"]')).toBeNull();

    const arc = signal(container)?.closest('svg') as SVGElement;
    expect(arc.getAttribute('class')).toContain('absolute');
    // 波纹按 13px 品牌的比例画在右上角外侧(16 单位画布里品牌区外的 3.5 单位带)。
    expect(parseFloat(arc.style.right)).toBeCloseTo(-3.64, 2);
    expect(parseFloat(arc.style.top)).toBeCloseTo(-3.64, 2);
  });
});

describe('SessionStatusIcon for an Agent on another computer', () => {
  it('marks the Agent icon and names the computer on hover', () => {
    const { container, getByTitle } = renderStatus({ agentDeviceId: 'device-b' });
    expect(signal(container)).not.toBeNull();
    expect(getByTitle('ccAgent.sessionHeader.agentDevice:Studio Mac')).toBeTruthy();
  });

  it('says when that computer is offline', () => {
    devices.list = [{ deviceId: 'device-b', name: 'Studio Mac', online: false }];
    const { getByTitle } = renderStatus({ agentDeviceId: 'device-b' });
    expect(getByTitle('ccAgent.sessionHeader.agentDeviceOffline:Studio Mac')).toBeTruthy();
  });

  it('leaves local, device-link and SSH tasks unmarked', () => {
    expect(signal(renderStatus({}).container)).toBeNull();
    cleanup();
    expect(
      signal(renderStatus({ agentDeviceId: 'device-b', deviceLinkDeviceId: 'device-c' }).container),
    ).toBeNull();
    cleanup();
    expect(
      signal(renderStatus({ agentDeviceId: 'device-b', remoteHostId: 'host-1' }).container),
    ).toBeNull();
  });

  it('gives the top-right corner to the attention dot while one is shown', () => {
    const withDot = renderStatus({ agentDeviceId: 'device-b' }, { hasAttentionNotification: true });
    expect(attentionDot(withDot.container)).toBeDefined();
    expect(signal(withDot.container)).toBeNull();
    cleanup();

    // 侧栏行不在左侧画状态点(右侧状态槽承担),波纹照常显示。
    const row = renderStatus(
      { agentDeviceId: 'device-b' },
      { hasAttentionNotification: true, showAttentionDot: false },
    );
    expect(attentionDot(row.container)).toBeUndefined();
    expect(signal(row.container)).not.toBeNull();
  });
});
