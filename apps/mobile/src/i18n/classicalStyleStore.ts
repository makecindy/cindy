/**
 * 文言等古典界面下 AI 作答的输出风格(AsyncStorage,版本化 key)。
 *
 * 与显示语言同属这台手机的偏好:每轮随 uiLanguage 一起发给电脑,电脑只在
 * 远程轮次采用。发送路径同步读取,所以这里保留一份内存当前值,挂载时从
 * 存储恢复。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_CLASSICAL_REPLY_STYLE,
  isClassicalReplyStyle,
  type ClassicalReplyStyleId,
} from '@cindy/maker-shared/classical-reply';

const STORAGE_KEY = 'xdt-maker.mobile.classical-reply-style.v1';

let current: ClassicalReplyStyleId = DEFAULT_CLASSICAL_REPLY_STYLE;

export function currentClassicalStyle(): ClassicalReplyStyleId {
  return current;
}

export async function readClassicalStyle(): Promise<ClassicalReplyStyleId> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  current = isClassicalReplyStyle(raw) ? raw : DEFAULT_CLASSICAL_REPLY_STYLE;
  return current;
}

export async function saveClassicalStyle(style: ClassicalReplyStyleId): Promise<void> {
  current = style;
  await AsyncStorage.setItem(STORAGE_KEY, style).catch(() => undefined);
}
