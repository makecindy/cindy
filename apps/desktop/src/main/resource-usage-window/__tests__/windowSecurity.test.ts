import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../window.ts'), 'utf8');
const preloadSource = fs.readFileSync(
  path.resolve(__dirname, '../../../preload/resourceUsagePreload.ts'),
  'utf8',
);

describe('resource usage BrowserWindow security contract', () => {
  it('stays hidden and uses the dedicated preload with Electron isolation enabled', () => {
    expect(source).toContain('show: false');
    expect(source).toContain("path.join(__dirname, 'resourceUsagePreload.js')");
    expect(source).toContain('sandbox: true');
    expect(source).toContain('contextIsolation: true');
    expect(source).toContain('nodeIntegration: false');
    expect(source).toContain('webSecurity: true');
    expect(source).toContain('allowRunningInsecureContent: false');
    expect(source).toContain('navigateOnDragDrop: false');
    expect(source).not.toContain("once('ready-to-show'");
  });

  it('keeps the dedicated preload read-only outside resource-window actions', () => {
    expect(preloadSource).not.toContain('RESOURCE_USAGE_WINDOW_OPEN_CHANNEL');
    expect(preloadSource).not.toContain("ipcRenderer.invoke('appearance-settings:set-patch'");
    expect(preloadSource).not.toContain("ipcRenderer.invoke('appearance-settings:get'");
    expect(preloadSource).not.toContain("ipcRenderer.invoke('local-themes:list'");
    expect(preloadSource).not.toContain("ipcRenderer.send('update-set-relaunch-theme'");
  });
});
