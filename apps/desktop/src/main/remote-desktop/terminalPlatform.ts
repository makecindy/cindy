import { desktopPermissionReady } from '@cindy/device-link';
import { createMacHandoffDriver } from '../input-handoff/macDriver';
import { createRemoteDesktopPlatform } from './platform';
import { remoteCredentialHost } from './credentialHost';
import { resolveDesktopInputBinary } from './inputHost';
import type { CreateTerminalDesktopPlatform } from '../../../../cindy-terminal/src/desktop-platform';

/** Installed only by the signed platform host. There is no public driver RPC:
 * requests arrive through that host's normal authenticated Device Link path. */
export const createTerminalDesktopPlatform: CreateTerminalDesktopPlatform = (context) => {
  let closed = false;
  let epoch = 0;
  let credentials: Awaited<ReturnType<typeof context.credentials>> = null;
  const disposers: Array<{ phase: string; run(): void | Promise<void> }> = [];
  const current = () => !closed && context.authenticated();
  const platform = createRemoteDesktopPlatform({
    readDeviceLinkSettings: () => {
      const settings = context.settings.deviceLink.readDeviceLinkSettings();
      return current() ? settings : { ...settings, remoteControlEnabled: false };
    },
    writeDeviceLinkSetting: (...args) => context.settings.deviceLink.writeDeviceLinkSetting(...args),
    loadDesktopIceServers: context.iceServers,
    getInputHandoffService: () => context.handoff() ?? null,
    onQuit: (_name, run, phase = 'sync') => { disposers.push({ phase, run }); },
    // The only renderer here is the original isolated capture renderer. Its
    // dedicated sender checks remain inside registerRemoteDesktopIpc.
    assertTrustedAppRendererEvent: () => { throw new Error('PERMISSION_DENIED'); },
    showGuide: context.permissionGuideRequested,
  });
  remoteCredentialHost.currentToken = () => current() ? credentials : null;
  platform.registerRemoteDesktopIpc(undefined, { name: context.controllerName, revoke: context.revoke });
  const reset = async () => {
    epoch++;
    credentials = null;
    platform.permissions.dismiss();
    platform.remoteDesktop.stop(undefined, undefined, 'authorization-lost');
    remoteCredentialHost.dispose();
    await platform.remoteDesktop.stopAndRestore();
  };
  return {
    async request(peer, value) {
      const generation = epoch;
      if (!current()) throw new Error('DESKTOP_UNAVAILABLE');
      const refreshed = await context.credentials();
      if (!current() || generation !== epoch || !refreshed) throw new Error('DESKTOP_UNAVAILABLE');
      credentials = refreshed;
      return platform.requestRemoteDesktop(peer, value);
    },
    async permissions(action) {
      if (closed) throw new Error('DESKTOP_UNAVAILABLE');
      if (action === 'guide') {
        const status = await platform.permissions.read();
        if (!desktopPermissionReady(status.screenRecording)) await platform.permissions.open('screenRecording');
        if (!desktopPermissionReady(status.accessibility)) await platform.permissions.open('accessibility');
      }
      return platform.permissions.read();
    },
    createHandoffDriver: () => !closed && process.platform === 'darwin' ? createMacHandoffDriver() : null,
    inputBinary: resolveDesktopInputBinary,
    liveViewAvailable: () => {
      const settings = context.settings.deviceLink.readDeviceLinkSettings();
      return current() && process.platform === 'darwin' && settings.remoteControlEnabled && settings.remoteDesktopEnabled;
    },
    peerClosed(peer) {
      platform.remoteDesktop.stop(peer, undefined, 'peer-closed');
      void remoteCredentialHost.close(peer).catch(() => remoteCredentialHost.dispose());
    },
    signalingLost: peer => platform.remoteDesktop.signalingLost(peer),
    reset,
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      try { await reset(); } catch (error) { errors.push(error); }
      for (const phase of ['sync', 'async', 'post-async']) {
        for (const disposer of disposers.filter(value => value.phase === phase)) {
          try { await disposer.run(); } catch (error) { errors.push(error); }
        }
      }
      disposers.length = 0;
      remoteCredentialHost.currentToken = undefined;
      if (errors.length) throw new AggregateError(errors, 'DESKTOP_CLOSE_FAILED');
    },
  };
};
