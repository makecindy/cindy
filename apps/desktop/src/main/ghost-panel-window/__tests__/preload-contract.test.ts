import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const preloadPath = path.resolve(
  process.cwd().endsWith(`${path.sep}apps${path.sep}desktop`)
    ? process.cwd()
    : path.join(process.cwd(), 'apps', 'desktop'),
  'src/preload/ghostPanelWindowPreload.ts',
);

const source = readFileSync(preloadPath, 'utf8').replace(/\r\n/g, '\n');

function balancedObject(start: number): string {
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
}

function objectBody(name: string): string {
  const match = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*:[ \\t]*\\{`, 'm').exec(source);
  return match ? balancedObject(match.index + match[0].length - 1) : '';
}

function keys(body: string): string[] {
  return [...body.matchAll(/^([ \t]*)([A-Za-z_$][\w$]*)[ \t]*:/gm)]
    .filter((match, _, all) => match[1].length === Math.min(...all.map((item) => item[1].length)))
    .map((match) => match[2]);
}

const topLevel = keys(balancedObject(source.indexOf("contextBridge.exposeInMainWorld('electronAPI'")));
const ghostPanelWindow = keys(objectBody('ghostPanelWindow'));
const ghosts = keys(objectBody('ghosts'));

describe('ghost panel preload contract', () => {
  it('exposes only the window chrome and media capabilities needed by the panel', () => {
    expect(topLevel).toEqual(expect.arrayContaining([
      'platform', 'preferredSystemLocale', 'windowMinimize', 'windowMaximize', 'windowClose',
      'appearanceSettings', 'localThemes', 'appShortcuts', 'theme',
      'onFullscreenChange', 'getFullscreenState',
      'copyMediaToClipboard', 'showItemInFolder', 'cacheMediaForSession',
      'openMediaWithDefaultApp', 'saveMediaAs', 'ghostPanelWindow', 'ghosts',
    ]));
  });

  it('does not expose unrelated privileged namespaces', () => {
    expect(topLevel).not.toEqual(expect.arrayContaining([
      'maker', 'agent', 'voiceInput', 'login', 'auth', 'settings', 'updater', 'chat',
      'session', 'processMonitor', 'rightSidebarWindow', 'rsbBrowserBridge', 'deviceLink',
    ]));
  });

  it('exposes the ghost panel lifecycle bridge', () => {
    expect(ghostPanelWindow).toEqual(expect.arrayContaining([
      'getStateSync', 'getState', 'open', 'setDetached', 'onStateChanged',
      'rendererReady', 'presentationReady', 'onVisibilityChanged',
      'onMinimizeRequested',
    ]));
  });

  it('exposes the panel runtime and unread bridge', () => {
    expect(ghosts).toEqual(expect.arrayContaining([
      'listSync', 'reload', 'setEnabled', 'resolvePanelMedia', 'runtimeStates',
      'onChanged', 'onRuntimeChanged', 'onPreviewMedia', 'unreadSync', 'clearUnread',
      'onBadge', 'onUnreadSnapshot',
    ]));
  });

  it('guards plugin mutations to the current detached panel id', () => {
    expect(source).toContain("new URLSearchParams(window.location.search).get('ghostPanelWindow')");
    expect(source).toContain('mutationErrorForGhostPanel(id)');
    expect(source).toContain("return ipcRenderer.invoke('maker:ghost-panel-window:open', ghostId);");
    expect(source).toContain("return ipcRenderer.invoke('maker:ghost-panel-window:set-detached', ghostId, detached);");
    expect(source).toContain("ipcRenderer.invoke('ghosts:reload', id)");
    expect(source).toContain("ipcRenderer.invoke('ghosts:set-enabled', id, enabled)");
    expect(source).toContain("return ipcRenderer.invoke('ghosts:clear-unread', id, seenAt);");
  });

  it('scopes unread snapshots and badge events to the current detached panel', () => {
    expect(source).toContain('onCurrentGhostBadge');
    expect(source).toContain('onCurrentGhostUnreadSnapshot');
    expect(source).toContain('if (ghostId !== currentGhostPanelId || typeof at !== \'number\') continue;');
    expect(source).toContain('if (candidate.ghostId !== currentGhostPanelId) return;');
    expect(source).toContain('if (candidate.ghostId !== currentGhostPanelId || typeof candidate.at !== \'number\') continue;');
  });

  it('uses shared lifecycle channel constants', () => {
    expect(source).toContain('GHOST_PANEL_WINDOW_RENDERER_READY_CHANNEL');
    expect(source).toContain('GHOST_PANEL_WINDOW_PRESENTATION_READY_CHANNEL');
    expect(source).toContain('GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL');
    expect(source).toContain('GHOST_PANEL_WINDOW_MINIMIZE_REQUESTED_CHANNEL');
  });
});
