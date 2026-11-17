import { BrowserWindow, webContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import { readPluginHostUi } from '../mcp-integrations/plugin-app-registry.js';
import type { McpAppResourceBinding } from './host.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';
import { getDeepLinkMainWindow } from '../deepLink.js';
import { isRsbWindowWebContentsId } from '../right-sidebar-window/registry.js';
import { readPluginUiRegions, setPluginUiRegions } from './visibility.js';
import { configurePluginAppearanceApply, editPluginAppearance, getPluginAppearanceService } from './appearance.js';
import { onPagePermissionSessionChanged } from './pagePermissions.js';
import { manageAppSettings } from '../app-settings/sections.js';

type Reply = { caller: string; finish(value: unknown, error?: string): void };
const replies = new Map<string, Reply>();

/** Only the trusted owning renderer can acknowledge an actual editor/layout operation. */
export function finishPluginUiAction(caller: string, id: string, result: unknown, error?: string): void {
  const pending = replies.get(id);
  if (!pending || pending.caller !== caller) throw new Error('MCP_APP_ACTION_UNAVAILABLE');
  pending.finish(result, error);
}

function callerWindow(caller: string) {
  const match = /^renderer:(\d+)$/.exec(caller);
  const contents = match ? webContents.fromId(Number(match[1])) : undefined;
  const window = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
  if (!window || window.isDestroyed()) throw new Error('MCP_APP_OWNER_ONLY');
  return window;
}

async function rendererAction(caller: string, input: Record<string, unknown>, signal: AbortSignal,
  assertCurrent: () => void | Promise<void>, observe?: (value: unknown) => void): Promise<unknown> {
  await assertCurrent();
  signal.throwIfAborted();
  const source = callerWindow(caller);
  // Layout commands use the existing main-window sidebar controller. Full App
  // windows own their drafts; only sidebar-only windows need the main editor.
  const window = input.kind === 'open' || isRsbWindowWebContentsId(source.webContents.id)
    ? getDeepLinkMainWindow() : source;
  if (!window || window.isDestroyed()) throw new Error('MCP_APP_ACTION_UNAVAILABLE');
  const requestId = randomUUID();
  const ownerStamp = getSafeDataOwnerPushStamp();
  const result = await new Promise<unknown>((resolve, reject) => {
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      window.webContents.removeListener('destroyed', abort);
      replies.delete(requestId);
      if (observe && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        try { window.webContents.send('plugin-ui:action', { kind: 'draft-unwatch', requestId, ownerStamp }); } catch { /* Window closed. */ }
      }
    };
    const finish = (value: unknown, error?: string) => {
      if (!active) return;
      if (error) { cleanup(); reject(new Error(error)); return; }
      try { observe?.(value); } catch (failure) { cleanup(); reject(failure); return; }
      clearTimeout(timer);
      if (!observe) cleanup();
      resolve(value);
    };
    const abort = () => finish(undefined, 'MCP_APP_ACTION_CANCELLED');
    const timer = setTimeout(() => finish(undefined, 'MCP_APP_ACTION_TIMEOUT'), 30_000);
    timer.unref();
    replies.set(requestId, { caller: `renderer:${window.webContents.id}`, finish });
    signal.addEventListener('abort', abort, { once: true });
    window.webContents.once('destroyed', abort);
    try { window.webContents.send('plugin-ui:action', { ...input, requestId, ownerStamp }); }
    catch (failure) { cleanup(); reject(failure); }
  });
  await assertCurrent();
  return result;
}

