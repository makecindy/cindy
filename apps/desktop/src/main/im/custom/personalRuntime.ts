/**
 * custom/personalRuntime.ts — 设置页「自定义渠道」的运行时。
 *
 * 与伙伴页那条的区别只有落点: 这里的连接没有伙伴, 会话 source 是 'custom',
 * 走设置页那份个人 bot 的默认 agent/模型。端点与 token 机制完全共用
 * (./runtime.ts + ./endpoint.ts)。
 */

import { ipcMain } from 'electron';

import { createCustomIM } from '@cindy/im';

import { createLogger } from '../../logger';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { IM_DEFAULT_SETTINGS } from '../../../shared/imDefaultSettings';
import type { ImOrchestratorConfig } from '../shared/types';
import { createImOrchestrator } from '../shared/orchestrator';
import { host as imHost } from '../host';
import { buildCustomAdapter, customAttachmentMeta } from './adapter';
import {
  addPersonalCustomConnection,
  isPersonalCustomId,
  listPersonalCustomConnections,
  readPersonalCustomConnection,
  removePersonalCustomConnection,
  type PersonalCustomConnection,
} from './personalStore';
import {
  generateCustomToken,
  readCustomToken,
  registerCustomConnection,
  removeCustomToken,
  unregisterCustomConnection,
  writeCustomToken,
} from './runtime';
import { resolveSocketPath, urlFor } from './endpoint';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

const log = createLogger('im:custom-personal');

interface LivePersonal {
  connection: PersonalCustomConnection;
  im: ReturnType<typeof createCustomIM>;
  orchestrator: ReturnType<typeof createImOrchestrator>;
  inboundUrl: string;
}

const live = new Map<string, LivePersonal>();
let started = false;

function configFor(connection: PersonalCustomConnection): ImOrchestratorConfig {
  const base = IM_DEFAULT_SETTINGS.agents[connection.agentKind];
  return {
    agentKind: connection.agentKind,
    defaultModel: connection.model ?? base.model,
    defaultPermissionMode: IM_DEFAULT_SETTINGS.permissionMode,
    effortOverrides: {},
  };
}

async function startOne(connection: PersonalCustomConnection): Promise<void> {
  if (live.has(connection.id)) return;
  const token = readCustomToken(connection.id);
  if (!token) {
    log.warn('custom channel skipped: token missing', { id: connection.id });
    return;
  }
  const im = createCustomIM(imHost, {
    connectionId: connection.id,
    displayName: connection.displayName,
    token,
    callbackUrl: connection.callbackUrl,
    resolveAttachment: customAttachmentMeta,
  });
  await im.init();
  const orchestrator = createImOrchestrator(
    buildCustomAdapter(im, configFor(connection), {
      connectionId: connection.id,
      displayName: connection.displayName,
    }),
    { instanceKey: `custom-personal#${connection.id}` },
  );
  const inboundUrl = await registerCustomConnection(connection.id, im);
  live.set(connection.id, { connection, im, orchestrator, inboundUrl });
  log.info('custom channel started', { id: connection.id, inboundUrl });
}

async function stopOne(id: string): Promise<void> {
  const item = live.get(id);
  if (!item) return;
  live.delete(id);
  unregisterCustomConnection(id);
  try {
    await item.orchestrator.disposeAllSessions();
  } catch (err) {
    log.warn('custom channel disposeAllSessions failed', { id, error: String(err) });
  }
  item.orchestrator.unregister();
  await item.im.dispose();
}

export async function startPersonalCustomChannels(): Promise<void> {
  started = true;
  const connections = listPersonalCustomConnections();
  log.info('custom channels boot', { count: connections.length });
  for (const connection of connections) {
    try {
      await startOne(connection);
    } catch (err) {
      log.error('custom channel start failed', { id: connection.id, error: String(err) });
    }
  }
}

export async function stopPersonalCustomChannels(): Promise<void> {
  started = false;
  for (const id of [...live.keys()]) await stopOne(id);
}

export interface PersonalCustomView {
  id: string;
  displayName: string;
  callbackUrl: string | null;
  agentKind: PersonalCustomConnection['agentKind'];
  model: string | null;
  inboundUrl: string;
  socketPath: string;
  /** 只在添加/轮换的返回里出现一次; 列表投影不含 token。 */
  token?: string;
}

function viewOf(connection: PersonalCustomConnection): PersonalCustomView {
  const item = live.get(connection.id);
  const socketPath = resolveSocketPath(ownerScopedImUserDataPath('im-custom'));
  return {
    id: connection.id,
    displayName: connection.displayName,
    callbackUrl: connection.callbackUrl,
    agentKind: connection.agentKind,
    model: connection.model,
    inboundUrl: item?.inboundUrl ?? urlFor(connection.id),
    socketPath,
  };
}

export function listPersonalCustomViews(): PersonalCustomView[] {
  return listPersonalCustomConnections().map(viewOf);
}

export function registerPersonalCustomChannelIpc(): void {
  ipcMain.handle('customChannel:list', (event) => {
    assertTrustedAppRendererEvent(event);
    return { connections: listPersonalCustomViews() };
  });

  ipcMain.handle('customChannel:add', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const displayName = typeof p.displayName === 'string' ? p.displayName.trim() : '';
    if (!displayName || displayName.length > 80) {
      throwIpcError('INVALID_PARAMS', 'displayName is invalid');
    }
    let callbackUrl: string | null = null;
    if (typeof p.callbackUrl === 'string' && p.callbackUrl.trim()) {
      try {
        const parsed = new URL(p.callbackUrl.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throwIpcError('INVALID_PARAMS', 'callbackUrl must be http or https');
        }
        callbackUrl = parsed.toString();
      } catch {
        throwIpcError('INVALID_PARAMS', 'callbackUrl is invalid');
      }
    }
    const agentKind =
      p.agentKind === 'codex' || p.agentKind === 'pi' ? p.agentKind : 'claude-code';
    const model = typeof p.model === 'string' && p.model.trim() ? p.model.trim() : null;

    const connection = await addPersonalCustomConnection({
      displayName,
      callbackUrl,
      agentKind,
      model,
    });
    const token = generateCustomToken();
    try {
      writeCustomToken(connection.id, token);
      if (started) await startOne(connection);
    } catch (err) {
      removeCustomToken(connection.id);
      await removePersonalCustomConnection(connection.id);
      throw err;
    }
    return {
      ...viewOf(connection),
      token,
      inboundUrl: live.get(connection.id)?.inboundUrl ?? null,
    };
  });

  ipcMain.handle('customChannel:remove', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = (payload as { id?: unknown } | null)?.id;
    if (!isPersonalCustomId(id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    await stopOne(id);
    removeCustomToken(id);
    await removePersonalCustomConnection(id);
    return { connections: listPersonalCustomViews() };
  });

  ipcMain.handle('customChannel:rotate-token', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = (payload as { id?: unknown } | null)?.id;
    if (!isPersonalCustomId(id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    const connection = readPersonalCustomConnection(id);
    if (!connection) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
    await stopOne(id);
    const token = generateCustomToken();
    writeCustomToken(id, token);
    if (started) await startOne(connection);
    return { ...viewOf(connection), token, inboundUrl: live.get(id)?.inboundUrl ?? null };
  });
}
