// @vitest-environment jsdom

/**
 * User-approved correction (2026-11-07): a selection is not execution progress.
 * Production GhostSummonCard preserves directive identity/details, while the
 * whole-turn fulfillment/animation contract is retired. Minimal failing input:
 * an explicit command rendered during an assistant turn previously said running.
 * Unit tier; full MessageStream transitions are exercised by plugin-call-display
 * in the real renderer fixture, rather than importing its entire graph here.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { GhostSummonCard } from '@/components/chat/GhostSummonCard';
import { expandCollapsedMessages, stripMessageSources } from '@/lib/shareConversationImage';
import { type GhostDirectiveDisplay } from '@/cindy-brain/ghostCommand';
import type { HostCapabilityDirectiveDisplay } from '@/cindy-brain/hostCapabilityInvocation';
import type { InstalledGhost } from '../../shared/ghost';

const { installedGhostsMock } = vi.hoisted(() => ({
  installedGhostsMock: vi.fn(() => [] as InstalledGhost[]),
}));

vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => installedGhostsMock(),
}));

const commandDirective: GhostDirectiveDisplay = {
  kind: 'command',
  command: 'xd-feishu',
  name: 'XD Feishu',
  ghostId: 'xd-feishu',
  raw: '[插件指令] 用户显式点名插件 XD Feishu(id: xd-feishu)',
};

const mentionDirective: GhostDirectiveDisplay = {
  kind: 'mention',
  ghosts: [{ name: 'XD Feishu', ghostId: 'xd-feishu' }],
  raw: '[插件提示] 消息提及了插件 XD Feishu(id: xd-feishu)',
};

const hostCapabilityDirective: HostCapabilityDirectiveDisplay = {
  kind: 'host-capability',
  capability: 'ios-simulator',
  route: 'cindy_ios_simulator',
  name: 'iOS 模拟器',
  ghostId: 'ios-simulator',
  raw: '[Cindy Host 能力] iOS 模拟器',
};

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});
afterEach(() => {
  cleanup();
  installedGhostsMock.mockReturnValue([]);
});

function installed(namespace: string | null, iconDataUrl: string): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'xd-feishu',
      name: 'Installed name',
      version: 'v2.0.0',
      kind: 'chip',
      entry: 'main.js',
      command: 'xd-feishu',
    },
    namespace,
    dir: namespace === null ? '/fixture/_root/xd-feishu' : '/fixture/_ns/acme/xd-feishu',
    enabled: true,
    iconDataUrl,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  } as InstalledGhost;
}

describe('GhostSummonCard selection annotation', () => {
  it.each([commandDirective, hostCapabilityDirective])(
    'shows the selected route without claiming execution ($kind)',
    (directive) => {
      const { rerender } = render(<GhostSummonCard directive={directive} />);
      expect(screen.getByText('已选择')).toBeTruthy();
      expect(screen.queryByText('已调用')).toBeNull();
      // Remount/history retains selection rather than inventing completion.
      rerender(<GhostSummonCard key="history" directive={directive} />);
      expect(screen.getByText('已选择')).toBeTruthy();
    },
  );

  // Preserve namespace/legacy identity coverage after removing call attribution.
  it.each([
    {
      label: 'explicit root',
      namespace: null,
      suffix: undefined,
      id: 'xd-feishu',
      icon: 'root-icon',
    },
    {
      label: 'explicit org',
      namespace: 'acme',
      suffix: undefined,
      id: 'xd-feishu',
      icon: 'org-icon',
    },
    {
      label: 'legacy root suffix',
      namespace: undefined,
      suffix: '@root',
      id: 'xd-feishu',
      icon: 'root-icon',
    },
    {
      label: 'legacy org suffix',
      namespace: undefined,
      suffix: 'acme',
      id: 'xd-feishu',
      icon: 'org-icon',
    },
    {
      label: 'encoded org',
      namespace: undefined,
      suffix: undefined,
      id: '_ns__acme__xd-feishu',
      icon: 'org-icon',
    },
    {
      label: 'encoded root',
      namespace: undefined,
      suffix: undefined,
      id: '_root__xd-feishu',
      icon: 'root-icon',
    },
    {
      label: 'ambiguous bare history',
      namespace: undefined,
      suffix: undefined,
      id: 'xd-feishu',
      icon: null,
    },
  ])('keeps saved name and correct live identity: $label', ({ namespace, suffix, id, icon }) => {
    installedGhostsMock.mockReturnValue([
      installed(null, 'root-icon'),
      installed('acme', 'org-icon'),
    ]);
    const { container } = render(
      <GhostSummonCard
        directive={{ ...commandDirective, ghostId: id, namespace }}
        commandNamespace={suffix}
      />,
    );
    expect(screen.getByText('XD Feishu')).toBeTruthy();
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(
      icon ? [icon] : [],
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(Boolean(screen.queryByText('v2.0.0'))).toBe(Boolean(icon));
    expect(screen.queryByText('Installed name')).toBeNull();
  });

  it('keeps transparency: expanding reveals the $command badge and directive text', () => {
    render(<GhostSummonCard directive={commandDirective} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // $指令 徽章 + 指令原文里的注入值,至少各出现一次。
    expect(screen.getAllByText('$xd-feishu').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('追加给模型的指令')).toBeTruthy();
  });

  it('keeps historical mentions distinct from explicit selections', () => {
    render(<GhostSummonCard directive={mentionDirective} />);
    expect(screen.getByText(/提及插件/)).toBeTruthy();
    expect(screen.queryByText('已选择')).toBeNull();
  });

  it('leaves no empty annotation row or divider in share images', () => {
    const { container } = render(
      <div>
        <GhostSummonCard
          directive={commandDirective}
          className="mb-2.5 border-b pb-2.5"
        />
        <GhostSummonCard directive={mentionDirective} />
        <p>正文</p>
      </div>,
    );
    const clone = container.cloneNode(true) as HTMLElement;
    stripMessageSources(clone);
    expandCollapsedMessages(clone);
    expect(clone.textContent).toBe('正文');
    expect(clone.querySelector('.border-b')).toBeNull();
  });
});