const result = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
configurePluginAppearanceApply(async settings => {
  const window = getDeepLinkMainWindow();
  if (!window || window.isDestroyed()) return { status: 'saved', reason: 'NO_VIEWING_WINDOW' };
  return await rendererAction(`renderer:${window.webContents.id}`, { kind: 'appearance', settings },
    AbortSignal.timeout(30000), () => {}) as { status: 'applied' | 'saved' | 'failed' };
});
const tool = (name: string, description: string, properties: Record<string, object>, required: string[] = []): Tool => ({
  name: `cindy.ui.${name}`, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

/** Resolve declarations in Main. A page never chooses an instance, task or resource. */
export function bindPluginUiResource(caller: string, sessionId: string | null, instance: string, viewId: string,
  revision: (config: NonNullable<ReturnType<typeof readPluginHostUi>>['config']) => string,
  assertScope?: () => Promise<void>, task?: Record<string, unknown>): McpAppResourceBinding {
  const entry = readPluginHostUi(instance);
  const view = entry?.host.views?.find(view => view.id === viewId);
  if (!entry || !view || view.scope === 'task' && sessionId === null) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
  // Global resources have genuinely global scope, even when opened beside a task.
  if (view.scope !== 'task' && sessionId !== null) throw new Error('MCP_APP_INVALID_SCOPE');
  callerWindow(caller);
  const owner = activeOwnerScopeKey();
  const capabilities = entry.host.capabilities ?? [];
  const watching = sessionId !== null && (capabilities.includes('draft') || capabilities.includes('context'))
    ? new AbortController() : undefined;
  const assertCurrent = () => {
    if (watching?.signal.aborted) throw new Error('MCP_APP_SESSION_UNAVAILABLE');
    if (owner !== activeOwnerScopeKey() || readPluginHostUi(instance) !== entry) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
    entry.config.plugin!.assertCurrent(sessionId ?? undefined);
    callerWindow(caller);
  };
  assertCurrent();
  const assertOperation = async () => { assertCurrent(); await assertScope?.(); assertCurrent(); };
  let draft: Record<string, unknown> | null = null;
  const tools: Tool[] = [tool('open', 'Open another approved view of this plugin.', { viewId: { type: 'string' }, input: { type: 'object' } }, ['viewId'])];
  if (entry.host.settings?.length) tools.push(tool('settings', 'Read, update or reset this plugin’s registered settings.', {
    operation: { enum: ['get', 'update', 'reset'] }, patch: { type: 'object' },
  }, ['operation']));
  if (capabilities.includes('draft') && sessionId !== null) tools.push(tool('draft',
    'Read or edit the bound task draft. Read returns a JSON document chunk and nextOffset; subsequent chunks require revision. Replacing requires revision; never sends a message.', {
      mode: { enum: ['read', 'append', 'replace', 'replace-selection'] }, text: { type: 'string', maxLength: 128000 }, revision: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
    }, ['mode']));
  if (capabilities.includes('appearance')) tools.push(tool('appearance', 'Read or patch Cindy appearance through its settings owner.', {
    patch: { type: 'object' }, reset: { type: 'array', items: { type: 'string' } }, ifRevision: { type: 'string' },
  }));
  if (capabilities.includes('visibility')) tools.push(tool('visibility', 'Read or change the owning Cindy window or its UI regions.', {
    visible: { type: 'boolean' }, regions: { type: 'object', additionalProperties: { type: 'boolean' } },
  }));
  return {
    id: `${instance}:${viewId}`, title: view.title, serverId: entry.config.id,
    serverRevision: revision(entry.config), resourceUri: view.resourceUri, assertCurrent, assertOperation, hostTools: tools,
    ...(watching ? {
      async observeContext(changed: () => void, signal: AbortSignal) {
        const stop = () => { signal.removeEventListener('abort', stop); unlistenSession(); watching.abort(); };
        const unlistenSession = onPagePermissionSessionChanged((id, patch) => {
          if (id !== sessionId || !('clearedAt' in patch || 'status' in patch && patch.status !== 'active')) return;
          stop();
          draft = null;
        });
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        try {
          if (!capabilities.includes('draft')) return stop;
          await rendererAction(caller, { kind: 'draft-watch', sessionId }, watching.signal, assertCurrent, value => {
            assertCurrent();
            const snapshot = value as Record<string, unknown>;
            draft = { revision: snapshot.revision, selection: snapshot.selection ?? null }; changed();
          });
          return stop;
        } catch (failure) { stop(); throw failure; }
      },
    } : {}),
    projectContext(context: McpUiHostContext) {
      assertCurrent();
      const supplied = context.cindy && typeof context.cindy === 'object' && !Array.isArray(context.cindy)
        ? context.cindy as Record<string, unknown> : {};
      return { source: { instanceId: instance, viewId, sessionId }, capabilities,
        input: supplied.input && typeof supplied.input === 'object' && !Array.isArray(supplied.input) ? supplied.input : {},
        ...(sessionId !== null && capabilities.includes('context') ? {
          context: { ...(supplied.context && typeof supplied.context === 'object' && !Array.isArray(supplied.context) ? supplied.context : {}),
            ...(task ? { task } : {}), sessionId }, selection: supplied.selection ?? '',
        } : {}),
        ...(sessionId !== null && capabilities.includes('draft') ? { draft } : {}),
      };
    },
    async callHostTool(name, args, signal) {
      await assertOperation(); signal.throwIfAborted();
      if (!tools.some(tool => tool.name === name)) throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
      switch (name) {
        case 'cindy.ui.settings':
          if (!['get', 'update', 'reset'].includes(String(args.operation))) throw new Error('MCP_APP_INVALID_REQUEST');
          return result(await manageAppSettings({ operation: args.operation as 'get' | 'update' | 'reset',
            section: `plugins.${instance}`, patch: args.patch as Record<string, unknown> | undefined }, assertOperation));
        case 'cindy.ui.open': {
          if (args.input !== undefined && (!args.input || typeof args.input !== 'object' || Array.isArray(args.input))) throw new Error('MCP_APP_INVALID_REQUEST');
          const target = entry.host.views?.find(view => view.id === args.viewId);
          if (!target || target.scope === 'task' && sessionId === null) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
          return result(await rendererAction(caller, { kind: 'open', instanceId: instance, viewId: target.id,
            sessionId: target.scope === 'task' ? sessionId : null, input: args.input }, signal, assertOperation));
        }
        case 'cindy.ui.draft':
          if (args.mode === 'read') {
            if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0) ||
              args.revision !== undefined && typeof args.revision !== 'string' || (args.offset as number) > 0 && typeof args.revision !== 'string')
              throw new Error('MCP_APP_INVALID_REQUEST');
            return result(await rendererAction(caller, { kind: 'draft-read', sessionId, offset: args.offset ?? 0,
              revision: args.revision }, signal, assertOperation));
          }
          if (!['append', 'replace', 'replace-selection'].includes(String(args.mode)) || typeof args.text !== 'string' || args.text.length > 128000 ||
              args.mode !== 'append' && typeof args.revision !== 'string') throw new Error('MCP_APP_INVALID_REQUEST');
          return result(await rendererAction(caller, { kind: 'draft', sessionId, mode: args.mode,
            text: args.text, revision: args.revision }, signal, assertOperation));
        case 'cindy.ui.appearance': {
          const { readAppearanceSettings } = await import('../appearance-settings-store.js');
          const { updateAppearanceFromSettings } = await import('../appearance-settings-ipc.js');
          assertCurrent(); signal.throwIfAborted();
          if (args.patch !== undefined && args.reset !== undefined) throw new Error('MCP_APP_INVALID_REQUEST');
          if (args.reset !== undefined) return result(await editPluginAppearance(instance,
            { kind: 'reset', fields: args.reset, ifRevision: args.ifRevision }, assertCurrent));
          if (!args.patch) {
            const { uiFontResource: _ui, codeFontResource: _code, bodyFontResource: _body, ...settings } = readAppearanceSettings();
            return result({ ...settings, ...(await getPluginAppearanceService()).read(instance, assertCurrent) });
          }
          if (typeof args.patch === 'object' && !Array.isArray(args.patch) &&
              Object.keys(args.patch).some(key => ['uiFont', 'codeFont', 'bodyFont', 'wallpaper', 'theme', 'reading', 'contentStyle'].includes(key)))
            return result(await editPluginAppearance(instance, { kind: 'set', patch: args.patch, ifRevision: args.ifRevision }, assertCurrent));
          if (typeof args.patch !== 'object' || Array.isArray(args.patch) || 'appIcon' in args.patch) throw new Error('MCP_APP_INVALID_REQUEST');
          if (entry.host.appearance) {
            const fields: Record<string, string> = { uiFamily: 'uiFont', uiSize: 'uiFont', codeFamily: 'codeFont', codeSize: 'codeFont',
              wallpaperId: 'wallpaper', wallpaperOverlay: 'wallpaper', wallpaperMotion: 'wallpaper', wallpaperVisibility: 'wallpaper',
              desktopVisibility: 'wallpaper', wallpaperBlur: 'wallpaper' };
            if (Object.keys(args.patch).some(key => !entry.host.appearance!.fields.includes(fields[key]))) throw new Error('FIELD_NOT_DECLARED');
          }
          return result(await updateAppearanceFromSettings(args.patch, { ifRevision: args.ifRevision, assertCurrent }));
        }
        case 'cindy.ui.visibility': {
          const window = callerWindow(caller);
          if (args.visible !== undefined && typeof args.visible !== 'boolean') throw new Error('MCP_APP_INVALID_REQUEST');
          const layoutWindow = isRsbWindowWebContentsId(window.webContents.id) ? getDeepLinkMainWindow() : window;
          if (!layoutWindow || layoutWindow.isDestroyed()) throw new Error('MCP_APP_ACTION_UNAVAILABLE');
          const regions = args.regions === undefined ? readPluginUiRegions(layoutWindow)
            : setPluginUiRegions(layoutWindow, instance, `${entry.owner}:${entry.fingerprint}`, args.regions);
          if (args.regions !== undefined) await rendererAction(caller, { kind: 'regions', values: regions }, signal, assertOperation);
          if (args.visible === true) window.show();
          if (args.visible === false) window.hide();
          return result({ visible: window.isVisible(), regions });
        }
        default: throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
      }
    },
  };
}
