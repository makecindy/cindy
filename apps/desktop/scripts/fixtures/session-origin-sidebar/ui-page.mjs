import assert from 'node:assert/strict';

export default {
  name: 'session-origin-sidebar',
  entry: './fixture.tsx',
  viewport: { width: 780, height: 520 },
  real: 'SessionItem, SessionCard (list), SessionOriginMark, SessionOriginChip, OrcaRemoteLeadBadge, SidebarFilterPopover and filterSidebarTasks with real themes and translations',
  notCovered: 'Host SQLite persistence, remote device transport and navigation targets; uses representative fixture sessions.',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({ dataOwnerId: "fixture", isAuthenticated: false });',
    },
    'src/renderer/contexts/PrRefsContext': {
      partial: 'export const usePrRefsForSession = () => []; export const usePrActions = () => ({ registerPrConsumer: () => () => {} });',
    },
    'src/renderer/features/device-link/useDeviceLinkDeviceList': {
      partial: 'export const useDeviceLinkDeviceList = () => [];',
    },
    'src/renderer/features/device-link/useMachineSwitcher': {
      partial: "export const useEffectiveSelectedMachineId = () => 'all';",
    },
    'src/renderer/features/cc-agent/hooks/useRemoteHostProjectOrders': {
      partial: "export const useLocalHostProjectOrder = () => ({ snapshot: undefined }); export const useRemoteHostProjectOrders = () => ({ orders: new Map() }); export const projectOrderWriteScopeForSelection = () => ({ kind: 'viewer' }); export const controllerManualOrderForDevice = () => [];",
    },
    'src/renderer/features/scheduler/lib/scheduleSessionBinding': {
      partial: 'export const useSessionBoundSchedules = () => [];',
    },
    'src/renderer/features/bots/botFollowScopes': {
      partial: 'export const useSessionFollowers = () => []; export const useSessionDelegatingBot = () => null; export const matchesTaskCreators = () => true;',
    },
  },
  cases: {
    default: {
      about: 'Sidebar provenance icons for createdBySession and orcaRemoteLead, header chips, and unified automation + task-origin filters',
    },
  },
  async check(page, ui) {
    const textRows = page.locator('[data-testid="text-rows"] [data-session-id]');
    await textRows.first().waitFor();
    assert.equal(await textRows.count(), 5);
    assert.equal(await page.locator('[data-testid="text-rows"] [data-testid="session-origin-task-task-created"]').count(), 1);
    assert.equal(await page.locator('[data-testid="text-rows"] [data-testid="session-origin-orca-remote-orca-remote"]').count(), 1);
    assert.equal(await page.locator('[data-testid="text-rows"] [data-session-id="user-task"] [data-testid^="session-origin-"]').count(), 0);
    assert.equal(await page.getByTestId('session-header-origin-task-created').count(), 1);
    await ui.capture('before');

    await page
      .locator('button')
      .filter({ has: page.locator('svg.lucide-sliders-horizontal') })
      .click({ force: true });
    await page
      .getByRole('menuitem')
      .filter({ hasText: await ui.t('ccAgent.sidebar.hideHeading') })
      .first()
      .press('ArrowRight');
    await page
      .getByRole('menuitemcheckbox', { name: await ui.t('ccAgent.sidebar.hideOptions.automations'), exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="text-rows"] [data-session-id]').length === 3,
    );
    await page
      .getByRole('menuitemcheckbox', { name: await ui.t('ccAgent.sidebar.hideOptions.taskCreated'), exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="text-rows"] [data-session-id]').length === 2,
    );
    await ui.capture('filtered');
  },
};
