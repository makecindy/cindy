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
  profiles: [] as Array<{ id: string; name: string; status?: string }>,
  seedBotMemory: vi.fn(),
  generateBotPersona: vi.fn(),
}));
vi.mock('../botStore', () => ({
  addBotProfileAndWait: mocks.addBotProfileAndWait,
  useBotProfiles: () => mocks.profiles,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

import { BotRosterView } from '../BotRosterView';
import {
  BOT_AVATAR_HUES,
  BOT_PRESET_AVATAR_IDS,
  CINDY_OFFICIAL_AVATAR,
  parsePresetAvatarId,
} from '../BotAvatar';
import { BOT_TEMPLATES, botTemplateSeedEntries, getBotTemplate } from '../botTemplates';
import type { BotPersonaDraft } from '../../../../shared/botPersonaDraft';
import {
  peekPendingBotWelcome,
  peekPendingBotWelcomeEntry,
  resetPendingBotWelcomeForTests,
} from '../botWelcome';

function renderRoster(opts: { onCreated?: ReturnType<typeof vi.fn> } = {}) {
  const onCreated = opts.onCreated ?? vi.fn();
  render(<BotRosterView onCreated={onCreated} />);
  return { onCreated };
}

/**
 * 「自己捏一个」现在先落在角色生成那一步;原来那张「名字 + 头像」的表由
 * 「跳过,自己写」进入。手写路径本身一步没变,所以这些用例只是多走一次跳过。
 */
function openManualCustom() {
  fireEvent.click(screen.getByRole('button', { name: 'bots.roster.customAction' }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.roster.generate.skip' }));
}

/** The join button that belongs to one roster card. */
function joinButtonFor(templateId: string): HTMLButtonElement {
  const card = screen
    .getByText(`bots.createWizard.templates.${templateId}.name`)
    .closest('div.rounded-xl') as HTMLElement;
  return card.querySelector('button') as HTMLButtonElement;
}

const GENERATED_DRAFT: BotPersonaDraft = {
  name: '阿橘',
  description: '你的设计搭子',
  identity: '你是阿橘，设计搭子。界面、配图、走查都归你。',
  greeting: '嗨，我是阿橘。配图和走查都可以丢给我。',
  style: 'lively',
  proactivity: 'proactive',
  call: 'name',
  avatarPreset: 'whitecat',
  avatarHue: 'amber',
  memories: [
    { title: '先给三版', description: '不一上来就定稿', body: '每次先出三版。' },
    { title: '走查后再交', description: '交付前自己走一遍', body: '交付前自己走一遍。' },
  ],
};

beforeEach(() => {
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Cindy' });
  mocks.profiles = [];
  mocks.navigate.mockReset();
  mocks.seedBotMemory.mockReset();
  mocks.seedBotMemory.mockResolvedValue({ written: 0, skipped: 0 });
  mocks.generateBotPersona.mockReset();
  mocks.generateBotPersona.mockResolvedValue({ ok: true, draft: GENERATED_DRAFT });
  // 生成链路在测试里永远走假响应:这一层测的是判定与落库,不是模型。
  (globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
    maker: {
      botMemory: { seed: mocks.seedBotMemory },
      generateBotPersona: mocks.generateBotPersona,
    },
  };
  resetPendingBotWelcomeForTests();
});

afterEach(() => cleanup());

describe('BotRosterView — the roster page', () => {
  it('shows every character with a face, a skill, a self-introduction and a join button', () => {
    renderRoster();

    for (const template of BOT_TEMPLATES) {
      expect(screen.getByText(`bots.createWizard.templates.${template.id}.name`)).toBeTruthy();
      expect(screen.getByText(`bots.createWizard.templates.${template.id}.intro`)).toBeTruthy();
    }
    // 阵容有六张角色卡 + 一张自定义卡。
    // 阵容人数会随产品增删,这里锁的是「每个角色都渲染出来了」而不是一个魔数:
    // 上一版把它写死成 6,加两个角色就红,红的却不是任何真实缺陷。
    expect(BOT_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(screen.getByText('bots.roster.customName')).toBeTruthy();
    // 每张卡的加入按钮都带**自己**的第三人称:女角色「她」、男角色「他」。
    // 之前这里只对得上一个裸 key,于是阵容页整屏落到兜底词「这位伙伴」也照样绿
    // (2026-08-21 实测才发现)。
    for (const template of BOT_TEMPLATES) {
      const expected = template.gender === 'female' ? '她' : '他';
      expect(
        screen.getAllByText(`bots.roster.join:{"pronoun":"${expected}"}`).length,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(
      screen.getAllByText((text) => text.startsWith('bots.roster.join:')).length,
    ).toBe(BOT_TEMPLATES.length);
    // 阵容式创建没有名字 / 描述 / 身份表单。
    expect(screen.queryByText('bots.nameLabel')).toBeNull();
    expect(screen.queryByText('bots.descriptionLabel')).toBeNull();
    expect(screen.queryByLabelText('bots.createWizard.roleLabel')).toBeNull();
    expect(screen.getByText('bots.roster.footerHint')).toBeTruthy();
  });

  it('never paints an avatar sentinel as text', () => {
    renderRoster();
    expect(document.body.textContent).not.toContain('cindy://');
  });

  it('greys out a character that is already on the crew, and only that one', () => {
    mocks.profiles = [
      { id: 'bot-1', name: 'bots.createWizard.templates.cindy.name', status: 'active' },
      // 归档的伙伴不算数:那张卡必须还能再加回来。
      { id: 'bot-2', name: 'bots.createWizard.templates.shiba.name', status: 'archived' },
    ];
    renderRoster();

    expect(joinButtonFor('cindy').disabled).toBe(true);
    expect(joinButtonFor('cindy').textContent).toContain('bots.roster.joined');
    expect(joinButtonFor('shiba').disabled).toBe(false);
    expect(joinButtonFor('melody').disabled).toBe(false);
  });

  it('creates straight from the card, with that character\'s identity and capabilities', async () => {
    const { onCreated } = renderRoster();

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
    // 页面化之后没有「关掉浮层」这一步:创建成功就直接进 TA 的对话。
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'bot-new', name: 'Cindy' }));
  });

  it('parks the character greeting so the canonical chat can say hello', async () => {
    renderRoster();

    fireEvent.click(joinButtonFor('star'));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(peekPendingBotWelcome('bot-new')).toBe(getBotTemplate('star').welcomeKey),
    );
  });

  it('gives an ordinary assistant no event subscription', async () => {
    renderRoster();

    fireEvent.click(joinButtonFor('cindy'));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    expect(payload.avatar).toBe(CINDY_OFFICIAL_AVATAR);
    expect(payload.eventSubscription).toBeUndefined();
  });

  it('asks the blank card for a name and a face, and nothing else', async () => {
    renderRoster();

    openManualCustom();
    const submit = screen.getByRole('button', { name: /^bots.roster.join:/ }) as HTMLButtonElement;
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
    // 自己捏的伙伴不会冒出别人的台词,但也不能一句话不说 —— 阵容页脚注对所有
    // 创建路径都承诺了「加入后 TA 会先跟你打个招呼」。
    expect(peekPendingBotWelcomeEntry('bot-new')).toEqual({
      key: 'bots.welcome.generic',
      params: { name: 'Ops buddy' },
    });
  });

  it('hands the import link to the existing ?import=1 flow, not a second import path', () => {
    renderRoster();

    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.importLink' }));

    expect(mocks.navigate).toHaveBeenCalledWith('/bots?import=1');
  });

  it('gives only the first card a solid CTA — six solid buttons leave the page without a landing point', () => {
    renderRoster();

    const [first, ...rest] = BOT_TEMPLATES.map((template) => joinButtonFor(template.id));
    expect(first.className).toContain('bg-[var(--accent-cta-bg)]');
    for (const button of rest) {
      expect(button.className).not.toContain('bg-[var(--accent-cta-bg)]');
      expect(button.className).toContain('border-[var(--border-default)]');
    }
  });

  it('moves the solid CTA to the first card that can still be clicked', () => {
    // 第一张已加入时,实心按钮必须让位给下一张 —— 否则回头再看阵容的那一屏
    // 一个实心按钮都没有,恰好没了落点。
    mocks.profiles = [
      { id: 'bot-1', name: 'bots.createWizard.templates.cindy.name', status: 'active' },
    ];
    renderRoster();

    const [first, second, ...rest] = BOT_TEMPLATES.map((template) => joinButtonFor(template.id));
    expect(first.disabled).toBe(true);
    expect(first.className).not.toContain('bg-[var(--accent-cta-bg)]');
    expect(second.className).toContain('bg-[var(--accent-cta-bg)]');
    for (const button of rest) {
      expect(button.className).not.toContain('bg-[var(--accent-cta-bg)]');
    }
  });

  it('lays the character faces out flat on the blank card page — picking one costs no extra click', () => {
    renderRoster();
    openManualCustom();

    for (const id of BOT_PRESET_AVATAR_IDS) {
      expect(screen.getByRole('button', { name: `bots.avatarPicker.presets.${id}` })).toBeTruthy();
    }
    // 完整选择器（emoji + 底色）仍在，作为少数人的额外一格，不是必经的一次点击。
    expect(screen.getByRole('button', { name: 'bots.avatarPicker.open' })).toBeTruthy();
  });

  it('creates with the face the user picked on the blank card', async () => {
    renderRoster();
    openManualCustom();
    fireEvent.click(screen.getByRole('button', { name: 'bots.avatarPicker.presets.owl' }));
    fireEvent.change(
      screen.getByLabelText('bots.roster.customNameLabel', { selector: 'input' }),
      { target: { value: 'Ops buddy' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /^bots.roster.join:/ }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    expect(parsePresetAvatarId(mocks.addBotProfileAndWait.mock.calls[0][0].avatar)).toBe('owl');
  });
});

/*
  第 9 条:模板的「初始记忆」要在选卡那一刻真的落地,而不是停在定义里。
*/
describe('BotRosterView — 角色自带的开场笔记', () => {
  it('writes the character\'s own starting notes into its memory space on join', async () => {
    renderRoster();

    fireEvent.click(joinButtonFor('shiba'));

    await waitFor(() => expect(mocks.seedBotMemory).toHaveBeenCalledTimes(1));
    const [botId, entries] = mocks.seedBotMemory.mock.calls[0];
    expect(botId).toBe('bot-new');
    expect(entries).toEqual(botTemplateSeedEntries(getBotTemplate('shiba'), translate));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('lands the notes before the user can reach the settings page', async () => {
    const onCreated = vi.fn();
    let seedResolved = false;
    mocks.seedBotMemory.mockImplementation(async () => {
      seedResolved = true;
      return { written: 1, skipped: 0 };
    });
    renderRoster({ onCreated });

    fireEvent.click(joinButtonFor('melody'));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(seedResolved).toBe(true);
  });

  it('keeps the teammate when seeding fails — an empty list is honest, a rollback is not', async () => {
    const onCreated = vi.fn();
    mocks.seedBotMemory.mockRejectedValue(new Error('memory offline'));
    renderRoster({ onCreated });

    fireEvent.click(joinButtonFor('star'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'bot-new', name: 'Cindy' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not call the seed channel for a hand-made teammate with no notes', async () => {
    renderRoster();
    openManualCustom();
    fireEvent.change(screen.getByLabelText('bots.roster.customNameLabel', { selector: 'input' }), {
      target: { value: 'Ops buddy' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^bots.roster.join:/ }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    expect(mocks.seedBotMemory).not.toHaveBeenCalled();
  });
});

/*
  第 10 条:自定义路径先问一句「TA 是谁」,一句话换回一份可编辑的草稿。
  这一组钉三件事 —— 生成后能改、改完落库、失败必须说人话且「自己写」还在。
*/
describe('BotRosterView — 角色生成助手', () => {
  const askForRole = (role: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.customAction' }));
    fireEvent.change(screen.getByLabelText('bots.roster.generate.inputLabel'), {
      target: { value: role },
    });
    fireEvent.click(screen.getByRole('button', { name: /bots\.roster\.generate\.action/ }));
  };

  it('lands on the one-line question, with the manual path right beside it', () => {
    renderRoster();
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.customAction' }));

    expect(screen.getByText('bots.roster.generate.title')).toBeTruthy();
    expect(screen.getByLabelText('bots.roster.generate.inputLabel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.roster.generate.skip' })).toBeTruthy();
    // 空输入不发请求。
    expect(
      (screen.getByRole('button', { name: /bots\.roster\.generate\.action/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows an editable preview card instead of creating straight away', async () => {
    renderRoster();
    askForRole('设计师');

    await waitFor(() => expect(screen.getByText('bots.roster.generate.previewTitle')).toBeTruthy());
    expect(mocks.generateBotPersona).toHaveBeenCalledWith('设计师');
    // 生成 ≠ 创建:预览这一步不许碰库。
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
    expect(screen.getByText('先给三版')).toBeTruthy();
    expect(screen.getByText('走查后再交')).toBeTruthy();
  });

  it('creates from whatever the user left on the card, notes and all', async () => {
    renderRoster();
    askForRole('设计师');
    await waitFor(() => expect(screen.getByText('bots.roster.generate.previewTitle')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('bots.roster.customNameLabel'), {
      target: { value: '小橘' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.generate.confirm' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const payload = mocks.addBotProfileAndWait.mock.calls[0][0];
    expect(payload.name).toBe('小橘');
    expect(payload.description).toBe('你的设计搭子');
    expect(payload.identitySource).toContain('设计搭子');
    // 生成的伙伴照样能被向导读回来:三档口气在自己的 marker 段里。
    expect(payload.identitySource).toContain('<!--persona:v1:');
    expect(payload.capabilities).toBeDefined();
    await waitFor(() => expect(mocks.seedBotMemory).toHaveBeenCalledTimes(1));
    expect(mocks.seedBotMemory.mock.calls[0][1]).toHaveLength(2);
  });

  it('drops a starting note the user deleted on the card', async () => {
    renderRoster();
    askForRole('设计师');
    await waitFor(() => expect(screen.getByText('bots.roster.generate.previewTitle')).toBeTruthy());

    fireEvent.click(
      screen.getByRole('button', {
        name: 'bots.memoryList.deleteAria:{"title":"先给三版"}',
      }),
    );
    expect(screen.queryByText('先给三版')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.generate.confirm' }));
    await waitFor(() => expect(mocks.seedBotMemory).toHaveBeenCalledTimes(1));
    const entries = mocks.seedBotMemory.mock.calls[0][1];
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('走查后再交');
  });

  /*
    每一条失败都要说人话,而且「自己写」必须还在原地。点了没反应是这条链路最坏的
    结局 —— 用户会以为是自己点错了。
  */
  it.each([
    ['provider-not-ready', 'bots.roster.generate.errors.providerNotReady'],
    ['generation-failed', 'bots.roster.generate.errors.failed'],
    ['invalid-output', 'bots.roster.generate.errors.invalidOutput'],
  ])('gives a real sentence when generation fails with %s', async (code, key) => {
    mocks.generateBotPersona.mockResolvedValue({ ok: false, code });
    renderRoster();
    askForRole('设计师');

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(key));
    expect(screen.getByRole('button', { name: 'bots.roster.generate.skip' })).toBeTruthy();
    expect(screen.queryByText('bots.roster.generate.previewTitle')).toBeNull();
  });

  it('says so when the generation channel is missing entirely, rather than doing nothing', async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
      maker: { botMemory: { seed: mocks.seedBotMemory } },
    };
    renderRoster();
    askForRole('设计师');

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('bots.roster.generate.errors.unavailable'),
    );
  });

  it('keeps the hand-written path reachable from the question step', async () => {
    renderRoster();
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.customAction' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.generate.skip' }));

    expect(screen.getByLabelText('bots.roster.customNameLabel', { selector: 'input' })).toBeTruthy();
    expect(mocks.generateBotPersona).not.toHaveBeenCalled();
  });
});

/*
  「加入后 TA 会先跟你打个招呼」印在阵容页脚注上,那是对**每一条**创建路径的承诺。
  模板卡一直兑现;手捏与生成两条路在这一轮补齐,走的是同一条幂等注入通道。
*/
describe('BotRosterView — 每条路都打招呼', () => {
  it('uses the model\'s own opening line when the draft was left as generated', async () => {
    renderRoster();
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.customAction' }));
    fireEvent.change(screen.getByLabelText('bots.roster.generate.inputLabel'), {
      target: { value: '设计师' },
    });
    fireEvent.click(screen.getByRole('button', { name: /bots\.roster\.generate\.action/ }));
    await waitFor(() => expect(screen.getByText('bots.roster.generate.previewTitle')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.generate.confirm' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    expect(peekPendingBotWelcomeEntry('bot-new')).toMatchObject({
      text: GENERATED_DRAFT.greeting,
    });
  });

  /*
    模型那句开场白里念着生成时的名字。用户改了名之后再用它,TA 一进门就会自我
    介绍成一个不存在的人 —— 这时必须退回到带**当前**名字的模板句。
  */
  it('drops the generated line once the user renames the teammate', async () => {
    renderRoster();
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.customAction' }));
    fireEvent.change(screen.getByLabelText('bots.roster.generate.inputLabel'), {
      target: { value: '设计师' },
    });
    fireEvent.click(screen.getByRole('button', { name: /bots\.roster\.generate\.action/ }));
    await waitFor(() => expect(screen.getByText('bots.roster.generate.previewTitle')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('bots.roster.customNameLabel'), {
      target: { value: '小橘' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.roster.generate.confirm' }));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    const parked = peekPendingBotWelcomeEntry('bot-new');
    expect(parked?.text).toBeUndefined();
    expect(parked).toEqual({
      key: 'bots.welcome.withRole',
      params: { name: '小橘', description: GENERATED_DRAFT.description },
    });
  });

  it('leaves the shipped characters saying their own lines', async () => {
    renderRoster();
    fireEvent.click(joinButtonFor('shiba'));

    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1));
    expect(peekPendingBotWelcome('bot-new')).toBe(getBotTemplate('shiba').welcomeKey);
  });
});
