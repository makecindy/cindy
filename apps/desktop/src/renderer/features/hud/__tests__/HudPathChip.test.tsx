// @vitest-environment jsdom
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HudPathChip } from '../HudPathChip';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
// User request: copying a visually truncated path must preserve the entire current
// working directory. No previous HUD path control coverage. jsdom unit, no OS clipboard.
it('copies the full current path after changing tasks', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { rerender } = render(<HudPathChip path="/long/first/task" />);
  rerender(<HudPathChip path="/long/second/task-end" />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('/long/second/task-end'));
});
