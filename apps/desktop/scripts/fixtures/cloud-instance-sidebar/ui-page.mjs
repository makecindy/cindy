import assert from 'node:assert/strict';
export default {
  name: 'cloud-instance-sidebar',
  entry: './fixture.tsx',
  cases: {
    default: {
      about: 'Project area lists no separate cloud instance entries; an online instance header is any device header, with no cloud settings shortcut',
    },
  },
  viewport: { width: 320, height: 240 },
  real: 'ProjectsSection with device grouping, DeviceSectionHeader and the access provider',
  notCovered:
    'Synthetic device index; no sessions, projects, remote desktop, production credentials or cloud writes. Settings → Remote connections → Cloud instances is covered by the cloud-access page.',
  stubs: {
    'src/renderer/contexts/AuthContext':
      'export const useAuth=()=>({mode:"cloud",isAuthenticated:true,isInitializing:false,canEnterApp:true,dataOwnerId:"fixture-owner",dataOwnerGeneration:1});export const useOptionalAuthUser=()=>null;export const useOptionalAuthDeviceId=()=>null;export const useOptionalDataOwnerGeneration=()=>1;',
    'src/renderer/features/remote-desktop/useRemoteDesktopAvailability':
      'export const useRemoteDesktopAvailability=()=>({available:false,checking:false,reason:"remoteDesktop.shortcut.offline"});',
  },
  async ready(page) {
    await page.getByText('我的云端 Cindy').first().waitFor();
  },
  async check(page, ui) {
    const name = '我的云端 Cindy';
    // Cloud settings are opened from My devices, not the task sidebar. The header
    // renders as for any remote device: no settings link, at rest or on hover.
    assert.equal(await page.getByRole('link').count(), 0);
    await ui.capture('resting');
    await page.getByText(name).first().hover();
    assert.equal(await page.getByRole('link').count(), 0);
    await ui.capture('hover');
  },
};
