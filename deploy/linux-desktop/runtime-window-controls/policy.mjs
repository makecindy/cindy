// Cloud packaging only. This module is never installed into the client source tree.
export const CLOUD_MAIN_WINDOW_ARGUMENT = '--cindy-cloud-main-window';

export function hasCloudMainWindowControls(argv, platform) {
  return platform === 'linux' && argv.includes(CLOUD_MAIN_WINDOW_ARGUMENT);
}

export function createCloudMainWindowControls(deps) {
  return {
    blocksAction(target) {
      return deps.enabled() && (!target || target === deps.mainWindow());
    },
    preventClose(event) {
      if (!deps.enabled() || deps.isQuitting()) return false;
      event.preventDefault();
      return true;
    },
  };
}
