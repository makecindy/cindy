// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openTerminalExternalLink } from '../xtermPool';

describe('openTerminalExternalLink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes detected URLs through the host external-link bridge', () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openExternal },
    });

    const event = new MouseEvent('click');
    const url = 'https://git.example.com/project/-/merge_requests/42';

    openTerminalExternalLink(event, url);

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(url);
  });
});
