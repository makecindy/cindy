if (typeof globalThis.SharedArrayBuffer === 'undefined') {
  // Expo Go on iOS/Hermes does not expose SharedArrayBuffer, but some shared
  // JS packages probe the global during module initialization.
  globalThis.SharedArrayBuffer = ArrayBuffer;
}

require('./src/debug/quietDevLogs').installDevLogFilters();
require('expo-router/entry');
