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
  BOT_PRESET_AVATAR_IDS,
  BOT_PRESET_AVATAR_SRC,
  BotAvatar,
  BotAvatarPicker,
  CINDY_OFFICIAL_AVATAR,
  CINDY_PRESET_AVATAR_PREFIX,
  botAvatarArtworkSrc,
  botAvatarAssignment,
  botAvatarInitial,
  botAvatarHueToken,
  isCindyAvatarSentinel,
  isCindyOfficialAvatar,
  normalizeBotAvatarHue,
  parsePresetAvatarId,
  presetAvatarValue,
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
  it('gives the same name the same hue and character every time', () => {
    const first = botAvatarAssignment('Release Steward');
    const second = botAvatarAssignment('Release Steward');
    expect(second).toEqual(first);
    expect(BOT_AVATAR_HUES).toContain(first.hue);
    // A new Bot starts as a shipped character, not a glyph on a disc.
    expect(parsePresetAvatarId(first.emoji)).not.toBeNull();
    expect(botAvatarArtworkSrc(first.emoji)).toBeTruthy();
  });

  it('spreads different names over the family instead of always picking one', () => {
    const hues = new Set<string>();
    const characters = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      const assignment = botAvatarAssignment(`bot-${index}`);
      hues.add(assignment.hue);
      characters.add(assignment.emoji);
    }
    expect(hues.size).toBeGreaterThan(3);
    expect(characters.size).toBeGreaterThan(3);
  });

  it('only ever hands out a character this build can resolve', () => {
    // The official portrait must stay an explicit template or user choice; an
    // auto-named Bot may not look like Cindy itself. And every minted sentinel
    // must resolve to bundled artwork — a value this build cannot draw would
    // degrade the Bot to its initial.
    for (let index = 0; index < 200; index += 1) {
      const { emoji } = botAvatarAssignment(`bot-${index}`);
      expect(isCindyOfficialAvatar(emoji)).toBe(false);
      const preset = parsePresetAvatarId(emoji);
      expect(preset).not.toBeNull();
      expect(BOT_PRESET_AVATAR_IDS).toContain(preset!);
    }
  });
});

describe('Shipped character presets', () => {
  it('ships artwork for every registered id', () => {
    for (const id of BOT_PRESET_AVATAR_IDS) {
      const src = BOT_PRESET_AVATAR_SRC[id];
      expect(src, `${id} must have bundled artwork`).toBeTruthy();
      expect(src).toContain(`bot-avatar-preset-${id}`);
      expect(botAvatarArtworkSrc(presetAvatarValue(id))).toBe(src);
    }
    expect(Object.keys(BOT_PRESET_AVATAR_SRC).sort()).toEqual([...BOT_PRESET_AVATAR_IDS].sort());
  });

  it('parses only ids this build knows, case- and space-insensitively', () => {
    expect(presetAvatarValue('shiba')).toBe('cindy://avatar/preset/shiba');
    expect(presetAvatarValue('shiba')).toBe(`${CINDY_PRESET_AVATAR_PREFIX}shiba`);
    expect(parsePresetAvatarId('cindy://avatar/preset/shiba')).toBe('shiba');
    expect(parsePresetAvatarId('  CINDY://AVATAR/PRESET/Owl  ')).toBe('owl');
    for (const value of [
      'cindy://avatar/preset/unicorn',
      'cindy://avatar/preset/',
      'cindy://avatar/preset',
      CINDY_OFFICIAL_AVATAR,
      'cindy://avatar/future-mark',
      '🤖',
      '',
      null,
      undefined,
    ]) {
      expect(parsePresetAvatarId(value), `${String(value)} must not parse`).toBeNull();
    }
  });

  it('keeps every preset inside the reserved namespace but out of the official mark', () => {
    for (const id of BOT_PRESET_AVATAR_IDS) {
      const value = presetAvatarValue(id);
      expect(isCindyAvatarSentinel(value)).toBe(true);
      expect(isCindyOfficialAvatar(value)).toBe(false);
    }
  });
});

