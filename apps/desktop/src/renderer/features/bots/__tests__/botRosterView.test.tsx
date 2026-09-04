// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => ({
  addBotProfileAndWait: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../botStore', () => ({ addBotProfileAndWait: mocks.addBotProfileAndWait }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

import { BotRosterView } from '../BotRosterView';
import { peekPendingBotWelcomeEntry, resetPendingBotWelcomeForTests } from '../botWelcome';

beforeEach(() => {
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Ops buddy' });
  mocks.navigate.mockReset();
  resetPendingBotWelcomeForTests();
});

afterEach(() => cleanup());

describe('BotRosterView — 唯一的伙伴创建界面', () => {
  it('shows three professional presets plus custom and the shared basic profile fields', () => {
    render(<BotRosterView />);

    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
    for (const id of ['programmer', 'designer', 'counsel', 'custom']) {
      expect(screen.getByText(`bots.createWizard.templates.${id}.title`)).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3);
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
    expect(screen.getByLabelText('bots.profile.summary')).toBeTruthy();
    expect(screen.queryByText('bots.profile.avatar')).toBeNull();
    expect(screen.queryByText('bots.background.title')).toBeNull();
    expect(screen.queryByText('bots.persona.title')).toBeNull();
  });

  it('starts custom from a blank profile and waits for a name', () => {
    render(<BotRosterView />);
    fireEvent.click(screen.getByText('bots.createWizard.templates.custom.title'));

    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('bots.profile.summary') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByRole('button', { name: 'bots.roster.create' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('uses a template as a draft in the same fields', () => {
    render(<BotRosterView />);
    fireEvent.click(screen.getByText('bots.createWizard.templates.designer.title'));

    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe(
      'bots.createWizard.templates.designer.defaultName',
    );
    expect((screen.getByLabelText('bots.profile.summary') as HTMLInputElement).value).toBe(
      'bots.createWizard.templates.designer.defaultDescription',
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
      avatar: '💻',
      avatarColor: 'blue',
      identitySource: expect.stringContaining('负责软件开发'),
      userContextSource: '',
      skills: [],
    });
  });

  it('creates a custom teammate with a neutral professional identity', async () => {
    render(<BotRosterView />);
    fireEvent.click(screen.getByText('bots.createWizard.templates.custom.title'));
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
  });

  it('navigates to the new teammate and leaves a greeting', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Ops buddy' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-new'));
    expect(peekPendingBotWelcomeEntry('bot-new')).toEqual({
      key: 'bots.welcome.generic',
      params: { name: 'Ops buddy' },
    });
  });

  it('keeps the unified form usable after a real create error', async () => {
    mocks.addBotProfileAndWait.mockRejectedValue(new Error('offline'));
    render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.create' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('offline'));
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
  });
});
