// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillSortMenu, type SkillHomeSort } from '../SkillSortMenu';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
afterEach(cleanup);
it('opens with the keyboard and updates the radio selection', async () => {
  function Harness() { const [value, setValue] = useState<SkillHomeSort>('downloads'); return <SkillSortMenu value={value} onChange={setValue} />; }
  render(<Harness />);
  screen.getByRole('button').focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('menuitemradio', { name: 'skillhub.home.sortDownloads' }).getAttribute('aria-checked')).toBe('true');
  act(() => screen.getByRole('menuitemradio', { name: 'skillhub.home.sortUpdated' }).focus());
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('button').textContent).toContain('skillhub.home.sortUpdated');
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('menuitemradio', { name: 'skillhub.home.sortUpdated' }).getAttribute('aria-checked')).toBe('true');
});
