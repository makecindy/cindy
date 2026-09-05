// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

vi_mock_react_i18next();
function vi_mock_react_i18next() {
  return undefined;
}

import {
  BOT_AVATAR_HUES,
  BotAvatar,
  botAvatarAssignment,
  botAvatarInitial,
  botAvatarHueToken,
  isCindyAvatarSentinel,
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
  it('gives the same name the same hue every time, and never an auto character', () => {
    const first = botAvatarAssignment('Release Steward');
    const second = botAvatarAssignment('Release Steward');
    expect(second).toEqual(first);
    expect(BOT_AVATAR_HUES).toContain(first.hue);
    // A fresh Bot starts on the hue tint plus its name's initial — no
    // auto-assigned character or emoji.
    expect(first.emoji).toBe('');
  });

  it('spreads different names over the hue family instead of always picking one', () => {
    const hues = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      const assignment = botAvatarAssignment(`bot-${index}`);
      hues.add(assignment.hue);
      expect(assignment.emoji).toBe('');
    }
    expect(hues.size).toBeGreaterThan(3);
  });
});

describe('Managed Bot avatar images', () => {
  const managed = `cindy-media://blobs/${'a'.repeat(64)}.webp`;

  it('renders a managed image address as artwork', () => {
    render(<BotAvatar bot={{ name: 'Nova', avatar: managed, avatarColor: 'teal' }} />);
    expect(document.querySelector('img')?.getAttribute('src')).toBe(managed);
    expect(screen.queryByText(managed)).toBeNull();
  });

  it('falls back to the Bot initial when a managed blob cannot be decoded', () => {
    const { container } = render(
      <BotAvatar bot={{ name: 'Nova', avatar: managed, avatarColor: 'teal' }} />,
    );
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('N');
  });
});

describe('Reserved Cindy avatar sentinel', () => {
  it('recognizes the whole cindy://avatar/ namespace, case- and padding-insensitively', () => {
    for (const value of [
      'cindy://avatar/official',
      'cindy://avatar/preset/shiba',
      'cindy://avatar/future-mark',
      '  CINDY://AVATAR/Whatever  ',
    ]) {
      expect(isCindyAvatarSentinel(value)).toBe(true);
    }
  });

  it('resolves the three built-in teammate portraits as packaged artwork', () => {
    for (const id of ['cindy', 'lizi', 'dash']) {
      const { container } = render(
        <BotAvatar
          bot={{ name: id, avatar: `cindy://avatar/preset/${id}`, avatarColor: 'blue' }}
        />,
      );
      expect(container.querySelector('img')).not.toBeNull();
      cleanup();
    }
  });

  it('rejects everything outside the namespace', () => {
    for (const value of ['', '   ', '🤖', 'cindy://media/official', null, undefined]) {
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

  it('falls back to the initial for a sentinel this build cannot (or no longer) resolve', () => {
    // An older client meeting a preset a newer client minted — or any
    // now-unresolvable legacy sentinel (official mark, retired preset) — must
    // never paint the raw `cindy://avatar/…` string as if it were an emoji.
    for (const value of [
      'cindy://avatar/preset/unicorn',
      'cindy://avatar/official',
      'cindy://avatar/future-mark',
    ]) {
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
