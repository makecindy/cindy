import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { botGrowthNoteLabel, type BotGrowthNote as BotGrowthNoteData } from './botGrowth';
import { buildBotGrowthSettingsPath } from './botSettingsNav';

/**
 * 成长尾注 —— 伙伴刚才顺手往自己的记忆里记了一笔,在那句话末尾留一条极淡的注脚。
 *
 * 定稿口径(伙伴原型「成长时刻」):**淡淡的、有趣的**,不是系统通知。所以它是
 * 一条极淡分隔线 + ✦ + 一句话,颜色停在三级文字色,hover 才提到二级;不弹窗、
 * 不占独立卡片、不打断对话节奏。点它跳设置页并高亮对应列表 —— 「TA 学的东西
 * 在哪」这个问题只需要点一下就能回答。
 *
 * 字号:定稿标注 11.5px,DESIGN.md §3 的字号白名单里没有 11.5,取最近的 11
 * (`text-11`)。这是规范优先于原型像素值的有意取舍。
 */
export function BotGrowthNote({ botId, note }: { botId: string; note: BotGrowthNoteData }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = botGrowthNoteLabel(note);
  const text = t(label.key, label.params);

  return (
    <button
      type="button"
      title={t('bots.growth.hint')}
      onClick={() => navigate(buildBotGrowthSettingsPath(botId, note.target))}
      className="mt-2.5 flex w-full items-start gap-1.5 border-t border-[var(--border-default)] pt-2 text-left text-11 leading-5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
    >
      <Sparkles size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{text}</span>
    </button>
  );
}
