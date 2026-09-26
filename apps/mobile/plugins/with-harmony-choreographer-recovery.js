const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('@expo/config-plugins');

const MARKER = 'cindy-harmony-choreographer-resume-repair-v1';
const TEMPLATE = path.join(__dirname, 'harmony-choreographer-recovery', 'android', 'ReactChoreographerResumeRepair.kt');

function patchMainApplication(source) {
  if (source.includes(MARKER)) return source;
  const anchor = '    ApplicationLifecycleDispatcher.onApplicationCreate(this)';
  if (!source.includes(anchor)) throw new Error('Missing Expo MainApplication lifecycle anchor');
  const block = [
    '    // ' + MARKER,
    '    registerActivityLifecycleCallbacks(object : android.app.Application.ActivityLifecycleCallbacks {',
    '      override fun onActivityResumed(activity: android.app.Activity) {',
    '        if (activity is MainActivity) {',
    '          android.os.Handler(android.os.Looper.getMainLooper()).post {',
    '            ReactChoreographerResumeRepair.rearmIfNeeded()',
    '          }',
    '        }',
    '      }',
    '',
    '      override fun onActivityCreated(activity: android.app.Activity, state: android.os.Bundle?) = Unit',
    '      override fun onActivityStarted(activity: android.app.Activity) = Unit',
    '      override fun onActivityPaused(activity: android.app.Activity) = Unit',
    '      override fun onActivityStopped(activity: android.app.Activity) = Unit',
    '      override fun onActivitySaveInstanceState(activity: android.app.Activity, state: android.os.Bundle) = Unit',
    '      override fun onActivityDestroyed(activity: android.app.Activity) = Unit',
    '    })',
  ].join('\n');
  return source.replace(anchor, anchor + '\n' + block);
}

function applyAndroidRepair(projectRoot, androidPackage) {
  if (!androidPackage) throw new Error('Harmony recovery requires android.package');
  const javaRoot = path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', ...androidPackage.split('.'));
  const mainApplication = path.join(javaRoot, 'MainApplication.kt');
  if (!fs.existsSync(mainApplication)) throw new Error('Missing generated MainApplication: ' + mainApplication);
  const repair = fs.readFileSync(TEMPLATE, 'utf8').replace('__CINDY_ANDROID_PACKAGE__', androidPackage);
  fs.writeFileSync(path.join(javaRoot, 'ReactChoreographerResumeRepair.kt'), repair);
  fs.writeFileSync(mainApplication, patchMainApplication(fs.readFileSync(mainApplication, 'utf8')));
}

module.exports = function withHarmonyChoreographerRecovery(config) {
  return withDangerousMod(config, ['android', async (mod) => {
    applyAndroidRepair(mod.modRequest.projectRoot, config.android?.package);
    return mod;
  }]);
};
module.exports.__testing = { patchMainApplication, applyAndroidRepair, MARKER };
