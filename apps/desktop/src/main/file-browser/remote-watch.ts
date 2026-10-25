import type { BrowserWindow } from 'electron';
import { RemoteWatchRegistry as SharedRegistry } from '@cindy/app-runtime/remoteFileWatch';
import { createLogger } from '../logger.js';
import type { RemoteFileBrowserManager } from './remote.js';
import type { FileTreeEvent } from './watcher.js';
export class RemoteWatchRegistry {
  private readonly runtime: SharedRegistry;
  constructor(mgr: RemoteFileBrowserManager) {
    this.runtime = new SharedRegistry(mgr, createLogger('file-browser/remote-watch'));
  }
  start(
    window: BrowserWindow,
    hostId: string,
    workdir: string,
    opts: { hideMetaFiles?: boolean },
    onEvent: (event: FileTreeEvent) => void,
  ) {
    return this.runtime.start(
      {
        id: window.id,
        isDisposed: () => window.isDestroyed(),
        onDispose: (callback) => {
          window.once('closed', callback);
        },
      },
      hostId,
      workdir,
      opts,
      onEvent,
    );
  }
  stop(windowId: number, hostId: string, workdir: string) {
    return this.runtime.stop(windowId, hostId, workdir);
  }
}
let registry: RemoteWatchRegistry | null = null;
export function getRemoteWatchRegistry(mgr: RemoteFileBrowserManager) {
  return (registry ??= new RemoteWatchRegistry(mgr));
}
