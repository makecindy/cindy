export function createMediaPlayerWebViewLifecycle() {
  let loading = true;
  let reloadOnActive = false;
  let visible = true;

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
    /**
     * 页面可见性沿(翻页 / 屏被压栈失活)。返回 true 表示该暂停一次:
     * 只在「可见 → 失活」沿触发,持续失活不重复暂停,回到本页也不代用户续播。
     */
    onVisibilityChange(next: boolean) {
      const becameHidden = visible && !next;
      visible = next;
      return becameHidden;
    },
  };
}
