// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

import {
  BOT_AVATAR_EMOJIS,
  BOT_AVATAR_HUES,
  BotAvatar,
  BotAvatarPicker,
  botAvatarAssignment,
  botAvatarInitial,
  botAvatarHueToken,
  normalizeBotAvatarHue,
} from '../BotAvatar';

afterEach(() => cleanup());

describe('Bot avatar hue family', () => {
  it('resolves every hue to a registered bot-avatar token', () => {
    for (const hue of BOT_AVATAR_HUES) {
      expect(botAvatarHueToken(hue)).toBe(`var(--bot-avatar-${hue}-bg)`);
    }
  });

  it('keeps the four legacy avatarColor values readable without a data migration', () => {
    for (const legacy of ['violet', 'blue', 'amber', 'graphite'] as const) {
      expect(normalizeBotAvatarHue(legacy)).toBe(legacy);
    }
    // graphite is the neutral step of the new family, not a chromatic guess.
    expect(botAvatarHueToken('graphite')).toBe('var(--bot-avatar-graphite-bg)');
  });

  it('never resolves an unknown or empty color to an unregistered token', () => {
    const empty = normalizeBotAvatarHue('');
    const unknown = normalizeBotAvatarHue('chartreuse');
    expect(BOT_AVATAR_HUES).toContain(empty);
    expect(BOT_AVATAR_HUES).toContain(unknown);
    // Unknown values stay deterministic instead of collapsing onto one hue.
    expect(normalizeBotAvatarHue('chartreuse')).toBe(unknown);
    expect(normalizeBotAvatarHue('VIOLET')).toBe('violet');
    expect(normalizeBotAvatarHue(undefined)).toBe('violet');
  });
});

describe('Bot avatar auto assignment', () => {
  it('gives the same name the same hue and emoji every time', () => {
    const first = botAvatarAssignment('Release Steward');
    const second = botAvatarAssignment('Release Steward');
    expect(second).toEqual(first);
    expect(BOT_AVATAR_HUES).toContain(first.hue);
    expect(BOT_AVATAR_EMOJIS).toContain(first.emoji as (typeof BOT_AVATAR_EMOJIS)[number]);
  });

  it('spreads different names over the family instead of always picking one', () => {
    const hues = new Set<string>();
    const emojis = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      const assignment = botAvatarAssignment(`bot-${index}`);
      hues.add(assignment.hue);
      emojis.add(assignment.emoji);
    }
    expect(hues.size).toBeGreaterThan(3);
    expect(emojis.size).toBeGreaterThan(3);
  });
});

describe('BotAvatar rendering', () => {
  it('paints a round tint from the token family and centers the emoji', () => {
    const { container } = render(
      <BotAvatar bot={{ name: 'Nova', avatar: '🚀', avatarColor: 'teal' }} size="sm" />,
    );
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.className).toContain('rounded-full');
    expect(mark.style.backgroundColor || mark.getAttribute('style')).toContain(
      'var(--bot-avatar-teal-bg)',
    );
    expect(mark.textContent).toBe('🚀');
  });

  it('falls back to the first grapheme of the name when no emoji is set', () => {
    const { container } = render(
      <BotAvatar bot={{ name: 'nova pilot', avatar: '', avatarColor: 'blue' }} />,
    );
    expect(container.textContent).toBe('N');
    expect(botAvatarInitial('  发布助手')).toBe('发');
    expect(botAvatarInitial('')).toBe('?');
  });
});

describe('BotAvatarPicker', () => {
  it('reports the picked emoji while keeping the current hue, and vice versa', () => {
    const onChange = vi.fn();
    render(
      <BotAvatarPicker name="Nova" avatar="🚀" avatarColor="teal" onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'bots.avatarPicker.open' }));

    fireEvent.click(
      screen.getByRole('button', { name: 'bots.chooseAvatar:{"avatar":"🧭"}' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ emoji: '🧭', hue: 'teal' });

    fireEvent.click(
      screen.getByRole('button', { name: 'bots.chooseAvatarColor:{"color":"pink"}' }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ emoji: '🚀', hue: 'pink' });
  });
});
