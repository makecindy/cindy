/**
 * sidebarWindowPreload 闈欐€佸绾︽祴璇曘€?
 *
 * 楠岃瘉 RSB 涓撶敤 preload 鏆撮湶鐨?bridge 鏂规硶涓?SidebarWindowLayout + RightSidebarShell
 * 鍙婂叾渚濊禆鏍戠殑瀹為檯 window.electronAPI.* 璋冪敤瀹屽叏鍖归厤銆?
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PRELOAD_PATH = path.resolve(
  process.cwd().toLowerCase().endsWith((path.sep + 'apps' + path.sep + 'desktop').toLowerCase())
    ? process.cwd()
    : path.join(process.cwd(), 'apps', 'desktop'),
  'src/preload/sidebarWindowPreload.ts',
);

let source = '';
try {
  source = readFileSync(PRELOAD_PATH, 'utf-8').replace(/\r\n/g, '\n');
} catch {
  // skip on bundled builds
}

function exposedTopLevelKeys(src: string): string[] {
  const start = src.indexOf("contextBridge.exposeInMainWorld('electronAPI'");
  if (start < 0) return [];
  const open = src.indexOf('{', start);
  const body = open < 0 ? null : readBalancedObject(src, open);
  return body === null ? [] : objectKeys(body, 2);
}

function exposedNestedKeys(src: string, parent: string): string[] {
  const body = extractBlock(src, parent);
  return body === null ? [] : objectKeys(body);
}

function extractBlock(src: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\n)[ \\t]*${key}[ \\t]*:[ \\t]*\\{`, 'm');
  const match = re.exec(src);
  if (!match) return null;
  const open = src.indexOf('{', match.index + match[0].length - 1);
  return readBalancedObject(src, open);
}

function readBalancedObject(src: string, open: number): string | null {
  if (open < 0 || src[open] !== '{') return null;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < src.length; i += 1) {
    const char = src[i];
    const next = src[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function objectKeys(body: string, baseIndent?: number): string[] {
  const candidates = [...body.matchAll(/^([ \t]*)([A-Za-z_$][\w$]*)[ \t]*:/gm)];
  if (candidates.length === 0) return [];
  const indent = baseIndent ?? Math.min(...candidates.map((match) => match[1].length));
  return candidates
    .filter((match) => match[1].length === indent)
    .map((match) => match[2]);
}

const topLevel = exposedTopLevelKeys(source);
const rswKeys = exposedNestedKeys(source, 'rightSidebarWindow');
const deviceLinkKeys = exposedNestedKeys(source, 'deviceLink');
const mirrorCacheKeys = exposedNestedKeys(source, 'mirrorCache');
const localDbBody = extractBlock(source, 'localDb') ?? '';
const localDbKeys = objectKeys(localDbBody);
const rightSidebarTabsKeys = exposedNestedKeys(localDbBody, 'rightSidebarTabs');
const subagentRunsKeys = exposedNestedKeys(localDbBody, 'subagentRuns');
const orcaWorkflowKeys = exposedNestedKeys(localDbBody, 'orcaWorkflows');
const gitReviewKeys = exposedNestedKeys(source, 'gitReview');
const makerKeys = exposedNestedKeys(source, 'maker');
const iosSimulatorKeys = exposedNestedKeys(source, 'iosSimulator');
const fileBrowserKeys = exposedNestedKeys(source, 'fileBrowser');
const terminalKeys = exposedNestedKeys(source, 'terminal');
const processMonitorKeys = exposedNestedKeys(source, 'processMonitor');
const nativePopupKeys = exposedNestedKeys(source, 'rsbNativePopup');
const ghostKeys = exposedNestedKeys(source, 'ghosts');

describe('sidebarWindowPreload 椤跺眰濂戠害', () => {
  it('鏆撮湶 chrome 鑳藉姏', () => {
    expect(topLevel).toEqual(expect.arrayContaining(['platform']));
    expect(topLevel).toEqual(expect.arrayContaining(['windowMinimize']));
    expect(topLevel).toEqual(expect.arrayContaining(['windowMaximize']));
    expect(topLevel).toEqual(expect.arrayContaining(['windowClose']));
    expect(topLevel).toEqual(expect.arrayContaining(['logToMain']));
    expect(topLevel).toEqual(expect.arrayContaining(['appearanceSettings']));
    expect(topLevel).toEqual(expect.arrayContaining(['localThemes']));
    expect(topLevel).toEqual(expect.arrayContaining(['appShortcuts']));
    expect(topLevel).toEqual(expect.arrayContaining(['theme']));
    expect(topLevel).toEqual(expect.arrayContaining(['onFullscreenChange']));
    expect(topLevel).toEqual(expect.arrayContaining(['getFullscreenState']));
    expect(topLevel).toEqual(expect.arrayContaining(['search']));
  });

  it('鏆撮湶 AuthProvider 鎵€闇€鐨勬渶灏忚璇佺姸鎬?bridge', () => {
    expect(topLevel).toEqual(expect.arrayContaining([
      'authHasPersistedSessionHintSync',
      'authInitialize',
      'authGetLoginState',
      'authGetAccountDeletionAvailability',
      'authGetAccountDeletionStatus',
      'onAuthStateChange',
      'onAuthSessionExpired',
    ]));
    for (const key of [
      'authDispatchLoginAction',
      'authLogout',
      'authEnterLocal',
      'authExitLocal',
      'authRequestAccountDeletionChallenge',
      'authConfirmAccountDeletion',
      'authClearAccountDeletionReceipt',
      'authConsumeAccountDeletionRestoredNotice',
    ]) {
      expect(topLevel).not.toEqual(expect.arrayContaining([key]));
    }
  });

  it('鏆撮湶 rightSidebarWindow 鍛藉悕绌洪棿', () => {
    expect(topLevel).toEqual(expect.arrayContaining(['rightSidebarWindow']));
  });

  it('鏆撮湶 RSB tab 鎸佷箙鍖?+ browser bridge', () => {
    expect(topLevel).toEqual(expect.arrayContaining(['localDb']));
    expect(topLevel).toEqual(expect.arrayContaining(['rsbBrowserBridge']));
    expect(topLevel).toEqual(expect.arrayContaining(['onRsbBrowserCommand']));
    const browserKeys = exposedNestedKeys(source, 'rsbBrowserBridge');
    expect(browserKeys).toEqual(expect.arrayContaining([
      'report', 'release', 'snapshot', 'captureScreenshot', 'captureScreenshotData',
      'onPin', 'onUnpin', 'onTabOpRequest', 'tabOpResult', 'setActiveSession',
      'setForeground', 'forceKill', 'onResourceEvent',
    ]));
  });

  it('鏆撮湶鍒嗙鍙充晶鏍忓疄闄呮寕杞介潰鏉挎墍闇€鐨勬渶灏?bridge', () => {
    expect(topLevel).toEqual(expect.arrayContaining([
      'fileBrowser', 'terminal', 'gitReview', 'processMonitor', 'rsbNativePopup',
      'openExternal', 'openFileInBrowser', 'openPath', 'showItemInFolder',
      'copyMediaToClipboard', 'openMediaWithDefaultApp', 'saveMediaAs',
      'cacheMediaForSession', 'readImageBytes', 'readCachedImageAsBase64',
      'getFilePath', 'cacheImageFromBuffer', 'maker', 'localDb', 'ghosts',
    ]));
    expect(fileBrowserKeys).toEqual(expect.arrayContaining([
      'listDir', 'listAllFiles', 'readFile', 'writeFile', 'createFile', 'createFolder',
      'deleteEntry', 'renameEntry', 'stat', 'startWatch', 'stopWatch', 'onEvent',
      'fetchRemote', 'readCached', 'cachePut', 'onTransferProgress', 'chatFetch', 'chatStat',
    ]));
    expect(terminalKeys).toEqual(expect.arrayContaining([
      'create', 'write', 'resize', 'dispose', 'restart', 'onData', 'onExit',
    ]));
    expect(gitReviewKeys).toEqual(expect.arrayContaining([
      'get', 'summary', 'commits', 'commitDiff', 'branchDiff', 'fileDiff', 'imagePreview',
      'markdownPreview', 'openFile', 'stageFile', 'unstageFile', 'discardFile', 'stageHunk',
      'unstageHunk', 'discardHunk', 'stageAll', 'unstageAll', 'discardAll', 'commit', 'push',
    ]));
    expect(processMonitorKeys).toEqual(expect.arrayContaining([
      'subscribe', 'unsubscribe', 'terminate', 'onSample',
    ]));
    expect(nativePopupKeys).toEqual(expect.arrayContaining([
      'claim', 'setBounds', 'command', 'close', 'onEvent',
    ]));
    expect(ghostKeys).toEqual(expect.arrayContaining([
      'listSync', 'reload', 'setEnabled', 'resolvePanelMedia', 'runtimeStates',
      'onChanged', 'onRuntimeChanged', 'onPreviewMedia',
      'unreadSync', 'clearUnread', 'onBadge', 'onUnreadSnapshot',
    ]));
  });

  it('涓嶆毚闇?maker / agent / voice / login 鑷不鑳藉姏', () => {
    const forbidden = [
      'agent', 'voiceInput', 'login', 'settings',
      'updater', 'chat', 'session',
      'resourceUsageWindow', 'ghostPanelWindow',
      'pluginMarket', 'deepLink', 'gitContext',
      'safeStorageStore', 'safeStorageRead', 'safeStorageRemove',
    ];
    for (const key of forbidden) {
      expect(topLevel).not.toEqual(expect.arrayContaining([key]));
    }
    for (const key of [
      'install', 'uninstall', 'inspect', 'devRuntime', 'devCall',
      'approve', 'revokeApproval', 'setCindyPref', 'listCardsBySession',
    ]) {
      expect(ghostKeys).not.toEqual(expect.arrayContaining([key]));
    }
  });

  it('RSB browser bridge contract', () => {
    const browserKeys = exposedNestedKeys(source, 'rsbBrowserBridge');
    expect(browserKeys).toEqual(expect.arrayContaining([
      'report', 'release', 'snapshot', 'captureScreenshot', 'captureScreenshotData',
      'onPin', 'onUnpin', 'onTabOpRequest', 'tabOpResult', 'setActiveSession',
      'setForeground', 'forceKill', 'onResourceEvent',
    ]));
  });
});

describe('deviceLink 閺堚偓鐏忓繗绻欑粙瀣╃窗鐠囨繃藟閹?', () => {
  it('閸欘亝姣氶棁鑼剁箼缁嬪绱扮拠婵嗗灙鐞涖劋绗岄梹婊冨剼缂傛挸鐡ㄩ幍鈧棁鈧懗钘夊', () => {
    expect(topLevel).toEqual(expect.arrayContaining(['deviceLink']));
    expect(deviceLinkKeys).toEqual(expect.arrayContaining([
      'getState', 'listDevices', 'invoke', 'subscribe', 'unsubscribe',
      'onPresenceChanged', 'onStatusChanged', 'onRemotePush', 'onAccessRevoked',
      'onControlTargetChanged', 'onResponsivenessChanged', 'mirrorCache',
    ]));
    expect(mirrorCacheKeys).toEqual(expect.arrayContaining([
      'getMessages', 'putMessages', 'getSessionList', 'putSessionList', 'clear',
    ]));
  });

  it('娑撳秵姣氶棁鑼额啎婢跺洨顓搁悶鍡曠瑢閺夊啴妾?mutation', () => {
    for (const key of [
      'setEnabled', 'setKeepAwake', 'setDeviceControlEnabled', 'renameDevice',
      'deleteDevice', 'openLink', 'closeLink', 'disconnectAll', 'revoke', 'restore',
    ]) {
      expect(deviceLinkKeys).not.toEqual(expect.arrayContaining([key]));
    }
  });
});

describe('rightSidebarWindow 鍛藉悕绌洪棿', () => {
  it('rightSidebarWindow namespace contract', () => {
    expect(rswKeys).toEqual(expect.arrayContaining(['getState']));
    expect(rswKeys).toEqual(expect.arrayContaining(['open']));
    expect(rswKeys).toEqual(expect.arrayContaining(['close']));
    expect(rswKeys).toEqual(expect.arrayContaining(['setDetached']));
    expect(rswKeys).toEqual(expect.arrayContaining(['getContext']));
    expect(rswKeys).toEqual(expect.arrayContaining(['ready']));
    expect(rswKeys).toEqual(expect.arrayContaining(['rendererReady']));
    expect(rswKeys).toEqual(expect.arrayContaining(['presentationReady']));
    expect(rswKeys).toEqual(expect.arrayContaining(['refreshContext']));
    expect(rswKeys).toEqual(expect.arrayContaining(['onStateChanged']));
    expect(rswKeys).toEqual(expect.arrayContaining(['onContextChanged']));
    expect(rswKeys).toEqual(expect.arrayContaining(['onTabHandoff']));
    expect(rswKeys).toEqual(expect.arrayContaining(['onCommand']));
    expect(rswKeys).toEqual(expect.arrayContaining(['sendCommand']));
    expect(rswKeys).toEqual(expect.arrayContaining(['onVisibilityChanged']));
  });
});

describe('sidebar nested namespace contract', () => {
  it('localDb nested namespace contract', () => {
    expect(localDbKeys).toEqual(
      expect.arrayContaining(['sessions', 'messages', 'rightSidebarTabs', 'subagentRuns']),
    );
    expect(exposedNestedKeys(localDbBody, 'sessions')).toEqual(
      expect.arrayContaining(['get', 'list', 'resolveReferences', 'ackInterrupted']),
    );
    expect(exposedNestedKeys(localDbBody, 'messages')).toEqual(
      expect.arrayContaining([
        'list', 'around', 'aroundClientId', 'estimatedSessionValue',
        'onCreated', 'onDeleted', 'onErrorPersisted',
      ]),
    );
    expect(rightSidebarTabsKeys).toEqual(expect.arrayContaining([
      'list', 'ensureSingleton', 'upsert', 'close', 'setActive', 'reorder',
    ]));
    expect(subagentRunsKeys).toEqual(expect.arrayContaining(['list', 'detail', 'onChanged']));
    expect(orcaWorkflowKeys).toEqual(expect.arrayContaining([
      'getByLeadSession', 'getByWorkerSession', 'listWorkersByLead', 'listWorkersByLeads',
      'createWorker', 'switchFocus', 'idleWorker', 'archiveWorker', 'endTeam',
      'getCollaborationSettings', 'onOrcaWorkerChanged',
    ]));
  });
  it('maker capability contract', () => {
    expect(makerKeys).toEqual(expect.arrayContaining([
      'getTurnChangeSets', 'getWorkflowProgress', 'listSessionBackgroundTasks', 'stopAgentTask',
      'getPendingInteractions',
      'iosSimulator',
    ]));
    expect(iosSimulatorKeys).toEqual(expect.arrayContaining([
      'requestAccess', 'status', 'call', 'setAgentControl', 'setMutationControl',
      'setViewerVisibility', 'retryNativeRoute', 'latestFrame', 'setStreamProfile', 'liveTouch',
      'onH264Frame', 'onRouteStatus', 'onFocusRequest',
    ]));
  });
});
