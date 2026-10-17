const { withAppBuildGradle } = require('@expo/config-plugins');

// expo-build-properties enables R8, but Expo's Android template still selects
// proguard-android.txt, which contains -dontoptimize. Apply the optimizing defaults
// during prebuild so every region and build entry point gets the same rules,
// including clean prebuilds that replace the generated Android project.
function enableDefaultProguardOptimizations(source) {
  const defaultFile = /getDefaultProguardFile\(\s*(['"])proguard-android(?:-optimize)?\.txt\1\s*\)/g;
  if (!defaultFile.test(source)) {
    throw new Error('with-android-release-optimization: expected an Android default ProGuard file; review the Expo template before building');
  }
  return source.replace(defaultFile, (_match, quote) =>
    `getDefaultProguardFile(${quote}proguard-android-optimize.txt${quote})`);
}

function withAndroidReleaseOptimization(config) {
  return withAppBuildGradle(config, (androidConfig) => {
    if (androidConfig.modResults.language !== 'groovy') {
      throw new Error('with-android-release-optimization: expected a Groovy app build.gradle');
    }
    androidConfig.modResults.contents = enableDefaultProguardOptimizations(androidConfig.modResults.contents);
    return androidConfig;
  });
}

module.exports = withAndroidReleaseOptimization;
module.exports.enableDefaultProguardOptimizations = enableDefaultProguardOptimizations;
