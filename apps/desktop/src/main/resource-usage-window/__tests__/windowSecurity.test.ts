import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../window.ts'), 'utf8');
const controllerSource = fs.readFileSync(path.resolve(__dirname, '../controller.ts'), 'utf8');
const preloadSource = fs.readFileSync(
  path.resolve(__dirname, '../../../preload/resourceUsagePreload.ts'),
  'utf8',
);

describe('resource usage BrowserWindow security contract', () => {
  it('stays hidden and uses the dedicated preload with Electron isolation enabled', () => {
    expect(source).toContain('show: false');
    expect(source).not.toContain('fullscreen: false');
    expect(source).not.toContain('fullscreenable: false');
    expect(source).toContain("t('titleBar.menuItems.resourceUsage')");
    expect(source).toContain(
      "process.platform === 'darwin' || !parent || parent.isDestroyed() ? {} : { parent };",
    );
    expect(source).toContain("path.join(__dirname, 'resourceUsagePreload.js')");
    expect(source).toContain('sandbox: true');
    expect(source).toContain('contextIsolation: true');
    expect(source).toContain('nodeIntegration: false');
    expect(source).toContain('webSecurity: true');
    expect(source).toContain('allowRunningInsecureContent: false');
    expect(source).toContain('navigateOnDragDrop: false');
    expect(source).not.toContain("once('ready-to-show'");
  });

  it('only drives fullscreen to exit and uses the shared native-state broadcaster', () => {
    expect(controllerSource).toContain("win.once('leave-full-screen'");
    expect(controllerSource).toContain('win.setFullScreen(false)');
    expect(controllerSource).not.toContain('win.setFullScreen(true)');
    expect(controllerSource).toContain("win.on('enter-full-screen'");
    expect(source).toContain('installWindowFullscreenStateBroadcast(win');
    expect(source).toContain('screen.getDisplayMatching(bounds).bounds');
    expect(source).not.toContain("win.on('enter-full-screen'");
    expect(source).not.toContain("win.on('leave-full-screen'");
    expect(preloadSource).toContain('onFullscreenChange: fanOutFullscreenChange');
    expect(preloadSource).toContain(
      "getFullscreenState: (): Promise<boolean> => ipcRenderer.invoke('get-fullscreen-state')",
    );
  });

  it('keeps the dedicated preload read-only outside resource-window actions', () => {
    expect(preloadSource).not.toContain('RESOURCE_USAGE_WINDOW_OPEN_CHANNEL');
    expect(preloadSource).not.toContain("ipcRenderer.invoke('appearance-settings:set-patch'");
    expect(preloadSource).not.toContain("ipcRenderer.invoke('appearance-settings:get'");
    expect(preloadSource).not.toContain("ipcRenderer.invoke('local-themes:list'");
    expect(preloadSource).not.toContain("ipcRenderer.send('update-set-relaunch-theme'");
  });

  it('exposes the persisted-session hint so the first-launch light gate cannot lock dark users to light', () => {
    expect(preloadSource).toContain('authHasPersistedSessionHintSync');
    expect(preloadSource).toContain("ipcRenderer.sendSync('auth:has-persisted-session-hint-sync')");
  });
});
