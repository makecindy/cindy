const { withMainActivity } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const tag = 'cindy-activity-display-metrics';

module.exports = function withAndroidActivityDisplayMetrics(config) {
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt') {
      throw new Error(`${tag}: expected a Kotlin MainActivity`);
    }
    const activity = mergeContents({
      tag,
      src: mod.modResults.contents,
      anchor: /class MainActivity : ReactActivity\(\) \{/,
      offset: 1,
      comment: '//',
      newSrc: `  private companion object {
    private var metricsOnSecondaryDisplay = false
  }

  // RN 0.88 uses process-wide screen metrics for native text measurement.
  // Restore the primary display's metrics when this task returns from another display.
  @Suppress("DEPRECATION")
  private fun syncReactDisplayMetrics() {
    val displayId = windowManager.defaultDisplay.displayId
    val secondary = displayId != android.view.Display.DEFAULT_DISPLAY
    if (secondary || metricsOnSecondaryDisplay) {
      com.facebook.react.uimanager.DisplayMetricsHolder.initDisplayMetrics(this)
      metricsOnSecondaryDisplay = secondary
    }
  }

  override fun setContentView(view: android.view.View) {
    // ReactRootView has already initialized the holder from the application here.
    syncReactDisplayMetrics()
    super.setContentView(view)
  }`,
    });
    const delegate = mergeContents({
      tag: `${tag}-delegate`,
      src: activity.contents.replace(/^(\s*)\)\{\}\)$/m, '$1) {\n          })'),
      anchor: /^\s*\) \{$/,
      offset: 1,
      comment: '//',
      newSrc: `            override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
              super.onConfigurationChanged(newConfig)
              syncReactDisplayMetrics()
            }`,
    });
    mod.modResults.contents = delegate.contents;
    return mod;
  });
};
