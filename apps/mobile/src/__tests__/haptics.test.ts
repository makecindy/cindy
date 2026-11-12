// Unit: unsupported/older builds and native failures must not break the user's action.
// No existing test exercises the optional haptics bridge. Minimal failure: absent module.
import { beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ missing: false, play: vi.fn() }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => bridge.missing ? null : { play: bridge.play },
}));
import { playHaptic } from '@/platform/haptics';

beforeEach(() => {
  bridge.missing = false;
  bridge.play.mockReset().mockResolvedValue(true);
});
it('keeps older native builds and web silent', () => {
  bridge.missing = true;
  expect(() => playHaptic('commit')).not.toThrow();
  expect(bridge.play).not.toHaveBeenCalled();
});
it('passes each user intent once to the native hardware gate', () => {
  playHaptic('selection');
  playHaptic('commit');
  expect(bridge.play.mock.calls).toEqual([['selection'], ['commit']]);
});
it('does not retry or substitute a vibration when the native gate declines', async () => {
  bridge.play.mockResolvedValue(false);
  playHaptic('commit');
  await Promise.resolve();
  expect(bridge.play).toHaveBeenCalledTimes(1);
});
it('contains synchronous and asynchronous native failures', async () => {
  bridge.play.mockImplementationOnce(() => { throw new Error('bridge unavailable'); });
  expect(() => playHaptic('selection')).not.toThrow();
  bridge.play.mockRejectedValueOnce(new Error('hardware unavailable'));
  playHaptic('commit');
  await Promise.resolve();
  expect(bridge.play).toHaveBeenCalledTimes(2);
});
