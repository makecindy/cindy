/**
 * TipsSection — Settings → 个性化 下的 "小技巧" 区。
 * ---------------------------------------------------------------------------
 * 同 MemorySection 的多 cell 共享 container 模式: 标题/描述在外层独立渲染,
 * 内层一个 rounded 灰底 container 装多个 cell, cell 之间用 border-t 分隔。
 *
 * 当前 cell:
 *   1. SilentEncryptedRetryCell — 静默 invalid_encrypted_content 重试
 *   2. ChatEmbeddingCell — 启用聊天记录语义索引 (chat-history-embedder)
 *
 * 新增 cell 直接加在 container 内, divider 由相邻选择器 `[&>*+*]:border-t` 自动
 * 应用, 不需要修改任何 cell 组件。
 */

import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';

import { ChatEmbeddingCell } from './ChatEmbeddingCell';
import { SilentEncryptedRetryCell } from './SilentEncryptedRetryCell';

export function TipsSection() {
  const { t } = useTranslation();
  const { mode } = useAuth();
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
        <SilentEncryptedRetryCell />
        {mode !== 'local' ? <ChatEmbeddingCell /> : null}
      </div>
    </div>
  );
}
