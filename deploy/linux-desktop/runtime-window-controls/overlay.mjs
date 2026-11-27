import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { addImports } from '../overlay-imports.mjs';

const virtualId = 'virtual:cindy-cloud-main-window-controls';
const resolvedId = '\0' + virtualId;
const policy = fs.readFileSync(new URL('./policy.mjs', import.meta.url), 'utf8');
const bootstrap = 'apps/desktop/src/main/bootstrap-electron.ts';
const preload = 'apps/desktop/src/preload/preload.ts';
const renderer = 'apps/desktop/src/renderer/components/title-bar/WindowControls.tsx';
export const targets = [bootstrap, preload, renderer];

function once(code, before, after) {
  assert.equal(code.split(before).length, 2, `Cloud window integration changed: ${before.slice(0, 100)}`);
  return code.replace(before, after);
}

export function transformCloudWindowSource(code, relativePath) {
  if (!targets.includes(relativePath)) return null;
  assert.ok(!code.includes('cloudMainWindowControls'), 'Cloud window overlay must not be injected twice');
  if (relativePath === bootstrap) {
    code = addImports(code, relativePath, [`import { createCloudMainWindowControls, CLOUD_MAIN_WINDOW_ARGUMENT } from '${virtualId}';`]);
    code = once(code, 'let isQuitting = false;', `let isQuitting = false;
const cloudMainWindowControls = createCloudMainWindowControls({
  enabled: () => process.platform === 'linux' && getInstanceConfig() !== null,
  mainWindow: () => mainWindowRef,
  isQuitting: () => isQuitting,
});`);
    code = once(code,
      "        createWindowBackdropMaterialArgument(winBackdropConfig.backgroundMaterial ?? 'none'),",
      "        createWindowBackdropMaterialArgument(winBackdropConfig.backgroundMaterial ?? 'none'),\n        ...(process.platform === 'linux' && getInstanceConfig() ? [CLOUD_MAIN_WINDOW_ARGUMENT] : []),");
    code = once(code, "  mainWindow.on('close', (event) => {\n    if (isQuitting) return;",
      "  mainWindow.on('close', (event) => {\n    if (isQuitting) return;\n    if (cloudMainWindowControls.preventClose(event)) return;");
    // The Dock restores a minimized window, so the minimize IPC stays unchanged.
    // Blocked before the close-once branch too: on Linux it can quit the app.
    code = once(code, "  ipcMain.on('window-close', (event, once: unknown) => {\n    const win = BrowserWindow.fromWebContents(event.sender);",
      "  ipcMain.on('window-close', (event, once: unknown) => {\n    const win = BrowserWindow.fromWebContents(event.sender);\n    if (cloudMainWindowControls.blocksAction(win)) return;");
  } else if (relativePath === preload) {
    code = addImports(code, relativePath, [`import { hasCloudMainWindowControls } from '${virtualId}';`]);
    code = once(code, '  platform: process.platform,',
      '  platform: process.platform,\n  cloudMainWindowControls: hasCloudMainWindowControls(process.argv, process.platform),');
  } else {
    // Presentation hint supplied only by the managed main window's preload.
    // Keep this contract local to the cloud build; no client API/type changes.
    code = once(code, '  const closingRef = useRef(false);', `  const closingRef = useRef(false);
  const managedMainWindow = (window.electronAPI as typeof window.electronAPI & {
    cloudMainWindowControls?: boolean;
  }).cloudMainWindowControls === true;`);
    code = once(code, '      onClose ||', '      managedMainWindow ||\n      onClose ||');
    code = once(code, '  }, [onClose]);', '  }, [managedMainWindow, onClose]);');
    code = once(code, '        {closing ? (', '        {!managedMainWindow && (closing ? (');
    code = once(code, '        )}\n      </div>\n      <ConfirmDialog', '        ))}\n      </div>\n      <ConfirmDialog');
  }
  return code;
}

export function cloudMainWindowControlsPlugin({ sourceRoot, onTransform = () => {} }) {
  assert.ok(path.isAbsolute(sourceRoot));
  return {
    name: 'cindy-cloud-main-window-controls',
    enforce: 'pre',
    resolveId(id) { return id === virtualId ? resolvedId : null; },
    load(id) { return id === resolvedId ? policy : null; },
    transform(code, id) {
      const relative = path.relative(sourceRoot, id).split(path.sep).join('/');
      const transformed = transformCloudWindowSource(code, relative);
      if (transformed === null) return null;
      onTransform({ relativePath: relative, beforeSha256: createHash('sha256').update(code).digest('hex'), afterSha256: createHash('sha256').update(transformed).digest('hex') });
      return { code: transformed, map: null };
    },
  };
}
