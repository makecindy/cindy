// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => ({
  addBotProfileAndWait: vi.fn(),
  navigate: vi.fn(),
  profiles: [] as Array<{ id: string; name: string; invitation: { stage: string } }>,
}));
vi.mock('../botStore', () => ({
  addBotProfileAndWait: mocks.addBotProfileAndWait,
  useBotProfiles: () => mocks.profiles,
  refreshBotProfiles: vi.fn(),
  retryBotInvitation: vi.fn(),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

import { BotRosterView } from '../BotRosterView';

beforeEach(() => {
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Ops buddy' });
  mocks.navigate.mockReset();
  mocks.profiles = [];
});

afterEach(() => cleanup());

describe('BotRosterView — 唯一的伙伴创建界面', () => {
  it('waits in the invitation dialog and meets only after preparation completes', async () => {
    const preparing = { id: 'new', name: '阿橙', invitation: { stage: 'skills' } };
    mocks.addBotProfileAndWait.mockResolvedValue(preparing);
    const view = render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));
    await waitFor(() =>
      expect(screen.getByText('bots.invitation.skills:{"name":"阿橙"}')).toBeTruthy(),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    mocks.profiles = [{ ...preparing, invitation: { stage: 'ready' } }];
    view.rerender(<BotRosterView />);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/new'));
  });

  it('allows leaving the welcome while main continues preparing', async () => {
    mocks.addBotProfileAndWait.mockResolvedValue({
      id: 'new',
      name: '阿橙',
      invitation: { stage: 'profile' },
    });
    const onClose = vi.fn();
    render(<BotRosterView onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.invitation.leave' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('shows three professional presets plus custom and the shared basic profile fields', () => {
    render(<BotRosterView />);

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('cindy');
    for (const id of ['cindy', 'dash', 'lizi', 'custom']) {
      expect(screen.getByText(`bots.createWizard.templates.${id}.title`)).toBeTruthy();
    }
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
    expect(screen.getByLabelText('bots.profile.summary')).toBeTruthy();
    expect(screen.queryByText('bots.profile.avatar')).toBeNull();
    expect(screen.queryByText('bots.background.title')).toBeNull();
    expect(screen.queryByText('bots.persona.title')).toBeNull();
  });

  it('starts custom from a blank profile and waits for a name', () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });

    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('bots.profile.summary') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByRole('button', { name: 'bots.roster.create' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('uses a template as a draft in the same fields', () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dash' } });

    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe(
      'bots.createWizard.templates.dash.defaultName',
    );
    expect((screen.getByLabelText('bots.profile.summary') as HTMLInputElement).value).toBe(
      'bots.createWizard.templates.dash.defaultDescription',
    );
  });

  it('lets the user change name and description while the template supplies the initial avatar', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Ops buddy' } });
    fireEvent.change(screen.getByLabelText('bots.profile.summary'), {
      target: { value: 'Release partner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    expect(mocks.addBotProfileAndWait.mock.calls[0]?.[0]).toMatchObject({
      name: 'Ops buddy',
      description: 'Release partner',
      prepareInvitation: true,
      avatar: 'cindy://avatar/preset/cindy',
      avatarColor: 'blue',
      identitySource: expect.stringContaining('Cindy 助理'),
      userContextSource: '',
      skills: [],
      capabilities: { toolsetMode: 'allowlist', toolsets: ['docs'] },
    });
  });

  it('creates a custom teammate with a neutral professional identity', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: '项目伙伴' } });
    fireEvent.change(screen.getByLabelText('bots.profile.summary'), {
      target: { value: '负责项目资料整理' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    expect(mocks.addBotProfileAndWait.mock.calls[0]?.[0]).toMatchObject({
      name: '项目伙伴',
      description: '负责项目资料整理',
      avatar: '✦',
      avatarColor: 'amber',
      identitySource: expect.stringContaining('由用户自定义职责'),
    });
    expect(mocks.addBotProfileAndWait.mock.calls[0]?.[0]).not.toHaveProperty('templateId');
  });

  it('requests main-owned preparation instead of sending a generic greeting', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Ops buddy' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-new'));
    expect(mocks.addBotProfileAndWait.mock.calls[0]?.[0]).toMatchObject({
      prepareInvitation: true,
    });
  });

  it('keeps the unified form usable after a real create error', async () => {
    mocks.addBotProfileAndWait.mockRejectedValue(new Error('offline'));
    render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('offline'));
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
  });
  it('previews a custom image without creating a profile, preserves the draft across roles, and submits the image bytes', async () => {
    const { container } = render(<BotRosterView />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Mika' } });
    const image = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])],
      'avatar.png',
      { type: 'image/png' },
    );
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [image] } });
    await waitFor(() => expect(document.querySelector('img[src^="data:image/png"]')).toBeTruthy());
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dash' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Mika');
    expect(document.querySelector('img[src^="data:image/png"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));
    await waitFor(() =>
      expect(mocks.addBotProfileAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Mika',
          avatarImageBase64: 'iVBORw0KGgo=',
        }),
      ),
    );
  });

  it('leaves the draft alone when the picker is canceled and rejects unsupported or oversized files', async () => {
    const { container } = render(<BotRosterView />);
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, { target: { files: [] } });
    expect(screen.queryByRole('alert')).toBeNull();
    for (const file of [
      new File(['<svg/>'], 'avatar.svg', { type: 'image/svg+xml' }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
    ]) {
      fireEvent.change(input, { target: { files: [file] } });
      expect(screen.getByRole('alert').textContent).toBe('bots.profile.avatarSelectionFailed');
    }
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'bots.roster.create' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('closes the creation dialog without creating a teammate', () => {
    const onClose = vi.fn();
    render(<BotRosterView onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
  });
});
