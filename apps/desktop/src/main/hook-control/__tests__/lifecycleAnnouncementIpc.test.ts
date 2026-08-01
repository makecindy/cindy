import { describe, expect, it, vi } from 'vitest';

import type { SlackHookView } from '../../../shared/hookControlIpc.js';
import { setLifecycleAnnouncementFromIpc } from '../lifecycleAnnouncementIpc.js';

const HOOK_VIEW = {
  lifecycleAnnouncement: false,
} as SlackHookView;

describe('setLifecycleAnnouncementFromIpc', () => {
  it('returns the updated hook snapshot after persistence succeeds', () => {
    const manager = {
      setLifecycleAnnouncement: vi.fn(),
      snapshot: vi.fn(() => HOOK_VIEW),
    };
    const log = { warn: vi.fn() };

    expect(setLifecycleAnnouncementFromIpc(manager, true, log)).toEqual({ hook: HOOK_VIEW });
    expect(manager.setLifecycleAnnouncement).toHaveBeenCalledWith(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs filesystem details only in Main and returns a sanitized IPC error', () => {
    const privatePath = '/Users/private/Library/Application Support/Cindy/slack-hook.json';
    const failure = new Error(`EROFS: read-only file system, rename '${privatePath}.tmp'`);
    const manager = {
      setLifecycleAnnouncement: vi.fn(() => {
        throw failure;
      }),
      snapshot: vi.fn(() => HOOK_VIEW),
    };
    const log = { warn: vi.fn() };

    expect(() => setLifecycleAnnouncementFromIpc(manager, false, log)).toThrow(
      '[INTERNAL] failed to persist Slack lifecycle notification preference',
    );
    try {
      setLifecycleAnnouncementFromIpc(manager, false, log);
    } catch (err) {
      expect(String(err)).not.toContain(privatePath);
    }
    expect(log.warn).toHaveBeenCalledWith(
      'failed to persist Slack lifecycle notification preference',
      failure,
    );
  });
});
