import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type FakePlayer = {
  uri: string;
  played: number;
  released: number;
  listeners: Array<(status: { didJustFinish: boolean }) => void>;
};
const players = vi.hoisted(() => [] as FakePlayer[]);
vi.mock('expo-audio', () => ({
  createAudioPlayer: (uri: string) => {
    const player: FakePlayer = { uri, played: 0, released: 0, listeners: [] };
    players.push(player);
    return {
      play: () => {
        player.played += 1;
      },
      release: () => {
        player.released += 1;
      },
      addListener: (_event: string, listener: (status: { didJustFinish: boolean }) => void) => {
        player.listeners.push(listener);
        return {
          remove: () => {
            player.listeners = player.listeners.filter((item) => item !== listener);
          },
        };
      },
    };
  },
}));

import {
  MOBILE_VOICE_END_CUES,
  MOBILE_VOICE_INTERACTION_NOTE,
  mobileVoiceCueGain,
  playMobileVoiceInputEndCue,
} from '@/session/mobileVoiceCue';

/** RMS of the played WAV in consecutive 10 ms windows. */
function playedEndCueLevels(): number[] {
  playMobileVoiceInputEndCue();
  const bytes = Buffer.from(players.at(-1)!.uri.split(',')[1], 'base64');
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) / 2);
  const window = 441;
  const levels: number[] = [];
  for (let start = 0; start + window <= pcm.length; start += window) {
    let energy = 0;
    for (let i = start; i < start + window; i++) energy += pcm[i] * pcm[i];
    levels.push(Math.sqrt(energy / window));
  }
  return levels;
}

const desktopCueSource = readFileSync(
  resolve(__dirname, '../../../desktop/src/renderer/voice-input/startCue.ts'),
  'utf8',
);

describe('mobile voice cue', () => {
  it('uses the same interaction note as desktop', () => {
    const block =
      desktopCueSource.match(/const interactionNote: VoiceInputCue = \{([\s\S]*?)\};/)?.[1] ?? '';
    const desktopNote = Object.fromEntries(
      [...block.matchAll(/(\w+): ([\d.]+)/g)].map(([, key, value]) => [key, Number(value)]),
    );
    expect(MOBILE_VOICE_INTERACTION_NOTE).toEqual(desktopNote);
  });

  it('plays the note, then the same note a minor third lower after 140 ms', () => {
    const [first, second] = MOBILE_VOICE_END_CUES;
    expect(first).toEqual(MOBILE_VOICE_INTERACTION_NOTE);
    expect(second.delay).toBe(0.14);
    expect(second.fromFrequency / first.fromFrequency).toBeCloseTo(2 ** (-3 / 12), 10);
    expect(second.toFrequency / first.toFrequency).toBeCloseTo(2 ** (-3 / 12), 10);
  });

  it('renders two distinct notes 140 ms apart, starting immediately like desktop', () => {
    const levels = playedEndCueLevels();
    const loud = levels
      .map((level, index) => (level > 1000 ? index : -1))
      .filter((index) => index >= 0);
    expect(loud[0]).toBe(0);
    expect(loud).toContain(14);
    expect(Math.max(...levels.slice(8, 14))).toBeLessThan(100);
  });

  it('keeps the player alive until playback finishes, then releases it once', () => {
    vi.useFakeTimers();
    try {
      playMobileVoiceInputEndCue();
      const player = players.at(-1)!;
      expect(player.played).toBe(1);
      expect(player.released).toBe(0);
      player.listeners.forEach((listener) => listener({ didJustFinish: false }));
      expect(player.released).toBe(0);
      player.listeners.forEach((listener) => listener({ didJustFinish: true }));
      expect(player.released).toBe(1);
      vi.advanceTimersByTime(5_000);
      expect(player.released).toBe(1);

      // A player that never reports completion is still released eventually.
      playMobileVoiceInputEndCue();
      const stuck = players.at(-1)!;
      vi.advanceTimersByTime(5_000);
      expect(stuck.released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows desktop exponential attack, body and decay', () => {
    const note = MOBILE_VOICE_INTERACTION_NOTE;
    expect(mobileVoiceCueGain(note, 0)).toBeCloseTo(0.0001, 6);
    expect(mobileVoiceCueGain(note, note.attack)).toBeCloseTo(note.volume, 6);
    expect(mobileVoiceCueGain(note, note.decayAt)).toBeCloseTo(note.bodyVolume, 6);
    expect(mobileVoiceCueGain(note, note.duration)).toBeCloseTo(0.0001, 6);
  });
});
