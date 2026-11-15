import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LocalThemeWire } from '../../shared/local-themes';
import { convertVsCodeTheme } from '../../shared/theme-import';

export const OMARCHY_THEME_FILE = 'vscode-theme.json';

let lastGoodTheme: LocalThemeWire | null = null;

/** 只读，不写。 */
export function getOmarchyStateDir(): string {
  return path.join(os.homedir(), '.local', 'state', 'omarchy', 'current');
}

/** 未装则 null。 */
export function readOmarchyTheme(): LocalThemeWire | null {
  const dir = getOmarchyStateDir();
  if (!fs.statSync(path.join(dir, 'theme.name'), { throwIfNoEntry: false })) return null;
  const raw = fs.readFileSync(path.join(dir, 'theme', OMARCHY_THEME_FILE), 'utf8');
  const theme = convertVsCodeTheme(raw, 'Omarchy')?.themes[0];
  if (!theme) throw new Error(`${OMARCHY_THEME_FILE} is not a VS Code color theme`);
  lastGoodTheme = { id: 'omarchy', name: 'Omarchy', type: theme.type, colors: theme.colors };
  return lastGoodTheme;
}

/** 换主题间隙用。 */
export function lastGoodOmarchyTheme(): LocalThemeWire | null {
  return lastGoodTheme;
}

export function resetOmarchyThemeForTest(): void {
  lastGoodTheme = null;
}

/** 换主题后回调。 */
export function watchOmarchyTheme(onSwitch: () => void): fs.FSWatcher | null {
  const dir = getOmarchyStateDir();
  if (!fs.statSync(dir, { throwIfNoEntry: false })) return null;
  return fs.watch(dir, (_event, filename) => {
    if (filename === 'theme.name') onSwitch();
  });
}
