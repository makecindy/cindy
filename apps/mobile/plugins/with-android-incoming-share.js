const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

const RECEIVER = 'expo.modules.cindyincomingshare.IncomingShareActivity';
const ACTIONS = new Set(['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE']);

// Expo 58's singleton loses consecutive intents and clearSharedPayloads deletes
// every copy. Keep its MIME configuration, but receive in our durable inbox.
function routeIncomingShares(manifest) {
  const main = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const filters = main['intent-filter'] ?? [];
  const shares = filters.filter(filter => filter.action?.some(action => ACTIONS.has(action.$['android:name'])));
  if (shares.length !== 2) throw new Error('Expected Expo SEND and SEND_MULTIPLE filters');
  main['intent-filter'] = filters.filter(filter => !shares.includes(filter));
  application.activity ??= [];
  let receiver = application.activity.find(activity => activity.$['android:name'] === RECEIVER);
  if (!receiver) {
    receiver = { $: { 'android:name': RECEIVER, 'android:exported': 'true',
      'android:excludeFromRecents': 'true',
      'android:launchMode': 'singleTask', 'android:taskAffinity': '${applicationId}.incoming-share', 'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
      'android:configChanges': 'orientation|screenSize|screenLayout|keyboardHidden' } };
    application.activity.push(receiver);
  }
  receiver['intent-filter'] = shares;
  return manifest;
}
module.exports = config => withAndroidManifest(config, mod => {
  mod.modResults = routeIncomingShares(mod.modResults);
  return mod;
});
module.exports.routeIncomingShares = routeIncomingShares;
