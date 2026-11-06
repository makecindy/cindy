/**
 * AI 作答文风(AsyncStorage,版本化 key)。文言界面与简体 / 繁體中文界面分开记忆:
 * 在文言界面选的唐诗不带进现代中文界面,每个语境各自从未选状态起步
 * (默认见 defaultClassicalReplyStyleFor:classical → 文言,modern → 照常作答)。
 *
 * 与显示语言同属这台手机的偏好:每轮随 uiLanguage 一起发给电脑,电脑只在
 * 远程轮次采用。发送路径同步读取,所以这里保留一份内存当前值,挂载时从
 * 存储恢复。null = 用户在该语境没选过。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  classicalReplyStyleContextOf,
  isClassicalReplyStyle,
  type ClassicalReplyStyleContext,
  type ClassicalReplyStyleId,
} from '@cindy/maker-shared/classical-reply';

const STORAGE_KEYS = {
  classical: 'xdt-maker.mobile.classical-reply-style.v1',
  modern: 'xdt-maker.mobile.classical-reply-style.modern.v1',
} as const satisfies Record<ClassicalReplyStyleContext, string>;

type StoredStyles = Record<ClassicalReplyStyleContext, ClassicalReplyStyleId | null>;

const current: StoredStyles = { classical: null, modern: null };

/** 未选过的语境返回 null,由调用方按界面语言取默认。 */
export function currentClassicalStyle(context: ClassicalReplyStyleContext): ClassicalReplyStyleId | null {
  return current[context];
}

export function currentClassicalStyleForLocale(locale: string | null | undefined): ClassicalReplyStyleId | null {
  return currentClassicalStyle(classicalReplyStyleContextOf(locale));
}

export async function readClassicalStyle(): Promise<StoredStyles> {
  const [classical, modern] = await Promise.all([
    AsyncStorage.getItem(STORAGE_KEYS.classical),
    AsyncStorage.getItem(STORAGE_KEYS.modern),
  ]);
  current.classical = isClassicalReplyStyle(classical) ? classical : null;
  current.modern = isClassicalReplyStyle(modern) ? modern : null;
  return { ...current };
}

export async function saveClassicalStyle(
  context: ClassicalReplyStyleContext,
  style: ClassicalReplyStyleId,
): Promise<void> {
  current[context] = style;
  await AsyncStorage.setItem(STORAGE_KEYS[context], style).catch(() => undefined);
}
