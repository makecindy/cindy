// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key === 'ccAgent.remoteSession.proxyHint'
        ? `本机可能经 Proxy 出站：${options?.proxy ?? ''}`
        : key,
  }),
}));

import { RemoteSessionBanner } from '@/features/cc-agent/RemoteSessionBanner';

const PROXY = 'http://proxy.example.com:8080';

function renderBanner(overrides: Partial<ComponentProps<typeof RemoteSessionBanner>> = {}) {
  return render(
    <RemoteSessionBanner
      status="degraded"
      proxyVerdict={{ kind: 'proxy', proxy: PROXY }}
      onResync={() => {}}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

describe('degraded 横幅的出站路径提示', () => {
  // 测试价值
  // - 生产入口与可观察结果:RemoteSessionBanner（控制端会话视图顶部的状态条）在 degraded 态
  //   拿到确证 kind='proxy' 的判定时，渲染出带脱敏代理地址的排查提示；深浅两色各渲染一次，
  //   两种模式都出提示、且提示颜色走语义 token（不硬编码任何一模式）。
  // - Bug/规则依据:维护者确认 issue #9982 的行动项 —— 「通过组件 fixture 补齐
  //   RemoteSessionBanner 在 degraded 态下的深浅双色核对，确认脱敏代理地址在小尺寸或长地址
  //   场景下的折行与视觉层级符合规范」。这里把可自动化的部分落成断言：两模式都渲染、
  //   颜色走 token、长地址走截断而不是撑破布局。
  // - 现有覆盖缺口:本 PR 的测试只覆盖主进程探针（outboundProxyResolver）、IPC 与连接状态
  //   判定（remoteConnectionStatus），没有任何组件级用例 —— 提示文案与脱敏地址的展示链路
  //   只在真实客户端里才看得见。
  // - 最小失败输入:degraded + proxyVerdict{kind:'proxy', proxy:'http://proxy.example.com:8080'}。
  // - tier:unit(jsdom + react-i18next mock)。
  it('renders the proxy hint in both light and dark mode with a token-based colour', () => {
    const light = renderBanner();
    const hint = screen.getByText(/proxy\.example\.com:8080/);
    expect(hint).not.toBeNull();
    // 颜色走语义 token —— 深浅两色由 token 各自取色，不存在只适配一种模式的硬编码。
    expect(hint.getAttribute('class')).toContain('var(--text-tertiary)');
    cleanup();

    document.documentElement.classList.add('dark');
    renderBanner();
    const darkHint = screen.getByText(/proxy\.example\.com:8080/);
    expect(darkHint).not.toBeNull();
    expect(darkHint.getAttribute('class')).toContain('var(--text-tertiary)');
  });

  // 长地址 / 小尺寸场景:提示是 strip 上的次要信息,必须截断而不是把状态文案挤出可视区。
  it('truncates a long proxy address instead of pushing the status label out of view', () => {
    const long = 'http://proxy.internal.example.com:3128/some/long/path/segment?token=abcdefghijklmnop';
    renderBanner({ proxyVerdict: { kind: 'proxy', proxy: long } });
    const hint = screen.getByText(/proxy\.internal\.example\.com:3128/);
    expect(hint.getAttribute('class')).toContain('truncate');
    expect(hint.getAttribute('class')).toContain('shrink-0');
    // 完整地址保留在 title 上，小尺寸下悬停仍可读到。
    expect(hint.getAttribute('title')).toContain('proxy.internal.example.com:3128');
  });

  // 诊断只陈述已核实的事实：未确证（unknown / direct / 探测失败）不展示任何代理提示。
  it.each(['unknown', 'direct', 'unsupported'] as const)(
    'shows no proxy hint for kind=%s',
    (kind) => {
      renderBanner({ proxyVerdict: { kind, proxy: null } });
      expect(screen.queryByText(/Proxy 出站/)).toBeNull();
    },
  );

  // 非 degraded 态不展示：reconnecting / host-offline 的提示语与代理诊断无关。
  it('shows no proxy hint outside the degraded state', () => {
    renderBanner({ status: 'reconnecting', proxyVerdict: { kind: 'proxy', proxy: PROXY } });
    expect(screen.queryByText(/Proxy 出站/)).toBeNull();
  });
});
