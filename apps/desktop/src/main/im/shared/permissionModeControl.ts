import { getCurrentDbClientSnapshot } from '../../localDb/client/current.js';
import { withSessionPermissionChange } from '../../maker-ipc/sessionPermissionChange.js';
import { changeSessionPermissionMode as changeSharedPermissionMode } from '@cindy/im-runtime/permissionModeControl';
export * from '@cindy/im-runtime/permissionModeControl';
export function changeSessionPermissionMode(
  args: Parameters<typeof changeSharedPermissionMode>[0],
) {
  return changeSharedPermissionMode(args, {
    captureAccount() {
      const snapshot = getCurrentDbClientSnapshot();
      return {
        isCurrent: () => snapshot === getCurrentDbClientSnapshot(),
        assertCurrent() {
          if (snapshot !== getCurrentDbClientSnapshot())
            throw new Error('Account changed during permission update');
        },
      };
    },
    withSessionPermissionChange,
  });
}
