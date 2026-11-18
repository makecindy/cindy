import { createRequire } from 'node:module';
import path from 'node:path';

import type { LoginItemState } from '../shared/loginItem.js';
import { createIpcError } from '../shared/ipc-errors.js';
import { requireBoolean, throwIpcError } from './utils/ipcValidate.js';

type Operation = 'read' | 'enable' | 'disable';
type Perform = (operation: Operation) => Promise<string>;

const loadNative = createRequire(__filename);
const performNative: Perform = (operation) => new Promise((resolve) => {
  const native = loadNative(path.join(process.resourcesPath, 'tools/login-item/cindy-login-item.node'));
  native.start({ read: -1, enable: 1, disable: 0 }[operation], resolve);
});

export function createMacLoginItemSettings(perform: Perform = performNative) {
  let pending: { operation: Operation; result: Promise<LoginItemState> } | undefined;

  function run(operation: Operation): Promise<LoginItemState> {
    if (pending) {
      if (operation === 'read' || operation === pending.operation) return pending.result;
      return Promise.reject(createIpcError('INTERNAL', 'Login startup setting is busy'));
    }

    const result = new Promise<LoginItemState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(createIpcError('INTERNAL', 'Login startup request timed out'));
      }, 3000);

      // A timeout ends the UI wait. Keep ownership of the underlying request
      // until smd replies so repeated focus events cannot exhaust native threads.
      Promise.resolve().then(() => perform(operation)).then((status) => {
        if (!['enabled', 'requires-approval', 'not-registered'].includes(status)) {
          throwIpcError('INTERNAL', 'Unable to read login startup settings');
        }
        const enabled = status === 'enabled';
        const requiresApproval = status === 'requires-approval';
        if (operation !== 'read' && (operation === 'enable') !== (enabled || requiresApproval)) {
          throwIpcError('PRECONDITION_FAILED', 'The system did not apply the login startup setting');
        }
        return { available: true, enabled, requiresApproval };
      }, () => throwIpcError('INTERNAL', 'Unable to access login startup settings'))
        .finally(() => {
          clearTimeout(timeout);
          pending = undefined;
        }).then(resolve, reject);
    });
    pending = { operation, result };
    return result;
  }

  return {
    read: () => run('read'),
    set: (raw: unknown) => run(requireBoolean(raw, 'enabled') ? 'enable' : 'disable'),
  };
}
