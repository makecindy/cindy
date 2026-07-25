if (typeof globalThis.SharedArrayBuffer === 'undefined') {
  // Expo Go on iOS/Hermes does not expose SharedArrayBuffer, but some shared
  // JS packages probe the global during module initialization.
  globalThis.SharedArrayBuffer = ArrayBuffer;
}

// 尽早安装崩溃捕获:先于业务树模块初始化,才能抓到最早期的 JS 崩溃与未处理 rejection。
// 内部幂等且全程吞异常,不会阻断启动。见 src/debug/crashCapture.ts。
require('./src/debug/crashCapture').installCrashCapture();

require('expo-router/entry');
