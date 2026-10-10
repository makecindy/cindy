import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * BotAiBadge — 伙伴互动界面的持续 AI 身份标识。
 *
 * 合规背景:《人工智能生成合成内容标识办法》与拟人化互动服务监管精神要求
 * 在互动界面「持续、稳定、可见」地公示 AI 属性,且不随滚动、皮肤切换或
 * 任务状态更新消失。本组件是一个纯展示的稳定身份层:
 * - 放在每个伙伴对话的内容头(固定栏),不随消息滚动;
 * - 与「任务状态 / 底层引擎」等可变信息分层,状态更新不会覆盖它;
 * - 可见图标仅作辅助,身份由可见文案承载(不依赖颜色或图标);
 * - 同时提供 title 与 aria-label,保证读屏与悬停提示一致。
 */
export function BotAiBadge() {
  const { t } = useTranslation();
  const label = t('bots.aiBadge.label');
  const ariaLabel = t('bots.aiBadge.ariaLabel');
  return (
    <span
      data-testid="bot-ai-badge"
      title={ariaLabel}
      aria-label={ariaLabel}
      className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-1.5 text-10 font-medium leading-none text-[var(--text-tertiary)]"
    >
      <Bot size={11} aria-hidden />
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}
