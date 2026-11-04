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
    'ghosts.listPickerModels': () => [],
    'maker.memoryGetSettings': () => ({ maker: true, claudeCode: true, codex: true, pi: true }),
    'maker.memoryPreserveLegacyMakerDisabled': () => ({ maker: true, claudeCode: true, codex: true, pi: true }),
    'maker.gitSafetyGet': () => ({ mode: 'off' }),
    'maker.gitSafetySet': () => ({ mode: 'off' }),
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
    'localThemes.listSync': () => [],
    'authHasPersistedSessionHintSync': () => Boolean(window.__cindyBoot?.auth?.user),
    'appearanceSettings.getSync': () => window.__cindyBoot?.appearance ?? {},
    'appearanceSettings.get': () => Promise.resolve(window.__cindyBoot?.appearance ?? {}),
    'getAnalyticsSettings': () => ({ allowed: false }),
    'voiceInput.setGlobalShortcut': () => ({ ok: false }),
    'worktreeListAll': () => [],
    'localDb.bots.list': () => [],
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
    'ghosts.listSync': () => ({ ghosts: [] }),
    'ghosts.recommendationsSync': () => ({ items: [] }),
    'sidebarSettings.loadSnapshot': () => ({ pinned: [], hidden: [], order: [] }),
    'maker.getCapabilities': () => ({ agents: ['claude-code'], models: [] }),
    'maker.listActive': () => [],
    'remoteDesktop.state': () => ({ status: 'unavailable' }),
    'sidebarSettings.claimLegacyRendererOwner': () => ({ claimed: false }),
    'maker.claimLegacyModelVisibilityOwner': () => ({ claimed: false }),
    'setUpdateRelaunchTheme': () => undefined,
    'theme.applyVibrancy': () => undefined,
    'syncWorkerCreationPrefs': () => undefined,
    'syncDesktopCcPrefs': () => undefined,
    'syncNewMakerDraft': () => undefined,
    'syncProviderModelMemory': () => undefined,
    'setClassicalReplyStyle': () => undefined,
    'setApplicationMenuLocale': () => undefined,
    'localDb.sessions.list': () => rpc('/sessions/list'),
    'localDb.sessions.messages': async (args) => rpc('/sessions/messages', args),
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

  function makeNode(path) {
    const node = function shimCall(...args) {
      window.__cindyCalls?.push(path);
      const handler = routes[path];
      if (!handler) return unsupported(path);
      const value = handler(args);
      // Mirror the preload: sync channels return values, the rest are promises.
      return SYNC_CHANNEL.test(path) ? value : Promise.resolve(value);
    };
    return new Proxy(node, {
      get(_target, prop) {
        if (path === '' && prop in SYNC_VALUES) return SYNC_VALUES[prop];
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
