import {
  app,
  ipcMain,
  net,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import { CindyAuthClient } from '@cindy/auth-client';
import { getResolvedMainLocale } from '../i18n.desktop';
import * as auth from '../authManager';
import { getClientEndpointForRealm } from '../clientEndpointsService';
import { isAppSessionBoundaryPending, peekCommittedAppSession } from '../appSessionState';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { CLOUD_CLIENT_CHANNELS } from '../../shared/cloudSettingsClient';
import { createCloudSettingsService } from './service';
import { cloudSettingsClientHandlers } from './ipc';
import { CloudClientError, createCloudClientHttp, type CloudClientIdentity } from './transport';
import { CLOUD_LOGIN_WINDOW } from '../../shared/cloudLoginWindow';
import { cloudInstanceTargetSchema } from '../../shared/cloudInstanceControl';
import {
  cloudLoginActionSchema,
  cloudLoginDispatchSchema,
  cloudLoginHandleSchema,
} from '../../shared/cloudInstanceLogin';
import { CloudLoginWindow } from './login-window';
import { throwIpcError } from '../utils/ipcValidate';
import type { SupportedLocale } from '../../shared/locale';

/** The region's cloud instance service; null when this client has none configured. */
function cloudInstanceApiBaseUrl(realm: ReturnType<typeof auth.getActiveAuthRealm>): string | null {
  try {
    return getClientEndpointForRealm(realm, 'cloudInstanceApiBaseUrl') || null;
  } catch {
    return null;
  }
}
function identity(): CloudClientIdentity | null {
  if (isAppSessionBoundaryPending()) return null;
  const session = peekCommittedAppSession(),
    membership = auth.peekCommittedAuthIdentity();
  const accessToken = auth.getAccessToken();
  if (
    session?.mode !== 'cloud' ||
    !membership?.isAuthenticated ||
    !accessToken ||
    session.dataOwnerId !== membership.userId
  )
    return null;
  const realm = auth.getActiveAuthRealm();
  const baseUrl = cloudInstanceApiBaseUrl(realm);
  if (!baseUrl) return null;
  return {
    key: JSON.stringify([
      session.dataOwnerId,
      session.generation,
      realm,
      auth.getDeviceId(),
      baseUrl,
    ]),
    generation: session.generation,
    baseUrl,
    accessToken,
  };
}
let registered = false;
let loginWindow: CloudLoginWindow | undefined;
let prewarmRequested = false;
let admittedKey: string | undefined;
// Only an account the service has admitted gets a hidden login window, after the main window
// has shown; an unreachable service or an account without access costs no extra renderer.
function prewarmAdmitted() {
  if (prewarmRequested && admittedKey !== undefined && admittedKey === identity()?.key)
    loginWindow?.prewarm();
}
export const cloudLoginWindowLifecycle = {
  prewarm: () => {
    prewarmRequested = true;
    prewarmAdmitted();
  },
  setLocale: (locale: SupportedLocale) => loginWindow?.setLocale(locale),
  reset: () => loginWindow?.reset(),
  destroy: () => loginWindow?.destroy(),
};
export function registerCloudSettingsClientIpc(windowDeps?: {
  createWindow(): BrowserWindow;
  isOpenSender(sender: WebContents): boolean;
  title(): string;
}) {
  if (registered) return;
  registered = true;
  const service = createCloudSettingsService({
    identity,
    openExternal: (url) => shell.openExternal(url),
    loginAuth(deviceId) {
      const region = auth.getActiveAuthRealm();
      const baseUrl = getClientEndpointForRealm(region, 'authApiBaseUrl');
      return {
        baseUrl,
        client: new CindyAuthClient({
          baseUrl,
          region,
          deviceId,
          clientType: 'desktop',
          locale: getResolvedMainLocale(),
          fetch: (url, init) => net.fetch(url, init as RequestInit),
        }),
      };
    },
    http: createCloudClientHttp((url, init) => net.fetch(url as string, init)),
    keepAlive(refresh) {
      const timer = setInterval(() => {
        void refresh();
      }, 30_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
  const handlers = cloudSettingsClientHandlers(service);
  const observed = new WeakSet<WebContents>();
  const caller = (event: IpcMainInvokeEvent) => {
    assertTrustedAppRendererEvent(event);
    const sender = event.sender;
    if (!observed.has(sender)) {
      observed.add(sender);
      const invalidate = () => service.invalidate(sender.id);
      sender.once('destroyed', invalidate);
      sender.on('render-process-gone', invalidate);
      sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) invalidate();
      });
    }
    return { id: sender.id, assertCurrent: () => assertTrustedAppRendererEvent(event) };
  };
  const access = async (call: ReturnType<typeof caller>, raw: unknown) => {
    const owner = identity()?.key;
    const decision = await handlers.instanceAccess(call, raw);
    admittedKey = decision.allowed ? owner : undefined;
    prewarmAdmitted();
    return decision;
  };
  for (const key of Object.keys(CLOUD_CLIENT_CHANNELS) as Array<keyof typeof handlers>) {
    ipcMain.handle(CLOUD_CLIENT_CHANNELS[key], (event, raw: unknown) => {
      const call = caller(event);
      // No cloud instance service in this region: the access check says so once, and the
      // renderer stops asking for this account.
      if (key === 'instanceAccess' && !cloudInstanceApiBaseUrl(auth.getActiveAuthRealm()))
        throwIpcError('CLOUD_SETTINGS_UNSUPPORTED', 'No cloud instance service in this region');
      if (key === 'instanceAccess') return access(call, raw);
      return handlers[key](call, raw);
    });
  }
  if (windowDeps) {
    const manager = new CloudLoginWindow({
      ...windowDeps,
      ownerKey: () => identity()?.key,
      invalidate: (id) => service.invalidate(id),
      async authorize(sender, deviceId) {
        const targets = (await service.instanceList(
          {
            id: sender.id,
            assertCurrent() {
              if (sender.isDestroyed() || !windowDeps.isOpenSender(sender))
                throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
            },
          },
        )).filter((target) => target.deviceId === deviceId);
        if (targets.length !== 1) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
        const target = targets[0]!;
        if (!target.loginRequired) throw new CloudClientError('CLOUD_SETTINGS_CONFLICT');
        return { deviceId: target.deviceId, name: target.name, ordinal: target.ordinal };
      },
    });
    loginWindow = manager;
    const epoch = z.strictObject({ generation: z.number().int().nonnegative() });
    function windowHandler<S extends z.core.$ZodType>(
      channel: string,
      schema: S,
      run: (event: IpcMainInvokeEvent, input: z.output<S>) => unknown,
    ) {
      ipcMain.handle(channel, async (event, raw: unknown) => {
        assertTrustedAppRendererEvent(event);
        const input = z.safeParse(schema, raw);
        if (!input.success) throwIpcError('INVALID_PARAMS', 'Invalid cloud login window request');
        try {
          return await run(event, input.data);
        } catch (error) {
          if (error instanceof CloudClientError) throwIpcError(error.code, error.code);
          throwIpcError('CLOUD_SETTINGS_UNAVAILABLE', 'Cloud login window request failed');
        }
      });
    }
    windowHandler(CLOUD_LOGIN_WINDOW.open, cloudInstanceTargetSchema, (e, input) =>
      manager.open(e.sender, input.deviceId),
    );
    for (const key of ['state', 'ready', 'presented'] as const) {
      windowHandler(CLOUD_LOGIN_WINDOW[key], z.strictObject({}), (e) => {
        manager.assertSender(e.sender);
        if (key === 'ready') manager.controller.markRendererReady(e.sender);
        if (key === 'presented') manager.controller.markPresentationReady(e.sender);
        return manager.state();
      });
    }
    windowHandler(CLOUD_LOGIN_WINDOW.close, epoch, (e, input) =>
      manager.close(e.sender, input.generation),
    );
    const windowCaller = (e: IpcMainInvokeEvent, generation: number) => ({
      id: e.sender.id,
      assertCurrent() {
        assertTrustedAppRendererEvent(e);
        manager.assertCurrent(e.sender, generation);
      },
    });
    windowHandler(CLOUD_LOGIN_WINDOW.start, epoch, (e, input) => {
      const target = manager.assertCurrent(e.sender, input.generation);
      return service.instanceLoginStart(windowCaller(e, input.generation), target.deviceId);
    });
    windowHandler(
      CLOUD_LOGIN_WINDOW.end,
      epoch.extend(cloudLoginHandleSchema.shape).strict(),
      (e, input) => {
        // The unmount cleanup of a reset/closed window arrives after its sessions were invalidated.
        if (manager.isSuperseded(e.sender, input.generation)) return;
        manager.assertCurrent(e.sender, input.generation);
        return service.instanceLoginClose(windowCaller(e, input.generation), input.handle);
      },
    );
    for (const key of ['poll', 'dispatch'] as const) {
      const schema =
        key === 'poll'
          ? epoch.extend(cloudLoginHandleSchema.shape).strict()
          : epoch.extend(cloudLoginDispatchSchema.shape).strict();
      windowHandler(CLOUD_LOGIN_WINDOW[key], schema, async (e, input) => {
        manager.assertCurrent(e.sender, input.generation);
        const scoped = windowCaller(e, input.generation);
        const result =
          'action' in input
            ? await service.instanceLoginDispatch(
                scoped,
                input.handle,
                cloudLoginActionSchema.parse(input.action),
              )
            : await service.instanceLoginPoll(scoped, input.handle);
        manager.assertCurrent(e.sender, input.generation);
        if (result.complete) manager.complete(e.sender, input.generation);
        return result;
      });
    }
  }
  let ownerKey = identity()?.key;
  const off = auth.onAuthStateChange(() => {
    const next = identity()?.key;
    if (next !== ownerKey) {
      loginWindow?.reset();
      service.invalidate();
      ownerKey = next;
    }
  });
  app.once('before-quit', () => {
    loginWindow?.destroy();
    off();
    service.invalidate();
  });
}
