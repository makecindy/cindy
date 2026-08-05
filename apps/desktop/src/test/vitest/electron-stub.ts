import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';

const noop = () => undefined;
const asyncNoop = async () => undefined;
let memoizedTempRoot: string | null = null;

function getTempRoot(): string {
  if (memoizedTempRoot) {
    return memoizedTempRoot;
  }

  let baseDir = '/tmp';
  try {
    if (typeof os.tmpdir === 'function') {
      baseDir = os.tmpdir();
    }
  } catch {
    baseDir = '/tmp';
  }

  memoizedTempRoot = path.join(baseDir, 'xdt-maker-vitest-electron');
  return memoizedTempRoot;
}

function tempPath(name: string): string {
  return path.join(getTempRoot(), name);
}

function createEmitter<T extends object>(shape: T): T & EventEmitter {
  return Object.assign(new EventEmitter(), shape);
}

function createWebContents() {
  return createEmitter({
    id: 1,
    send: noop,
    sendInputEvent: noop,
    executeJavaScript: async () => undefined,
    insertCSS: async () => '',
    loadURL: asyncNoop,
    getURL: () => '',
    getTitle: () => '',
    isDestroyed: () => false,
    isLoading: () => false,
    openDevTools: noop,
    closeDevTools: noop,
    setWindowOpenHandler: noop,
    capturePage: async () => nativeImage.createEmpty(),
    printToPDF: async () => Buffer.from(''),
  });
}

export const app = createEmitter({
  commandLine: {
    appendSwitch: noop,
    appendArgument: noop,
    hasSwitch: () => false,
    getSwitchValue: () => '',
  },
  dock: {
    setBadge: noop,
    bounce: () => 0,
    cancelBounce: noop,
    hide: noop,
    show: asyncNoop,
  },
  isReady: () => true,
  whenReady: asyncNoop,
  getPath: (name: string) => tempPath(name),
  setPath: noop,
  getAppPath: () => process.cwd(),
  getName: () => 'XDMaker Test',
  setName: noop,
  getVersion: () => '0.0.0-test',
  configureWebAuthn: noop,
  setAppUserModelId: noop,
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: noop,
  setAsDefaultProtocolClient: () => true,
  removeAsDefaultProtocolClient: () => true,
  isDefaultProtocolClient: () => true,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: noop,
  setBadgeCount: () => true,
  getBadgeCount: () => 0,
  addRecentDocument: noop,
  clearRecentDocuments: noop,
  quit: noop,
  exit: noop,
  relaunch: noop,
  focus: noop,
});

export class BrowserWindow extends EventEmitter {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }

  static getFocusedWindow(): BrowserWindow | null {
    return null;
  }

  static fromWebContents(): BrowserWindow | null {
    return null;
  }

  static fromId(): BrowserWindow | null {
    return null;
  }

  readonly webContents = createWebContents();

  loadURL = asyncNoop;
  loadFile = asyncNoop;
  show = noop;
  hide = noop;
  close = noop;
  destroy = noop;
  focus = noop;
  blur = noop;
  maximize = noop;
  unmaximize = noop;
  minimize = noop;
  restore = noop;
  setMenu = noop;
  setMenuBarVisibility = noop;
  setTitle = noop;
  setBounds = noop;
  setSize = noop;
  setPosition = noop;
  setAlwaysOnTop = noop;
  setVisibleOnAllWorkspaces = noop;
  setFullScreen = noop;
  isDestroyed = () => false;
  isVisible = () => false;
  isMinimized = () => false;
  isMaximized = () => false;
  isFullScreen = () => false;
  getBounds = () => ({ x: 0, y: 0, width: 1024, height: 768 });
  getContentBounds = () => ({ x: 0, y: 0, width: 1024, height: 768 });
  getSize = (): [number, number] => [1024, 768];
  getPosition = (): [number, number] => [0, 0];
}

