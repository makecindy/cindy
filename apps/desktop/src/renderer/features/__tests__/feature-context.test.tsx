// @vitest-environment jsdom
// Unit regression for PB97-BBH8 follow-up: one title change invalidated unrelated
// sidebar readers and fed back into the registrar, adding work before paint.
// Exercise the real provider/hooks with one title change, sidebar control change,
// or route unmount. Existing shell tests only mount this module; none cover these
// notifications or retained input state. Keep these three cases together here
// because the provider previously had no dedicated behavioral test file.
// Standalone run: 1.37 s (2.71 s including pnpm), below the 5 s unit budget.
import { memo, useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FeatureSidebarSlotProvider,
  useFeatureContentHeader,
  useFeatureSidebarEnabled,
  useFeatureSidebarUpper,
  useOwnsTopNavScrollableRows,
  useOwnTopNavScrollableRows,
  useRegisterContentHeader,
  useRegisterSidebarUpper,
  useSetSidebarEnabled,
  useSidebarCollapsedState,
} from '../feature-context';

afterEach(cleanup);

describe('feature slots', () => {
  function fixture() {
    const sidebarRender = vi.fn();
    const headerRender = vi.fn();
    const registerRender = vi.fn();
    const Header = memo(function Header() {
      const content = useFeatureContentHeader();
      headerRender();
      return <header>{content}</header>;
    });
    const Sidebar = memo(function Sidebar() {
      const collapsed = useSidebarCollapsedState();
      const enabled = useFeatureSidebarEnabled();
      const ownsRows = useOwnsTopNavScrollableRows();
      const content = useFeatureSidebarUpper();
      sidebarRender();
      return (
        <aside
          data-testid="sidebar"
          data-collapsed={collapsed}
          data-enabled={enabled}
          data-owns-rows={ownsRows}
        >
          {content}
        </aside>
      );
    });
    const Register = memo(function Register({
      title,
      label,
      enabled,
      ownsRows,
    }: {
      title: string;
      label: string;
      enabled: boolean;
      ownsRows: boolean;
    }) {
      registerRender();
      useRegisterContentHeader(useMemo(() => <h1>{title}</h1>, [title]));
      useRegisterSidebarUpper(useMemo(() => <input aria-label={label} defaultValue="" />, [label]));
      useSetSidebarEnabled(enabled);
      useOwnTopNavScrollableRows(ownsRows);
      return null;
    });
    function App() {
      const [title, setTitle] = useState('Task A');
      const [label, setLabel] = useState('Filter A');
      const [collapsed, setCollapsed] = useState(false);
      const [enabled, setEnabled] = useState(true);
      const [ownsRows, setOwnsRows] = useState(false);
      const [mounted, setMounted] = useState(true);
      return (
        <FeatureSidebarSlotProvider isCollapsed={collapsed}>
          <button onClick={() => setTitle('Task B')}>title</button>
          <button onClick={() => setLabel('Filter B')}>sidebar</button>
          <button onClick={() => setCollapsed(true)}>collapse</button>
          <button
            onClick={() => {
              setEnabled(false);
              setOwnsRows(true);
            }}
          >
            navigation
          </button>
          <button onClick={() => setMounted(false)}>leave</button>
          {mounted && (
            <Register title={title} label={label} enabled={enabled} ownsRows={ownsRows} />
          )}
          <Header />
          <Sidebar />
        </FeatureSidebarSlotProvider>
      );
    }
    render(<App />);
    sidebarRender.mockClear();
    headerRender.mockClear();
    registerRender.mockClear();
    return { sidebarRender, headerRender, registerRender };
  }

  it('updates the title without re-rendering the sidebar or feeding the registration back', () => {
    const { sidebarRender, headerRender, registerRender } = fixture();
    fireEvent.click(screen.getByText('title'));
    expect(screen.getByRole('heading').textContent).toBe('Task B');
    expect(headerRender).toHaveBeenCalledTimes(1);
    expect(registerRender).toHaveBeenCalledTimes(1);
    expect(sidebarRender).not.toHaveBeenCalled();
  });

  it('publishes sidebar content and controls without updating the title reader', () => {
    const { headerRender, sidebarRender, registerRender } = fixture();
    fireEvent.click(screen.getByText('sidebar'));
    expect(screen.getByRole('textbox', { name: 'Filter B' })).toBeTruthy();
    fireEvent.click(screen.getByText('collapse'));
    fireEvent.click(screen.getByText('navigation'));
    expect(screen.getByTestId('sidebar').dataset).toMatchObject({
      collapsed: 'true',
      enabled: 'false',
      ownsRows: 'true',
    });
    expect(sidebarRender).toHaveBeenCalledTimes(3);
    expect(registerRender).toHaveBeenCalledTimes(2);
    expect(headerRender).not.toHaveBeenCalled();
  });

  it('clears the old title on leaving while retaining sidebar content and its local state', () => {
    fixture();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep filter' } });
    fireEvent.click(screen.getByText('leave'));
    expect(screen.queryByRole('heading')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('keep filter');
  });
});
