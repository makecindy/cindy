// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  withSidebarNavigation,
  useSidebarNavigate,
  type SidebarNavigationProps,
} from '@/features/cc-agent/sidebar/sidebarNavigation';

afterEach(cleanup);

it('does not render an unchanged row on task navigation and still navigates from the latest route', () => {
  const rendered = vi.fn();
  const Row = withSidebarNavigation<{ label: string }>(function Row({
    label,
    navigate,
  }: { label: string } & SidebarNavigationProps) {
    rendered();
    return <button onClick={() => navigate('scheduled', { relative: 'path' })}>{label}</button>;
  });
  function Harness() {
    const navigate = useSidebarNavigate();
    const location = useLocation();
    return (
      <>
        <button onClick={() => navigate('/cc-agent/b')}>switch</button>
        <Row label="schedule" />
        <output>{location.pathname}</output>
      </>
    );
  }
  render(
    <MemoryRouter initialEntries={['/cc-agent/a']}>
      <Routes>
        <Route path="/cc-agent/:id/*" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(rendered).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('switch'));
  expect(screen.getByText('/cc-agent/b')).toBeTruthy();
  expect(rendered).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('schedule'));
  expect(screen.getByText('/cc-agent/b/scheduled')).toBeTruthy();
  expect(rendered).toHaveBeenCalledTimes(1);
});
