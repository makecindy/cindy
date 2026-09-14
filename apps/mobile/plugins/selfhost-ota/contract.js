// Native ABI: changing this contract requires a new self-host runtime.
const NATIVE_OTA_VERSION = 1;
const EXPO_UPDATES_VERSION = '57.0.18';
const SHARED_CLIENT_ID = '00000000-0000-4000-8000-000000000000';
const CHANNEL_HEADER = 'x-cindy-update-channel';

function nativeSourceHash(readSource) {
  const fs = require('node:fs');
  const path = require('node:path');
  const hash = require('node:crypto').createHash('sha256');
  const read = readSource ?? ((file) => fs.readFileSync(path.join(__dirname, file)));
  // Expo tracks imported JS plugins, not native files read later by a dangerous
  // mod. Include their digest in resolved plugin options so any native adapter
  // change necessarily changes the self-host runtime fingerprint.
  for (const file of ['contract.js', 'patches.js', '../with-selfhost-ota.js',
    'android/CindyOtaJournal.kt', 'ios/CindyOtaJournal.swift']) {
    hash.update(file + '\0').update(read(file));
  }
  return hash.digest('hex');
}

function requestHeaders(channel = 'release') {
  if (!['release', 'beta', 'canary'].includes(channel)) {
    throw new Error('Invalid self-host OTA channel');
  }
  // Omitted and empty headers are different Expo download identities. Always
  // include both keys, including in the native default and rollback configuration.
  return {
    'EAS-Client-ID': SHARED_CLIENT_ID,
    [CHANNEL_HEADER]: channel === 'release' ? '' : channel,
  };
}

function resolveUpdatesUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Native self-host OTA requires CINDY_MOBILE_UPDATES_URL at build time');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Invalid CINDY_MOBILE_UPDATES_URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('CINDY_MOBILE_UPDATES_URL must use HTTPS without credentials, query or fragment');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/manifest') ? pathname : pathname + '/manifest';
  return url.toString();
}

module.exports = {
  NATIVE_OTA_VERSION,
  EXPO_UPDATES_VERSION,
  SHARED_CLIENT_ID,
  CHANNEL_HEADER,
  requestHeaders,
  resolveUpdatesUrl,
  nativeSourceHash,
};
