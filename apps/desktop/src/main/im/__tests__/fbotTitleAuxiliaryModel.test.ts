import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generatedTitle: null as string | null,
}));

vi.mock('../../maker-host/session-storage.js', () => ({
  desktopSessionStorage: { update: vi.fn() },
}));

vi.mock('../../maker-ipc/title.js', () => ({
  generateMakerSessionTitle: vi.fn(async () => h.generatedTitle),
}));

vi.mock('../shared/sessionBroadcast.js', () => ({
  broadcastSessionPatched: vi.fn(),
}));

import { generateMakerSessionTitle } from '../../maker-ipc/title.js';
import { generateImSessionTitleText } from '../shared/fbotTitle.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.generatedTitle = null;
});

describe('IM task title auxiliary model boundary', () => {
  it('delegates title generation to generateMakerSessionTitle', async () => {
    h.generatedTitle = '飞书会话标题';

    await expect(generateImSessionTitleText('task-1', '第一条消息')).resolves.toBe(
      '飞书会话标题',
    );
    expect(generateMakerSessionTitle).toHaveBeenCalledWith(
      '第一条消息',
      'claude-code',
      'task-1',
    );
  });

  it('returns null when generateMakerSessionTitle has no title', async () => {
    h.generatedTitle = null;

    await expect(generateImSessionTitleText('task-1', '第一条消息')).resolves.toBeNull();
  });
});
