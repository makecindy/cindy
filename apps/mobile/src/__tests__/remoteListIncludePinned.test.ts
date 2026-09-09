import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile remote session bootstrap', () => {
  it('asks the controlled desktop to include active pinned sessions outside the recent window', () => {
    const homeSource = readFileSync(resolve(process.cwd(), 'app/devices/index.tsx'), 'utf8');
    const detailSource = readFileSync(resolve(process.cwd(), 'app/devices/[deviceId].tsx'), 'utf8');
    const listWithPinned =
      /local-db:sessions:list'[\s\S]{0,280}\{ includePinned: true, fresh: true \}/;

    expect(homeSource).toMatch(listWithPinned);
    expect(detailSource).toMatch(listWithPinned);
  });

  it('forces detail schedule-index refreshes for schedule-list and unread-clear events', () => {
    const detailSource = readFileSync(resolve(process.cwd(), 'app/devices/[deviceId].tsx'), 'utf8');

    expect(detailSource).toContain('scheduleEventSnapshot.scheduleListVersion === 0');
    expect(detailSource).toContain('scheduleEventSnapshot.unreadClearVersion === 0');
    expect(detailSource).toContain('{ force: true }');
    expect(detailSource).toContain('scheduleEventSnapshot.scheduleListVersion,');
    expect(detailSource).toContain('scheduleEventSnapshot.unreadClearVersion,');
  });
});
