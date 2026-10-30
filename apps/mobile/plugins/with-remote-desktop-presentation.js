const { withInfoPlist } = require('@expo/config-plugins');
// Runs after foreground-only cleanup. This entitlement enables AVKit PiP;
// voice recording and ordinary audio retain their foreground-only runtime policy.
module.exports = config => withInfoPlist(config, result => {
  result.modResults.UIBackgroundModes = [...new Set([...(result.modResults.UIBackgroundModes || []), 'audio'])];
  return result;
});
