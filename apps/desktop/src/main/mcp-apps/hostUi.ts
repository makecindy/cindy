import { BrowserWindow, webContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import { readPluginHostUi } from '../mcp-integrations/plugin-app-registry.js';
import type { McpAppResourceBinding } from './host.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';
import { getDeepLinkMainWindow } from '../deepLink.js';

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
  callerWindow(caller);
  // Detached pages still operate on the original editor and layout owners.
  const window = getDeepLinkMainWindow();
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
  const assertCurrent = () => {
    if (owner !== activeOwnerScopeKey() || readPluginHostUi(instance) !== entry) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
    entry.config.plugin!.assertCurrent(sessionId ?? undefined);
    callerWindow(caller);
  };
  assertCurrent();
  const assertOperation = async () => { assertCurrent(); await assertScope?.(); assertCurrent(); };
  const capabilities = entry.host.capabilities ?? [];
  let draft: unknown = null;
  const tools: Tool[] = [tool('open', 'Open another approved view of this plugin.', { viewId: { type: 'string' }, input: { type: 'object' } }, ['viewId'])];
  if (capabilities.includes('draft') && sessionId !== null) tools.push(tool('draft',
    'Edit the bound task draft. Replacing requires the revision from hostContext.cindy.draft; never sends a message.', {
      mode: { enum: ['append', 'replace'] }, text: { type: 'string', maxLength: 128000 }, revision: { type: 'string' },
    }, ['mode', 'text']));
  if (capabilities.includes('appearance')) tools.push(tool('appearance', 'Read or patch Cindy appearance through its settings owner.', {
    patch: { type: 'object' },
  }));
  if (capabilities.includes('visibility')) tools.push(tool('visibility', 'Read or change the owning Cindy window visibility.', { visible: { type: 'boolean' } }));
  if (capabilities.includes('app-icon')) tools.push(tool('app-icon', 'Choose the existing macOS Dock artwork. Does not change Finder artwork.', {
    icon: { enum: ['default', 'cat', 'wordmark', 'mark'] },
  }, ['icon']));
  return {
    id: `${instance}:${viewId}`, title: view.title, serverId: entry.config.id,
    serverRevision: revision(entry.config), resourceUri: view.resourceUri, assertCurrent, assertOperation, hostTools: tools,
    ...(sessionId !== null && capabilities.includes('draft') ? {
      async observeContext(changed: () => void, signal: AbortSignal) {
        const watching = new AbortController();
        const stop = () => { signal.removeEventListener('abort', stop); watching.abort(); };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        try {
          await rendererAction(caller, { kind: 'draft-watch', sessionId }, watching.signal, assertCurrent, value => {
            assertCurrent(); draft = value; changed();
          });
          return stop;
        } catch (failure) { stop(); throw failure; }
      },
    } : {}),
    projectContext(context: McpUiHostContext) {
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
        case 'cindy.ui.open': {
          if (args.input !== undefined && (!args.input || typeof args.input !== 'object' || Array.isArray(args.input))) throw new Error('MCP_APP_INVALID_REQUEST');
          const target = entry.host.views?.find(view => view.id === args.viewId);
          if (!target || target.scope === 'task' && sessionId === null) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
          return result(await rendererAction(caller, { kind: 'open', instanceId: instance, viewId: target.id,
            sessionId: target.scope === 'task' ? sessionId : null, input: args.input }, signal, assertOperation));
        }
        case 'cindy.ui.draft':
          if ((args.mode !== 'append' && args.mode !== 'replace') || typeof args.text !== 'string' || args.text.length > 128000 ||
              args.mode === 'replace' && typeof args.revision !== 'string') throw new Error('MCP_APP_INVALID_REQUEST');
          return result(await rendererAction(caller, { kind: 'draft', sessionId, mode: args.mode,
            text: args.text, revision: args.revision }, signal, assertOperation));
        case 'cindy.ui.appearance': {
          const { readAppearanceSettings } = await import('../appearance-settings-store.js');
          const { updateAppearanceFromSettings } = await import('../appearance-settings-ipc.js');
          assertCurrent(); signal.throwIfAborted();
          if (!args.patch) return result(readAppearanceSettings());
          if (typeof args.patch !== 'object' || Array.isArray(args.patch) || 'appIcon' in args.patch) throw new Error('MCP_APP_INVALID_REQUEST');
          return result(await updateAppearanceFromSettings(args.patch));
        }
        case 'cindy.ui.app-icon': {
          if (!['default', 'cat', 'wordmark', 'mark'].includes(String(args.icon))) throw new Error('MCP_APP_INVALID_REQUEST');
          const { updateAppearanceFromSettings } = await import('../appearance-settings-ipc.js');
          assertCurrent(); signal.throwIfAborted();
          return result(await updateAppearanceFromSettings({ appIcon: args.icon }));
        }
        case 'cindy.ui.visibility': {
          const window = callerWindow(caller);
          if (args.visible !== undefined && typeof args.visible !== 'boolean') throw new Error('MCP_APP_INVALID_REQUEST');
          if (args.visible === true) window.show();
          if (args.visible === false) window.hide();
          return result({ visible: window.isVisible() });
        }
        default: throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
      }
    },
  };
}
