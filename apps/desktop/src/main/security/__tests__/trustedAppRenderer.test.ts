/** trustedAppRenderer.test — 高权限 IPC 只接受 Cindy 自有顶层页面。 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
}));

import { markAppContentWindow } from '../../windowFocusClassifier';
import {
  isTrustedAppRendererEventForLocation,
  isTrustedAppRendererUrl,
  isTrustedAppRendererWindowForLocation,
} from '../trustedAppRenderer';

const packagedRendererFile = path.resolve('/Applications/Cindy/resources/app/renderer/index.html');
const packagedOptions = { devServerUrl: null, packagedRendererFile };

function fakeEvent(url: string, options: { child?: boolean } = {}) {
  const mainFrame = { url, parent: null };
  const senderFrame = options.child ? { url, parent: mainFrame } : mainFrame;
  const sender = { mainFrame };
  return { sender, senderFrame } as never;
}

describe('trustedAppRenderer · URL', () => {
  it('正式包只接受精确的 renderer index 文件，可带 query/hash', () => {
    const url = new URL(pathToFileURL(packagedRendererFile));
    url.searchParams.set('secondaryWindow', '1');
    url.hash = '/cc-agent/boot';
    expect(isTrustedAppRendererUrl(url.toString(), packagedOptions)).toBe(true);
    expect(isTrustedAppRendererUrl('file:///etc/passwd', packagedOptions)).toBe(false);
    expect(isTrustedAppRendererUrl('https://attacker.example/index.html', packagedOptions)).toBe(
      false,
    );
  });

  it('开发模式只接受配置的 Vite 同源页面', () => {
    const options = {
      devServerUrl: 'http://127.0.0.1:5173/',
      packagedRendererFile,
    };
    expect(isTrustedAppRendererUrl('http://127.0.0.1:5173/#/plugins', options)).toBe(true);
    expect(isTrustedAppRendererUrl('http://127.0.0.1:5174/#/plugins', options)).toBe(false);
    expect(isTrustedAppRendererUrl('https://127.0.0.1:5173/#/plugins', options)).toBe(false);
  });
});

describe('trustedAppRenderer · sender frame', () => {
  it('登记过的 Cindy 窗口顶层 frame 才通过', () => {
    const win = { isDestroyed: () => false };
    markAppContentWindow(win as never);
    electronMocks.fromWebContents.mockReturnValue(win);
    const event = fakeEvent(pathToFileURL(packagedRendererFile).toString());

    expect(isTrustedAppRendererEventForLocation(event, packagedOptions)).toBe(true);
    expect(
      isTrustedAppRendererEventForLocation(
        fakeEvent(pathToFileURL(packagedRendererFile).toString(), { child: true }),
        packagedOptions,
      ),
    ).toBe(false);
  });

  it('未登记窗口或已经导航到外部地址时拒绝', () => {
    electronMocks.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    expect(
      isTrustedAppRendererEventForLocation(
        fakeEvent(pathToFileURL(packagedRendererFile).toString()),
        packagedOptions,
      ),
    ).toBe(false);

    const win = { isDestroyed: () => false };
    markAppContentWindow(win as never);
    electronMocks.fromWebContents.mockReturnValue(win);
    expect(
      isTrustedAppRendererEventForLocation(fakeEvent('https://attacker.example/'), packagedOptions),
    ).toBe(false);
  });
});

/**
 * 出站推送(webContents.send)与入站 IPC 是同一道授权边界。载荷带用户私密内容时
 * (如插件未读摘要:工单标题、邮件主题),拿 getAllWindows() 无条件广播就是把它
 * 发给所有窗口,包括已经导航到别处的那些。
 */
describe('trustedAppRenderer · 窗口级判据(出站推送用)', () => {
  const fakeWindow = (url: string) =>
    ({ isDestroyed: () => false, webContents: { mainFrame: { url } } }) as never;

  it('登记过且停在 renderer 页的窗口才可收推送', () => {
    const win = fakeWindow(pathToFileURL(packagedRendererFile).toString());
    markAppContentWindow(win);
    expect(isTrustedAppRendererWindowForLocation(win, packagedOptions)).toBe(true);
  });

  it('已导航到别处的窗口不可收 —— 这正是内容泄漏面', () => {
    const win = fakeWindow('https://attacker.example/index.html');
    markAppContentWindow(win);
    expect(isTrustedAppRendererWindowForLocation(win, packagedOptions)).toBe(false);
  });

  it('未登记的窗口、已销毁的窗口、null 一律不可收', () => {
    const unregistered = fakeWindow(pathToFileURL(packagedRendererFile).toString());
    expect(isTrustedAppRendererWindowForLocation(unregistered, packagedOptions)).toBe(false);

    const destroyed = {
      isDestroyed: () => true,
      webContents: { mainFrame: { url: pathToFileURL(packagedRendererFile).toString() } },
    } as never;
    markAppContentWindow(destroyed);
    expect(isTrustedAppRendererWindowForLocation(destroyed, packagedOptions)).toBe(false);

    expect(isTrustedAppRendererWindowForLocation(null, packagedOptions)).toBe(false);
    expect(isTrustedAppRendererWindowForLocation(undefined, packagedOptions)).toBe(false);
  });
});
