// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GhostMailHistory } from '../GhostMailHistory';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('starts collapsed and keeps every original recipient and quote readable without editing or sending', () => {
  const { container } = render(<GhostMailHistory fields={[
    { name: 'subject', label: 'Subject', value: 'Meeting' },
    { name: 'to', label: 'To', value: 'Jane <jane@example.test>, Tim <tim@example.test>' },
    { name: 'quote', label: 'Quote', value: '<img src=x> original' },
  ]} />);
  const details = container.querySelector('details')!;
  expect(details.open).toBe(false);
  details.open = true;
  expect(screen.getByText('Jane <jane@example.test>, Tim <tim@example.test>')).toBeTruthy();
  expect(screen.getByText('<img src=x> original')).toBeTruthy();
  expect(container.querySelector('input, textarea, button, iframe, img')).toBeNull();
});
