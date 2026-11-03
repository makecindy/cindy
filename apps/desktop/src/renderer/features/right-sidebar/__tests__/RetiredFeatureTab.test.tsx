// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TabKindBodyProps } from '../types';
import { getTabKind } from '../registry';
import '../plugins/retired-feature';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('opens details through the main window bridge without replacing the sidebar shell', async () => {
  const openRetirement = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('electronAPI', { ghosts: { openRetirement } });
  const plugin = getTabKind('retired-feature')!;
  const Body = plugin.TabBody;
  render(<Body {...({ state: { pluginId: 'ios-simulator' } } as TabKindBodyProps)} />);
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.retirement.view' }));
  await waitFor(() => expect(openRetirement).toHaveBeenCalledWith('ios-simulator'));
  expect(plugin.menu.hiddenFromMenu).toBe(true);
});
