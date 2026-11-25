import { beforeEach, describe, expect, it, vi } from 'vitest';
import { linuxDisplaySocket, openLinuxDisplay } from '../linuxDisplay';

const fixture = vi.hoisted(() => ({
  access: vi.fn(),
  stat: vi.fn(),
  exec: vi.fn(),
  info: { ino: 3, dev: 1, ctimeMs: 9, isSocket: () => true },
}));
vi.mock('node:fs/promises', () => ({ access: fixture.access, stat: fixture.stat }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: fixture.exec }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.access.mockResolvedValue(undefined);
  fixture.stat.mockResolvedValue(fixture.info);
  fixture.exec.mockResolvedValue({ stdout: '1280 800\n' });
});

describe('Linux display binding', () => {
  it.each([
    [{}, null],
    [{ DISPLAY: ':99' }, '/tmp/.X11-unix/X99'],
    [{ DISPLAY: ':99.0' }, '/tmp/.X11-unix/X99'],
    [{ DISPLAY: 'host:0' }, null],
    [{ DISPLAY: ':99; echo bad' }, null],
    [{ DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-0' }, null],
  ])('selects only an explicit local X11 display', (environment, expected) => {
    expect(linuxDisplaySocket(environment)).toBe(expected);
  });

  it('pins the display and strips unrelated credentials from the child environment', async () => {
    const environment = { DISPLAY: ':99', HOME: '/home/test', TOKEN: 'secret' };
    const display = await openLinuxDisplay(environment);
    expect(display.width).toBe(1280);
    expect(display.height).toBe(800);
    expect(fixture.exec).toHaveBeenCalledWith(
      '/usr/bin/xdotool',
      ['getdisplaygeometry'],
      expect.objectContaining({
        timeout: 1500,
        maxBuffer: 2048,
        env: expect.objectContaining({ DISPLAY: ':99' }),
      }),
    );
    expect(display.environment).not.toHaveProperty('TOKEN');
    environment.DISPLAY = ':100';
    await expect(display.current()).resolves.toBe(false);
    expect(display).not.toHaveProperty('command');
    expect(fixture.exec).toHaveBeenCalledOnce();
  });

  it.each(['ino', 'dev', 'ctimeMs'] as const)(
    'rejects a replacement X socket with changed %s',
    async (field) => {
      const display = await openLinuxDisplay({ DISPLAY: ':99' });
      fixture.stat.mockResolvedValue({ ...fixture.info, [field]: 100 });
      await expect(display.current()).resolves.toBe(false);
      expect(fixture.exec).toHaveBeenCalledOnce();
    },
  );

  it('sanitizes native command failures instead of forwarding stderr', async () => {
    fixture.exec.mockRejectedValue(new Error('private content in stderr'));
    await expect(openLinuxDisplay({ DISPLAY: ':99' })).rejects.toThrow(
      /^DESKTOP_INPUT_UNAVAILABLE$/,
    );
  });
});
