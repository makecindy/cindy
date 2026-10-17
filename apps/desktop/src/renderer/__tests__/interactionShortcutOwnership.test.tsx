// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyntheticInteraction, interactionKinds, type InteractionKind } from '../../../scripts/fixtures/permission-focus/interaction-cards';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string) => key, i18n: { language: 'zh-CN' },
}) }));
afterEach(cleanup);

function setup(a: InteractionKind, b: InteractionKind, reversed: boolean) {
  const respond = vi.fn();
  function Fixture() {
    const [active, setActive] = useState('A');
    return <>
      <button onClick={(e) => { setActive('B'); e.currentTarget.blur(); }}>Navigate B</button>
      {(reversed ? ['B', 'A'] : ['A', 'B']).map((id) => <SyntheticInteraction key={id}
        kind={id === 'A' ? a : b} session={id} enabled={id === active} onRespond={respond} />)}
    </>;
  }
  const view = render(<Fixture />);
  const card = (id: string) => view.container.querySelector(`[data-interaction-session="${id}"]`)! as HTMLElement;
  const navigate = () => {
    const oldA = card('A');
    const oldB = card('B');
    fireEvent.click(view.getByText('Navigate B'));
    expect(card('A')).toBe(oldA);
    expect(card('B')).toBe(oldB);
  };
  return { ...view, respond, card, navigate };
}

// Mixed cards matter: an inactive confirmation must not consume the active plan's key.
describe.each(interactionKinds)('inactive %s', (a) => {
  describe.each(interactionKinds)('active %s', (b) => {
    it.each([false, true])('only B handles Escape (reverse registration: %s)', async (reverse) => {
      const f = setup(a, b, reverse);
      f.navigate();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      await waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
      expect(f.respond.mock.calls[0].slice(0, 2)).toEqual(['B', 'request-B']);
    });
  });
});

describe.each(interactionKinds)('%s primary action', (kind) => {
  it.each([false, true])('handles its own key only after ownership switches (%s)', async (reverse) => {
    const f = setup(kind, kind, reverse);
    if (kind === 'issue') {
      for (const id of ['A', 'B']) fireEvent.click(within(f.card(id)).getByRole('checkbox'));
    }
    f.navigate();
    fireEvent.keyDown(document.body, {
      key: kind === 'ask' ? '1' : 'Enter',
      ctrlKey: !['plan', 'ask'].includes(kind),
    });
    await waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
    expect(f.respond.mock.calls[0].slice(0, 2)).toEqual(['B', 'request-B']);
  });

  it('keeps the inactive card’s native button usable', async () => {
    const f = setup(kind, kind, false);
    f.navigate();
    const names = {
      plan: 'newChat.planReview.approve', ask: 'Choice', permission: 'agentIsland.native.allowOnce',
      issue: 'issueAgent.confirm.cancel', rename: 'renameSessions.confirm.cancel', ghost: 'ghostGrant.confirm.deny',
    };
    const user = userEvent.setup();
    await user.click(within(f.card('A')).getByRole('button', { name: new RegExp(names[kind]) }));
    await waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
    expect(f.respond.mock.calls[0].slice(0, 2)).toEqual(['A', 'request-A']);
  });
});
