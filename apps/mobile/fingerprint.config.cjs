// Keep beta-only EAS profiles out of the native runtime fingerprint.
// Production profiles remain transparent: any production EAS/app config change
// still changes the fingerprint and must be handled intentionally.
//
// Self-host package versions are release metadata, not native capability. The
// CN and Global self-host packages share app.json, so a buildNumber bump made
// while publishing one region must not change the runtime fingerprint used to
// check the other region. Keep the existing package-script skip and add the
// Expo version skip only for self-host commands (they set this env explicitly),
// leaving EAS/TestFlight fingerprint semantics unchanged.
const sourceSkips = [
  'PackageJsonAndroidAndIosScriptsIfNotContainRun',
  ...(process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1'
    ? ['ExpoConfigVersions']
    : []),
];

module.exports = {
  sourceSkips,
  // These images are compiled into the native catalog, not delivered by Metro.
  extraSources: [
    'cindy-message-square-plus',
    'cindy-link-2',
    'cindy-undo-2',
    'cindy-trash-2',
  ].map((name) => ({
    type: 'dir',
    filePath: `assets/message-menu/${name}.imageset`,
    reasons: ['native message menu assets'],
  })),
  fileHookTransform(source, chunk, isEndOfFile) {
    if (source.type !== 'file' || source.filePath !== 'eas.json') {
      return chunk;
    }
    return transformEasJson(chunk, isEndOfFile);
  },
};

const easChunks = [];

function transformEasJson(chunk, isEndOfFile) {
  if (chunk != null) easChunks.push(Buffer.from(chunk).toString('utf8'));
  if (!isEndOfFile) {
    return null;
  }

  const eas = stripBetaProfiles(JSON.parse(easChunks.join('')));
  easChunks.length = 0;
  return `${JSON.stringify(eas, null, 2)}\n`;
}

function stripBetaProfiles(eas) {
  if (!eas.build) return eas;
  for (const profileName of Object.keys(eas.build)) {
    if (profileName === 'beta-base' || profileName.startsWith('beta-')) {
      delete eas.build[profileName];
    }
  }
  return eas;
}

module.exports.stripBetaProfiles = stripBetaProfiles;
