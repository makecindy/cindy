import { describe, expect, it, vi } from 'vitest';

import { refreshGhostLocalizationIfChanged } from '../ghostLocalizationRefresh';

const GHOSTS = ['plugin-a', 'plugin-b'];

function setup() {
  const broadcastChanged = vi.fn();
  const sendContextChanged = vi.fn();
  const refresh = (previousLocale: 'zh-CN' | 'en' | 'zh-TW' | 'ja', currentLocale: 'zh-CN' | 'en' | 'zh-TW' | 'ja') =>
    refreshGhostLocalizationIfChanged({
      region: 'global',
      previousLocale,
      currentLocale,
      list: () => GHOSTS,
      broadcastChanged,
      sendContextChanged,
    });
  return { refresh, broadcastChanged, sendContextChanged };
}

describe('refreshGhostLocalizationIfChanged', () => {
  it('stays silent when the plugin-visible app-context is unchanged (same locale, or startup locale re-sent)', () => {
    const { refresh, broadcastChanged, sendContextChanged } = setup();
    refresh('zh-CN', 'zh-CN');
    refresh('en', 'en');
    expect(broadcastChanged).not.toHaveBeenCalled();
    expect(sendContextChanged).not.toHaveBeenCalled();
  });

  it('notifies each plugin once with the new context, then stays silent on a repeat', () => {
    const { refresh, broadcastChanged, sendContextChanged } = setup();
    refresh('zh-CN', 'en');
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
    expect(sendContextChanged).toHaveBeenCalledTimes(2);
    expect(sendContextChanged).toHaveBeenCalledWith('plugin-a', {
      type: 'host-context-changed',
      ok: true,
      context: { region: 'global', locale: 'en', uiLocale: 'en' },
    });
    expect(sendContextChanged).toHaveBeenCalledWith('plugin-b', expect.objectContaining({ type: 'host-context-changed' }));

    refresh('en', 'en');
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
    expect(sendContextChanged).toHaveBeenCalledTimes(2);
  });

  it('still notifies when the protocol locale stays en but uiLocale changes', () => {
    const { refresh, sendContextChanged } = setup();
    refresh('en', 'zh-TW');
    expect(sendContextChanged).toHaveBeenCalledTimes(2);
    expect(sendContextChanged).toHaveBeenCalledWith('plugin-a', expect.objectContaining({
      context: { region: 'global', locale: 'en', uiLocale: 'zh-TW' },
    }));
  });
});
