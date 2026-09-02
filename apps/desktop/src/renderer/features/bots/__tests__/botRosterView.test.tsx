// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stable `t` identity, like real i18next.
const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

const mocks = vi.hoisted(() => ({
  addBotProfileAndWait: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../botStore', () => ({
  addBotProfileAndWait: mocks.addBotProfileAndWait,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

import { BotRosterView } from '../BotRosterView';
import { BOT_AVATAR_HUES } from '../BotAvatar';
import { peekPendingBotWelcomeEntry, resetPendingBotWelcomeForTests } from '../botWelcome';

function fillAndSubmit(overrides: { name?: string } = {}) {
  fireEvent.change(screen.getByLabelText('bots.descriptionLabel'), {
    target: { value: 'Release partner' },
  });
  fireEvent.change(screen.getByLabelText('bots.background.title'), {
    target: { value: 'Own release preparation and verification.' },
  });
  fireEvent.change(screen.getByLabelText('bots.persona.title'), {
    target: { value: 'Be direct and warn me early.' },
  });
  const name = screen.getByLabelText('bots.roster.customNameLabel', {
    selector: 'input',
  }) as HTMLInputElement;
  fireEvent.change(name, { target: { value: overrides.name ?? 'Ops buddy' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));
}

beforeEach(() => {
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Ops buddy' });
  mocks.navigate.mockReset();
  resetPendingBotWelcomeForTests();
});

afterEach(() => cleanup());

describe('BotRosterView — 手捏伙伴的自由创建表单', () => {
  it('opens straight on the free-form identity form', () => {
    render(<BotRosterView />);

    expect(screen.getByText('bots.roster.customTitle')).toBeTruthy();
    expect(screen.getByLabelText('bots.descriptionLabel')).toBeTruthy();
    expect(screen.getByLabelText('bots.background.title')).toBeTruthy();
    expect(screen.getByLabelText('bots.persona.title')).toBeTruthy();
    expect(
      screen.getByLabelText('bots.roster.customNameLabel', { selector: 'input' }),
    ).toBeTruthy();
  });

  it('never paints an avatar sentinel as text', () => {
    render(<BotRosterView />);
    expect(document.body.textContent).not.toContain('cindy://');
  });

  it('disables create until a name is entered', () => {
    render(<BotRosterView />);
    const submit = screen.getByRole('button', { name: 'bots.roster.create' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(
      screen.getByLabelText('bots.roster.customNameLabel', { selector: 'input' }),
      { target: { value: 'Ops buddy' } },
    );
    expect(submit.disabled).toBe(false);
  });

  it("creates from the user's own description, background and personality", async () => {
    const onCreated = vi.fn();
    render(<BotRosterView onCreated={onCreated} />);

    fillAndSubmit();

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    expect(payload).toMatchObject({
      channel: 'local',
      name: 'Ops buddy',
      description: 'Release partner',
      identitySource: 'Own release preparation and verification.\n\nBe direct and warn me early.',
      userContextSource: '',
      skills: [],
    });
    expect(payload.avatar).toBe('');
    expect(BOT_AVATAR_HUES).toContain(payload.avatarColor);
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: 'bot-new', name: 'Ops buddy' }),
    );
  });

  it('navigates to the new teammate when no onCreated is supplied', async () => {
    render(<BotRosterView />);
    fillAndSubmit();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-new'));
  });

  it('parks a generic greeting with the teammate\'s own name', async () => {
    render(<BotRosterView />);
    fillAndSubmit({ name: 'Ops buddy' });

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    expect(peekPendingBotWelcomeEntry('bot-new')).toEqual({
      key: 'bots.welcome.generic',
      params: { name: 'Ops buddy' },
    });
  });

  it('shows a real error message and keeps the form usable when creation fails', async () => {
    mocks.addBotProfileAndWait.mockRejectedValue(new Error('offline'));
    render(<BotRosterView />);
    fillAndSubmit();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('offline'));
    expect(
      screen.getByLabelText('bots.roster.customNameLabel', { selector: 'input' }),
    ).toBeTruthy();
  });
});
