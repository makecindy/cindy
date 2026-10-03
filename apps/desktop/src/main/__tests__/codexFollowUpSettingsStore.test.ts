import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }));
vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (
    _path: string,
    _options: unknown,
    run: (status: { held: boolean }) => Promise<unknown>,
  ) => run({ held: true }),
}));
import {
  readCodexFollowUpSettings,
  writeCodexFollowUpSettings,
} from '../maker-host/codex-follow-up-settings';

fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-follow-up-'));
afterAll(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
describe('Codex follow-up override persistence', () => {
  it('defaults to queue, retains explicit queue, persists steer and deletes overrides on reset', async () => {
    const file = path.join(fixture.directory, 'codex-follow-up-settings.json');
    expect(readCodexFollowUpSettings()).toMatchObject({
      value: { mode: 'queue' },
      isCustomized: false,
    });
    await writeCodexFollowUpSettings('queue');
    expect(readCodexFollowUpSettings()).toMatchObject({
      value: { mode: 'queue' },
      isCustomized: true,
    });
    expect(fs.existsSync(file)).toBe(true);
    await writeCodexFollowUpSettings('steer');
    expect(readCodexFollowUpSettings()).toMatchObject({
      value: { mode: 'steer' },
      isCustomized: true,
    });
    expect(fs.readFileSync(file, 'utf8')).toContain('steer');
    await writeCodexFollowUpSettings(null);
    expect(fs.existsSync(file)).toBe(false);
    expect(readCodexFollowUpSettings()).toMatchObject({
      value: { mode: 'queue' },
      isCustomized: false,
    });
  });
});
