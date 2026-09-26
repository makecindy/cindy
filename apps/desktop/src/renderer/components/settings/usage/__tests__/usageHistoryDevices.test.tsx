// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageHistoryDevice, UsageHistoryPayload } from '@/hooks/useUsageHistory';
import { UsageHistorySection } from '../UsageHistorySection';
import {
  buildUsageDeviceOptions,
  hasIncompleteUsageDevices,
  hasPeerUsageDevices,
} from '../UsageDeviceSelect';

const state = vi.hoisted(() => ({
  history: null as UsageHistoryPayload | null,
  requests: [] as Array<{ device?: string }>,
  taskRows: [] as unknown[],
  userId: null as string | null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: state.userId ? { id: state.userId } : null }),
}));
vi.mock('@/hooks/useUsageHistory', () => ({
  useUsageHistory: (opts: { device?: string }) => {
    state.requests.push(opts);
    return { history: state.history, refreshing: false };
  },
}));
vi.mock('../UsageTaskTable', () => ({
  useTopTokenSessions: () => state.taskRows,
  UsageTaskTable: () => <output data-testid="tasks" />,
}));
vi.mock('../UsageStatRow', () => ({ UsageStatRow: () => null }));
vi.mock('../UsageBreakdownTables', () => ({
  UsageAgentTable: () => null,
  UsageModelTable: () => null,
}));
afterEach(() => {
  cleanup();
  state.requests = [];
  state.taskRows = [];
  state.userId = null;
});

const money = {
  amount: 0,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};

function device(over: Partial<UsageHistoryDevice> & { deviceId: string }): UsageHistoryDevice {
  return {
    name: over.deviceId,
    platform: 'darwin',
    isSelf: false,
    syncedAt: null,
    status: 'ok',
    ...over,
  };
}

function history(devices?: UsageHistoryDevice[]): UsageHistoryPayload {
  return {
    generatedAt: 0,
    todayKey: '2026-09-26',
    days: [{ day: '2026-09-26', money, tokens: 100 }],
    modelDaily: [],
    models: [],
    totals: {
      today: money,
      last30Days: money,
      last30DaysWithEstimatedValue: money,
      last30DaysEstimatedValue: money,
      todayTokens: 100,
      last30DaysTokens: 100,
    },
    streak: { current: 1, longest: 1 },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
    ...(devices ? { devices } : {}),
  };
}

describe('usage device options', () => {
  it('orders all devices, this device, then other computers by name', () => {
    const options = buildUsageDeviceOptions([
      device({ deviceId: 'z', name: 'Zed', syncedAt: 2 }),
      device({ deviceId: 'self', name: 'Studio', isSelf: true }),
      device({ deviceId: 'a', name: 'Air', syncedAt: 1 }),
      device({ deviceId: 'never', name: 'Never read', status: 'offline' }),
    ]);
    expect(options.map((option) => option.value)).toEqual(['all', 'local', 'a', 'z']);
    expect(options[1].device?.name).toBe('Studio');
  });

  it('flags merged totals as incomplete only for unreadable computers', () => {
    const self = device({ deviceId: 'self', isSelf: true });
    expect(hasPeerUsageDevices([self])).toBe(false);
    expect(hasPeerUsageDevices(undefined)).toBe(false);
    expect(hasIncompleteUsageDevices([self, device({ deviceId: 'b', status: 'syncing' })])).toBe(
      false,
    );
    expect(
      hasIncompleteUsageDevices([self, device({ deviceId: 'b', status: 'offline', syncedAt: 1 })]),
    ).toBe(true);
    // 从未读到的电脑不列出,也不触发「合计可能偏少」。
    const never = device({ deviceId: 'c', status: 'unsupported' });
    expect(hasPeerUsageDevices([self, never])).toBe(false);
    expect(hasIncompleteUsageDevices([self, never])).toBe(false);
  });
});

describe('Usage history device scope', () => {
  it('requests the merged all-devices scope by default and hides the picker without other computers', () => {
    state.history = history([device({ deviceId: 'self', isSelf: true })]);
    const view = render(<UsageHistorySection />);
    expect(state.requests.at(-1)?.device).toBe('all');
    expect(view.queryByLabelText('usageHistory.device.ariaLabel')).toBeNull();
    expect(view.queryByText('usageHistory.device.partial')).toBeNull();
  });

  it('shows the picker, the incomplete note and the local-only task subtitle with other computers', () => {
    state.history = history([
      device({ deviceId: 'self', isSelf: true }),
      device({ deviceId: 'laptop', status: 'offline', syncedAt: 1 }),
    ]);
    state.taskRows = [{}];
    const view = render(<UsageHistorySection />);
    expect(view.getByLabelText('usageHistory.device.ariaLabel')).toBeTruthy();
    expect(view.getByText('usageHistory.device.partial')).toBeTruthy();
    expect(view.getByText('usageHistory.tasks.subtitleLocal')).toBeTruthy();
  });
});

describe('usage device select panel', () => {
  it('binds the dropdown panel to the trigger width (DESIGN.md §4)', () => {
    const source = readFileSync(resolve(__dirname, '../UsageDeviceSelect.tsx'), 'utf8');
    expect(source).toContain('w-[var(--radix-select-trigger-width)]');
    expect(source).not.toContain('min-w-[var(--radix-select-trigger-width)]');
    expect(source).not.toMatch(/max-w-\[\d+px\]/);
  });
});

describe('usage device scope across accounts', () => {
  it('drops the previous account devices and selection when the account changes', () => {
    state.userId = 'account-a';
    state.history = history([
      device({ deviceId: 'self', isSelf: true }),
      device({ deviceId: 'laptop-a', name: 'Laptop A', syncedAt: 1 }),
    ]);
    const view = render(<UsageHistorySection />);
    expect(view.getByLabelText('usageHistory.device.ariaLabel')).toBeTruthy();

    // 新账号的首帧还没有 payload(或回退空 payload 不带 devices)。
    state.userId = 'account-b';
    state.history = null;
    view.rerender(<UsageHistorySection />);
    expect(state.requests.at(-1)?.device).toBe('all');
    expect(view.queryByLabelText('usageHistory.device.ariaLabel')).toBeNull();
    expect(view.queryByText('Laptop A')).toBeNull();
  });
});

describe('usage device first-load hint', () => {
  it('shows a quiet loading line during the first device sync only', () => {
    state.history = {
      ...history([device({ deviceId: 'self', isSelf: true })]),
      devicesSyncing: true,
    };
    const view = render(<UsageHistorySection />);
    expect(view.getByText('usageHistory.device.loading')).toBeTruthy();

    state.history = {
      ...history([
        device({ deviceId: 'self', isSelf: true }),
        device({ deviceId: 'b', syncedAt: 1 }),
      ]),
      devicesSyncing: false,
    };
    view.rerender(<UsageHistorySection />);
    expect(view.queryByText('usageHistory.device.loading')).toBeNull();

    // 之后每分钟的后台同步不再提示。
    state.history = { ...state.history, devicesSyncing: true };
    view.rerender(<UsageHistorySection />);
    expect(view.queryByText('usageHistory.device.loading')).toBeNull();
  });
});
