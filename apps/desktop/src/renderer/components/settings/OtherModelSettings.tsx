/**
 * 「模型供应商 → 智能路由」页里的 Subagent 模型与辅助模型两块设置。它们原来在「个性化」里(2026-11-25 用户反馈：
 * 从智能路由页只能跳过去)，现在放在这一页，模型相关的设置在同一处改。
 * 外层的 id 是设置搜索与别处「去设置」链接落到的位置，沿用原来的，旧链接仍然有效。
 * 单独一个文件：路由页画出来以后才取这两块(它们带着各自的选模型面板与测试逻辑)。
 */
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';

import { AuxiliaryModelSection } from './AuxiliaryModelSection';
import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { personalizationSettings } from './PersonalizationSettings.settings-search';
import { SubagentModelSection } from './SubagentModelSection';

export function OtherModelSettings() {
  const { t } = useTranslation();
  const { mode, dataOwnerId } = useAuth();
  return (
    <>
      <section id={personalizationSettings.subagents.targetId} aria-label={t(personalizationSettings.subagents.titleKey)}>
        <SubagentModelSection key={`subagent-models:${mode}:${dataOwnerId ?? 'none'}`} />
      </section>
      <section id={personalizationDetailsSettings.auxiliaryModelsTitle.targetId} aria-label={t(personalizationSettings.auxiliaryModels.titleKey)}>
        <AuxiliaryModelSection key={`auxiliary-models:${mode}:${dataOwnerId ?? 'none'}`} />
      </section>
    </>
  );
}
