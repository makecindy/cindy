// @vitest-environment jsdom

/**
 * 「协同」右栏 tab 的详情面板。
 *
 * 这一组盯的是一个具体的不一致:**同一份委派产物,在对话的协作卡里是能点开的
 * 作品卡,在这个详情面板里却是一行 `cindy-media://blobs/<指纹>.png` 死文本。**
 * 用户看到的是同一件东西的两副面孔,其中一副还是乱码。
 *
 * 面板改成复用同一张作品卡之后,这里钉住的就是「它用的是卡,不是裸地址」。
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotArtifactItem } from '../../../../shared/botArtifact';
import type { BotDelegationView } from '../../../../shared/botDelegation';

const mocks = vi.hoisted(() => ({ openArtifact: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/features/bots/useBotArtifactOpen', () => ({
  useBotArtifactOpen: () => ({ openArtifact: mocks.openArtifact, artifactLightboxes: null }),
}));
/*
  作品卡本体在别处有自己的测试;这里只关心「面板到底用没用它」,所以打一个只回显
  引用地址的桩件 —— 断言看的是有没有这张卡,而不是卡长什么样。
*/
vi.mock('@/features/bots/BotArtifactCard', () => ({
  BotArtifactCard: ({ item }: { item: BotArtifactItem }) => (
    <div data-testid="bot-artifact-card" data-ref={item.ref ?? ''} />
  ),
}));

import { BotDelegationsBody } from '../plugins/bot-delegations/BotDelegationsBody';
import type { TabKindHostContext } from '../types';

const ROW: BotDelegationView = {
  id: 'del-1',
  requestingBotId: 'bot-a',
  targetBotId: 'bot-b',
  targetBotName: '小柴',
  parentSessionId: 'session-1',
  childSessionId: 'session-2',
  objective: '把这周的数据做成一页图',
  status: 'completed',
  depth: 1,
  tokensUsed: 1200,
  budgetTokens: 40000,
  createdAt: 1_000,
  updatedAt: 5_000,
  completedAt: 5_000,
  resultSummary: '做好了',
  outputArtifacts: [{ kind: 'image', ref: 'cindy-media://blobs/chart.png' }],
} as unknown as BotDelegationView;

function ctx(overrides: Partial<TabKindHostContext> = {}): TabKindHostContext {
  return {
    tabId: 'tab-1',
    sessionId: 'session-1',
    workdir: '/w',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.openArtifact.mockClear();
  (globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
    maker: {
      listBotDelegations: vi.fn(async () => ({ ok: true, delegations: [ROW] })),
      onBotDelegationChanged: vi.fn(() => () => {}),
      botDeliveries: { onChanged: vi.fn(() => () => {}) },
    },
  };
});

afterEach(cleanup);

describe('委派详情里的产物', () => {
  it('用作品卡呈现,不把协议地址当死文本摆出来', async () => {
    render(
      <BotDelegationsBody state={{ selectedDelegationId: 'del-1' }} ctx={ctx()} />,
    );
    await waitFor(() => expect(screen.getByTestId('bot-artifact-card')).toBeTruthy());
    expect(screen.getByTestId('bot-artifact-card').getAttribute('data-ref')).toBe(
      'cindy-media://blobs/chart.png',
    );
    // 裸地址不再作为正文出现在面板里。
    expect(screen.queryByText('cindy-media://blobs/chart.png')).toBeNull();
  });
});
