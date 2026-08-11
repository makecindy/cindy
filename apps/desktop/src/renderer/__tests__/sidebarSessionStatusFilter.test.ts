import { describe, expect, it } from 'vitest';

import { matchesSidebarSessionStatus } from '@/features/cc-agent/lib/sidebarSessionStatusFilter';
import type { SessionStatus } from '@/lib/ccAgent.types';

function row(status: SessionStatus, remote = false) {
  return {
    status,
    ...(remote ? { deviceLinkDeviceId: 'device-a' } : {}),
  };
}

describe('matchesSidebarSessionStatus', () => {
  it('远程行始终按用户选择筛选，不受本地旧桶或失败请求影响', () => {
    expect(matchesSidebarSessionStatus(row('archived', true), 'archived', 'active')).toBe(true);
    expect(matchesSidebarSessionStatus(row('active', true), 'archived', 'active')).toBe(false);
    expect(matchesSidebarSessionStatus(row('active', true), 'all', 'archived')).toBe(true);
    expect(matchesSidebarSessionStatus(row('archived', true), 'all', 'active')).toBe(true);
  });

  it('本地行继续跟随实际已落地的桶，all 桶才按用户选择收窄', () => {
    expect(matchesSidebarSessionStatus(row('active'), 'archived', 'active')).toBe(true);
    expect(matchesSidebarSessionStatus(row('archived'), 'archived', 'active')).toBe(false);
    expect(matchesSidebarSessionStatus(row('active'), 'archived', 'all')).toBe(false);
    expect(matchesSidebarSessionStatus(row('archived'), 'archived', 'all')).toBe(true);
  });
});
