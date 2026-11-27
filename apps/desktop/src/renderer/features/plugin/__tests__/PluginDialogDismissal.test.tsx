/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { MarketplaceSourcesDialog } from '../MarketplaceSourcesDialog';
import { UpdateAllDialog } from '../UpdateAllDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

afterEach(cleanup);

function DialogOpener({ kind }: { kind: 'updates' | 'sources' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {kind === 'updates' ? (
        <UpdateAllDialog open={open} rows={[]} iconByGhostId={new Map()} onClose={() => setOpen(false)} />
      ) : (
        <MarketplaceSourcesDialog open={open} sources={[]} onOpenChange={setOpen} onChanged={() => {}} />
      )}
    </>
  );
}

it.each(['updates', 'sources'] as const)('closes the %s dialog with one Escape after keyboard opening', async (kind) => {
  const user = userEvent.setup();
  render(<DialogOpener kind={kind} />);

  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open dialog' }));
  await user.keyboard('{Enter}');
  await screen.findByRole('dialog');
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
  expect(screen.queryByRole('tooltip')).toBeNull();
  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it.each([
  ['updates', 'settings.ghosts.detail.closeDialog'],
  ['sources', 'settings.ghosts.market.sources.close'],
] as const)('keeps the %s close button and its Tip in the Tab order', async (kind, closeLabel) => {
  const user = userEvent.setup();
  render(<DialogOpener kind={kind} />);

  await user.tab();
  await user.keyboard('{Enter}');
  await user.tab();

  expect(document.activeElement).toBe(screen.getByRole('button', { name: closeLabel }));
  expect((await screen.findByRole('tooltip')).textContent).toBe(closeLabel);
});
