import type { WebContents } from 'electron';
import { PtyManager as SharedPtyManager, type PtyManagerDeps as SharedDeps, type CreateOptions as SharedCreateOptions, type PtyEventSink as SharedSink } from '@cindy/terminal-core';
import { createLogger } from '../logger.js';
export type { CreateResult, DataPayload, ExitPayload, ExitInfo } from '@cindy/terminal-core';
export type CreateOptions = SharedCreateOptions<WebContents>;
export type PtyEventSink = SharedSink<WebContents>;
export type PtyManagerDeps = Omit<SharedDeps<WebContents>, 'lifecycle' | 'logger'>;
export class PtyManager extends SharedPtyManager<WebContents> {
  constructor(deps: PtyManagerDeps) {
    super({ ...deps, logger: createLogger('terminal/pty-manager'), lifecycle: {
      isAlive: owner => !owner.isDestroyed(),
      onClose: (owner, callback) => { owner.once('destroyed', callback); },
    } });
  }
}
