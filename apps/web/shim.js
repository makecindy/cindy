/**
 * Browser shim for the renderer's `window.electronAPI`.
 *
 * The renderer is reused unchanged: this module publishes the same shape and
 * forwards the channels the host implements to the loopback HTTP API, using the
 * HttpOnly cookie obtained through explicit browser pairing. Unknown actions
 * reject with `HOST_CHANNEL_UNSUPPORTED`; optional reads retain fallback shapes
 * for renderer boot. Shared routes are defined by host-channel-contract.
 */

import { createHostChannelHandlers, unsupportedHostChannel } from '@cindy/maker-shared/host-channel-contract';
import { startHostEventStream } from '@cindy/maker-shared/host-event-stream';

(function installCindyHostShim() {
  // Polyfill Web Crypto randomUUID in insecure contexts (e.g. plain HTTP over LAN IP).
  // Modern browsers (Firefox, Chromium) gate crypto.randomUUID behind [SecureContext],
  // leaving it undefined when Cindy Host is accessed over LAN http://<ip>:<port>.
  if (typeof window !== 'undefined') {
    if (!window.crypto) {
      window.crypto = {};
    }
    if (typeof window.crypto.randomUUID !== 'function') {
      window.crypto.randomUUID = function() {
        if (typeof window.crypto.getRandomValues === 'function') {
          return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, function(c) {
            return (+c ^ (window.crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16);
          });
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          var r = (Math.random() * 16) | 0;
          var v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      };
    }
  }

  // Polyfill clipboard copy in insecure contexts where navigator.clipboard is unavailable.
  if (typeof navigator !== 'undefined') {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        const fallbackClipboard = {
          writeText: function(text) {
            return new Promise(function(resolve, reject) {
              try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(ta);
                if (ok) resolve();
                else reject(new Error('copy_command_failed'));
              } catch (e) {
                reject(e);
              }
            });
          }
        };
        try {
          Object.defineProperty(navigator, 'clipboard', {
            value: fallbackClipboard,
            configurable: true,
            writable: true,
          });
        } catch {
          // If defineProperty fails on navigator, attach to fallback object
          navigator.clipboard = fallbackClipboard;
        }
      }
    } catch {}
  }

  const pending = new Map();

  /**
   * The Desktop's own settings, inlined when the host serves this page. They
   * come from the same files the Desktop main process reads, so the browser and
   * the client show one copy instead of two. Writes below go back to those same
   * files through the host, which is why this is a mirror and not a store.
   */
  const boot = window.__cindyBoot ?? {};
  const settingsMirror = {
    appearance: boot.appearance ?? {},
    layout: boot.layout ?? null,
    analytics: boot.analytics ?? {},
    appShortcuts: boot.appShortcuts ?? { overrides: {}, platform: 'linux' },
    sidebar: boot.sidebar ?? { pinnedOrder: [], hiddenProjectKeys: [], hiddenMainViewGhostIds: [] },
    voiceInput: boot.voiceInput ?? { settings: {}, history: [] },
  };
  const ownerStamp = () => ({
    dataOwnerId: boot.auth?.ownerId ?? null,
    ownerGeneration: 1,
  });
  const pinnedOrder = () => Array.from(settingsMirror.sidebar.pinnedOrder ?? []);
  function saveSidebar(next) {
    settingsMirror.sidebar = { ...settingsMirror.sidebar, ...next };
    return rpc('/settings/sidebar/set', { value: settingsMirror.sidebar }).then((saved) => {
      if (saved && typeof saved === 'object') settingsMirror.sidebar = saved;
      return settingsMirror.sidebar;
    });
  }
  function requireOwner() {
    if (!ownerStamp().dataOwnerId) throw new Error('sidebar settings require an active account');
  }

  async function requestHost(path, args, method = 'POST', signal) {
    const headers = { 'content-type': 'application/json' };
    const response = await fetch(path, {
      method,
      signal,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(args ?? null),
      credentials: 'same-origin',
    });
    if (!response.ok) {
      if (response.status === 401) eventConnection?.authorizationRequired();
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(detail || `host ${path} failed`), { code: `HTTP_${response.status}` });
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  const rpc = (path, args) => requestHost(`/api${path}`, args);
  const hostChannels = createHostChannelHandlers(requestHost);

  /**
   * Frozen singletons for the channels the host answers with a constant.
   * Several renderer stores compare snapshots by identity; a fresh object per
   * read makes React re-render forever (#185).
   */
  const STATIC = Object.freeze({
    remoteDesktopState: Object.freeze({ enabled: false, active: null }),
    ghosts: Object.freeze({ ghosts: [] }),
    ghostRecommendations: Object.freeze({ items: [] }),
    layout: Object.freeze({ layout: null }),
    sidebarSettings: Object.freeze({
      dataOwnerId: null, ownerGeneration: 0,
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: Object.freeze([]), hiddenProjectKeys: Object.freeze([]),
      hiddenMainViewGhostIds: Object.freeze([]),
    }),
    pluginRuns: Object.freeze({ runs: [] }),
    emptyList: Object.freeze([]),
    memorySettings: Object.freeze({ maker: true, claudeCode: true, codex: true, pi: true }),
    gitSafetyOff: Object.freeze({ mode: 'off' }),
    claimDenied: Object.freeze({ claimed: false }),
    emptyOverrides: Object.freeze({}),
    emptyRecord: Object.freeze({}),
    botGroupsEmpty: Object.freeze({ ok: true, groups: Object.freeze([]) }),
    deviceLinkState: Object.freeze({
      remoteControlEnabled: false, keepAwake: false, linkStatus: 'stopped',
      connectionIssue: null, standby: false,
      controlledBy: Object.freeze([]), revokedControllers: Object.freeze([]),
      disabledControlDeviceIds: Object.freeze([]), unresponsiveDeviceIds: Object.freeze([]),
    }),
    voiceNotReady: Object.freeze({
      ok: false, serviceMode: Object.freeze({}), provider: 'openai-realtime-whisper',
      providerModel: '', auth: 'api-key', settingsTab: 'api-keys', error: 'not_available_on_host',
    }),
    rightSidebarTabs: Object.freeze({ tabs: Object.freeze([]), activeTabId: null }),
    localThemes: Object.freeze({ success: true, themes: Object.freeze([]), diagnostics: Object.freeze([]) }),
    ghostsUnread: Object.freeze({ entries: Object.freeze([]) }),
    ghostRecentUsage: Object.freeze({ ids: Object.freeze([]) }),
    companionCloud: Object.freeze({ enabled: false, selfDeviceId: null, humanActorId: null, actors: Object.freeze([]), demotedBotIds: Object.freeze([]) }),
    pluginMarketSnapshot: Object.freeze({ items: Object.freeze([]), unavailableReason: null, customSourceNames: Object.freeze([]), unavailableCustomSourceNames: Object.freeze([]), organizationAccessError: null }),
    workdirPrefs: Object.freeze({ disabled: Object.freeze([]) }),
    localCliDetections: Object.freeze({ detections: Object.freeze([]) }),
    llamaCppStatus: Object.freeze({ installed: false, supported: false, running: false, models: Object.freeze([]) }),
    localModelStatus: Object.freeze({ runtime: 'ollama', kind: 'not-installed', appInstalled: false }),
    creditUsage: Object.freeze({
      available: '0',
      plan: Object.freeze({ remaining: '0', used: null, total: null }),
      purchased: Object.freeze({ remaining: '0', used: null, total: null }),
      promotional: Object.freeze({ remaining: '0', used: null, total: null }),
      promotionalGrants: Object.freeze([]),
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED',
      ledgerUpdatedAt: null,
      scale: 9,
      observedAt: '2026-11-06T00:00:00.000Z',
    }),
    billingOrders: Object.freeze({ orders: Object.freeze([]), nextCursor: null }),
    billingSubscription: Object.freeze({ subscription: null }),
    billingCatalog: Object.freeze({ products: Object.freeze([]), plans: Object.freeze([]) }),
    billingBalance: Object.freeze({ available: '0' }),
    deviceLinkDevices: Object.freeze({ devices: Object.freeze([]) }),
    remoteSshHosts: Object.freeze({ hosts: Object.freeze([]) }),
    usageHistory: Object.freeze({
      generatedAt: Date.now(),
      todayKey: '2026-11-06',
      estimatesPending: false,
      days: Object.freeze([]),
      modelDaily: Object.freeze([]),
      models: Object.freeze([]),
      streak: Object.freeze({ current: 0, longest: 0 }),
      totals: Object.freeze({
        today: Object.freeze({ currency: 'CNY', amount: 0, text: '¥0.00' }),
        last30Days: Object.freeze({ currency: 'CNY', amount: 0, text: '¥0.00' }),
        last30DaysWithEstimatedValue: Object.freeze({ currency: 'CNY', amount: 0, text: '¥0.00' }),
        last30DaysEstimatedValue: Object.freeze({ currency: 'CNY', amount: 0, text: '¥0.00' }),
        todayTokens: 0,
        last30DaysTokens: 0,
      }),
      anomaly: Object.freeze({ isAnomalous: false, trailing7DayAvg: null }),
      devices: Object.freeze([]),
      taskDaily: Object.freeze([]),
      tasks: Object.freeze([]),
    }),
    visionBridgeSettings: Object.freeze({
      enabled: false,
      targetModels: Object.freeze([]),
      primary: null,
      fallback: null,
      isCustomized: false,
      customizedKeys: Object.freeze([]),
      defaults: Object.freeze({ enabled: false, targetModels: Object.freeze([]), primary: null, fallback: null }),
    }),
    mediaStorageStats: Object.freeze({
      success: true,
      blobs: Object.freeze({ totalCount: 0, totalBytes: 0, cacheCount: 0, cacheBytes: 0 }),
      legacy: Object.freeze({ bytes: 0, fileCount: 0 }),
      fixedCaches: Object.freeze({
        legacyImages: Object.freeze({ bytes: 0, fileCount: 0 }),
        chatAttachments: Object.freeze({ bytes: 0, fileCount: 0 }),
      }),
      deadDirs: Object.freeze([]),
    }),
    piKernelState: Object.freeze({
      currentVersion: null,
      restartRequired: false,
      official: Object.freeze({ release: null, checkedAt: null, error: false }),
      upstream: Object.freeze({ release: null, checkedAt: null, error: false }),
      operation: null,
    }),
    voiceModelSelection: Object.freeze({ serviceMode: null, asrProvider: null, refinerProvider: null, refinerModel: null }),
    appShortcuts: Object.freeze({ overrides: Object.freeze({}), platform: 'linux', globalFailures: Object.freeze([]) }),
  });

  function accountSwitcherSnapshot() {
    const user = window.__cindyBoot?.auth?.user;
    if (!user) return { accounts: [], mutationAllowed: false };
    return {
      accounts: [{
        accountKey: String(user.id ?? 'owner'),
        displayName: user.name ?? 'Cindy',
        email: user.email ?? null,
        avatarUrl: user.avatar ?? null,
        kind: user.membershipKind === 'org' ? 'org' : 'personal',
        orgName: user.orgName ?? null,
        orgLogoUrl: user.orgLogoUrl ?? null,
        isCurrent: true,
      }],
      mutationAllowed: false,
    };
  }

  // Channel table: electronAPI paths the host actually implements.
  const routes = {
    // Browser Files have no privileged host path. Keep the synchronous preload
    // shape so the composer reports its existing unsupported-upload message,
    // rather than sending a Promise as a filesystem path.
    'getFilePath': () => '',
    'maker.openSessionInNewWindow': ([sessionId, deviceId]) => {
      if (typeof sessionId !== 'string' || !sessionId || deviceId) {
        return unsupported('maker.openSessionInNewWindow');
      }
      const url = new URL(location.href);
      url.hash = `/cc-agent/${encodeURIComponent(sessionId)}`;
      window.open(url.href, '_blank', 'noopener,noreferrer');
    },
    ...hostChannels,
    'hostConnection.retry': () => eventConnection?.reconnect(),
    // Host-side telemetry sink: the browser already logs to its console.
    'logToMain': (args) => {
      const [, scope, message] = args ?? [];
      window.__cindyErrors?.push(`${scope}: ${String(message).slice(0, 400)}`);
      return undefined;
    },
    // Startup diagnostics are telemetry: the preload sends them and ignores the
    // result, so the browser must not answer with a rejected promise.
    'reportStartupGateStall': () => undefined,
    // Boot-time snapshot; the host has no microphone permission surface.
    // Voice settings/history come from owners/<key>/voice-input-data.v1.json.
    'voiceInput.getDataSnapshot': () => settingsMirror.voiceInput,
    // Renderer boot gates: answer with the host defaults instead of stalling.
    'maker.send': async (args) => {
      const [sessionId, message, createOpts] = args ?? [];
      const prompt = typeof message === 'string' ? message : (message?.content ?? '');
      const body = {
        prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        workDir: createOpts?.workingDir,
        model: createOpts?.model,
        agentKind: createOpts?.agentKind ?? 'claude-code',
      };
      const headers = { 'content-type': 'application/json' };
        const response = await fetch('/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      if (!response.ok || !response.body) return { accepted: false, reason: `HTTP_${response.status}` };
      void (async () => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            const payload = line.slice(6);
            if (payload === '{}') continue;
            try { emit('maker.onEvent', JSON.parse(payload)); } catch { /* ignore partial */ }
          }
        }
      })();
      return { accepted: true };
    },
    // The host has no provider-sharing service: report "not ready" in the real
    // shapes instead of fabricating shares.
    'providerShare.command': (args) => {
      const action = args?.[0]?.action ?? '';
      switch (action) {
        case 'owned':
          return { ready: false, shares: [] };
        case 'received':
          return [];
        case 'shared-provider-ids':
          return { ready: false, providerIds: [] };
        case 'get-run-limits':
          return { limits: null, ready: false };
        default: {
          const error = new Error(`provider sharing is not available on cindy-host yet (${action})`);
          error.code = 'HOST_CHANNEL_UNSUPPORTED';
          return Promise.reject(error);
        }
      }
    },
    'maker.getCapabilities': (args) => {
      // Store consumers compare the descriptor by identity; a fresh object on
      // every read can keep a subscribing component re-rendering forever.
      const key = String(args?.[0] ?? '');
      capabilitiesCache ??= new Map();
      if (!capabilitiesCache.has(key)) {
        capabilitiesCache.set(
          key,
          hostChannels['maker.getCapabilities']([key]).catch(error => {
            capabilitiesCache.delete(key);
            throw error;
          }),
        );
      }
      return capabilitiesCache.get(key);
    },
    'maker.input.getProjection': (args) => {
      if (window.__noProjection === true) return Promise.reject(new Error('projection disabled for diagnosis'));
      return hostChannels['maker.input.getProjection'](args);
    },
    'maker.input.enqueue': (args) => {
      ensureEventStream();
      return hostChannels['maker.input.enqueue'](args);
    },
    'maker.input.updateContent': (args) => rpc('/input/update-content', { sessionId: args?.[0], clientId: args?.[1], item: args?.[2] }),
    'maker.input.updateText': (args) => rpc('/input/update-text', { sessionId: args?.[0], clientId: args?.[1], newText: args?.[2] }),
    'maker.input.move': (args) => rpc('/input/move', { sessionId: args?.[0], clientId: args?.[1], targetIndex: args?.[2] }),
    'maker.input.setExpanded': (args) => rpc('/input/set-expanded', { sessionId: args?.[0], expanded: args?.[1] }),
    'maker.input.setInteractionLock': (args) => rpc('/input/set-interaction-lock', { sessionId: args?.[0], lockId: args?.[1], locked: args?.[2] }),
    'maker.input.setEditLock': (args) => rpc('/input/set-edit-lock', { sessionId: args?.[0], clientId: args?.[1], locked: args?.[2] }),
    'maker.input.clearSession': (args) => rpc('/input/clear-session', { sessionId: args?.[0] }),
    'maker.setPermissionMode': (args) => {
      const sessionId = args?.[0];
      const mode = args?.[1];
      if (!sessionId) return Promise.resolve();
      return rpc('/sessions/update', { sessionId, patch: { permissionMode: mode } });
    },
    'maker.setModel': (args) => {
      const [sessionId, model, providerId, _rev, selection] = args ?? [];
      if (!sessionId) return Promise.resolve({ deferred: false });
      const patch = { model };
      if (providerId !== undefined) patch.providerId = providerId;
      if (selection?.effort) patch.effort = selection.effort;
      if (selection?.fastMode !== undefined) patch.fastMode = selection.fastMode;
      return rpc('/sessions/update', { sessionId, patch }).then(() => ({ deferred: false }));
    },
    'maker.switchSessionAgent': async (args) => {
      const [sessionId, targetAgentKind, model, providerId, effort, fastMode] = args ?? [];
      if (!sessionId || !model) {
        return { switched: false, agentKind: targetAgentKind, model, engineReady: true };
      }
      return rpc('/sessions/switch-agent', {
        sessionId,
        targetAgentKind,
        model,
        providerId: providerId ?? null,
        effort,
        fastMode,
      });
    },
    'maker.setEffort': (args) => {
      const sessionId = args?.[0];
      const effort = args?.[1];
      if (!sessionId) return Promise.resolve();
      return rpc('/sessions/update', { sessionId, patch: { effort } });
    },
    'maker.setFastMode': (args) => {
      const sessionId = args?.[0];
      const fastMode = args?.[1];
      if (!sessionId) return Promise.resolve();
      return rpc('/sessions/update', { sessionId, patch: { fastMode } });
    },
    'maker.setPlanMode': (args) => {
      const sessionId = args?.[0];
      const planModeEnabled = args?.[1];
      if (!sessionId) return Promise.resolve();
      return rpc('/sessions/update', { sessionId, patch: { planModeEnabled } });
    },
    'maker.setThinkingEnabled': () => unsupported('maker.setThinkingEnabled'),
    'maker.listDesktopCommands': () => ({ success: true, commands: STATIC.emptyList }),
    'maker.claimLegacyModelVisibilityOwner': () => ({
      dataOwnerId: window.__cindyBoot?.auth?.ownerId ?? null,
      ownerGeneration: 1,
      canWriteOwnerScoped: Boolean(window.__cindyBoot?.auth?.ownerId),
      claimed: false,
      claimedByOtherOwner: false,
      canInitialize: false,
      profileOrigin: 'existing',
    }),
    'maker.syncModelVisibility': () => undefined,
    'ghosts.listPickerModels': () => STATIC.emptyList,
    'maker.memoryGetSettings': () => STATIC.memorySettings,
    'maker.memoryGetSettingsState': () => ({ ...STATIC.memorySettings, isCustomized: false, customizedKeys: [], defaults: STATIC.memorySettings }),
    'maker.memoryGet': () => ({ enabled: true, source: 'host-runtime' }),
    'maker.memorySet': () => unsupported('maker.memorySet'),
    'maker.memoryReset': () => unsupported('maker.memoryReset'),
    'maker.makerMemorySetEnabled': () => unsupported('maker.makerMemorySetEnabled'),
    'maker.makerMemoryReset': () => unsupported('maker.makerMemoryReset'),
    'maker.memoryPreserveLegacyMakerDisabled': () => STATIC.memorySettings,
    'voiceInput.getReadinessCached': () => STATIC.voiceNotReady,
    'voiceInput.getMicrophonePermissionCached': () => ({ granted: false, state: 'unsupported' }),
    'voiceInput.getSystemPermissionsCached': () => ({ microphone: 'unsupported' }),
    'voiceInput.getReadiness': () => STATIC.voiceNotReady,
    'voiceInput.getHistory': () => STATIC.emptyList,
    'voiceInput.getHistoryForRefinement': () => STATIC.emptyList,
    'voiceInput.getModelSelection': () => STATIC.voiceModelSelection,
    'voiceInput.onDataChanged': () => () => {},
    'accessibilitySupport.getSync': () => false,
    'ghosts.unreadSync': () => STATIC.ghostsUnread,
    'ghosts.recentUsageSync': () => STATIC.ghostRecentUsage,
    'ghosts.noteSessionFocused': () => undefined,
    'ghosts.markUsed': () => undefined,
    'voiceInput.cancel': () => undefined,
    'rightSidebarWindow.setContext': () => undefined,
    'notificationSetDesktopEnabled': () => undefined,
    'takePendingDeepLink': () => null,
    'safeStorageRead': () => null,
    'providerGroup.command': (args) => {
      const action = args?.[0]?.action ?? '';
      if (action === 'list') return STATIC.emptyRecord;
      if (action === 'candidates') return STATIC.emptyList;
      if (action === 'session-group') return null;
      const error = new Error(`provider groups are not available on cindy-host yet (${action})`);
      error.code = 'HOST_CHANNEL_UNSUPPORTED';
      return Promise.reject(error);
    },
    'maker.listBotGroups': () => STATIC.botGroupsEmpty,
    'maker.botGroupOutbox': () => STATIC.emptyList,
    'maker.schedule.listSidebarIndexRuns': () => STATIC.emptyList,
    'deviceLink.getState': () => STATIC.deviceLinkState,
    'deviceLink.listDevices': () => STATIC.deviceLinkDevices,
    'deviceLink.mirrorCache.getSessionList': () => STATIC.emptyList,
    'deviceLink.mirrorCache.putSessionList': () => undefined,
    'localDb.sessions.setPinnedCardSummaries': () => undefined,
    'localDb.bots.workbench.followScopes': () => STATIC.emptyList,
    'sharedTask.account': () => STATIC.emptyList,
    'sharedTask.host': () => null,
    'localDb.sessionImport.scan': () => ({
      candidates: STATIC.emptyList,
      hiddenCounts: { cindy: 0, temp: 0, internal: 0, imported: 0 },
      sources: STATIC.emptyList,
      sourceErrors: STATIC.emptyList,
      scannedAt: Date.now(),
    }),
    'localDb.sessionImport.start': () => unsupported('localDb.sessionImport.start'),
    'localDb.sessionImport.status': () => null,
    'localDb.sessionImport.cancel': () => null,
    'localDb.sessionImport.relocate': () => null,
    'maker.gitSafetyGet': () => STATIC.gitSafetyOff,
    'maker.gitSafetySet': () => unsupported('maker.gitSafetySet'),
    // The host already opened and migrated the owner database before serving.
    'localDb.ensureReady': () => ({ ready: true }),
    // The browser cannot create a local identity. Preserve the Host's actual
    // verdict, including canEnterApp=false when its account is signed out.
    'authEnterLocal': () => routes['authInitialize'](),
    'authExitLocal': () => routes['authInitialize'](),
    // The host exposes no cloud login surface; the entry step still offers the
    // local profile, which is what the desktop client shows when signed out.
    'authGetLoginState': () => ({ success: true, state: { step: 'entry' } }),
    'authInitialize': () => hostChannels['auth.getState'](),
    'authRefresh': () => hostChannels['auth.refresh'](),
    'checkEnvironment': () => {
      const harness = window.__cindyBoot?.harness ?? {};
      const entry = (ready) => (ready ? { status: 'passed' } : { status: 'failed', error: 'not installed' });
      const allPassed = Boolean(harness['claude-code'] && harness.codex);
      return {
        claudeCode: entry(harness['claude-code']),
        codex: entry(harness.codex),
        pi: harness.pi ? { status: 'passed' } : { status: 'skipped' },
        ripgrep: harness.ripgrep ? { status: 'passed' } : { status: 'skipped' },
        allPassed,
        platform: window.__cindyBoot?.platform ?? navigator.platform,
      };
    },
    'localThemes.listSync': () => STATIC.localThemes,
    'authHasPersistedSessionHintSync': () => Boolean(boot.auth?.user),
    // Appearance comes from <dataDir>/appearance-settings.json, the Desktop's file.
    'appearanceSettings.getSync': () => settingsMirror.appearance,
    'appearanceSettings.get': () => Promise.resolve({ value: settingsMirror.appearance, overrides: {} }),
    'appearanceSettings.setPatch': async (args) => {
      settingsMirror.appearance = await hostChannels['appearanceSettings.setPatch'](args);
      emit('appearanceSettings.onChanged', settingsMirror.appearance);
      return settingsMirror.appearance;
    },
    'appearanceSettings.reset': async () => {
      settingsMirror.appearance = await hostChannels['appearanceSettings.reset']();
      emit('appearanceSettings.onChanged', settingsMirror.appearance);
      return settingsMirror.appearance;
    },
    // Consent + opt-out live in <dataDir>/analytics-settings.json.
    'getAnalyticsSettings': () => ({
      ...settingsMirror.analytics,
      allowed:
        settingsMirror.analytics?.privacyConsentAccepted === true &&
        settingsMirror.analytics?.analyticsEnabled === true,
      analyticsEnabledCustomized: false,
    }),
    'voiceInput.setGlobalShortcut': () => ({ ok: false }),
    'worktreeListAll': () => STATIC.emptyList,
    'localDb.bots.list': () => STATIC.emptyList,
    'localDb.bots.getModelChainSettings': () => ({ chain: [] }),
    'maker.silentEncryptedRetryGet': () => ({ enabled: true }),
    'maker.chatEmbeddingGet': () => ({ enabled: false }),
    'maker.lspModeGet': () => ({ enabled: false }),
    'rsbBrowserBridge.snapshot': () => ({ tabs: [], activeTabId: null }),
    'localDb.maintenance.getStartupProgress': () => null,
    'legacyMigration.getState': () => ({ status: 'none' }),
    'getUpdateStatus': () => ({ status: 'idle' }),
    'checkAppUpdate': () => ({ hasUpdate: false }),
    'modelFavoritesHost.ready': () => undefined,
    'modelFavoritesHost.changed': () => () => {},
    'gitContext.listAllPrRefs': () => [],
    'gitContext.getForSession': () => ({ workdir: null, head: null, source: null }),
    'gitContext.listPrRefs': () => [],
    'gitContext.findLinkedWorktree': () => null,
    'gitContext.watch': () => undefined,
    'gitContext.unwatch': () => undefined,
    'gitContext.onChanged': () => () => {},
    // Layout tree comes from <dataDir>/layout.v1.json.
    'layout.getStateSync': () => ({ layout: settingsMirror.layout }),
    'layout.set': async (args) => {
      const { layout } = await hostChannels['layout.set'](args);
      settingsMirror.layout = layout;
      emit('layout.onChanged', { layout });
      return { layout, persisted: true };
    },
    'layout.reset': async () => {
      const { layout } = await hostChannels['layout.reset']();
      settingsMirror.layout = layout;
      emit('layout.onChanged', { layout });
      return { layout, persisted: true };
    },
    // Preloaded at boot (sync channel): the desktop answers this from memory too.
    'ghosts.listSync': () => ({ ghosts: ghostsCache ?? [] }),
    'ghosts.recommendationsSync': () => STATIC.ghostRecommendations,
    // Sidebar identity state comes from owners/<key>/sidebar-settings.json.
    'sidebarSettings.loadSnapshot': () => ({
      ...ownerStamp(),
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: pinnedOrder(),
      hiddenProjectKeys: Array.from(settingsMirror.sidebar.hiddenProjectKeys ?? []),
      hiddenMainViewGhostIds: Array.from(settingsMirror.sidebar.hiddenMainViewGhostIds ?? []),
    }),
    'sidebarSettings.mutatePinnedOrder': async (args) => {
      requireOwner();
      const mutation = args?.[0] ?? {};
      let next = pinnedOrder();
      if (mutation.kind === 'reorder' || mutation.kind === 'migrate-legacy') {
        next = Array.from(mutation.order ?? []).filter((entry) => typeof entry === 'string');
      } else if (mutation.kind === 'promote' && typeof mutation.entryId === 'string') {
        next = [mutation.entryId, ...next.filter((entry) => entry !== mutation.entryId)];
      } else if (mutation.kind === 'remove' && typeof mutation.entryId === 'string') {
        next = next.filter((entry) => entry !== mutation.entryId);
      }
      const saved = await saveSidebar({ pinnedOrder: next });
      const order = Array.from(saved.pinnedOrder ?? []);
      emit('sidebarSettings.onPinnedOrderChanged', order, ownerStamp());
      return order;
    },
    'sidebarSettings.setProjectHidden': async (args) => {
      requireOwner();
      const projectKey = typeof args?.[0] === 'string' ? args[0] : '';
      const hidden = args?.[1] === true;
      if (!projectKey) return false;
      const current = Array.from(settingsMirror.sidebar.hiddenProjectKeys ?? []);
      const next = hidden
        ? [...current.filter((key) => key !== projectKey), projectKey]
        : current.filter((key) => key !== projectKey);
      const saved = await saveSidebar({ hiddenProjectKeys: next });
      emit('sidebarSettings.onHiddenProjectKeysChanged', Array.from(saved.hiddenProjectKeys ?? []), ownerStamp());
      return hidden;
    },
    'sidebarSettings.setMainViewHidden': async (args) => {
      requireOwner();
      const ghostId = typeof args?.[0] === 'string' ? args[0] : '';
      const hidden = args?.[1] === true;
      if (!ghostId) return Array.from(settingsMirror.sidebar.hiddenMainViewGhostIds ?? []);
      const current = Array.from(settingsMirror.sidebar.hiddenMainViewGhostIds ?? []);
      const next = hidden
        ? [...current.filter((id) => id !== ghostId), ghostId]
        : current.filter((id) => id !== ghostId);
      const saved = await saveSidebar({ hiddenMainViewGhostIds: next });
      const ids = Array.from(saved.hiddenMainViewGhostIds ?? []);
      emit('sidebarSettings.onHiddenMainViewGhostIdsChanged', ids, ownerStamp());
      return ids;
    },
    // Application shortcut overrides come from <dataDir>/app-shortcuts.v1.json.
    'appShortcuts.getState': () => settingsMirror.appShortcuts,
    'appShortcuts.setOverride': async (args) => {
      const id = String(args?.[0] ?? '');
      const combo = args?.[1] ?? null;
      const overrides = { ...(settingsMirror.appShortcuts.overrides ?? {}) };
      if (id) overrides[id] = combo;
      settingsMirror.appShortcuts = await rpc('/settings/shortcuts/set', { overrides });
      emit('appShortcuts.onChanged', settingsMirror.appShortcuts);
      return { overrides: settingsMirror.appShortcuts.overrides ?? {} };
    },
    'appShortcuts.clearOverride': async (args) => {
      const id = String(args?.[0] ?? '');
      const overrides = { ...(settingsMirror.appShortcuts.overrides ?? {}) };
      delete overrides[id];
      settingsMirror.appShortcuts = await rpc('/settings/shortcuts/set', { overrides });
      emit('appShortcuts.onChanged', settingsMirror.appShortcuts);
      return { overrides: settingsMirror.appShortcuts.overrides ?? {} };
    },
    'appShortcuts.resetAll': async () => {
      settingsMirror.appShortcuts = await rpc('/settings/shortcuts/set', { overrides: {} });
      emit('appShortcuts.onChanged', settingsMirror.appShortcuts);
      return { overrides: {} };
    },
    'sidebarSettings.claimLegacyRendererOwner': () => STATIC.claimDenied,
    'setUpdateRelaunchTheme': () => undefined,
    'theme.applyVibrancy': () => undefined,
    'syncWorkerCreationPrefs': () => undefined,
    'syncDesktopCcPrefs': () => undefined,
    'syncNewMakerDraft': () => undefined,
    'syncProviderModelMemory': () => undefined,
    'setClassicalReplyStyle': () => undefined,
    'setApplicationMenuLocale': () => undefined,
    'localDb.sessions.delete': (args) => rpc('/sessions/delete', { sessionId: args?.[0] }),
    'localDb.sessions.messages': async (args) => rpc('/sessions/messages', args),
    'localDb.rightSidebarTabs.list': () => STATIC.rightSidebarTabs,
    'localDb.messages.workDetails': (args) => rpc('/messages/work-details', { sessionId: args?.[0], ref: args?.[1], after: args?.[2]?.after ?? null }),
    'voiceConversation.publishCallStatus': () => undefined,
    'voiceConversation.callStatus': () => null,
    'voiceInput.prewarm': () => undefined,
    'voiceInput.consumeShortcutRecoveryFailure': () => ({ failed: false }),
    'maker.schedule.list': () => STATIC.emptyList,
    'maker.schedule.getRuntimeState': () => ({ state: 'idle', activeRunCount: 0 }),
    'maker.browser.status': () => ({ running: false, available: false }),
    'browserBackend.getState': () => ({ mode: 'none', backend: 'none' }),
    'browserBackend.getHealth': () => ({ ready: false }),
    'browserBackend.setKind': () => unsupported('browserBackend.setKind'),
    'browserBackend.setUseRealProfile': () => unsupported('browserBackend.setUseRealProfile'),
    'browserBackend.recover': () => unsupported('browserBackend.recover'),
    'browserBackend.probeSourceRead': () => ({ ok: false }),
    'maker.computer.status': () => ({ available: false, running: false, error: null, permissions: {} }),
    'maker.computer.restart': () => undefined,
    'maker.computer.checkUpdate': () => ({ updateAvailable: false }),
    'maker.computer.installDriver': () => ({ ok: false }),
    'maker.computer.updateDriver': () => ({ ok: false }),
    'maker.computer.cancelPermissionGrant': () => undefined,
    'maker.computer.grantPermissions': () => ({ ok: false }),
    'maker.android.getConfig': () => ({
      value: { defaultDeviceSerial: null, adbPathOverride: null },
      defaults: { defaultDeviceSerial: null, adbPathOverride: null },
      isCustomized: false,
      customizedKeys: [],
    }),
    'maker.android.setDefaultDevice': () => unsupported('maker.android.setDefaultDevice'),
    'maker.android.setAdbPath': () => unsupported('maker.android.setAdbPath'),
    'maker.android.prepareAdb': () => ({
      supported: true,
      ready: false,
      platform: window.__cindyBoot?.platform ?? navigator.platform,
      path: null,
      source: null,
    }),
    'maker.android.status': () => ({
      adb_available: false,
      devices: [],
      default_device: null,
      active_device: null,
      configured: false,
      running: false,
    }),
    'maker.plugins.getState': () => ({ activePlugins: [], effectiveEnabled: false }),
    'maker.plugins.list': () => STATIC.emptyList,
    'maker.plugins.setEnabled': () => unsupported('maker.plugins.setEnabled'),
    'maker.plugins.setProjectEnabled': () => unsupported('maker.plugins.setProjectEnabled'),
    'maker.plugins.clearEnabled': () => unsupported('maker.plugins.clearEnabled'),
    'maker.plugins.clearProjectEnabled': () => unsupported('maker.plugins.clearProjectEnabled'),
    'billing.getBalance': () => STATIC.billingBalance,
    'billing.getCreditUsage': () => STATIC.creditUsage,
    'billing.getCatalog': () => STATIC.billingCatalog,
    'billing.listOrders': () => STATIC.billingOrders,
    'billing.getCurrentSubscription': () => STATIC.billingSubscription,
    'authListAccounts': () => accountSwitcherSnapshot(),
    'authSyncAccounts': () => accountSwitcherSnapshot(),
    'authSwitchAccount': () => unsupported('authSwitchAccount'),
    'authBeginAddAccount': () => ({ success: false, code: 'NOT_SUPPORTED', state: null }),
    'authCancelAddAccount': () => undefined,
    'authLogout': async () => { const result = await hostChannels['auth.logout'](); location.replace('/connect'); return result; },
    'authGetAccountDeletionAvailability': () => ({ success: true, value: { available: false, reason: 'not_supported' } }),
    'authRequestAccountDeletionChallenge': () => ({ success: false, code: 'NOT_SUPPORTED' }),
    'authConfirmAccountDeletion': () => ({ success: false, code: 'NOT_SUPPORTED' }),
    'authGetAccountDeletionStatus': () => ({ success: true, value: { status: 'none' } }),
    'authClearAccountDeletionReceipt': () => undefined,
    'authConsumeAccountDeletionRestoredNotice': () => false,
    'profileGetState': () => {
      const user = window.__cindyBoot?.auth?.user;
      return {
        name: user?.name ?? 'Cindy',
        avatarUrl: user?.avatar ?? null,
      };
    },
    'profileChooseAvatar': () => ({ canceled: true }),
    'profileUpdate': () => unsupported('profileUpdate'),
    'windowBehavior.getLinuxCloseBehavior': () => 'minimize',
    'sidebarSettings.getProjectOrder': () => STATIC.emptyList,
    'workLouderCodex.publishTasks': () => undefined,
    'notificationClearSessionAttention': () => undefined,
    'notificationMarkSessionAttention': () => undefined,
    // Task lifecycle presentation only; there is no native notification surface.
    'notificationShowSessionEvent': () => undefined,
    'maker.autoTitle': (args) => rpc('/sessions/auto-title', args?.[0] ?? {}),
    'notificationSetAppAttentionCount': () => undefined,
    'localDb.orcaWorkflows.getCollaborationSettings': () => ({ enabled: false }),
    'maker.agentResourceSettingsGet': () => ({ maxProcesses: 4, memoryLimitMb: 4096 }),
    'remoteSsh.list': () => STATIC.remoteSshHosts,
    'remoteSsh.ccMgrListPendingUpgrades': () => STATIC.emptyList,
    'localDb.databaseSizeWarning.getSettings': () => ({ enabled: false, warningThresholdMb: 1024 }),
    'localDb.databaseSizeWarning.getStatus': () => ({ status: 'normal', sizeMb: 10, databaseBytes: 0 }),
    'localDb.databaseSizeWarning.measure': () => ({ databaseBytes: 0 }),
    'localThemes.list': () => [],
    'workLouderCodex.getState': () => ({ available: false, connected: false, tasks: [] }),
    'workLouderCodex.probe': () => ({ available: false, connected: false }),
    'workLouderCodex.setEnabled': () => unsupported('workLouderCodex.setEnabled'),
    'xboxGamepad.getState': () => ({ available: false, connected: false }),
    'xboxGamepad.probe': () => ({ available: false, connected: false }),
    'xboxGamepad.setEnabled': () => unsupported('xboxGamepad.setEnabled'),
    'selfHostedRelay.command': () => ({ ok: false, unsupported: true }),
    'dialogueWorkspace.get': () => ({ path: null }),
    'dialogueWorkspace.set': () => unsupported('dialogueWorkspace.set'),
    'projectsRoot.get': () => ({ path: null }),
    'projectsRoot.set': () => unsupported('projectsRoot.set'),
    'worktreeRecycle.list': () => [],
    'worktreeRecycle.clean': () => unsupported('worktreeRecycle.clean'),
    'worktreeRecycle.restore': () => unsupported('worktreeRecycle.restore'),
    'getAutoUpdateSettings': () => ({ autoUpdate: false, channel: 'stable' }),
    'setAutoUpdateSettings': () => unsupported('setAutoUpdateSettings'),
    'ccSetDebugNet': () => undefined,
    'getLogUploadSettings': () => ({ enabled: false }),
    'setLogUploadSettings': () => unsupported('setLogUploadSettings'),
    'worktreeRecycle.empty': () => unsupported('worktreeRecycle.empty'),
    'remoteSsh.listHosts': () => [],
    'localDb.maintenance.getLastResult': () => null,
    'localDb.maintenance.chooseBackupDirectory': () => ({ canceled: true }),
    'localDb.maintenance.scan': () => ({ sessions: 0, messages: 0, estimatedBytes: 0 }),
    'localDb.maintenance.schedule': () => unsupported('localDb.maintenance.schedule'),
    'localDb.maintenance.openLastBackupDirectory': () => unsupported('localDb.maintenance.openLastBackupDirectory'),
    'cindyMediaStorage.stats': () => STATIC.mediaStorageStats,
    'cindyMediaStorage.scan': () => ({ totalCount: 0, totalBytes: 0, candidateCount: 0, candidateBytes: 0 }),
    'cindyMediaStorage.cleanup': () => unsupported('cindyMediaStorage.cleanup'),
    'cindyMediaStorage.reconcile': () => unsupported('cindyMediaStorage.reconcile'),
    'cindyMediaStorage.openLegacyImagesDir': () => unsupported('cindyMediaStorage.openLegacyImagesDir'),
    'cindyMediaStorage.clearLegacyImagesDir': () => unsupported('cindyMediaStorage.clearLegacyImagesDir'),
    'cindyMediaStorage.openChatAttachmentsDir': () => unsupported('cindyMediaStorage.openChatAttachmentsDir'),
    'cindyMediaStorage.clearChatAttachmentsDir': () => unsupported('cindyMediaStorage.clearChatAttachmentsDir'),
    'getUpdateChannelSettings': () => ({ channel: 'stable', autoUpdate: false }),
    'maker.chatDisplayCache': () => STATIC.emptyRecord,
    'agentIsland.setCompanionChats': () => undefined,
    'agentIsland.setRemoteSessions': () => undefined,
    'agentIsland.setVisibleSession': () => undefined,
    'pluginContributions.reviewUpdates': () => STATIC.emptyList,
    'pluginMarket.snapshot': () => STATIC.pluginMarketSnapshot,
    'ghosts.workdirPrefsSync': () => STATIC.workdirPrefs,
    'ghosts.workdirPrefs': () => STATIC.workdirPrefs,
    'worktreeRestoreStatus': () => ({}),
    'feishuBot.getState': () => ({
      service: 'feishu',
      appId: '',
      appSecret: '',
      status: 'idle',
      errorMessage: null,
      hasSavedCreds: false,
      ownerOpenId: null,
      lifecycleAnnouncement: true,
    }),
    'feishuBot.save': () => unsupported('feishuBot.save'),
    'feishuBot.clear': () => unsupported('feishuBot.clear'),
    'feishuBot.reconnect': () => unsupported('feishuBot.reconnect'),
    'feishuBot.setLifecycleAnnouncement': () => unsupported('feishuBot.setLifecycleAnnouncement'),
    'feishuBot.registrationBegin': () => ({ success: false }),
    'feishuBot.registrationCancel': () => undefined,
    'dingtalkBot.getState': () => ({ appKey: null, hasSecret: false, ownerUserId: null, status: { kind: 'idle' } }),
    'dingtalkBot.save': () => unsupported('dingtalkBot.save'),
    'dingtalkBot.reconnect': () => unsupported('dingtalkBot.reconnect'),
    'dingtalkBot.clear': () => unsupported('dingtalkBot.clear'),
    'discordBot.getStatus': () => ({ status: { kind: 'idle' }, ownerUserId: '', lifecycleAnnouncement: true }),
    'discordBot.setConfig': () => unsupported('discordBot.setConfig'),
    'discordBot.reconnect': () => unsupported('discordBot.reconnect'),
    'discordBot.disconnect': () => unsupported('discordBot.disconnect'),
    'discordBot.setLifecycleAnnouncement': () => unsupported('discordBot.setLifecycleAnnouncement'),
    'discordBot.listChannels': () => ({ status: { kind: 'idle' }, guilds: [] }),
    'discordBot.getChannelAccess': () => ({ channels: [] }),
    'discordBot.setChannelAccess': () => unsupported('discordBot.setChannelAccess'),
    'telegramBot.getStatus': () => ({ status: { kind: 'idle' }, ownerUserId: '', botUsername: null }),
    'telegramBot.setConfig': () => unsupported('telegramBot.setConfig'),
    'telegramBot.disconnect': () => unsupported('telegramBot.disconnect'),
    'telegramBot.setOnline': () => unsupported('telegramBot.setOnline'),
    'wecomBot.getStatus': () => ({ status: { kind: 'idle' }, botId: '', ownerUserId: '' }),
    'wecomBot.setConfig': () => unsupported('wecomBot.setConfig'),
    'wecomBot.reconnect': () => unsupported('wecomBot.reconnect'),
    'wecomBot.disconnect': () => unsupported('wecomBot.disconnect'),
    'wechatBot.getState': () => ({ status: 'idle', botAccount: null, loginQrCode: null }),
    'wechatBot.getChannelSettings': () => ({ defaultAgentKind: 'claude-code', defaultModel: '', defaultWorkingDir: null, companionBotId: null }),
    'wechatBot.authorize': () => ({ success: false }),
    'wechatBot.cancelAuthorization': () => undefined,
    'wechatBot.unbind': () => unsupported('wechatBot.unbind'),
    'wechatBot.chooseWorkingDirectory': () => undefined,
    'wechatBot.resetWorkingDirectory': () => unsupported('wechatBot.resetWorkingDirectory'),
    'wechatBot.setCompanion': () => unsupported('wechatBot.setCompanion'),
    'maker.imDefaultSettingsGet': () => ({
      agentKind: 'claude-code',
      agents: {
        'claude-code': { model: '' },
        'codex': { model: '' },
        'pi': { model: '' },
      },
    }),
    'maker.imDefaultSettingsSet': () => unsupported('maker.imDefaultSettingsSet'),
    'wecomGroupNotification.getState': () => ({ enabled: false }),
    'maker.projectAutomation.listPendingImports': () => STATIC.emptyList,
    'appearanceSettings.ensureWallpaperImage': () => null,
    'appReadyForBot': () => true,
    'sidebarTabWindow.getState': () => ({ visible: false }),
    'rightSidebarWindow.getState': () => ({ visible: false }),
    'performanceTrace.command': () => ({ phase: 'idle', startedAt: null, reportId: null, uploaded: false, partial: false, durationMs: 0 }),
    'maker.listSessionBackgroundActivity': () => STATIC.emptyList,
    'getCindyMakeState': () => ({ active: false }),
    'ghosts.uiPrompts': () => STATIC.emptyList,
    'ghosts.takePendingInstall': () => ({ filePath: null }),
    'fetchReleaseNotes': () => ({
      version: appVersion,
      date: '2026-11-06',
      contributors: ['Cindy Team'],
      topics: [{
        title: 'Cindy Host Web',
        text: '通过 Web 界面远程控制 Cindy 智能体服务。',
        contributors: ['Cindy Team'],
      }],
    }),
    'fetchReleaseNotesIndex': () => [appVersion],
    'pluginMarket.consumeRemovalNotice': () => null,
    'regionScreenshotCompose.take': () => null,
    'binding.listAttached': () => STATIC.emptyList,
    'maker.getCompanionCloudState': () => STATIC.companionCloud,
    'ghosts.legacyRecoveryStatus': () => ({ inProgress: false }),
    'maker.requestProviderModelsAutoRefresh': () => undefined,
    'maker.scanLocalCli': () => STATIC.localCliDetections,
    'maker.llamaCppStatus': () => STATIC.llamaCppStatus,
    'maker.localModelStatus': () => STATIC.localModelStatus,
    'maker.prewarmSession': () => undefined,
    'maker.piKernel.getState': () => STATIC.piKernelState,
    'maker.piKernel.install': () => unsupported('maker.piKernel.install'),
    'maker.agent.getBinaryVersion': (args) => ({
      kind: args?.[0] ?? 'claude-code',
      binaryPath: args?.[0] ?? null,
      version: '1.4.0',
      latestVersion: null,
      updateAvailable: false,
      latestCheckFailed: false,
    }),
    'maker.visionBridgeSettingsGet': () => STATIC.visionBridgeSettings,
    'maker.visionBridgeSettingsSet': () => unsupported('maker.visionBridgeSettingsSet'),
    'maker.visionBridgeSettingsReset': () => unsupported('maker.visionBridgeSettingsReset'),
    'maker.getGoalStatus': () => null,
    'maker.setGoal': () => unsupported('maker.setGoal'),
    'maker.clearGoal': () => unsupported('maker.clearGoal'),
    'maker.pauseGoal': () => unsupported('maker.pauseGoal'),
    'maker.resumeGoal': () => unsupported('maker.resumeGoal'),
    'maker.listCustomMcpServers': () => ({ servers: STATIC.emptyList }),
    'maker.createCustomMcpServer': () => unsupported('maker.createCustomMcpServer'),
    'maker.updateCustomMcpServer': () => unsupported('maker.updateCustomMcpServer'),
    'maker.deleteCustomMcpServer': () => unsupported('maker.deleteCustomMcpServer'),
    'maker.refreshCustomMcpCodex': () => unsupported('maker.refreshCustomMcpCodex'),
    'prepareHarnessUpdate': () => unsupported('prepareHarnessUpdate'),
    'anyActivityBlockingRelaunch': () => false,
    'relaunchForHarnessUpdate': () => unsupported('relaunchForHarnessUpdate'),
    'maker.updateGoal': () => unsupported('maker.updateGoal'),
    'localAgent.developerConnection': () => ({ state: 'stopped' }),
    'localAgent.connections': () => STATIC.emptyList,
    'localAgent.answerConfirmation': () => unsupported('localAgent.answerConfirmation'),
    'localAgent.setCreateVisibleSessions': () => unsupported('localAgent.setCreateVisibleSessions'),
    'localAgent.revoke': () => unsupported('localAgent.revoke'),
    'remoteDesktop.state': () => ({ enabled: false, active: null, overlay: false, permissionGuide: false, windowsSupport: 'unavailable' }),
    'remoteDesktop.permissions': () => ({ screen: 'granted', accessibility: 'granted', inputMonitoring: 'granted' }),
    'remoteDesktop.openPermission': () => undefined,
    'remoteDesktop.dismissPermissionGuide': () => undefined,
    'remoteDesktop.enable': () => unsupported('remoteDesktop.enable'),
    'remoteDesktop.windowsSupport': () => undefined,
    'remoteDesktop.stop': () => unsupported('remoteDesktop.stop'),
    'maker.usage.getHistory': () => ({
      ...STATIC.usageHistory,
      todayKey: new Date().toISOString().slice(0, 10),
    }),
    'maker.usage.getToday': () => null,
    'maker.usage.getAccount': () => null,
    'maker.usage.getCodexRateLimits': () => ({ available: false }),
    'maker.usage.getClaudeSubscription': () => null,
    'maker.usage.getXaiSubscription': () => null,
    'maker.getSessionAgentSwitchIntent': (args) => (
      rpc('/sessions/agent-switch-intent', { sessionId: args?.[0] })
    ),
    'maker.getSessionContextWindowBounds': () => null,
    'maker.getModelContextLimit': () => null,
    'maker.getSessionTurnActive': () => ({ active: false }),
    'maker.listSessionBackgroundTasks': () => [],
    'maker.getSessionBackgroundActivity': () => null,
    'maker.listSideChats': () => [],
    'binding.resolveSession': () => null,
    'resolvePathBatch': () => [],
    'maker.claudeOAuthStatus': () => ({ connected: false }),
    'maker.claudeSessionRouteGet': () => null,
    'learn.listRuns': () => [],
  };

  /**
   * Channels the preload answers synchronously (sendSync or an in-memory read).
   * Getting this wrong hands the renderer a Promise where it expects a value,
   * which makes snapshot stores re-render forever.
   */
  const SYNC_CHANNEL = /(Sync$|getSync$|listSync$|getDataSnapshot$)/;
  const SYNC_CHANNELS = {
    'getFilePath': true,
    'sidebarSettings.loadSnapshot': true,
    'layout.getStateSync': true,
    'appearanceSettings.getSync': true,
    'appShortcuts.getState': true,
    'voiceInput.getReadinessCached': true,
    'voiceInput.getSystemPermissionsCached': true,
  };

  function unsupported(path) {
    (window.__cindyRpcFailures ??= []).push({ path, error: 'unsupported' });
    if (window.__cindyRpcFailures.length > 200) window.__cindyRpcFailures.shift();
    // Read-only fallback shapes keep optional desktop panels from breaking boot.
    // Match the method, not its namespace (settings.set must remain a write).
    const method = path.split('.').at(-1);
    if (/^(list|get|load|read|fetch|find|search|scan|query|check|status|state|preview|connections|hosts|devices|models|items|tabs|providers|records)/i.test(method)) {
      if (/(list|all|items|rows|history|notes|channels|devices|tasks|runs|sessions|plugins|commands|skills|refs|scopes|candidates|prompts|updates|shares|connections|hosts|tabs|records)/i.test(path)) {
        return Promise.resolve([]);
      }
      if (/(status|state|config|settings|info)/i.test(path)) {
        return Promise.resolve({});
      }
      return Promise.resolve(null);
    }
    return Promise.reject(unsupportedHostChannel(path));
  }

  const appVersion = window.__cindyBoot?.appVersion ?? '0.1.124';
  const SYNC_VALUES = {
    platform: window.__cindyBoot?.platform ?? navigator.platform,
    windowBackdropMaterial: 'none',
    appVersion,
    isPackaged: true,
    locale: window.__cindyBoot?.locale ?? navigator.language,
  };

  /**
   * One long-lived SSE connection carries every runtime event; `maker.onEvent`
   * subscribers receive them through the same fan-out the preload provides.
   */
  let eventConnection = null;
  let connectionState = { status: 'connecting', connection: 0, recovery: 0 };
  function ensureEventStream() {
    if (eventConnection) return;
    eventConnection = startHostEventStream({
      open: (query, signal) => fetch(`/events${query}`, { credentials: 'same-origin', signal }),
      beforeEvents: async (signal) => {
        const auth = await requestHost('/api/auth/state', null, 'POST', signal);
        if (signal.aborted) return;
        (window.__cindyBoot ??= {}).auth = { user: auth.user, ownerId: auth.dataOwnerId };
        emit('onAuthStateChange', auth);
      },
      onState: (state) => {
        connectionState = state;
        emit('hostConnection.onStateChanged', state);
      },
      onEvent: (parsed) => {
        (window.__hostEvents ??= []).push(parsed);
        if (window.__hostEvents.length > 200) window.__hostEvents.shift();
        // Interaction traffic has its own preload channels; everything
        // else stays on the shared event stream.
        if (parsed.type === 'auth_changed') {
          (window.__cindyBoot ??= {}).auth = { user: parsed.user, ownerId: parsed.dataOwnerId };
          emit('onAuthStateChange', parsed);
        } else if (parsed.type === 'interaction_request') {
          emit('maker.onInteractionRequest', { sessionId: parsed.sessionId, request: parsed.request });
        } else if (parsed.type === 'interaction_dismissed') {
          emit('maker.onInteractionDismissed', {
            sessionId: parsed.sessionId,
            requestId: parsed.requestId,
            reason: parsed.reason,
          });
        } else if (parsed.type === 'plugin_push') {
          const subscriber = {
            'ghosts:changed': 'ghosts.onChanged',
            'ghosts:runtime-changed': 'ghosts.onRuntimeChanged',
            'ghosts:card-updated': 'ghosts.onCardUpdated',
            'ghosts:notify': 'ghosts.onNotify',
            'maker:auth:state-changed': 'maker.auth.onStateChanged',
            'maker:auth:login-progress': 'maker.auth.onLoginProgress',
            'model-access:status-change': 'modelAccess.onStatusChange',
            'maker:codex-runtime-route-changed': 'maker.onCodexRuntimeRouteChanged',
          }[parsed.channel];
          if (subscriber) emit(subscriber, parsed.payload);
        } else if (parsed.type === 'settings_changed') {
          if (parsed.domain === 'appearance') {
            settingsMirror.appearance = parsed.value;
            emit('appearanceSettings.onChanged', parsed.value);
          } else if (parsed.domain === 'layout') {
            settingsMirror.layout = parsed.value;
            emit('layout.onChanged', { layout: parsed.value });
          } else if (parsed.domain === 'shortcuts') {
            settingsMirror.appShortcuts = parsed.value;
            emit('appShortcuts.onChanged', parsed.value);
          } else if (parsed.domain === 'sidebar') {
            settingsMirror.sidebar = parsed.value;
            syncSnapshots.delete('sidebarSettings.loadSnapshot\u0000[]');
            if (Array.isArray(parsed.value?.pinnedOrder)) {
              emit('sidebarSettings.onPinnedOrderChanged', parsed.value.pinnedOrder, ownerStamp());
            }
            if (Array.isArray(parsed.value?.hiddenProjectKeys)) {
              emit('sidebarSettings.onHiddenProjectKeysChanged', parsed.value.hiddenProjectKeys, ownerStamp());
            }
          }
        } else if (parsed.type === 'appearance_changed') {
          settingsMirror.appearance = parsed.appearance;
          emit('appearanceSettings.onChanged', parsed.appearance);
        } else if (parsed.type === 'task_tags_changed') {
          emit('localDb.taskTags.onChanged', parsed.payload, parsed.ownerStamp);
        } else if (parsed.type === 'session_changed') {
          if (parsed.action === 'create') {
            emit('localDb.sessions.onCreated', parsed.session);
          } else if (parsed.action === 'update' || parsed.patch) {
            emit('localDb.sessions.onPatched', { sessionId: parsed.sessionId, patch: parsed.patch });
          } else if (parsed.action === 'discard_provisional' || parsed.status === 'deleted') {
            emit('localDb.sessions.onPatched', { sessionId: parsed.sessionId, patch: { status: 'deleted' } });
          } else if (parsed.status) {
            emit('localDb.sessions.onPatched', { sessionId: parsed.sessionId, patch: { status: parsed.status } });
          }
        } else if (parsed.type === 'message_created') {
          emit('localDb.messages.onCreated', { sessionId: parsed.sessionId, message: parsed.message });
        } else if (parsed.type === 'message_deleted') {
          emit('localDb.messages.onDeleted', parsed);
        } else if (parsed.type === 'error_persisted') {
          emit('localDb.messages.onErrorPersisted', { sessionId: parsed.sessionId, persistId: parsed.persistId });
        } else if (parsed.type === 'subagent_runs_changed') {
          emit('localDb.subagentRuns.onChanged', parsed);
        } else if (parsed.type === 'input_projection') {
          emit('maker.onInputProjection', parsed.projection);
        } else if (parsed.type === 'project_aliases_changed') {
          emit('localDb.projectAliases.onChanged');
        } else {
          const event = parsed.event ?? {
            type: parsed.type,
            data: parsed.data,
            source: parsed.source,
            agentMeta: parsed.agentMeta,
            turnContinuationId: parsed.turnContinuationId,
            turnScope: parsed.turnScope,
            turnOrigin: parsed.turnOrigin,
          };
          emit('maker.onEvent', {
            sessionId: parsed.sessionId,
            event,
            persistId: parsed.persistId,
            resolvedContent: parsed.resolvedContent,
          });
          if (event.type === 'status' && event.data?.status === 'closed') {
            emit('maker.onStatusChanged', { sessionId: parsed.sessionId, status: 'closed' });
          }
        }
      },
    });
  }

  /** Event listeners registered through `onX` members. */
  const listeners = new Map();
  function emit(channel, ...args) {
    // Both local writes and SSE events invalidate before notifying subscribers.
    const snapshot = channel === 'appearanceSettings.onChanged' ? 'appearanceSettings.getSync'
      : channel === 'layout.onChanged' ? 'layout.getStateSync'
        : channel === 'appShortcuts.onChanged' ? 'appShortcuts.getState'
          : channel.startsWith('sidebarSettings.on') ? 'sidebarSettings.loadSnapshot' : null;
    if (snapshot) syncSnapshots.delete(`${snapshot}\u0000[]`);
    for (const cb of listeners.get(channel) ?? []) {
      try { cb(...args); } catch (error) { console.error('[cindy-web] listener failed', channel, error); }
    }
  }

  /**
   * React's useSyncExternalStore compares snapshots by identity. A shim that
   * builds a fresh array on every call never settles, so sync reads keep the
   * first value they produced for the same channel and arguments.
   */
  const syncSnapshots = new Map();
  /** Installed plugins, fetched once at boot for the synchronous list channel. */
  let ghostsCache = null;
  void (async () => {
    try {
      const installed = await hostChannels['ghosts.listSync']();
      ghostsCache = Array.isArray(installed) ? installed : [];
    } catch {
      ghostsCache = [];
    }
  })();
  let capabilitiesCache = null;

  /** Non-function members the preload exposes as plain values. */
  const VALUE_CHANNELS = Object.freeze({
    'hostConnection.client': 'browser',
    'osRelease': window.__cindyBoot?.osRelease ?? '',
    'clientEndpoints.websiteUrl': 'https://cindy.app',
    'appDisplayVersion': appVersion,
    'appDisplayVersionDetail': `cindy-host (${appVersion})`,
    'preferredSystemLocale': 'zh-CN',
  });

  /**
   * The preload exposes plain objects with stable identities; renderer code
   * memoizes on them (`useMemo([api, …])`, store subscriptions). Building a new
   * Proxy per property read makes every one of those memo keys change on each
   * render, which re-subscribes external stores forever.
   */
  const nodeCache = new Map();

  function makeNode(path) {
    if (nodeCache.has(path)) return nodeCache.get(path);
    const node = function shimCall(...args) {
      window.__cindyCalls?.push(path);
      const handler = routes[path];
      if (!handler) return unsupported(path);
      const sync = SYNC_CHANNEL.test(path) || SYNC_CHANNELS[path] === true
        || path === 'maker.claimLegacyModelVisibilityOwner';
      const cacheKey = sync ? `${path}\u0000${JSON.stringify(args)}` : null;
      if (cacheKey !== null && syncSnapshots.has(cacheKey)) return syncSnapshots.get(cacheKey);
      let value;
      try {
        value = handler(args);
        (window.__cindyRpc ??= []).push({ path, ok: true });
        if (window.__cindyRpc.length > 200) window.__cindyRpc.shift();
      } catch (error) {
        (window.__cindyRpcFailures ??= []).push({ path, error: String(error && error.message ? error.message : error) });
        if (window.__cindyRpcFailures.length > 200) window.__cindyRpcFailures.shift();
        throw error;
      }
      if (cacheKey !== null) syncSnapshots.set(cacheKey, value);
      // Mirror the preload: sync channels return values, the rest are promises.
      return sync ? value : Promise.resolve(value);
    };
    const proxy = new Proxy(node, {
      get(_target, prop) {
        if (path === '' && prop in SYNC_VALUES) return SYNC_VALUES[prop];
        const full = path ? `${path}.${String(prop)}` : String(prop);
        if (full in VALUE_CHANNELS && path !== '') return VALUE_CHANNELS[full];
        if (path === '' && full in VALUE_CHANNELS) return VALUE_CHANNELS[full];
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return undefined;
        // Keep Function.prototype members intact: callers legitimately use
        // `fn.call(...)` on the preload functions.
        if (prop === 'call' || prop === 'apply' || prop === 'bind' || prop === 'name' || prop === 'length') {
          return Reflect.get(_target, prop, _target);
        }
        // Event registrations return an unsubscribe function, like the preload.
        if (prop.startsWith('on') && prop.length > 2 && prop[2] === prop[2].toUpperCase()) {
          const channel = path ? `${path}.${String(prop)}` : String(prop);
          return (callback) => {
            ensureEventStream();
            const set = listeners.get(channel) ?? new Set();
            set.add(callback);
            listeners.set(channel, set);
            if (channel === 'hostConnection.onStateChanged') callback(connectionState);
            return () => set.delete(callback);
          };
        }
        return makeNode(path ? `${path}.${String(prop)}` : String(prop));
      },
    });
    nodeCache.set(path, proxy);
    return proxy;
  }

  window.electronAPI = makeNode('');
  window.__cindyShim = true;
  /**
   * A browser tab has the browser's own window chrome. Renderer code checks this
   * flag to skip the desktop minimize/maximize/close cluster; the style below is
   * the same rule for bundles built before that check existed, which the host
   * serves from the Desktop's last build.
   */
  window.__CINDY_HOST_WEB__ = true;
  {
    const style = document.createElement('style');
    style.dataset.cindyHostWeb = 'window-controls';
    style.textContent = [
      '[data-tooltip-exempt="windows-system-control"]{display:none!important}',
    ].join('\n');
    document.head.appendChild(style);
  }
  window.__cindyCalls = [];
  window.__cindyErrors = [];
  window.addEventListener('error', (event) => {
    window.__cindyErrors.push(String(event.message ?? event.error ?? 'error'));
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__cindyErrors.push('rejection: ' + String(event.reason));
  });

  // Renderer diagnostics land in the browser console; the host never sees them.
  window.addEventListener('error', (event) => {
    console.error('[cindy-web] renderer error', event.error ?? event.message);
  });
  window.addEventListener('focus', () => {
    if (connectionState.status === 'authorization-required') eventConnection?.reconnect();
  });
  if (typeof BroadcastChannel !== 'undefined') {
    const pairing = new BroadcastChannel('cindy-host-pairing');
    pairing.onmessage = () => {
      if (connectionState.status === 'authorization-required') eventConnection?.reconnect();
    };
    window.addEventListener('pagehide', event => { if (!event.persisted) pairing.close(); });
  }
  window.addEventListener('pagehide', event => { if (!event.persisted) eventConnection?.stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) eventConnection?.reconnect(); });
  // Start event stream immediately on boot
  ensureEventStream();
  void pending;
})();
