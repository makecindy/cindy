// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { BotLearningFooter } from '../BotLearningFooter';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, args: { title: string }) => `${key}: ${args.title}` }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function Location() {
  return <output>{useLocation().search}</output>;
}
it('renders two footer rows after content and opens only the existing settings pages', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const receipts = [
    { kind: 'memory', key: 'a', title: 'Preference', action: 'created' },
    { kind: 'skill', key: 'b', title: 'Workflow', action: 'updated' },
  ];
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/bots/b/session/s']}>
        <article>
          <p>Reply</p>
          <BotLearningFooter receipts={receipts} />
        </article>
        <Location />
      </MemoryRouter>,
    ),
  );
  expect(host.querySelector('article')!.firstElementChild!.textContent).toBe('Reply');
  expect(
    host.querySelector('[data-bot-learning-footer]')!.previousElementSibling!.textContent,
  ).toBe('Reply');
  const buttons = host.querySelectorAll('button');
  expect(buttons.length).toBe(2);
  await act(async () => buttons[0].click());
  expect(host.querySelector('output')!.textContent).toBe('?settings=1&settingsPage=memory');
  await act(async () => buttons[1].click());
  expect(host.querySelector('output')!.textContent).toBe('?settings=1&settingsPage=capabilities');
  await act(async () => root.unmount());
  host.remove();
});
