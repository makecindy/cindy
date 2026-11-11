import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { tipsSettings } from './TipsSection.settings-search';
/**
 * TipsSection — Settings → 个性化 下的 "小技巧" 区。
 * ---------------------------------------------------------------------------
 * 版式用 settings-rows 的分区/卡片/行: 标题/描述由 SettingsSection 渲染,
 * 一张 SettingsCard 装多个 cell, 行间分割线由 SettingsRow / SettingsBlock 画。
 *
 * 当前 cell:
 *   1. SilentEncryptedRetryCell — 静默 invalid_encrypted_content 重试
 *   2. ChatEmbeddingCell — 启用聊天记录语义索引 (chat-history-embedder)
 *   3. MessageNavRailCell — 显示提问导航条 (默认关闭)
 *
 * 新增 cell 用 SettingsRow, 或包一层 SettingsBlock 取得分割线。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { usePromptRecommendationPreference } from '@/hooks/usePromptRecommendationPreference';

import { ChatEmbeddingCell } from './ChatEmbeddingCell';
import { MessageNavRailCell } from './MessageNavRailCell';
import { SilentEncryptedRetryCell } from './SilentEncryptedRetryCell';
import { additionalSettings } from './AdditionalSettings.settings-search';

export function TipsSection() {
  const { t } = useTranslation();
  const { mode } = useAuth();
  const { enabled: recommendationEnabled, setEnabled: setRecommendationEnabled } =
    usePromptRecommendationPreference();

  const handleRecommendationToggle = useCallback(
    (next: boolean) => {
      setRecommendationEnabled(next);
    },
    [setRecommendationEnabled],
  );

  return (
    <SettingsSection
      title={t(personalizationDetailsSettings.compatModeTitle.titleKey)}
      description={t('settings.compatMode.description')}
    >
      <SettingsCard>
        {/* 输入框推荐提示词:turn 结束后自动预测用户下一步输入 */}
        <SettingsRow
          lead={
            <span
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <Sparkles size={18} className="text-[var(--settings-section-title)]" />
            </span>
          }
          title={<span id={tipsSettings.promptRecommendationLabel.targetId}>{t(tipsSettings.promptRecommendationLabel.titleKey)}</span>}
          hint={t(tipsSettings.promptRecommendationLabel.descriptionKey)}
          trailing={
            <Switch data-setting-id={tipsSettings.promptRecommendationLabel.id}
              checked={recommendationEnabled}
              onCheckedChange={handleRecommendationToggle}
              aria-label={t('settings.promptRecommendation.toggleAria')}
            />
          }
        />
        <SilentEncryptedRetryCell />
        {additionalSettings.chatEmbedding.isVisible({ mode }) ? <ChatEmbeddingCell /> : null}
        <MessageNavRailCell />
      </SettingsCard>
    </SettingsSection>
  );
}