export const ipcMain = createEmitter({
  handle: noop,
  handleOnce: noop,
  removeHandler: noop,
  removeAllListeners: noop,
});

export const ipcRenderer = createEmitter({
  invoke: async () => undefined,
  send: noop,
  sendSync: () => undefined,
  postMessage: noop,
  removeAllListeners: noop,
});

export const shell = {
  openExternal: asyncNoop,
  openPath: async () => '',
  showItemInFolder: noop,
  trashItem: asyncNoop,
  beep: noop,
};

export const net = {
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, init),
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8'),
};

export const nativeImage = {
  createEmpty: () => ({
    isEmpty: () => true,
    toPNG: () => Buffer.from(''),
    toJPEG: () => Buffer.from(''),
    toBitmap: () => Buffer.from(''),
    resize: () => nativeImage.createEmpty(),
    getSize: () => ({ width: 0, height: 0 }),
  }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromBuffer: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
};

export const protocol = {
  registerSchemesAsPrivileged: noop,
  handle: noop,
  unhandle: noop,
  isProtocolHandled: async () => false,
  registerFileProtocol: () => true,
  registerBufferProtocol: () => true,
  registerStringProtocol: () => true,
  unregisterProtocol: asyncNoop,
};

export const clipboard = {
  readText: () => '',
  writeText: noop,
  readImage: () => nativeImage.createEmpty(),
  writeImage: noop,
  clear: noop,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: noop,
};

export const Menu = {
  buildFromTemplate: () => ({ popup: noop, closePopup: noop }),
  setApplicationMenu: noop,
  getApplicationMenu: () => null,
};

export const nativeTheme = createEmitter({
  shouldUseDarkColors: false,
  themeSource: 'system',
});

export const powerMonitor = createEmitter({
  getSystemIdleTime: () => 0,
  getSystemIdleState: () => 'active',
});

export const screen = createEmitter({
  getPrimaryDisplay: () => ({
    id: 1,
    bounds: { x: 0, y: 0, width: 1024, height: 768 },
    workArea: { x: 0, y: 0, width: 1024, height: 768 },
    scaleFactor: 1,
  }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
});

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return true;
  }

  show = noop;
  close = noop;
}

export const utilityProcess = {
  fork: () =>
    createEmitter({
      pid: 0,
      postMessage: noop,
      kill: () => true,
    }),
};

export const contextBridge = {
  exposeInMainWorld: noop,
};

export const webUtils = {
  getPathForFile: () => '',
};

export const powerSaveBlocker = {
  start: () => 1,
  stop: noop,
  isStarted: () => false,
};

export const systemPreferences = createEmitter({
  getMediaAccessStatus: () => 'not-determined',
  askForMediaAccess: async () => false,
  isTrustedAccessibilityClient: () => false,
  getUserDefault: () => undefined,
  setUserDefault: noop,
});

export const globalShortcut = {
  register: () => true,
  registerAll: noop,
  isRegistered: () => false,
  unregister: noop,
  unregisterAll: noop,
};

export const session = {
  defaultSession: createEmitter({
    protocol,
    webRequest: createEmitter({}),
    cookies: createEmitter({ get: async () => [], set: asyncNoop, remove: asyncNoop }),
    clearCache: asyncNoop,
    clearStorageData: asyncNoop,
  }),
  fromPartition: () => session.defaultSession,
};

export const webContents = {
  fromId: () => null,
  fromFrame: () => null,
  getAllWebContents: () => [],
};

export const crashReporter = {
  start: noop,
  addExtraParameter: noop,
  removeExtraParameter: noop,
  getParameters: () => ({}),
};

export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  shell,
  net,
  safeStorage,
  nativeImage,
  protocol,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
  powerMonitor,
  screen,
  Notification,
  utilityProcess,
  contextBridge,
  webUtils,
  powerSaveBlocker,
  systemPreferences,
  globalShortcut,
  session,
  webContents,
  crashReporter,
};
