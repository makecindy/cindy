/**
 * ChatEmbeddingCell — TipsSection 内的 "启用聊天记录语义索引" cell row。
 * ---------------------------------------------------------------------------
 * 仅渲染 cell row 本身; 卡片背景 / 标题描述 / cell 之间的 divider 都由
 * TipsSection 容器统一负责 (形态与 CompatModeCell 对齐)。
 *
 * 行为差异 (vs CompatModeCell):
 *   - 不带 "需新会话生效" 后缀: 嵌入开关立即生效 (下一条新消息即可)
 *   - 不带 confirm dialog: 关闭只是停止入队, 已嵌入的向量不删, 用户无可见副作用
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { createLogger } from '@/lib/logger';
import { chatEmbeddingFailureKey } from '@/lib/chatEmbeddingStore';
import { useChatEmbedding } from '@/hooks/useChatEmbedding';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('ChatEmbeddingCell');

export function ChatEmbeddingCell() {
  const { t } = useTranslation();
  const { enabled, isCustomized, setEnabled, setIsCustomized } = useChatEmbedding();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(
    async (next: boolean) => {
      // 乐观更新: toggle 视觉立即跟手, IPC 内部就是写一个 JSON 文件, 几乎不会失败
      const prev = enabled;
      setEnabled(next);
      setPending(true);
      try {
        const settings = await window.electronAPI.maker.chatEmbeddingSet(next);
        setEnabled(settings.enabled);
        setIsCustomized(settings.isCustomized);
        toast.success(
          t(next ? 'settings.chatEmbedding.toast.enabled' : 'settings.chatEmbedding.toast.disabled'),
        );
      } catch (err) {
        log.warn('chatEmbeddingSet failed', err);
        toast.error(t(chatEmbeddingFailureKey(err)));
        setEnabled(prev); // 回滚乐观值
      } finally {
        setPending(false);
      }
    },
    [enabled, setEnabled, setIsCustomized, t],
  );

  const handleReset = useCallback(async () => {
    setPending(true);
    try {
      const next = await window.electronAPI.maker.chatEmbeddingReset();
      setEnabled(next.enabled);
      setIsCustomized(next.isCustomized);
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('chatEmbeddingReset failed', err);
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setPending(false);
    }
  }, [setEnabled, setIsCustomized, t]);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <Database size={18} className="text-[var(--settings-section-title)]" />
        </div>
        <div className="flex flex-col gap-[8px]">
          <p className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
            {t('settings.chatEmbedding.cell.label')}
          </p>
          <p className="text-12 leading-none text-[var(--settings-section-desc)]">
            {t('settings.chatEmbedding.cell.description')}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <DefaultOverrideControls
          isCustomized={isCustomized}
          disabled={pending}
          onReset={() => void handleReset()}
        />
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={(v) => void handleToggle(v)}
          aria-label={t('settings.chatEmbedding.toggleAria')}
        />
      </div>
    </div>
  );
}
