// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stable `t` identity, like real i18next: the dialog refreshes its localized
// defaults when `t` changes, so a new function per render would reset the form.
const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

const mocks = vi.hoisted(() => ({
  addBotProfileAndWait: vi.fn(),
}));
vi.mock('../botStore', () => ({
  addBotProfileAndWait: mocks.addBotProfileAndWait,
}));

import { AddBotDialog } from '../AddBotDialog';
import {
  BOT_AVATAR_HUES,
  BOT_PRESET_AVATAR_IDS,
  CINDY_OFFICIAL_AVATAR,
  parsePresetAvatarId,
} from '../BotAvatar';
import { getBotTemplate } from '../botTemplates';

function renderDialog() {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(<AddBotDialog open onOpenChange={onOpenChange} onCreated={onCreated} />);
  return { onCreated, onOpenChange };
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText('bots.nameLabel', { selector: 'input' }) as HTMLInputElement;
}

beforeEach(() => {
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Control Bot' });
});

afterEach(() => cleanup());

describe('AddBotDialog', () => {
  it('creates in one screen: four cards, no wizard step, no developer sidebar', () => {
    renderDialog();

    for (const key of ['control', 'prSteward', 'assistant', 'custom']) {
      expect(screen.getByText(`bots.createWizard.templates.${key}.title`)).toBeTruthy();
    }
    // The two-step wizard and the harness / task-control aside are gone.
    expect(screen.queryByText('bots.createWizard.continue')).toBeNull();
    expect(screen.queryByText('bots.createWizard.back')).toBeNull();
    expect(screen.queryByText('bots.createWizard.recommendedConfiguration')).toBeNull();
    expect(screen.queryByText('bots.harnessLabel')).toBeNull();
    expect(screen.queryByText('bots.sessionControl.title')).toBeNull();
    // The submit button lives on the same screen.
    expect(screen.getByRole('button', { name: 'bots.createWizard.submit' })).toBeTruthy();
    expect(screen.getByText('bots.createWizard.channelsHint')).toBeTruthy();
  });

  it('prefills name, description and avatar from the selected template', () => {
    renderDialog();

    expect(nameInput().value).toBe('bots.createWizard.templates.control.defaultName');

    fireEvent.click(screen.getByText('bots.createWizard.templates.assistant.title'));
    expect(nameInput().value).toBe('bots.createWizard.templates.assistant.defaultName');
    // The standard assistant carries the official Cindy mark: the trigger shows
    // the bundled artwork, never the raw `cindy://avatar/…` sentinel as text.
    const trigger = screen.getByRole('button', { name: 'bots.avatarPicker.open' });
    expect(trigger.querySelector('img')?.getAttribute('src')).toContain('cindy-avatar-account');
    expect(trigger.textContent).not.toContain('cindy://');

    fireEvent.click(screen.getByText('bots.createWizard.templates.prSteward.title'));
    expect(
      screen.getByRole('button', { name: 'bots.avatarPicker.open' }).textContent,
    ).toContain(getBotTemplate('pr-steward').avatar);
  });

  it('never paints the avatar sentinel as text on a template card', () => {
    renderDialog();

    // The dialog lives in a portal, so assert against the whole document.
    expect(document.body.textContent).not.toContain('cindy://');
    const card = screen
      .getByText('bots.createWizard.templates.assistant.title')
      .closest('button') as HTMLButtonElement;
    expect(card.querySelector('img')?.getAttribute('src')).toContain('cindy-avatar-account');
  });

  it('submits the official avatar for the standard assistant template', async () => {
    renderDialog();

    fireEvent.click(screen.getByText('bots.createWizard.templates.assistant.title'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.createWizard.submit' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'bots.createWizard.templates.assistant.defaultName',
      avatar: CINDY_OFFICIAL_AVATAR,
      avatarColor: getBotTemplate('assistant').avatarColor,
    });
    expect(payload.eventSubscription).toBeUndefined();
  });

  it('keeps the identity field collapsed for templates and required for the blank card', () => {
    renderDialog();

    const toggle = screen.getByText('bots.createWizard.identityOptionalLabel');
    expect(screen.queryByLabelText('bots.createWizard.roleLabel')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByLabelText('bots.createWizard.roleLabel')).toBeTruthy();

    fireEvent.click(screen.getByText('bots.createWizard.templates.custom.title'));
    // Blank card: identity is expanded, mandatory, and submit is blocked until
    // both a name and an identity exist.
    expect(screen.getByText('bots.createWizard.identityRequiredLabel')).toBeTruthy();
    const identity = screen.getByLabelText('bots.createWizard.roleLabel') as HTMLTextAreaElement;
    expect(identity.value).toBe('');
    const submit = screen.getByRole('button', { name: 'bots.createWizard.submit' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(nameInput(), { target: { value: 'Ops buddy' } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(identity, { target: { value: 'You watch the deploy queue.' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits the template identity, capabilities and an avatar from the curated set', async () => {
    const { onCreated, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'bots.createWizard.submit' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    const template = getBotTemplate('control');
    expect(payload).toMatchObject({
      channel: 'local',
      name: 'bots.createWizard.templates.control.defaultName',
      identitySource: template.identitySource,
      capabilities: template.capabilities,
      userContextSource: '',
      avatar: template.avatar,
      avatarColor: template.avatarColor,
    });
    expect(payload.eventSubscription).toMatchObject({ id: 'control-events', status: 'active' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onCreated).toHaveBeenCalledWith({ id: 'bot-new', name: 'Control Bot' });
  });

  it('creates the blank card without capabilities or an event subscription', async () => {
    renderDialog();

    fireEvent.click(screen.getByText('bots.createWizard.templates.custom.title'));
    fireEvent.change(nameInput(), { target: { value: 'Ops buddy' } });
    fireEvent.change(screen.getByLabelText('bots.createWizard.roleLabel'), {
      target: { value: 'You watch the deploy queue.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.createWizard.submit' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    expect(payload.name).toBe('Ops buddy');
    expect(payload.identitySource).toBe('You watch the deploy queue.');
    expect(payload.capabilities).toBeUndefined();
    expect(payload.eventSubscription).toBeUndefined();
    // The blank card still gets a good-looking auto-assigned mark: a shipped
    // character this build can draw, never the official Cindy portrait.
    expect(BOT_PRESET_AVATAR_IDS).toContain(parsePresetAvatarId(payload.avatar)!);
    expect(payload.avatar).not.toBe(CINDY_OFFICIAL_AVATAR);
    expect(BOT_AVATAR_HUES).toContain(payload.avatarColor);
  });

  it('shows the auto-assigned character on the blank card, never the raw sentinel', () => {
    renderDialog();

    fireEvent.click(screen.getByText('bots.createWizard.templates.custom.title'));
    const trigger = screen.getByRole('button', { name: 'bots.avatarPicker.open' });
    expect(trigger.querySelector('img')?.getAttribute('src')).toContain('bot-avatar-preset-');
    expect(document.body.textContent).not.toContain('cindy://');
  });
});
