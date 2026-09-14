export function createMediaPlayerWebViewLifecycle() {
  let loading = true;
  let reloadOnActive = false;

  return {
    onLoadStart() {
      loading = true;
    },
    onLoadEnd() {
      loading = false;
    },
    onBackground() {
      reloadOnActive ||= loading;
    },
    consumeReloadOnActive() {
      if (!reloadOnActive) return false;
      reloadOnActive = false;
      loading = true;
      return true;
    },
  };
}
