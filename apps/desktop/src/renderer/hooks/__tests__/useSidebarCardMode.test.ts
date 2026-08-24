import { describe, expect, it } from 'vitest';

import { shouldNotifyMainOnPinnedModeMount } from '../useSidebarCardMode';

describe('shouldNotifyMainOnPinnedModeMount', () => {
  it('本 renderer 首次挂载才通知 main', () => {
    expect(shouldNotifyMainOnPinnedModeMount(false)).toBe(true);
  });

  it('重挂载不再通知,避免失败的 setItem 旧值盖回 main', () => {
    expect(shouldNotifyMainOnPinnedModeMount(true)).toBe(false);
  });
});
