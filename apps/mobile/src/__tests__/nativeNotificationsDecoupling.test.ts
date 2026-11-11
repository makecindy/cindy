/** SDK imports stay at the platform adapters; Android now has an actual FCM receiver. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// Native calls are mocked at the SDK boundary; adapter surface remains checked.
vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(), getPermissionsAsync: vi.fn(), requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(), addPushTokenListener: vi.fn(), addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(), clearLastNotificationResponseAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(), AndroidImportance: { HIGH: 4 }, AndroidNotificationVisibility: { PRIVATE: 0 },
}));

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = path.resolve(SRC_ROOT, '..', 'app');
const NOTIFICATIONS_DIR = path.join(SRC_ROOT, 'notifications');

/** 唯一允许出现 'expo-notifications' 的两个文件:真接入点与它的纯类型契约。 */
const SDK_ALLOWLIST = new Set([
  path.join(NOTIFICATIONS_DIR, 'nativeNotifications.ts'),
  path.join(NOTIFICATIONS_DIR, 'nativeNotifications.android.ts'),
  path.join(NOTIFICATIONS_DIR, 'nativeNotifications.types.ts'),
]);

/**
 * 只认真正的模块引用形态,散文里提到 SDK 名(注释)不算违规。
 *
 * 关键字必须带 `\b`:否则 `perform('expo-notifications')` 之类会把 `form` 当成 `from`
 * 误判。引号两种都收:漏掉一种会让守门在双引号写法下静默失效(漏判比误判更糟)。
 */
const SDK_MODULE_REFERENCE =
  /\b(?:from|import|require)\s*\(?\s*['"]expo-notifications(?:\/[^'"]*)?['"]/;
const NATIVE_NOTIFICATIONS_IMPORT =
  /\b(?:from|import|require)\s*\(?\s*['"](?:\.\/|@\/notifications\/)nativeNotifications['"]/;
const NOTIFICATIONS_MEMBER = /\bNotifications\.([A-Za-z0-9_]+)/g;

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

function allSourceFiles(): string[] {
  return [...walkSourceFiles(SRC_ROOT), ...walkSourceFiles(APP_ROOT)];
}

describe('通知 SDK 只由平台适配层访问', () => {
  // 守门自身的判据要有用例:正则悄悄失配会让上面两条断言变成永绿的假保险。
  it('模块引用正则认得各种写法,且不被散文/相似词误命中', () => {
    for (const violation of [
      "import * as Notifications from 'expo-notifications';",
      'import * as Notifications from "expo-notifications";',
      "const n = await import('expo-notifications');",
      "require('expo-notifications')",
      "import { setBadgeCountAsync } from 'expo-notifications/build/BadgeModule';",
    ]) {
      expect(SDK_MODULE_REFERENCE.test(violation), violation).toBe(true);
    }
    for (const allowed of [
      '// expo-notifications 的 JS 入口在 import 期就 requireNativeModule(...)',
      "await perform('expo-notifications')", // form ≠ from:词边界必须挡住
      "import * as Notifications from './nativeNotifications';",
    ]) {
      expect(SDK_MODULE_REFERENCE.test(allowed), allowed).toBe(false);
    }

    for (const consumer of [
      "import Notifications from './nativeNotifications';",
      'import Notifications from "./nativeNotifications";',
      "import Notifications from '@/notifications/nativeNotifications';",
    ]) {
      expect(NATIVE_NOTIFICATIONS_IMPORT.test(consumer), consumer).toBe(true);
    }
    expect(
      NATIVE_NOTIFICATIONS_IMPORT.test("import x from './nativeNotificationsHelper';"),
    ).toBe(false);
  });

  it('除接入点外没有文件直接 import expo-notifications', () => {
    const violations = allSourceFiles().filter(
      (file) =>
        !SDK_ALLOWLIST.has(file) &&
        SDK_MODULE_REFERENCE.test(fs.readFileSync(file, 'utf8')),
    );
    expect(
      violations.map((file) => path.relative(SRC_ROOT, file)),
      '请改用 @/notifications/nativeNotifications(原因见该文件头注)',
    ).toEqual([]);
  });

  it('Android 替身覆盖了业务代码用到的每个成员', async () => {
    const androidStub = (
      await import('@/notifications/nativeNotifications.android')
    ).default as Record<string, unknown>;

    const used = new Set<string>();
    for (const file of allSourceFiles()) {
      const content = fs.readFileSync(file, 'utf8');
      if (!NATIVE_NOTIFICATIONS_IMPORT.test(content)) continue;
      for (const [, member] of content.matchAll(NOTIFICATIONS_MEMBER)) {
        used.add(member);
      }
    }

    // 面接口不为空,避免正则失配导致这条断言空转成永真。
    expect(used.size).toBeGreaterThan(0);
    expect(
      [...used].filter((member) => typeof androidStub[member] !== 'function').sort(),
      '请在 nativeNotifications.android.ts 补上这些成员的 Android 实现',
    ).toEqual([]);
  });
});
