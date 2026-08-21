/**
 * 伙伴设置页的区块外壳 —— 一个区块 = 一件事 + 最多一句话。
 *
 * ## 为什么要有这个组件
 *
 * 重做之前,每个区块都是手写的四层结构:「标题行 / 说明行 / 内容 / 脚注行」。
 * 说明与脚注经常在讲同一件事 —— 「给 TA 一个文件夹,TA 就懂你的项目」下面跟着
 * 「TA 会自己读文件夹里的东西,对话时直接用」,中间只夹了一个按钮。整页的解释
 * 文字体量超过了内容本身,这就是「密密麻麻」的来源,不是区块太多。
 *
 * 两条约束固化在这里,让后来的人不必再靠自觉:
 *
 *  1. **那句话跟标题同一行**(窄窗口自动换行),不再独占一行。四个区块就省下四行,
 *     而且标题行本身变得有信息量。
 *  2. **那句话是 `hint`,调用方只在这一块还空着的时候传。** 用户已经把东西填进去
 *     了就撤掉 —— 说明文字的任务是教会他一次,不是常驻在那里占版面。
 *
 * **脚注这一层直接取消。** 要说的话只有两个去处:进 `hint`(空着时教一次),或者
 * 进空态文案本身。再往组件里加第三个解释槽位,就是把上面这段话白写了。
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

import { cn } from '@/lib/utils';

/**
 * 区块卡片本体的样式。导出是为了让**自己渲染外壳**的子组件
 * (BotAutomationSettings / BotGrowthLists)与这里长一模一样 —— 之前三处各写一遍
 * `rounded-xl border ... p-5`,改一处就会漏两处。
 */
export const BOT_SETTINGS_BLOCK_CLASS =
  'scroll-mt-6 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5';

export function BotSettingsBlockHeading({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  /** 只在这一块还空着的时候传。有内容了就别传 —— 见文件头第 2 条。 */
  hint?: string | undefined;
  /** 标题行右端的操作(刷新、新建…)。没有就不占位。 */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      {/*
        标题与 hint 同行:`items-baseline` 让 14px 标题和 11px 提示的文字基线对齐,
        否则小字会浮在标题的垂直中线上,看着像没对齐。图标是 flex 子项,单独用
        `translate-y` 微调会跟着字号缩放跑掉,所以放进 baseline 行里靠自身行高对齐。
      */}
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
          <Icon size={16} className="shrink-0" aria-hidden />
          {title}
        </span>
        {hint ? (
          <span className="min-w-0 text-11 leading-5 text-[var(--text-tertiary)]">{hint}</span>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
    </div>
  );
}

export function BotSettingsBlock({
  icon,
  title,
  hint,
  action,
  blockRef,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string | undefined;
  action?: ReactNode;
  blockRef?: Ref<HTMLElement>;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section ref={blockRef} className={cn(BOT_SETTINGS_BLOCK_CLASS, className)}>
      <BotSettingsBlockHeading icon={icon} title={title} hint={hint} action={action} />
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}
