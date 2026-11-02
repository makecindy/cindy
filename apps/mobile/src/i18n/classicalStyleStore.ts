/**
 * AI 作答文风(AsyncStorage,版本化 key)。文言界面默认文言作答;简体 / 繁體中文界面
 * 默认照常作答,也可选文言文风(见 defaultClassicalReplyStyleFor)。
 *
 * 与显示语言同属这台手机的偏好:每轮随 uiLanguage 一起发给电脑,电脑只在
 * 远程轮次采用。发送路径同步读取,所以这里保留一份内存当前值,挂载时从
 * 存储恢复。null = 用户没选过,按界面语言取默认。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isClassicalReplyStyle,
  type ClassicalReplyStyleId,
} from '@cindy/maker-shared/classical-reply';

const STORAGE_KEY = 'xdt-maker.mobile.classical-reply-style.v1';

let current: ClassicalReplyStyleId | null = null;

export function currentClassicalStyle(): ClassicalReplyStyleId | null {
  return current;
}

export async function readClassicalStyle(): Promise<ClassicalReplyStyleId | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  current = isClassicalReplyStyle(raw) ? raw : null;
  return current;
}

export async function saveClassicalStyle(style: ClassicalReplyStyleId): Promise<void> {
  current = style;
  await AsyncStorage.setItem(STORAGE_KEY, style).catch(() => undefined);
}
