import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { RemoteSessionListItem, RemoteSessionScheduleInfo } from '@cindy/maker-shared/session-list';
import { automationGroupPreview } from '../session/automationGroupPreview';

const NOW = Date.UTC(2026, 9, 5, 9, 52);
const t = ((key: string, options?: { count?: number }) =>
  options?.count === undefined ? key : `${key}(${options.count})`) as unknown as TFunction;

function group(info: Partial<RemoteSessionScheduleInfo> | null, pendingInteractionCount = 0): RemoteSessionListItem {
  return {
    pendingInteractionCount,
    scheduleInfo: info
      ? {
          scheduleId: 'sched-1',
          scheduleName: 'Daily',
          scheduleStatus: 'active',
          unreadRunIds: [],
          unreadCount: 0,
          running: false,
          latestRunAt: NOW - 60_000,
          ...info,
        }
      : undefined,
  } as RemoteSessionListItem;
}

describe('automationGroupPreview', () => {
  it('keeps attention, waiting and running ahead of the countdown', () => {
    const nextFireAt = NOW + 5 * 60_000;
    expect(automationGroupPreview(group({ unreadCount: 2, nextFireAt }, 1), 12, t, NOW))
      .toBe('devices.list.preview.needAttention(2) · devices.list.preview.waiting(1)');
    expect(automationGroupPreview(group({ running: true, nextFireAt }), 12, t, NOW))
      .toBe('devices.list.preview.automationRunning');
  });

  it('shows the next run with the desktop floor rounding', () => {
    const at = (ms: number) => automationGroupPreview(group({ nextFireAt: NOW + ms }), 12, t, NOW);
    expect(at(5 * 60_000 + 59_000)).toBe('devices.list.preview.nextRunMinutes(5) · devices.list.preview.runCount(12)');
    expect(at(3 * 3_600_000 + 59 * 60_000)).toBe('devices.list.preview.nextRunHours(3) · devices.list.preview.runCount(12)');
    expect(at(3 * 86_400_000 + 1)).toBe('devices.list.preview.nextRunDays(3) · devices.list.preview.runCount(12)');
  });

  it('says the run is imminent within a minute or once the host time has passed', () => {
    expect(automationGroupPreview(group({ nextFireAt: NOW + 30_000 }), 3, t, NOW))
      .toBe('devices.list.preview.imminent · devices.list.preview.runCount(3)');
    expect(automationGroupPreview(group({ nextFireAt: NOW - 30_000 }), 3, t, NOW))
      .toBe('devices.list.preview.imminent · devices.list.preview.runCount(3)');
  });

  it('marks stopped groups with the same rule as the paused timer badge', () => {
    expect(automationGroupPreview(group({ scheduleStatus: 'paused', allSchedulesStopped: true, nextFireAt: NOW + 60_000 }), 23, t, NOW))
      .toBe('devices.list.preview.stopped · devices.list.preview.runCount(23)');
  });

  it('falls back to the run count for manual tasks, unknown times and older hosts', () => {
    expect(automationGroupPreview(group({}), 3, t, NOW)).toBe('devices.list.preview.totalRuns(3)');
    expect(automationGroupPreview(group(null), 3, t, NOW)).toBe('devices.list.preview.totalRuns(3)');
  });
});
