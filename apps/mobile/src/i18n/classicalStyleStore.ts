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
// 本会话用户改过的语境:存储读回与用户写入竞速时以内存为准,保证设置显示与
// 发送路径(currentClassicalStyleForLocale)始终一致。
const dirtyContexts = new Set<ClassicalReplyStyleContext>();

/** 未选过的语境返回 null,由调用方按界面语言取默认。 */
export function currentClassicalStyle(context: ClassicalReplyStyleContext): ClassicalReplyStyleId | null {
  return current[context];
}

export function currentClassicalStyleForLocale(locale: string | null | undefined): ClassicalReplyStyleId | null {
  return currentClassicalStyle(classicalReplyStyleContextOf(locale));
}

// 水合只发起一次:模块加载期与 Provider 挂载各调一次 readClassicalStyle,共享同一
// promise,避免并发读回中后失败的一次把先成功恢复的值洗成 null(Codex P2)。
// 存储只会经 saveClassicalStyle 变化,已解析的缓存结果不会失真。
let hydration: Promise<StoredStyles> | null = null;

export function readClassicalStyle(): Promise<StoredStyles> {
  hydration ??= (async () => {
    // 单个 key 读失败只降级那一档,不拖垮另一档的已存值(Promise.all 需要永不 reject 的入参)。
    // 读回迟于用户操作 resolve 时,被改过的语境不得用旧值洗掉新选择。
    const read = (key: string) => AsyncStorage.getItem(key).catch(() => null);
    const [classical, modern] = await Promise.all([read(STORAGE_KEYS.classical), read(STORAGE_KEYS.modern)]);
    if (!dirtyContexts.has('classical')) {
      current.classical = isClassicalReplyStyle(classical) ? classical : null;
    }
    if (!dirtyContexts.has('modern')) {
      current.modern = isClassicalReplyStyle(modern) ? modern : null;
    }
    return { ...current };
  })();
  return hydration;
}

export async function saveClassicalStyle(
  context: ClassicalReplyStyleContext,
  style: ClassicalReplyStyleId,
): Promise<void> {
  dirtyContexts.add(context);
  current[context] = style;
  await AsyncStorage.setItem(STORAGE_KEYS[context], style).catch(() => undefined);
}

// 冷启动即开始读回:模块一被 import 就发起,远早于输入框可用,压缩首条消息
// 落在水合完成之前、被当成未选而按默认发送的窗口。Provider 挂载后再读一次
// 幂等无害,仍用于把结果同步进 React 状态。
void readClassicalStyle();
