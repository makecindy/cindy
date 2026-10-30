import { randomUUID } from 'node:crypto';
import {
  BrowserWindow,
  dialog,
  session,
  shell,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';
import {
  PLUGIN_OAUTH_CHANNEL,
  PLUGIN_SETTINGS_ACTION,
  PLUGIN_PAGE_MAX_BUNDLE_BYTES,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
  oauthId,
  oauthGhostId,
  parsePluginOauthAction,
  parsePluginSettingsRequest,
  type PluginPageFile,
  type PluginPageFetchResult,
  type PluginSettingsCommand,
  type PluginPagePoll,
  type PluginOauthRequest,
} from '@cindy/device-link';
import {
  REMOTE_PLUGIN_SETTINGS_PARTITION,
  REMOTE_PLUGIN_SETTINGS_DIRECTORY,
  type RemotePluginSettingsTarget,
  type RemotePluginSettingsView,
} from '../../shared/remotePluginSettings.js';
import { isSafeGhostRelativePath } from '../../shared/ghost.js';
import { authenticateOauthController } from '../plugin-oauth/authentication.js';
import { capturePluginOauthPeer } from '../plugin-oauth/runtime.js';
import { handleAssistPluginOauth, type LocalOauthDeps } from '../plugin-oauth/localIpc.js';
import { GHOST_HTML_CSP, registerGhostWebContents } from './runtime/electronSandboxAdapter.js';
import { remoteSettingsBroadcastScript } from './remoteSettingsBroadcast.js';
import { getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';
import { t } from '../i18n.js';

interface SettingsDocument {
  pageId: string;
  pluginId: string;
  manifestId: string;
  name: string;
  entry: string;
  files: PluginPageFile[];
}
const unavailable = () => new Error('PLUGIN_SETTINGS_UNAVAILABLE');
export function parseSettingsDocument(raw: unknown, instanceId: string): SettingsDocument {
  const doc = raw as SettingsDocument;
  if (
    !doc ||
    !oauthId(doc.pageId) ||
    doc.pluginId !== instanceId ||
    !oauthId(doc.manifestId) ||
    typeof doc.name !== 'string' ||
    doc.name.length > 160 ||
    !isSafeGhostRelativePath(doc.entry) ||
    !Array.isArray(doc.files) ||
    !doc.files.length ||
    doc.files.length > 10_000
  )
    throw unavailable();
  let total = 0;
  const paths = new Set<string>();
  for (const file of doc.files) {
    if (
      !file ||
      !isSafeGhostRelativePath(file.path) ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.mime !== 'string' ||
      file.mime.length > 128 ||
      /[\r\n]/.test(file.mime)
    )
      throw unavailable();
    paths.add(file.path);
    total += file.size;
  }
  if (
    total > PLUGIN_PAGE_MAX_BUNDLE_BYTES ||
    !doc.files.some((f) => f.path === doc.entry && f.mime.startsWith('text/html'))
  )
    throw unavailable();
  return {
    pageId: doc.pageId,
    pluginId: doc.pluginId,
    manifestId: doc.manifestId,
    name: doc.name,
    entry: doc.entry,
    files: doc.files,
  };
}

interface View {
  id: string;
  host: WebContents;
  partition: string;
  src: string;
  current(): void;
  attach(guest: WebContents): void;
  close(): void;
  answerDirectory(requestId: string, path: string | null): Promise<void>;
  answerModelPicker(requestId: string, route: import('@cindy/device-link').PluginModelSelection | null): Promise<unknown>;
}
const views = new Map<string, View>();

export function resolveRemoteSettingsAttach(
  host: WebContents,
  partition: string,
  src: string,
): View | null {
  const view = views.get(partition);
  if (!view || view.host !== host || view.src !== src) return null;
  try {
    view.current();
    return view;
  } catch {
    view.close();
    return null;
  }
}
export function closeRemotePluginSettings(host: WebContents, id: unknown): void {
  if (typeof id !== 'string') throw unavailable();
  for (const view of views.values())
    if (view.id === id && view.host === host) {
      view.close();
      return;
    }
}
export async function answerRemotePluginSettingsDirectory(
  host: WebContents,
  raw: unknown,
): Promise<void> {
  const answer =
    raw as import('../../shared/remotePluginSettings.js').RemotePluginSettingsDirectoryAnswer;
  if (!answer || typeof answer.viewId !== 'string') throw unavailable();
  const command = { kind: 'answer-directory', requestId: answer.requestId, path: answer.path };
  if (!parsePluginSettingsRequest({ op: 'settings', id: 'local', command })) throw unavailable();
  const view = [...views.values()].find((view) => view.id === answer.viewId && view.host === host);
  if (!view) throw unavailable();
  view.current();
  await view.answerDirectory(answer.requestId, answer.path);
}

export async function answerRemotePluginSettingsModelPicker(host: WebContents, raw: unknown): Promise<unknown> {
  const answer = raw as { viewId?: unknown; requestId?: unknown; route?: unknown } | null;
  if (!answer || typeof answer.viewId !== 'string') throw unavailable();
  const parsed = parsePluginSettingsRequest({ op: 'settings', id: 'local', command: {
    kind: 'answer-model-picker', requestId: answer.requestId, route: answer.route,
  } });
  if (!parsed || parsed.command.kind !== 'answer-model-picker') throw unavailable();
  const view = [...views.values()].find(v => v.id === answer.viewId && v.host === host);
  if (!view) throw unavailable();
  view.current();
  return view.answerModelPicker(parsed.command.requestId, parsed.command.route);
}

/** Main owns the encrypted exchange and the isolated page session. No values enter the app Renderer. */
export async function openRemotePluginSettings(
  host: WebContents,
  deps: LocalOauthDeps,
  raw: unknown,
): Promise<RemotePluginSettingsView> {
  const input = raw as RemotePluginSettingsTarget;
  if (
    !input ||
    !oauthId(input.deviceId) ||
    !oauthGhostId(input.instanceId) ||
    typeof input.expectedInstalledApproval !== 'string' ||
    input.expectedInstalledApproval.length > 4096 ||
    views.size >= 8
  )
    throw unavailable();
  const owner = deps.owner(),
    peerCurrent = capturePluginOauthPeer(input.deviceId);
  let closed = false;
  const assertCurrent = () => {
    if (closed || !owner || deps.owner() !== owner || host.isDestroyed()) throw unavailable();
    peerCurrent();
    deps.assertTarget(input.deviceId);
  };
  assertCurrent();
  const opened = await deps.invoke(input.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [
    {
      client: {
        protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
        primitives: ['status', 'markdown', 'action', 'form', 'list'],
      },
      collectionId: 'plugins',
      actionId: 'settings:open',
      resourceRef: { collectionId: 'plugins', kind: 'plugin', id: input.instanceId },
      input: { expectedInstalledApproval: input.expectedInstalledApproval },
    },
  ]);
  assertCurrent();
  if (!opened.ok) throw unavailable();
  const doc = parseSettingsDocument(
    (opened.result as { result?: unknown })?.result,
    input.instanceId,
  );
  const id = randomUUID(),
    partition = REMOTE_PLUGIN_SETTINGS_PARTITION + id;
  const origin = 'cindy-ghost://' + doc.manifestId;
  const src = origin + '/' + doc.entry;
  const internal = '/__cindy_remote_settings_' + randomUUID();
  let exchange: ((request: PluginOauthRequest) => Promise<unknown>) | undefined;
  let renew: Promise<void> | undefined,
    renewedAt = 0,
    sent = 0;
  const connect = async () => {
    assertCurrent();
    const target = await deps.identity(input.deviceId, assertCurrent);
    if (target.deviceId !== input.deviceId) throw unavailable();
    exchange = await authenticateOauthController({
      target,
      peer: deps.localDeviceId(),
      trustIdentity: deps.trustIdentity,
      action: { requestId: doc.pageId, actionId: PLUGIN_SETTINGS_ACTION, expectedRevision: 0 },
      ghostId: doc.pluginId,
      assertCurrent,
      invoke: async (request) => {
        peerCurrent();
        if (deps.owner() !== owner) throw unavailable();
        const result = await deps.invoke(input.deviceId, PLUGIN_OAUTH_CHANNEL, [request]);
        if (!result.ok) throw unavailable();
        return result.result;
      },
    });
    renewedAt = Date.now();
    sent = 0;
  };
  const send = async (command: PluginSettingsCommand) => {
    assertCurrent();
    // Reserve before sending; leave room under the Host's 1024-message limit.
    // A lost response must never cause a submitted command to be replayed.
    while (!exchange || Date.now() - renewedAt > 240_000 || sent >= 1000) {
      renew ??= connect().finally(() => {
        renew = undefined;
      });
      await renew;
      assertCurrent();
    }
    assertCurrent();
    sent++;
    return exchange!({ op: 'settings', id: doc.pageId, command });
  };
  await connect();
  assertCurrent();
  const ses = session.fromPartition(partition);
  let guest: WebContents | undefined;
  const confirmations = new Set<string>();
  const modelPickers = new Set<string>();
  const dismissModelPicker = (requestId: string) => {
    modelPickers.delete(requestId);
    if (!host.isDestroyed()) host.send('ghosts:model-picker:dismissed', { requestId }, getSafeDataOwnerPushStamp());
  };
  const prompt = (options: MessageBoxOptions) => {
    assertCurrent();
    const parent = BrowserWindow.fromWebContents(host);
    if (!parent || parent.isDestroyed()) throw unavailable();
    return dialog.showMessageBox(parent, options);
  };
  const confirm = async (value: PluginPagePoll['confirms'][number]) => {
    if (confirmations.has(value.id)) return;
    confirmations.add(value.id);
    if (confirmations.size > 256) confirmations.delete(confirmations.values().next().value!);
    try {
      assertCurrent();
      const { response } = await prompt({
        type: 'question',
        message: value.body,
        title: value.title,
        buttons: [
          value.confirmText ?? t('settings.ghosts.connections.confirmAllow'),
          value.cancelText ?? t('settings.ghosts.connections.confirmCancel'),
        ],
        defaultId: 1,
        cancelId: 1,
      });
      assertCurrent();
      await send({ kind: 'confirm', requestId: value.id, accepted: response === 0 });
    } catch {
      /* A closed lease cannot approve a pending mutation. */
    }
  };
  const poll = async (after: number) => {
    const result = (await send({ kind: 'poll', after })) as PluginPagePoll;
    for (const item of result.confirms) void confirm(item);
    for (const requestId of modelPickers) {
      if (!result.modelPickers?.some(value => value.requestId === requestId)) dismissModelPicker(requestId);
    }
    for (const request of result.modelPickers ?? []) {
      assertCurrent();
      if (modelPickers.has(request.requestId)) continue;
      modelPickers.add(request.requestId);
      host.send('ghosts:model-picker:request', { ...request, deviceId: input.deviceId, remoteViewId: id }, getSafeDataOwnerPushStamp());
    }
    for (const request of result.directories ?? []) {
      assertCurrent();
      host.send(
        REMOTE_PLUGIN_SETTINGS_DIRECTORY,
        { viewId: id, request },
        getSafeDataOwnerPushStamp(),
      );
    }
    for (const notice of result.notifications) {
      assertCurrent();
      host.send(
        'ghosts:notify',
        { ghostId: doc.pluginId, name: doc.name, text: notice.text, tone: 'info' },
        getSafeDataOwnerPushStamp(),
      );
    }
    return { ...result, directories: undefined, modelPickers: undefined };
  };
  const fetchSettings = async (
    path: string,
    method: string,
    body?: string,
  ): Promise<PluginPageFetchResult> => {
    if (/^\/oauth\/[^/]+\/connect$/.test(path) && method === 'POST') {
      const action = parsePluginOauthAction(await send({ kind: 'authorize', path, body }));
      if (!action) throw unavailable();
      try {
        await handleAssistPluginOauth(deps, {
          deviceId: input.deviceId,
          ghostId: doc.pluginId,
          ...action,
        });
      } catch {
        /* The original endpoint supplies the result, including cancellation. */
      }
      assertCurrent();
      return (await send({
        kind: 'authorization-result',
        requestId: action.requestId,
      })) as PluginPageFetchResult;
    }
    return (await send({
      kind: 'fetch',
      path,
      method,
      ...(body === undefined ? {} : { body }),
    })) as PluginPageFetchResult;
  };
  ses.setPermissionRequestHandler((_webContents, _permission, answer) => answer(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, answer) => {
    try {
      assertCurrent();
      const url = new URL(details.url);
      answer({
        cancel: !(
          (url.protocol === 'cindy-ghost:' && url.hostname === doc.manifestId) ||
          ['data:', 'blob:'].includes(url.protocol) ||
          (url.protocol === 'https:' && details.resourceType === 'image')
        ),
      });
    } catch {
      answer({ cancel: true });
    }
  });
  const failure = () => new Response(null, { status: 503 });
  ses.protocol.handle('cindy-ghost', async (request) => {
    try {
      assertCurrent();
      const url = new URL(request.url);
      if (url.hostname !== doc.manifestId) return failure();
      let response: Response;
      if (url.pathname === internal && request.method === 'POST') {
        const body = await readBody(request);
        const parsed = parsePluginSettingsRequest({
          op: 'settings',
          id: doc.pageId,
          command: JSON.parse(body),
        });
        if (!parsed || !['subscribe', 'unsubscribe', 'post', 'poll'].includes(parsed.command.kind))
          return failure();
        const result =
          parsed.command.kind === 'poll'
            ? await poll(parsed.command.after)
            : await send(parsed.command);
        response = Response.json(result);
      } else if (url.pathname === internal + '.js' && request.method === 'GET') {
        response = new Response(remoteSettingsBroadcastScript(internal), {
          headers: { 'Content-Type': 'text/javascript' },
        });
      } else {
        const file = doc.files.find((f) => '/' + f.path === decodeURIComponent(url.pathname));
        if (file && request.method === 'GET') {
          const parts: Buffer[] = [];
          for (let offset = 0; offset < file.size;) {
            const chunk = (await send({ kind: 'asset', path: file.path, offset })) as {
              mime: string;
              base64: string;
            };
            const bytes = Buffer.from(chunk.base64, 'base64');
            if (!bytes.length || bytes.length > 49_152 || offset + bytes.length > file.size)
              throw unavailable();
            parts.push(bytes);
            offset += bytes.length;
          }
          let content = Buffer.concat(parts);
          if (file.mime.startsWith('text/html')) {
            const html = content.toString('utf8');
            const script = '<script src="' + internal + '.js"></script>';
            content = Buffer.from(
              /<head\b[^>]*>/i.test(html)
                ? html.replace(/<head\b[^>]*>/i, (m) => m + script)
                : script + html,
            );
          }
          response = new Response(content, {
            headers: {
              'Content-Type': file.mime,
              ...(file.mime.startsWith('text/html')
                ? { 'Content-Security-Policy': GHOST_HTML_CSP }
                : {}),
            },
          });
        } else {
          const result = await fetchSettings(
            url.pathname + url.search,
            request.method,
            ['GET', 'HEAD'].includes(request.method) ? undefined : await readBody(request),
          );
          response = new Response(
            result.status === 204 ? null : Buffer.from(result.base64, 'base64'),
            {
              status: result.status,
              headers: { 'Content-Type': result.mime },
            },
          );
        }
      }
      assertCurrent();
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch {
      return failure();
    }
  });
  const keepAlive = setInterval(() => {
    void poll(0).catch(() => view.close());
  }, 30_000);
  keepAlive.unref();
  const attachDeadline = setTimeout(() => view.close(), 30_000);
  attachDeadline.unref();
  const view: View = {
    id,
    partition,
    src,
    host,
    current: assertCurrent,
    answerDirectory: async (requestId, path) => {
      await send({ kind: 'answer-directory', requestId, path });
    },
    answerModelPicker: async (requestId, route) => {
      if (!modelPickers.has(requestId)) throw unavailable();
      const result = await send({ kind: 'answer-model-picker', requestId, route }) as { handled: boolean; accepted: boolean };
      if (result.accepted || !result.handled) dismissModelPicker(requestId);
      return result;
    },
    close: () => {
      if (closed) return;
      void send({ kind: 'close' }).catch(() => {});
      closed = true;
      for (const requestId of [...modelPickers]) dismissModelPicker(requestId);
      clearInterval(keepAlive);
      clearTimeout(attachDeadline);
      views.delete(partition);
      host.removeListener('destroyed', view.close);
      ses.protocol.unhandle('cindy-ghost');
      if (guest && !guest.isDestroyed()) guest.close();
      void ses.clearStorageData().catch(() => {});
    },
    attach: (attached) => {
      if (guest) {
        attached.close();
        return;
      }
      guest = attached;
      clearTimeout(attachDeadline);
      registerGhostWebContents(guest.id);
      guest.setWindowOpenHandler(() => ({ action: 'deny' }));
      guest.on('will-navigate', (event, url) => {
        try {
          assertCurrent();
          const target = new URL(url);
          if (
            target.protocol === 'cindy-ghost:' &&
            target.hostname === doc.manifestId &&
            doc.files.some((f) => '/' + f.path === target.pathname)
          )
            return;
          event.preventDefault();
          if (['https:', 'http:'].includes(target.protocol))
            void (async () => {
              const answer = await prompt({
                type: 'question',
                message: url,
                buttons: [
                  t('settings.ghosts.connections.confirmAllow'),
                  t('settings.ghosts.connections.confirmCancel'),
                ],
                defaultId: 1,
                cancelId: 1,
              });
              assertCurrent();
              if (answer.response === 0) await shell.openExternal(url);
            })().catch(() => {});
        } catch {
          event.preventDefault();
        }
      });
      guest.once('destroyed', view.close);
    },
  };
  views.set(partition, view);
  host.once('destroyed', view.close);
  return { id, partition, src };
}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65_536) throw unavailable();
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
  }
}
