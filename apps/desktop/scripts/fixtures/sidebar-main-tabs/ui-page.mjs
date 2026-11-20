import assert from 'node:assert/strict';
const devices = `[{deviceId:'rog',name:'Chris-ROG5090',status:'connected',online:true},{deviceId:'mini',name:'Chris的Mac mini',status:'connected',online:true},{deviceId:'studio',name:'Mac Studio',status:'connecting',online:false},{deviceId:'old',name:'Old PC',status:'connected',online:true}]`;
export default {
  name: 'sidebar-main-tabs',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 420 },
  route: '/cc-agent',
  real: 'SidebarMainTabs, MachineTabStrip, SessionItem',
  notCovered: 'Real device directory, session sync, remote desktop opening, organize popover',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth=()=>({dataOwnerId:"fixture",isAuthenticated:false});' },
    'src/renderer/features/device-link/useMachineSwitcher': {
      partial: `export const useMachineSwitcher=()=>({devices:${devices},selectedDeviceId:window.__uiPage.ctx.case==='selected-offline'?['studio']:'all',select(){},toggle(){},hasRemote:true});export const useRemoteSessionBootstrapLoading=()=>false;`,
    },
    'src/renderer/features/device-link/useDeviceLinkDeviceList': { partial: 'export const useDeviceLinkDeviceList=()=>[];export const useDeviceLinkDeviceListRequestState=()=>({status:"ready",error:null});' },
    'src/renderer/features/remote-desktop/useRemoteDesktopAvailability': 'export const useRemoteDesktopAvailability=()=>({available:false,checking:false,reason:null,retryable:false,retry(){},markUnavailable(){}});',
    'src/renderer/features/bots/BotCreateMenu': 'export const BotCreateMenu=()=>null;',
  },
  cases: {
    default: { about: 'Online computers with content only; offline and empty computers hidden' },
    'selected-offline': { about: 'The selected computer stays listed after it goes offline' },
    single: { about: 'Only this computer has content: no computer row' },
  },
  async check(page, ui) {
    const chips = await page.locator('[role=toolbar] button').allTextContents();
    if (ui.case === 'single') assert.deepEqual(chips, []);
    else if (ui.case === 'default') assert.deepEqual(chips.slice(2), ['Chris-ROG5090', 'Chris的Mac mini']);
    else assert.ok(chips.includes('Mac Studio'));
  },
};
