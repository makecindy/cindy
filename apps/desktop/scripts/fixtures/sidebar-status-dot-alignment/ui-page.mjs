export default {
  name: 'sidebar-status-dot-alignment',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 520 },
  real: 'SidebarTopNav, ProjectsSection, SessionGroupNode, ProjectNode, DeviceSectionHeader, AutomationSessionGroupItem, SessionItem, SessionCard, TaskInbox and TeammateInboxRow',
  notCovered: 'Full desktop shell, live IPC remote-desktop capability checks and persisted sidebar preferences.',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({ dataOwnerId: "fixture", dataOwnerGeneration: 1, isAuthenticated: false });',
    },
    'src/renderer/contexts/PluginReviewUpdatesContext': {
      partial: 'export const usePluginReviewUpdates = () => ({ updates: [{ status: "approved", unread: true }] });',
    },
    'src/renderer/cindy-brain/useInstalledGhosts': {
      partial: 'export const useInstalledGhosts = () => []; export const readInstalledGhostsSnapshot = () => [];',
    },
    'src/renderer/cindy-brain/ghostUnreadStore': {
      partial: 'export const useAnyGhostUnread = () => false;',
    },
    'src/renderer/cindy-brain/ghostMainViews': {
      partial: 'export const useGhostMainViews = () => ({ declared: [], routeCapable: [], sidebarVisible: [] });',
    },
    'src/renderer/features/cc-agent/sidebar/conversationSearchContext': `export const useConversationSearchContext = () => ({
      search: { query: '', trimmed: '', lockedProjectKey: null, lockedSessionGroupName: null, setQuery: () => {}, resume: () => {}, clearLock: () => {}, status: 'idle', results: [], handleSelect: () => {} },
      allKnownProjects: [],
      openSignal: 0,
    });`,
    'src/renderer/features/device-link/useDeviceLinkDeviceList': {
      partial: `export const useDeviceLinkDeviceList = () => ([
        { deviceId: "remote-collapsed", name: "Studio", platform: "darwin", appVersion: "1", lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false },
        { deviceId: "remote-open", name: "Workstation", platform: "darwin", appVersion: "1", lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false },
      ]);
      export const useDeviceLinkDeviceListRequestState = () => ({ status: "ready", error: null });`,
    },
    'src/renderer/features/remote-desktop/useRemoteDesktopAvailability': {
      partial: 'export const useRemoteDesktopAvailability = () => ({ available: true, checking: false, retryable: false, retry: () => {}, markUnavailable: () => {} });',
    },
  },
  cases: {
    default: { about: 'Text mode: top nav, collapsed groups, project, automation group and task dots share one vertical column and swap on hover' },
    list: { about: 'List mode: collapsed groups, project, automation group and list task card dots share one vertical column' },
    devices: { about: 'Device grouping (text mode): local and remote collapsed device dots align with nested group/project/task dots and swap on hover' },
    'devices-list': { about: 'Device grouping (list mode): collapsed device dots align with list cards and folder rows' },
    'inbox-list': { about: 'Inbox list mode: TeammateInboxRow and SessionCard list dots align vertically' },
  },
  async ready(page) {
    await page.locator('[data-sidebar-right-status="done"]').first().waitFor();
  },
  async check(page, ui) {
    // Move pointer to neutral area so no row starts hovered.
    await page.mouse.move(4, 4);

    const measureDoneDots = async () =>
      page.evaluate(() => {
        const results = [];
        const seen = new Set();
        // Measure every green dot rendered in the sidebar (SidebarRightStatusIndicator,
        // AutomationSessionGroupItem inline dot, and SidebarTopNav AttentionDot).
        for (const el of document.querySelectorAll('span.rounded-full')) {
          const style = window.getComputedStyle(el);
          const isGreenDot =
            el.style.backgroundColor.includes('--card-status-done') ||
            el.className.includes('--card-status-done');
          if (!isGreenDot) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0 || Number(style.opacity) === 0) continue;
          if (seen.has(el)) continue;
          seen.add(el);
          const row = el.closest('[role="button"], button, [data-session-id]') ?? el.parentElement;
          const isTopNav = !el.closest('[data-sidebar-right-status]') && !el.closest('[role="img"]');
          results.push({
            kind: isTopNav ? 'top-nav' : 'right-status',
            label: (row?.textContent ?? '').trim().slice(0, 32),
            centerX: Math.round((rect.left + rect.width / 2) * 10) / 10,
            centerY: Math.round((rect.top + rect.height / 2) * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
          });
        }
        return results;
      });

    const dots = await measureDoneDots();
    const minCount = ui.case === 'inbox-list' ? 2 : 4;
    if (dots.length < minCount) {
      throw new Error(`Expected at least ${minCount} visible done dots, got ${dots.length}: ${JSON.stringify(dots)}`);
    }

    // In list mode, SidebarTopNav stays on pill-row geometry (2px right of list cards),
    // while all task-list rows/folders/device headers share one exact vertical column.
    const checked = (ui.case === 'list' || ui.case === 'devices-list')
      ? dots.filter((d) => d.kind === 'right-status')
      : dots;
    const xs = checked.map((d) => d.centerX);
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread > 1) {
      throw new Error(`Status dots are misaligned (spread=${spread}px): ${JSON.stringify(checked)}`);
    }

    await ui.capture('rest');

    // Verify hover-replacement on collapsed dialogue folder (when present).
    const dialogueLabel = await ui.t('ccAgent.sidebar.dialogues');
    const dialogueRow = page
      .locator('[role="button"][aria-expanded="false"]')
      .filter({ hasText: dialogueLabel })
      .first();
    if (await dialogueRow.count()) {
      const createBtn = dialogueRow.getByRole('button').first();
      const restPointer = await createBtn.evaluate((el) => window.getComputedStyle(el.parentElement).pointerEvents);
      if (restPointer !== 'none') {
        throw new Error(`Collapsed dialogue create button should be pointer-events:none at rest, got ${restPointer}`);
      }
      await dialogueRow.hover();
      await page.waitForTimeout(180);
      const hoverState = await dialogueRow.evaluate((row) => {
        const dot = row.querySelector('[data-sidebar-right-status="done"]');
        const btn = row.querySelector('button');
        return {
          dotOpacity: dot ? Number(window.getComputedStyle(dot.parentElement).opacity) : null,
          btnOpacity: btn ? Number(window.getComputedStyle(btn.parentElement).opacity) : null,
          btnPointer: btn ? window.getComputedStyle(btn.parentElement).pointerEvents : null,
        };
      });
      if (hoverState.dotOpacity !== 0 || hoverState.btnOpacity !== 1 || hoverState.btnPointer !== 'auto') {
        throw new Error(`Collapsed dialogue hover should swap dot for create button: ${JSON.stringify(hoverState)}`);
      }
      await ui.capture('hover-dialogue');
      await page.mouse.move(4, 4);
      await page.waitForTimeout(180);
    }

    // Verify hover-replacement on collapsed remote device header in device cases.
    if (ui.case === 'devices' || ui.case === 'devices-list') {
      const studioBtn = page.locator('button[aria-expanded="false"]').filter({ hasText: 'Studio' }).first();
      await studioBtn.hover();
      await page.waitForTimeout(180);
      const deviceHover = await studioBtn.evaluate((btn) => {
        const dot = btn.querySelector('[data-sidebar-right-status="done"]');
        const host = btn.parentElement;
        const actionBtn = host?.querySelector('button[data-device-header-action="true"]');
        return {
          dotOpacity: dot ? Number(window.getComputedStyle(dot.parentElement).opacity) : null,
          actionOpacity: actionBtn ? Number(window.getComputedStyle(actionBtn.parentElement).opacity) : null,
          actionPointer: actionBtn ? window.getComputedStyle(actionBtn.parentElement).pointerEvents : null,
        };
      });
      if (deviceHover.dotOpacity !== 0 || deviceHover.actionOpacity !== 1 || deviceHover.actionPointer !== 'auto') {
        throw new Error(`Collapsed device hover should swap dot for action buttons: ${JSON.stringify(deviceHover)}`);
      }
      await ui.capture('hover-device');
      await page.mouse.move(4, 4);
    }
  },
};
