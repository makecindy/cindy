// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PluginUiView } from '@cindy/maker-shared';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn() }));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect(event: { stopPropagation(): void }): void; disabled?: boolean }) =>
    <button disabled={disabled} onClick={onSelect}>{children}</button>,
}));
vi.mock('../usePluginShortcutDefinitions', () => ({
  usePluginShortcutDefinitions: () => [{ id: `plugin:${'a'.repeat(64)}`, scope: 'message', points: ['message.actions'] }],
}));
vi.mock('../usePluginUiContributions', () => ({
  usePluginUiContributions: (input: unknown) => mocks.read(input),
}));

import { PluginUiCommandMenuItems, usePluginUiCommandMenu } from '../PluginUiCommandMenu';

const view: PluginUiView = {
  version: 1, viewId: 'view', revision: '1', point: 'message.actions', contributionId: 'format',
  command: { shortcutId: `plugin:${'a'.repeat(64)}` },
  controls: [{ kind: 'button', id: 'run', actionId: 'run', label: 'Format' }],
  actions: [{ id: 'run', label: 'Format' }], blocks: [], fallbackMarkdown: 'Format',
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('plugin commands in an existing menu', () => {
  it('runs the host-bound command and ignores ordinary contributions', () => {
    mocks.read.mockReturnValue({ views: [view, { ...view, viewId: 'ordinary', command: undefined }],
      pending: new Set(), disabled: false, invoke: mocks.invoke });
    function Menu() {
      const menu = usePluginUiCommandMenu({ sessionId: 'task', point: 'message.actions', target: { kind: 'message', id: 'message' } });
      return <PluginUiCommandMenuItems menu={menu} />;
    }
    render(<Menu />);
    expect(screen.getAllByText('Format')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Format' }));
    expect(mocks.invoke).toHaveBeenCalledWith(view, 'run', {});
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'task', target: { kind: 'message', id: 'message' }, active: true }));
  });
});
