import assert from 'node:assert/strict';
export default {
  name: 'cloud-instance-sidebar',
  entry: './fixture.tsx',
  cases: {
    'scope-menu': {
      about: 'The task scope menu offers remote connection settings, with sidebar settings on its own button',
    },
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
    if (ui.case === 'scope-menu') {
      const scope = page.getByRole('button', { name: await ui.t('ccAgent.sidebar.allSessions'), exact: false });
      await scope.hover();
      const settings = page.getByRole('button', { name: await ui.t('ccAgent.sidebar.organizeSidebar'), exact: false });
      await settings.click();
      await page.getByRole('menu').waitFor();
      assert.equal(await settings.getAttribute('aria-expanded'), 'true');
      await ui.capture('sidebar-settings');
      await page.keyboard.press('Escape');
      await scope.click();
      const menu = page.getByRole('menu');
      await menu.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.machineSwitcher.remoteSettings') }).waitFor();
      assert.equal(await menu.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.organizeSidebar') }).count(), 0);
      return;
    }
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
