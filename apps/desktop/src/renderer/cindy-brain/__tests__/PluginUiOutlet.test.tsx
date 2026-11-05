// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginUiOutlet } from '../PluginUiOutlet';
import type { PluginUiView } from '@cindy/maker-shared';
import type { ReactNode } from 'react';
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect(): void }) => <button onClick={onSelect}>{children}</button>,
}));
afterEach(cleanup);
it('keeps two contributions and the host controls usable when one renderer fails, and reveals overflow explicitly', () => {
  const views: PluginUiView[] = ['ok', 'bad', 'extra'].map(id => ({ version: 1, viewId: id, contributionId: id, point: 'composer.tools', revision: '1', controls: [], blocks: [], actions: [], fallbackMarkdown: `fallback:${id}` }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<><button>Host send</button><PluginUiOutlet views={views} render={v => { if (v.viewId === 'bad') throw new Error('renderer'); return <span>content:{v.viewId}</span>; }} /></>);
  expect(screen.getByText('content:ok')).toBeTruthy(); expect(screen.getByText('fallback:bad')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Host send' })).toBeTruthy(); expect(screen.queryByText('content:extra')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'extra' })); expect(screen.getByText('content:extra')).toBeTruthy();
  error.mockRestore();
});
