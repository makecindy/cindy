// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AutomationSessionButton } from '@/features/cc-agent/sidebar/AutomationSessionButton';
import { loadScheduleSidebarIndexRuns } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/scheduler/lib/scheduleSidebarIndexRuns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/scheduler/lib/scheduleSidebarIndexRuns')>()),
  loadScheduleSidebarIndexRuns: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function setup() {
  const parentClick = vi.fn();
  render(
    <MemoryRouter initialEntries={['/cc-agent/example']}>
      <div onClick={parentClick}>
        <AutomationSessionButton sessionId="task" size={10} activeForeground={false} />
      </div>
      <Location />
    </MemoryRouter>,
  );
  return parentClick;
}
describe('automation task navigation', () => {
  it('loads on demand, opens the latest matching schedule, and does not select the row', async () => {
    vi.mocked(loadScheduleSidebarIndexRuns).mockResolvedValue([
      { runId: 'older', scheduleId: 'old', sessionId: 'task', firedAt: 1 },
      { runId: 'newer', scheduleId: 'new schedule', sessionId: 'task', firedAt: 2 },
    ] as Awaited<ReturnType<typeof loadScheduleSidebarIndexRuns>>);
    const parentClick = setup();
    expect(loadScheduleSidebarIndexRuns).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/cc-agent/scheduled?focus=new%20schedule',
      ),
    );
    expect(parentClick).not.toHaveBeenCalled();
  });
  it.each(['missing', 'error'])('falls back to the automation page when %s', async (kind) => {
    if (kind === 'missing') vi.mocked(loadScheduleSidebarIndexRuns).mockResolvedValue([]);
    else vi.mocked(loadScheduleSidebarIndexRuns).mockRejectedValue(new Error('offline'));
    setup();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent/scheduled'),
    );
  });
});
