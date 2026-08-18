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
  profiles: [] as Array<{ id: string; name: string; status?: string }>,
}));
vi.mock('../botStore', () => ({
  addBotProfileAndWait: mocks.addBotProfileAndWait,
  useBotProfiles: () => mocks.profiles,
}));

import { AddBotDialog } from '../AddBotDialog';
import {
  BOT_AVATAR_HUES,
  BOT_PRESET_AVATAR_IDS,
  CINDY_OFFICIAL_AVATAR,
  parsePresetAvatarId,
} from '../BotAvatar';
import { BOT_TEMPLATES, getBotTemplate } from '../botTemplates';
import { peekPendingBotWelcome, resetPendingBotWelcomeForTests } from '../botWelcome';

function renderDialog() {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  const onImport = vi.fn();
  render(
    <AddBotDialog
      open
      onOpenChange={onOpenChange}
      onCreated={onCreated}
      onImport={onImport}
    />,
  );
  return { onCreated, onOpenChange, onImport };
}

/** The join button that belongs to one roster card. */
function joinButtonFor(templateId: string): HTMLButtonElement {
  const card = screen
    .getByText(`bots.createWizard.templates.${templateId}.name`)
    .closest('div.rounded-xl') as HTMLElement;
  return card.querySelector('button') as HTMLButtonElement;
}

beforeEach(() => {
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Cindy' });
  mocks.profiles = [];
  resetPendingBotWelcomeForTests();
});

afterEach(() => cleanup());

describe('AddBotDialog — the roster', () => {
  it('shows every character with a face, a skill, a self-introduction and a join button', () => {
    renderDialog();

    for (const template of BOT_TEMPLATES) {
      expect(screen.getByText(`bots.createWizard.templates.${template.id}.name`)).toBeTruthy();
      expect(screen.getByText(`bots.createWizard.templates.${template.id}.intro`)).toBeTruthy();
    }
    // 阵容有六张角色卡 + 一张自定义卡。
    expect(BOT_TEMPLATES).toHaveLength(6);
    expect(screen.getByText('bots.roster.customName')).toBeTruthy();
    expect(screen.getAllByText('bots.roster.join').length).toBe(BOT_TEMPLATES.length);
    // 阵容式创建没有名字 / 描述 / 身份表单。
    expect(screen.queryByText('bots.nameLabel')).toBeNull();
    expect(screen.queryByText('bots.descriptionLabel')).toBeNull();
    expect(screen.queryByLabelText('bots.createWizard.roleLabel')).toBeNull();
    expect(screen.getByText('bots.roster.footerHint')).toBeTruthy();
  });

  it('never paints an avatar sentinel as text', () => {
    renderDialog();
    expect(document.body.textContent).not.toContain('cindy://');
  });

  it('greys out a character that is already on the crew, and only that one', () => {
    mocks.profiles = [
      { id: 'bot-1', name: 'bots.createWizard.templates.cindy.name', status: 'active' },
      // 归档的伙伴不算数:那张卡必须还能再加回来。
      { id: 'bot-2', name: 'bots.createWizard.templates.shiba.name', status: 'archived' },
    ];
    renderDialog();

    expect(joinButtonFor('cindy').disabled).toBe(true);
    expect(joinButtonFor('cindy').textContent).toContain('bots.roster.joined');
    expect(joinButtonFor('shiba').disabled).toBe(false);
    expect(joinButtonFor('melody').disabled).toBe(false);
  });

  it('creates straight from the card, with that character\'s identity and capabilities', async () => {
    const { onCreated, onOpenChange } = renderDialog();

    fireEvent.click(joinButtonFor('butler'));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    const template = getBotTemplate('butler');
    expect(payload).toMatchObject({
      channel: 'local',
      name: 'bots.createWizard.templates.butler.name',
      description: 'bots.createWizard.templates.butler.description',
      identitySource: template.identitySource,
      capabilities: template.capabilities,
      userContextSource: '',
      avatar: template.avatar,
      avatarColor: template.avatarColor,
    });
    // 本本会盯任务动静,所以带事件订阅。
    expect(payload.eventSubscription).toMatchObject({ id: 'control-events', status: 'active' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onCreated).toHaveBeenCalledWith({ id: 'bot-new', name: 'Cindy' });
  });

  it('parks the character greeting so the canonical chat can say hello', async () => {
    renderDialog();

    fireEvent.click(joinButtonFor('star'));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(peekPendingBotWelcome('bot-new')).toBe(getBotTemplate('star').welcomeKey),
    );
  });

  it('gives an ordinary assistant no event subscription', async () => {
    renderDialog();

    fireEvent.click(joinButtonFor('cindy'));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    expect(payload.avatar).toBe(CINDY_OFFICIAL_AVATAR);
    expect(payload.eventSubscription).toBeUndefined();
  });

  it('asks the blank card for a name and a face, and nothing else', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.customAction' }));
    const submit = screen.getByRole('button', { name: 'bots.roster.join' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // 自定义卡不再逼用户先写一段身份设定。
    expect(screen.queryByLabelText('bots.createWizard.roleLabel')).toBeNull();

    const name = screen.getByLabelText('bots.roster.customNameLabel', {
      selector: 'input',
    }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Ops buddy' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    expect(payload.name).toBe('Ops buddy');
    expect(payload.capabilities).toBeUndefined();
    expect(payload.eventSubscription).toBeUndefined();
    // 空白卡拿到的是这版能画出来的立绘,不是官方 Cindy 头像。
    expect(BOT_PRESET_AVATAR_IDS).toContain(parsePresetAvatarId(payload.avatar)!);
    expect(payload.avatar).not.toBe(CINDY_OFFICIAL_AVATAR);
    expect(BOT_AVATAR_HUES).toContain(payload.avatarColor);
    // 自己捏的伙伴没有预置欢迎语,不会凭空冒出一句别人的台词。
    expect(peekPendingBotWelcome('bot-new')).toBeNull();
  });

  it('hands the import link to the existing import flow', () => {
    const { onImport, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.importLink' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});
