/**
 * 伙伴视图里的第三人称上下文。
 *
 * 中文文案统一写 `{{pronoun}}`,值按当前伙伴的性别取「她 / 他」,用户自建的
 * 伙伴取它自己的名字(裁决见 shared/botGender.ts:不用「TA」)。
 *
 * 为什么做成 context + 绑定版 `t`,而不是逐个 t() 调用点传参:这个插值出现在
 * 47 条文案里、散在十几个组件中,逐句传参必然漏 —— 漏掉的地方会把
 * `{{pronoun}}` 原样显示给用户。这里在伙伴视图的根上供一次,子树里的
 * `useBotTranslation()` 自动带上;没有 provider 的地方回落到 i18n 的
 * defaultVariables(「这位伙伴」),同样是一句人话。
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { botPronoun, normalizeBotGender } from '../../../shared/botGender';

const BotPronounContext = createContext<string | null>(null);

export function BotPronounProvider({
  bot,
  children,
}: {
  bot: { gender?: unknown; name?: string | null } | null | undefined;
  children: ReactNode;
}) {
  const value = useMemo(
    () => botPronoun(normalizeBotGender(bot?.gender), bot?.name ?? ''),
    [bot?.gender, bot?.name],
  );
  return <BotPronounContext.Provider value={value}>{children}</BotPronounContext.Provider>;
}

/** 当前伙伴的第三人称;不在 provider 里时返回 null(由 i18n 兜底值接管)。 */
export function useBotPronoun(): string | null {
  return useContext(BotPronounContext);
}

/**
 * 与 `useTranslation()` 同形,但返回的 `t` 已经绑好 `pronoun`。
 * 伙伴视图里把 `useTranslation()` 换成它即可,调用点一个字都不用改。
 */
export function useBotTranslation(): { t: TFunction; i18n: ReturnType<typeof useTranslation>['i18n'] } {
  const { t, i18n } = useTranslation();
  const pronoun = useBotPronoun();
  const bound = useMemo<TFunction>(() => {
    if (!pronoun) return t;
    const wrapped = ((key: unknown, options?: unknown) => {
      if (options && typeof options === 'object') {
        return t(key as never, { pronoun, ...(options as object) } as never);
      }
      return t(key as never, { pronoun } as never);
    }) as unknown as TFunction;
    return wrapped;
  }, [t, pronoun]);
  return { t: bound, i18n };
}
