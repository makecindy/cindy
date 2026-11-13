/**
 * 从 Telegram 文案包派生其它纯文本渠道(钉钉、iMessage)的文案包。
 *
 * 文案跟随主人的界面语言、读取时现取, 所以派生必须是**惰性视图**: 每个叶子在被读到
 * (或模板函数被调用)时才去读源包、再把渠道名换掉; 不在模块加载时展开 / 复制源包,
 * 否则会把加载那一刻的语言冻结下来。覆盖项(overrides)里的 getter 同样按需求值。
 */

type Relabel = (text: string) => string;

type AnyFn = (...args: never[]) => unknown;

/** 顶层分组可整组替换为部分覆盖(浅一层合并), 其余叶子原样。 */
export type UiPackOverrides<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends AnyFn
    ? T[K]
    : NonNullable<T[K]> extends readonly unknown[]
      ? T[K]
      : NonNullable<T[K]> extends object
        ? Partial<NonNullable<T[K]>>
        : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function relabelValue(value: unknown, relabel: Relabel): unknown {
  if (typeof value === 'string') return relabel(value);
  if (typeof value === 'function') {
    return (...args: unknown[]) =>
      relabelValue((value as (...input: unknown[]) => unknown)(...args), relabel);
  }
  if (Array.isArray(value)) return value.map((item) => relabelValue(item, relabel));
  if (isPlainObject(value)) return relabeledView(value, relabel);
  return value;
}

function readOwn(target: object, key: string): { found: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) return { found: false };
  return { found: true, value: descriptor.get ? descriptor.get.call(target) : descriptor.value };
}

function relabeledView(
  source: Record<string, unknown>,
  relabel: Relabel,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  // Object.keys 只列键名, 不触发 getter。
  const keys = new Set([...Object.keys(source), ...(overrides ? Object.keys(overrides) : [])]);
  for (const key of keys) {
    Object.defineProperty(view, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        const override = overrides ? readOwn(overrides, key) : { found: false };
        if (override.found) {
          const base = source[key];
          if (isPlainObject(override.value) && isPlainObject(base)) {
            return relabeledView(base, relabel, override.value);
          }
          return override.value;
        }
        return relabelValue(source[key], relabel);
      },
    });
  }
  return view;
}

/**
 * 惰性派生: 读 `source` 的每个叶子时套 `relabel`(换渠道名), `overrides` 中的叶子优先且
 * 不再替换渠道名。返回值与源包同形, 可直接当 ImUiTextPack 用。
 */
export function relabeledUiPack<T extends object>(
  source: T,
  relabel: Relabel,
  overrides?: UiPackOverrides<T>,
): T {
  return relabeledView(
    source as Record<string, unknown>,
    relabel,
    overrides as Record<string, unknown> | undefined,
  ) as T;
}

/** 把 Telegram 文案里的渠道名换成 `channelName()`(按当前界面语言现取)。 */
export function telegramChannelRelabel(channelName: () => string): Relabel {
  return (text) => {
    if (!text.includes('Telegram') && !text.includes('TG')) return text;
    const name = channelName();
    return text.replaceAll('Telegram', name).replace(/\bTG\b/g, name);
  };
}