describe('Cindy official avatar sentinel', () => {
  it('matches the official mark exactly, ignoring case and padding', () => {
    expect(CINDY_OFFICIAL_AVATAR).toBe('cindy://avatar/official');
    expect(isCindyOfficialAvatar(CINDY_OFFICIAL_AVATAR)).toBe(true);
    expect(isCindyOfficialAvatar('  cindy://avatar/official  ')).toBe(true);
    expect(isCindyOfficialAvatar('CINDY://AVATAR/Official')).toBe(true);
    // A value minted by a newer client is NOT Cindy herself: inheriting the
    // official portrait would brand an arbitrary Bot as official.
    expect(isCindyOfficialAvatar('cindy://avatar/future-mark')).toBe(false);
    expect(isCindyOfficialAvatar('cindy://avatar/preset/shiba')).toBe(false);
  });

  it('reserves the whole cindy://avatar/ namespace so no member is painted as text', () => {
    for (const value of [
      CINDY_OFFICIAL_AVATAR,
      'cindy://avatar/future-mark',
      'cindy://avatar/preset/unicorn',
      'CINDY://AVATAR/Whatever',
    ]) {
      expect(isCindyAvatarSentinel(value)).toBe(true);
    }
  });

  it('rejects everything outside the namespace', () => {
    for (const value of [
      '',
      '   ',
      '🤖',
      'cindy://avatar',
      'cindy://media/official',
      'https://example.com/cindy://avatar/official',
      null,
      undefined,
    ]) {
      expect(isCindyOfficialAvatar(value)).toBe(false);
      expect(isCindyAvatarSentinel(value)).toBe(false);
    }
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

  it('renders bundled artwork for the official sentinel and never the raw string', () => {
    const { container } = render(
      <BotAvatar
        bot={{ name: 'Cindy', avatar: CINDY_OFFICIAL_AVATAR, avatarColor: 'graphite' }}
        size="lg"
      />,
    );
    const mark = container.firstElementChild as HTMLElement;
    const image = mark.querySelector('img') as HTMLImageElement;
    expect(image).toBeTruthy();
    expect(image.getAttribute('src')).toContain('cindy-avatar-account');
    // Circle-cropped, filling the mark: same silhouette as an emoji avatar.
    expect(mark.className).toContain('rounded-full');
    expect(mark.className).toContain('overflow-hidden');
    expect(image.className).toContain('object-cover');
    expect(image.className).toContain('h-full');
    // The hue stays behind the image, so it never flashes white while decoding,
    // and the mark keeps the same a11y shape as the emoji version.
    expect(mark.getAttribute('style')).toContain('var(--bot-avatar-graphite-bg)');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(image.getAttribute('alt')).toBe('');
    expect(mark.textContent).toBe('');
  });

  it('renders bundled artwork for a character preset, cropped like the official mark', () => {
    const { container } = render(
      <BotAvatar
        bot={{ name: 'Sora', avatar: presetAvatarValue('whitecat'), avatarColor: 'teal' }}
      />,
    );
    const mark = container.firstElementChild as HTMLElement;
    const image = mark.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('src')).toContain('bot-avatar-preset-whitecat');
    expect(image.className).toContain('object-cover');
    expect(image.className).toContain('rounded-full');
    expect(mark.textContent).toBe('');
  });

  it('falls back to the initial for a sentinel this build cannot resolve', () => {
    // An older client meeting a preset a newer client minted must not point an
    // <img> at a missing bundle path, and must never paint `cindy://avatar/…`.
    for (const value of ['cindy://avatar/preset/unicorn', 'cindy://avatar/future-mark']) {
      const { container } = render(
        <BotAvatar bot={{ name: 'nova pilot', avatar: value, avatarColor: 'blue' }} />,
      );
      const mark = container.firstElementChild as HTMLElement;
      expect(mark.querySelector('img')).toBeNull();
      expect(mark.textContent).toBe('N');
      cleanup();
    }
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

  it('offers the official Cindy mark as the first cell of the character row', () => {
    const onChange = vi.fn();
    render(<BotAvatarPicker name="Nova" avatar="🚀" avatarColor="teal" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'bots.avatarPicker.open' }));

    const official = screen.getByRole('button', { name: 'bots.avatarPicker.official' });
    const firstCharacter = screen.getByRole('button', {
      name: `bots.avatarPicker.presets.${BOT_PRESET_AVATAR_IDS[0]}`,
    });
    const firstEmoji = screen.getByRole('button', {
      name: `bots.chooseAvatar:${JSON.stringify({ avatar: BOT_AVATAR_EMOJIS[0] })}`,
    });
    // First cell of the character row, and it renders artwork instead of a glyph.
    expect(official.parentElement).toBe(firstCharacter.parentElement);
    expect(official.parentElement?.firstElementChild).toBe(official);
    // Characters are their own section, above the emoji grid.
    expect(official.parentElement).not.toBe(firstEmoji.parentElement);
    expect(screen.getByText('bots.avatarPicker.charactersLabel')).toBeTruthy();
    expect(official.querySelector('img')?.getAttribute('src')).toContain('cindy-avatar-account');
    expect(official.textContent).toBe('');
    // Same selected-state treatment as an emoji cell.
    expect(official.getAttribute('aria-pressed')).toBe('false');
    expect(official.className).toContain('h-8');
    expect(official.className).toContain('rounded-lg');

    fireEvent.click(official);
    // Picking the official mark keeps the current hue, exactly like an emoji.
    expect(onChange).toHaveBeenLastCalledWith({ emoji: CINDY_OFFICIAL_AVATAR, hue: 'teal' });
  });

  it('offers every shipped character and reports the sentinel while keeping the hue', () => {
    const onChange = vi.fn();
    render(<BotAvatarPicker name="Nova" avatar="🚀" avatarColor="teal" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'bots.avatarPicker.open' }));

    for (const id of BOT_PRESET_AVATAR_IDS) {
      const cell = screen.getByRole('button', { name: `bots.avatarPicker.presets.${id}` });
      expect(cell.querySelector('img')?.getAttribute('src')).toContain(
        `bot-avatar-preset-${id}`,
      );
      expect(cell.textContent).toBe('');
      expect(cell.getAttribute('aria-pressed')).toBe('false');
      expect(cell.className).toContain('rounded-lg');

      fireEvent.click(cell);
      expect(onChange).toHaveBeenLastCalledWith({ emoji: presetAvatarValue(id), hue: 'teal' });
    }
  });

  it('marks the picked character pressed and shows its artwork on the trigger', () => {
    render(
      <BotAvatarPicker
        name="Sora"
        avatar={presetAvatarValue('melody')}
        avatarColor="violet"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'bots.avatarPicker.open' });
    expect(trigger.querySelector('img')?.getAttribute('src')).toContain(
      'bot-avatar-preset-melody',
    );
    expect(trigger.textContent).toBe('');

    fireEvent.click(trigger);
    const melody = screen.getByRole('button', { name: 'bots.avatarPicker.presets.melody' });
    expect(melody.getAttribute('aria-pressed')).toBe('true');
    expect(melody.className).toContain('bg-[var(--surface-chip)]');
    // Only one character is pressed, and the official mark is not one of them.
    expect(
      screen.getByRole('button', { name: 'bots.avatarPicker.presets.star' }).getAttribute(
        'aria-pressed',
      ),
    ).toBe('false');
    expect(
      screen.getByRole('button', { name: 'bots.avatarPicker.official' }).getAttribute(
        'aria-pressed',
      ),
    ).toBe('false');
  });

  it('marks the official cell pressed and shows the artwork on the trigger when selected', () => {
    render(
      <BotAvatarPicker
        name="Cindy"
        avatar={CINDY_OFFICIAL_AVATAR}
        avatarColor="graphite"
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'bots.avatarPicker.open' });
    expect(trigger.querySelector('img')).toBeTruthy();
    expect(trigger.textContent).toBe('');

    fireEvent.click(trigger);
    const official = screen.getByRole('button', { name: 'bots.avatarPicker.official' });
    expect(official.getAttribute('aria-pressed')).toBe('true');
    expect(official.className).toContain('bg-[var(--surface-chip)]');
  });
});
