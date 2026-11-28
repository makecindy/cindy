import { useTranslation } from 'react-i18next';

/**
 * SkillStateBadge — 技能启用状态，跟在卡片名称行末尾的来源文字旁。
 *
 * 技能列表卡片原本只显示来源（官方 / SkillHub / 本地），停用的技能和启用中的技能外形
 * 完全一致，必须逐个进入详情才知道它当前会不会被新任务加载。这里补一个列表上就能读到
 * 的状态文字。
 *
 * 它与同一行的来源文字同尺寸、同色、同一基线，用「·」与来源分隔，读起来是一句
 * 「已启用 · 本地」而不是额外的徽标；状态靠文字区分，不靠底色或颜色。
 */
export function SkillStateBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="shrink-0" title={t(enabled ? 'skillhub.home.stateEnabledHint' : 'skillhub.home.stateDisabledHint')}>
        {t(enabled ? 'skillhub.home.stateEnabled' : 'skillhub.home.stateDisabled')}
      </span>
      <span aria-hidden="true" className="shrink-0">
        ·
      </span>
    </>
  );
}
