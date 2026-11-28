/**
 * 用户对「用插件打开文件」的开关(按物理安装实例)。
 *
 * 声明 `fileOpener` 的插件经整包安装/更新确认后默认接管;这里只记录用户主动关掉的实例。
 * 这是偏好,不是批准事实:关掉只让 Host 不再把文件交给它,不影响插件其它能力。
 * 文件:<owner userData>/plugin-file-openers.json,形如 { "<实例>": false }。
 */

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const store = createOverrideSettingsFile<Record<string, boolean>>({
  filePath: () => ownerScopedUserDataPath('plugin-file-openers.json'),
  defaults: {},
  normalize: (raw) =>
    Object.fromEntries(
      Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(
        ([key, value]) => key !== '__proto__' && typeof value === 'boolean',
      ),
    ),
  log: desktopMakerLogger.child('plugin-file-openers'),
  label: 'plugin-file-openers',
  preserveUnreadableFile: true,
});

export function isPluginFileOpenerEnabled(instance: string): boolean {
  store.invalidateIfChanged();
  return store.read()[instance] !== false;
}

export function setPluginFileOpenerEnabled(instance: string, enabled: boolean): void {
  store.writePatch({ [instance]: enabled });
}
