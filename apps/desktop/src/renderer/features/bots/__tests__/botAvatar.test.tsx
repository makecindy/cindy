// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { resetCompanionAvatarCacheForTests } from '../companionAvatarCache';

afterEach(() => {
  cleanup();
  resetCompanionAvatarCacheForTests();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

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

describe('Cloud companion avatar addresses', () => {
  const cloud = 'https://cdn.example.com/cindy/public/avatar/owner/793983c0-7ed4-47aa-9c00-000000000000.png';

  it('renders a public image address in avatar as artwork, never as text', () => {
    const { container } = render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(cloud);
    expect(container.textContent).toBe('');
  });

  it('falls back to the initial when the image cannot load', () => {
    const { container } = render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('M');
  });

  it('paints only a single grapheme as text', () => {
    for (const value of ['http://insecure.example/a.png', 'data:image/png;base64,AAAA', 'not an emoji']) {
      const { container } = render(<BotAvatar bot={{ name: 'Miao', avatar: value, avatarColor: 'violet' }} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe('M');
      cleanup();
    }
    const { container } = render(<BotAvatar bot={{ name: 'Miao', avatar: '🦊', avatarColor: 'violet' }} />);
    expect(container.textContent).toBe('🦊');
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

describe('Local copies of avatars held elsewhere', () => {
  const cloud = 'https://cdn.example.com/cindy/public/avatar/owner/793983c0.png';
  const copy = `cindy-media://blobs/${'c'.repeat(64)}.png`;
  const install = (resolve: (request: { avatar: string; deviceId?: string | null; fetch?: boolean }) => Promise<string | null>) => {
    const fn = vi.fn(resolve);
    Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: { maker: { resolveCompanionAvatar: fn } } });
    return fn;
  };

  it('shows the local copy first', async () => {
    install(async () => copy);
    const { container } = render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    // Lookup in progress: the tint only, no initial flashing before the image.
    expect(container.textContent).toBe('');
    await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(copy));
  });

  it('shows the original when nothing is cached yet and keeps a copy for next time', async () => {
    const resolve = install(async (request) => (request.fetch ? copy : null));
    const { container } = render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(cloud));
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ avatar: cloud, deviceId: null, fetch: true }));
    cleanup();
    // The next avatar of the same companion comes from this computer.
    const next = render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    expect(next.container.querySelector('img')?.getAttribute('src')).toBe(copy);
  });

  it('asks again on a later display when keeping a copy failed', async () => {
    let online = false;
    const resolve = install(async (request) => (request.fetch && online ? copy : null));
    render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ avatar: cloud, deviceId: null, fetch: true }));
    await vi.waitFor(() => expect(resolve.mock.results.length).toBe(2));
    await resolve.mock.results[1]!.value;
    cleanup();
    online = true;
    render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    await vi.waitFor(() => expect(resolve.mock.calls.filter(([request]) => request.fetch)).toHaveLength(2));
  });

  it('falls back to the original address when the local copy cannot load', async () => {
    install(async () => copy);
    const { container } = render(<BotAvatar bot={{ name: 'Miao', avatar: cloud, avatarColor: 'violet' }} />);
    await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(copy));
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(cloud);
    fireEvent.error(container.querySelector('img')!);
    expect(container.textContent).toBe('M');
  });

  it('asks for another computer\'s managed avatar with that computer', async () => {
    const managed = `cindy-media://blobs/${'d'.repeat(64)}.webp`;
    const resolve = install(async () => copy);
    render(<BotAvatar bot={{ name: 'Miao', avatar: managed, deviceId: 'laptop', avatarColor: 'violet' }} />);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ avatar: managed, deviceId: 'laptop' }));
  });
});
