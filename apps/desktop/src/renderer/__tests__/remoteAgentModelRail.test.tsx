// @vitest-environment jsdom
/**
 * 远程 Agent 从模型选择器左侧栏选择(2026-10-06 用户裁决:不再走设备菜单)。
 *
 * 锁三件事:远程供应商格与本机格互不串(同名供应商在本机与两台电脑上是三格);远程格用
 * 带信号波纹的 Logo、按「供应商 · 电脑」命名、每台电脑一段;列表筛选把远程格当作按供应商筛。
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView, UnifiedModelEntry } from '@cindy/model-providers';

vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: vi.fn() }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({ useClaudeSubscriptionUsage: vi.fn() }));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({ useXaiSubscriptionUsage: vi.fn() }));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: vi.fn(),
  useRemoteXaiSubscriptionUsage: vi.fn(),
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { UnifiedModelRail } from '@/components/new-chat/UnifiedModelRail';
import {
  buildUnifiedListSections,
  railItemKey,
  railProviderFilterId,
  remoteAgentProviders,
  type UnifiedRailItem,
} from '@/components/new-chat/unifiedModelSelection';

const provider = (id: string, name = id): ProviderView => ({
  id,
  name,
  source: 'builtin',
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'test' },
  connected: true,
  agents: [],
  routing: {},
  models: {},
});

function entryOf(providerId: string, modelId: string): UnifiedModelEntry {
  return {
    providerId,
    modelId,
    displayName: modelId,
    candidates: ['claude-code'],
    recommended: 'claude-code',
    nativeAgent: 'claude-code',
    capabilities: {
      'claude-code': {
        agent: 'claude-code',
        wireModelId: modelId,
        efforts: ['high'],
        defaultEffort: 'high',
        defaultEffortSource: 'catalog',
        supportsFastMode: false,
        contextWindow: 200_000,
        contextWindowVerified: false,
      },
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('providers another computer allows for remote use', () => {
  it('lists only providers that computer opened; missing flags count as closed', () => {
    const views = [
      { ...provider('shared'), remoteInvocationEnabled: true },
      { ...provider('private'), remoteInvocationEnabled: false },
      provider('legacy'),
    ];
    expect(remoteAgentProviders(views).map((view) => view.id)).toEqual(['shared']);
  });
});

describe('remote provider rail items', () => {
  it('keeps the same provider on this computer and on two others as distinct cells', () => {
    const keys = [
      railItemKey({ kind: 'provider', providerId: 'anthropic' }),
      railItemKey({ kind: 'remote-provider', deviceId: 'office', providerId: 'anthropic' }),
      railItemKey({ kind: 'remote-provider', deviceId: 'studio', providerId: 'anthropic' }),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(
      railProviderFilterId({ kind: 'remote-provider', deviceId: 'office', providerId: 'openai' }),
    ).toBe('openai');
    expect(railProviderFilterId({ kind: 'all' })).toBeNull();
  });

  it('filters the list by provider when a remote provider cell is active', () => {
    const sections = buildUnifiedListSections({
      entries: [entryOf('anthropic', 'claude-opus-5'), entryOf('openai', 'gpt-5.5')],
      favorites: [],
      query: '',
      rail: { kind: 'remote-provider', deviceId: 'office', providerId: 'openai' },
    });
    expect(sections.map((section) => section.group)).toEqual([
      { type: 'provider', providerId: 'openai' },
    ]);
  });

  it('renders remote cells with the remote mark, one segment per computer', () => {
    const items: UnifiedRailItem[] = [
      { kind: 'favorites' },
      { kind: 'all' },
      { kind: 'provider', providerId: 'anthropic' },
      { kind: 'remote-provider', deviceId: 'office', providerId: 'anthropic' },
      { kind: 'remote-provider', deviceId: 'office', providerId: 'openai' },
      { kind: 'remote-provider', deviceId: 'studio', providerId: 'anthropic' },
    ];
    const onSelect = vi.fn();
    const devices: Record<string, string> = { office: 'Office Mac', studio: 'Studio PC' };
    const { container } = render(
      <UnifiedModelRail
        items={items}
        active={{ kind: 'remote-provider', deviceId: 'office', providerId: 'openai' }}
        onSelect={onSelect}
        // 正在浏览 office 的目录:本机格不能拿这份当自己的名字 / 图标。
        providers={[provider('anthropic', 'Office catalog')]}
        providerLabel={(id) => `current ${id}`}
        remoteSources={{
          localProviders: [provider('anthropic', 'Anthropic')],
          localProviderLabel: (id) => `local ${id}`,
          providersOf: () => [provider('anthropic'), provider('openai')],
          labelOf: (deviceId, providerId) => `${providerId} · ${devices[deviceId]}`,
        }}
      />,
    );

    const local = screen.getByRole('button', { name: 'local anthropic' });
    expect(local.querySelector('[data-remote-source-mark]')).toBeNull();
    const remote = screen.getByRole('button', { name: 'openai · Office Mac' });
    expect(remote.querySelector('[data-remote-source-mark]')).not.toBeNull();
    expect(remote.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'anthropic · Studio PC' })).toBeTruthy();
    // 分隔线:全部之前一条 + 每台电脑的段首各一条。
    expect(container.querySelectorAll('div[aria-hidden].border-t').length).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'anthropic · Studio PC' }));
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'remote-provider',
      deviceId: 'studio',
      providerId: 'anthropic',
    });
  });
});
