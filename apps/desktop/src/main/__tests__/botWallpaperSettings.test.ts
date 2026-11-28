/**
 * 伙伴壁纸引用的读取与广播。依据：makecindy/cindy#12542 评审（7bb1323）。
 * - docs/design-rules/wallpaper.md：font-only utility renderers never receive custom media
 *   URLs。广播此前按「外观读取窗口」放行，语音浮层这类只读字体的窗口也会收到全部伙伴的媒体 URL。
 * - engineering-conventions.md §8.5：IPC handler 不得新增同步 I/O。`get-bot-wallpapers`
 *   此前每次调用都 statSync，冷读还会同步读文件。
 * 覆盖缺口：此前没有测试覆盖这两条边界。最小失败输入：一份引用文件、一个 app-content 窗口和
 * 一个只读外观的工具窗口。Tier：unit，真实文件，替换 electron 与窗口判定。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: '', windows: [] as Array<{ appContent: boolean; webContents: { send: ReturnType<typeof vi.fn> } }> }));
vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  BrowserWindow: { getAllWindows: () => h.windows },
}));
vi.mock('../security/trustedAppRenderer.js', () => ({
  isTrustedAppRendererWindow: (win: { appContent: boolean }) => win.appContent,
}));

import { broadcastBotWallpapers, loadBotWallpapers, updateBotWallpapers } from '../bot-wallpaper-settings';

const url = (fill: string) => `cindy-media://client-wallpaper/${fill.repeat(64)}.webp`;

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-wallpaper-settings-test-'));
  h.windows = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('teammate wallpaper references', () => {
  it('serves reads without synchronous disk access, from memory after the first load', async () => {
    fs.writeFileSync(path.join(h.dir, 'bot-wallpapers.json'), JSON.stringify({ wallpapers: { 'bot-1': url('a') } }));
    const sync = [
      vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'openSync'),
    ];
    const open = vi.spyOn(fs.promises, 'open');
    expect(await loadBotWallpapers()).toEqual({ 'bot-1': url('a') });
    const reads = open.mock.calls.length;
    expect(await loadBotWallpapers()).toEqual({ 'bot-1': url('a') });
    expect(open.mock.calls.length).toBe(reads);
    for (const spy of sync) expect(spy).not.toHaveBeenCalled();
  });

  it('shows nothing for a missing file and picks up later writes', async () => {
    expect(await loadBotWallpapers()).toEqual({});
    await updateBotWallpapers((current) => ({ ...current, 'bot-2': url('b') }));
    expect(await loadBotWallpapers()).toEqual({ 'bot-2': url('b') });
  });

  // Review of 1cc6c34, engineering-conventions.md §8.4: a failed first read was cached as an
  // empty table, so teammates fell back to the global wallpaper until restart even after the
  // file became readable. Minimal input: unparseable file, then the same file repaired.
  it('does not cache a failed read: the next load sees the repaired file', async () => {
    const file = path.join(h.dir, 'bot-wallpapers.json');
    fs.writeFileSync(file, '{broken');
    expect(await loadBotWallpapers()).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ wallpapers: { 'bot-1': url('a') } }));
    expect(await loadBotWallpapers()).toEqual({ 'bot-1': url('a') });
  });

  // Review of 1cc6c34, §8.5: import and removal run in IPC handlers, so the write
  // transaction (strict read, atomic replace) must not block main with synchronous I/O.
  it('writes without synchronous disk access', async () => {
    await updateBotWallpapers(() => ({ 'bot-1': url('a') }));
    const sync = [
      vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'renameSync'), vi.spyOn(fs, 'mkdirSync'),
    ];
    await updateBotWallpapers((current) => ({ ...current, 'bot-2': url('b') }));
    expect(JSON.parse(await fs.promises.readFile(path.join(h.dir, 'bot-wallpapers.json'), 'utf8')))
      .toEqual({ wallpapers: { 'bot-1': url('a'), 'bot-2': url('b') } });
    for (const spy of sync) expect(spy).not.toHaveBeenCalled();
  });

  // Review of 00481ae, engineering-conventions.md §8.2: the write path read the table
  // leniently, so a parseable but damaged file became an empty table and the next import
  // rewrote it without the other teammates' references. Minimal input: `{"wallpapers":[]}`.
  it.each(['{"wallpapers":[]}', '[]', '{"wallpapers":{"bot-1":"file:///private.webp"}}'])(
    'refuses to rewrite a damaged reference table and leaves it untouched: %s',
    async (content) => {
      const file = path.join(h.dir, 'bot-wallpapers.json');
      fs.writeFileSync(file, content);
      await expect(updateBotWallpapers((current) => ({ ...current, 'bot-2': url('b') }))).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    },
  );

  it('broadcasts media URLs to app-content windows only', async () => {
    const appWindow = { appContent: true, webContents: { send: vi.fn() } };
    const fontOnlyWindow = { appContent: false, webContents: { send: vi.fn() } };
    h.windows = [appWindow, fontOnlyWindow];
    await updateBotWallpapers(() => ({ 'bot-1': url('c') }));
    expect(broadcastBotWallpapers()).toEqual({ 'bot-1': url('c') });
    expect(appWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(
      'appearance-settings:bot-wallpapers-changed', { 'bot-1': url('c') },
    );
    expect(fontOnlyWindow.webContents.send).not.toHaveBeenCalled();
  });
});
