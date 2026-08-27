/**
 * TipsSection — Settings → 个性化 下的 "小技巧" 区。
 * ---------------------------------------------------------------------------
 * 同 MemorySection 的多 cell 共享 container 模式: 标题/描述在外层独立渲染,
 * 内层一个 rounded 灰底 container 装多个 cell, cell 之间用 border-t 分隔。
 *
 * 当前 cell:
 *   1. SilentEncryptedRetryCell — 静默 invalid_encrypted_content 重试
 *   2. SessionRuntimeFallbackCell — 任务运行时自动模型 fallback
 *   3. ChatEmbeddingCell — 启用聊天记录语义索引 (chat-history-embedder)
 *   4. MessageNavRailCell — 显示提问导航条 (默认关闭)
 *
 * 新增 cell 直接加在 container 内, divider 由相邻选择器 `[&>*+*]:border-t` 自动
 * 应用, 不需要修改任何 cell 组件。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Switch } from '@/components/ui/switch';
import { usePromptRecommendationPreference } from '@/hooks/usePromptRecommendationPreference';

import { ChatEmbeddingCell } from './ChatEmbeddingCell';
import { MessageNavRailCell } from './MessageNavRailCell';
import { SessionRuntimeFallbackCell } from './SessionRuntimeFallbackCell';
import { SilentEncryptedRetryCell } from './SilentEncryptedRetryCell';

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
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.compatMode.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.compatMode.description')}
        </p>
      </div>

      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
          // cell 之间统一 1px divider —— 跟 MemorySection 同款; 每个 cell 自身
          // 不感知是否第一个, 加新 cell 时直接附加即可。
          '[&>*+*]:border-t [&>*+*]:border-[var(--settings-theme-card-border)]',
        )}
      >
        {/* 输入框推荐提示词:turn 结束后自动预测用户下一步输入 */}
        <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <Sparkles size={18} className="text-[var(--settings-section-title)]" />
            </div>
            <div className="flex flex-col gap-[8px]">
              <p className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
                {t('settings.promptRecommendation.label')}
              </p>
              <p className="text-12 leading-[1.4] text-[var(--settings-section-desc)]">
                {t('settings.promptRecommendation.description')}
              </p>
            </div>
          </div>
          <Switch
            checked={recommendationEnabled}
            onCheckedChange={handleRecommendationToggle}
            aria-label={t('settings.promptRecommendation.toggleAria')}
          />
        </div>
        <SilentEncryptedRetryCell />
        <SessionRuntimeFallbackCell />
        {mode !== 'local' ? <ChatEmbeddingCell /> : null}
        <MessageNavRailCell />
      </div>
    </div>
  );
}
