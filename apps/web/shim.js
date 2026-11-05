/**
 * Browser shim for the renderer's `window.electronAPI`.
 *
 * The renderer is reused unchanged: this module publishes the same shape and
 * forwards the channels the host implements to the loopback HTTP API, using the
 * HttpOnly cookie the server sets when it serves the app. Unimplemented channels
 * reject with `HOST_CHANNEL_UNSUPPORTED` so the existing UI shows its own error
 * state instead of a fake success.
 */

(function installCindyHostShim() {
  const pending = new Map();

  async function rpc(path, args) {
    const response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? null),
      credentials: 'same-origin',
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(detail || `host ${path} failed`), { code: `HTTP_${response.status}` });
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Frozen singletons for the channels the host answers with a constant.
   * Several renderer stores compare snapshots by identity; a fresh object per
   * read makes React re-render forever (#185).
   */
  const STATIC = Object.freeze({
    remoteDesktopState: Object.freeze({ status: 'unavailable' }),
    ghosts: Object.freeze({ ghosts: [] }),
    ghostRecommendations: Object.freeze({ items: [] }),
    layout: Object.freeze({ layout: null }),
    sidebarSettings: Object.freeze({ pinned: [], hidden: [], order: [] }),
    pluginRuns: Object.freeze({ runs: [] }),
    emptyList: Object.freeze([]),
    memorySettings: Object.freeze({ maker: true, claudeCode: true, codex: true, pi: true }),
    gitSafetyOff: Object.freeze({ mode: 'off' }),
    claimDenied: Object.freeze({ claimed: false }),
    emptyOverrides: Object.freeze({}),
    botGroupsEmpty: Object.freeze({ ok: true, groups: Object.freeze([]) }),
    deviceLinkState: Object.freeze({ status: 'unavailable', devices: Object.freeze([]) }),
    voiceNotReady: Object.freeze({
      ok: false, serviceMode: Object.freeze({}), provider: 'openai-realtime-whisper',
      providerModel: '', auth: 'api-key', settingsTab: 'api-keys', error: 'not_available_on_host',
    }),
    rightSidebarTabs: Object.freeze({ tabs: Object.freeze([]), activeTabId: null }),
    voiceModelSelection: Object.freeze({ serviceMode: null, asrProvider: null, refinerProvider: null, refinerModel: null }),
    appShortcuts: Object.freeze({ overrides: Object.freeze({}), platform: 'linux', globalFailures: Object.freeze([]) }),
  });

  // Channel table: electronAPI paths the host actually implements.
  const routes = {
    // Host-side telemetry sink: the browser already logs to its console.
    'logToMain': (args) => {
      const [, scope, message] = args ?? [];
      window.__cindyErrors?.push(`${scope}: ${String(message).slice(0, 400)}`);
      return undefined;
    },
    // Boot-time snapshot; the host has no microphone permission surface.
    'voiceInput.getDataSnapshot': () => window.__cindyBoot?.voiceInput ?? {
      settings: {}, history: [],
    },
    'auth.getState': () => rpc('/me'),
    // Renderer boot gates: answer with the host defaults instead of stalling.
    'maker.send': async (args) => {
      const [sessionId, message, createOpts] = args ?? [];
      const prompt = typeof message === 'string' ? message : (message?.content ?? '');
      const body = {
        prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        workDir: createOpts?.workingDir,
        model: createOpts?.model,
        agentKind: createOpts?.agentKind === 'codex' ? 'codex' : 'claude-code',
      };
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    'maker.listProviders': () => rpc('/providers'),
    'maker.usage.getModelPricing': () => rpc('/usage/model-pricing'),
    'maker.usage.getReferenceModelPricing': () => rpc('/usage/reference-model-pricing'),
    'modelAccess.getStatus': () => rpc('/model-access'),
    'modelAccess.retry': () => rpc('/model-access'),
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
      if (!capabilitiesCache.has(key)) capabilitiesCache.set(key, rpc('/capabilities', { agentKind: key }));
      return capabilitiesCache.get(key);
    },
    'maker.listAvailableAgents': () => rpc('/agents'),
    'maker.listAgentCommands': (args) => rpc('/agent-commands', { agentKind: args?.[0], sessionId: args?.[1]?.sessionId }),
    'maker.listAgentSkills': (args) => rpc('/agent-skills', { agentKind: args?.[0], workingDir: args?.[1]?.workingDir, sessionId: args?.[1]?.sessionId, forceReload: args?.[1]?.forceReload === true }),
    'maker.listDesktopCommands': () => ({ success: true, commands: STATIC.emptyList }),
    'maker.discardProvisionalSession': (args) => rpc('/sessions/discard', { sessionId: args?.[0] }),
    'maker.commitProvisionalSession': (args) => rpc('/sessions/commit', { sessionId: args?.[0] }),
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
    'maker.memoryPreserveLegacyMakerDisabled': () => STATIC.memorySettings,
    'voiceInput.getReadinessCached': () => STATIC.voiceNotReady,
    'voiceInput.getReadiness': () => STATIC.voiceNotReady,
    'voiceInput.getHistory': () => STATIC.emptyList,
    'voiceInput.getHistoryForRefinement': () => STATIC.emptyList,
    'voiceInput.getModelSelection': () => STATIC.voiceModelSelection,
    'voiceInput.onDataChanged': () => () => {},
    'appShortcuts.getState': () => STATIC.appShortcuts,
    'appShortcuts.setOverride': () => ({ overrides: STATIC.emptyOverrides }),
    'appShortcuts.clearOverride': () => ({ overrides: STATIC.emptyOverrides }),
    'accessibilitySupport.getSync': () => false,
    'ghosts.unreadSync': () => 0,
    'ghosts.noteSessionFocused': () => undefined,
    'ghosts.markUsed': () => undefined,
    'voiceInput.cancel': () => undefined,
    'rightSidebarWindow.setContext': () => undefined,
    'notificationSetDesktopEnabled': () => undefined,
    'takePendingDeepLink': () => null,
    'safeStorageRead': () => null,
    'maker.listBotGroups': () => STATIC.botGroupsEmpty,
    'maker.botGroupOutbox': () => STATIC.emptyList,
    'maker.schedule.listSidebarIndexRuns': () => STATIC.emptyList,
    'deviceLink.getState': () => STATIC.deviceLinkState,
    'deviceLink.listDevices': () => STATIC.emptyList,
    'deviceLink.mirrorCache.getSessionList': () => STATIC.emptyList,
    'deviceLink.mirrorCache.putSessionList': () => undefined,
    'localDb.sessions.interruptedPending': () => STATIC.emptyList,
    'localDb.sessions.errorTailPending': () => STATIC.emptyList,
    'localDb.sessions.interruptedResumeCandidates': () => STATIC.emptyList,
    'localDb.sessions.setPinnedCardSummaries': () => undefined,
    'localDb.bots.workbench.followScopes': () => STATIC.emptyList,
    'sharedTask.account': () => null,
    'maker.gitSafetyGet': () => STATIC.gitSafetyOff,
    'maker.gitSafetySet': () => STATIC.gitSafetyOff,
    // The host already opened and migrated the owner database before serving.
    'localDb.ensureReady': () => ({ ready: true }),
    'authInitialize': () => {
      const boot = window.__cindyBoot?.auth ?? {};
      return {
        user: boot.user ?? null,
        mode: boot.user ? 'cloud' : 'signed-out',
        dataOwnerId: boot.ownerId ?? null,
        ownerGeneration: 1,
        canEnterApp: Boolean(boot.user),
        isAuthenticated: Boolean(boot.user),
        isCanary: false,
        deviceId: boot.deviceId ?? 'host',
        hasAccountDeletionReceipt: false,
        accountDeletionRestored: false,
        credentialStoreUnavailable: false,
      };
    },
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
        platform: 'linux',
      };
    },
    'localThemes.listSync': () => STATIC.emptyList,
    'authHasPersistedSessionHintSync': () => Boolean(window.__cindyBoot?.auth?.user),
    'appearanceSettings.getSync': () => window.__cindyBoot?.appearance ?? {},
    'appearanceSettings.get': () => Promise.resolve(window.__cindyBoot?.appearance ?? {}),
    'getAnalyticsSettings': () => ({ allowed: false }),
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
    'layout.getStateSync': () => ({ layout: window.__cindyBoot?.layout ?? null }),
    'ghosts.listSync': () => STATIC.ghosts,
    'ghosts.recommendationsSync': () => STATIC.ghostRecommendations,
    'sidebarSettings.loadSnapshot': () => STATIC.sidebarSettings,
    'maker.listActive': () => STATIC.emptyList,
    'remoteDesktop.state': () => STATIC.remoteDesktopState,
    'sidebarSettings.claimLegacyRendererOwner': () => STATIC.claimDenied,
    'setUpdateRelaunchTheme': () => undefined,
    'theme.applyVibrancy': () => undefined,
    'syncWorkerCreationPrefs': () => undefined,
    'syncDesktopCcPrefs': () => undefined,
    'syncNewMakerDraft': () => undefined,
    'syncProviderModelMemory': () => undefined,
    'setClassicalReplyStyle': () => undefined,
    'setApplicationMenuLocale': () => undefined,
    'localDb.sessions.create': (args) => rpc('/sessions/create', args?.[0] ?? {}),
    'localDb.sessions.get': (args) => rpc('/sessions/get', { sessionId: args?.[0] }),
    'localDb.sessions.list': () => rpc('/sessions/list'),
    'localDb.sessions.messages': async (args) => rpc('/sessions/messages', args),
    'localDb.rightSidebarTabs.list': () => STATIC.rightSidebarTabs,
    'localDb.messages.list': (args) => rpc('/messages/list', { sessionId: args?.[0], limit: args?.[1]?.limit }),
    'localDb.messages.estimatedSessionValue': (args) => rpc('/messages/estimated-value', { sessionId: args?.[0] }),
    'localDb.messages.historyView': (args) => rpc('/messages/history-view', { sessionId: args?.[0], before: args?.[1]?.before ?? null }),
    'pluginMarket.listInstalled': () => rpc('/plugins/list'),
    'logToMain': (args) => {
      const [, scope, message] = args ?? [];
      window.__cindyErrors?.push(`${scope}: ${String(message).slice(0, 400)}`);
      return undefined;
    },
  };

  const SYNC_CHANNEL = /(Sync$|getSync$|listSync$|getDataSnapshot$)/;

  function unsupported(path) {
    const error = new Error(`host channel not implemented: ${path}`);
    error.code = 'HOST_CHANNEL_UNSUPPORTED';
    (window.__cindyRpcFailures ??= []).push({ path, error: 'unsupported' });
    return Promise.reject(error);
  }

  const SYNC_VALUES = {
    platform: 'linux',
    windowBackdropMaterial: 'none',
    appVersion: '0.0.0-host',
    isPackaged: false,
    locale: 'en',
  };

  /** Event listeners registered through `onX` members. */
  const listeners = new Map();
  function emit(channel, payload) {
    for (const cb of listeners.get(channel) ?? []) {
      try { cb(payload); } catch (error) { console.error('[cindy-web] listener failed', channel, error); }
    }
  }

  /**
   * React's useSyncExternalStore compares snapshots by identity. A shim that
   * builds a fresh array on every call never settles, so sync reads keep the
   * first value they produced for the same channel and arguments.
   */
  const syncSnapshots = new Map();
  let capabilitiesCache = null;

  /** Non-function members the preload exposes as plain values. */
  const VALUE_CHANNELS = Object.freeze({
    'clientEndpoints.websiteUrl': 'https://cindy.app',
    'appDisplayVersion': '0.0.0-host',
    'appDisplayVersionDetail': 'cindy-host',
    'preferredSystemLocale': 'en',
  });

  function makeNode(path) {
    const node = function shimCall(...args) {
      window.__cindyCalls?.push(path);
      const handler = routes[path];
      if (!handler) return unsupported(path);
      const sync = SYNC_CHANNEL.test(path) || path === 'maker.claimLegacyModelVisibilityOwner';
      const cacheKey = sync ? `${path}\u0000${JSON.stringify(args)}` : null;
      if (cacheKey !== null && syncSnapshots.has(cacheKey)) return syncSnapshots.get(cacheKey);
      let value;
      try {
        value = handler(args);
        (window.__cindyRpc ??= []).push({ path, ok: true });
      } catch (error) {
        (window.__cindyRpcFailures ??= []).push({ path, error: String(error && error.message ? error.message : error) });
        throw error;
      }
      if (cacheKey !== null) syncSnapshots.set(cacheKey, value);
      // Mirror the preload: sync channels return values, the rest are promises.
      return sync ? value : Promise.resolve(value);
    };
    return new Proxy(node, {
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
            const set = listeners.get(channel) ?? new Set();
            set.add(callback);
            listeners.set(channel, set);
            return () => set.delete(callback);
          };
        }
        return makeNode(path ? `${path}.${String(prop)}` : String(prop));
      },
    });
  }

  window.electronAPI = makeNode('');
  window.__cindyShim = true;
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
  void pending;
})();
