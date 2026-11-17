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
import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { createLogger } from '@/lib/logger';
import { chatEmbeddingFailureKey, refreshChatEmbeddingFromMain } from '@/lib/chatEmbeddingStore';
import { useChatEmbedding } from '@/hooks/useChatEmbedding';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('ChatEmbeddingCell');

export function ChatEmbeddingCell() {
  const setting = useSettingDefinition(additionalSettings.chatEmbedding);
  const { t } = useTranslation();
  const { enabled, isCustomized, beginMutation, completeMutation, rollbackMutation } =
    useChatEmbedding();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const token = beginMutation(next);
      setPending(true);
      try {
        const settings = await window.electronAPI.maker.chatEmbeddingSet(next, {
          dataOwnerId: token.dataOwnerId,
          ownerGeneration: token.ownerGeneration,
        });
        if (completeMutation(token, settings)) {
          toast.success(
            t(
              next
                ? 'settings.chatEmbedding.toast.enabled'
                : 'settings.chatEmbedding.toast.disabled',
            ),
          );
        }
      } catch (err) {
        log.warn('chatEmbeddingSet failed', err);
        if (rollbackMutation(token)) {
          toast.error(t(chatEmbeddingFailureKey(err)));
          void refreshChatEmbeddingFromMain();
        }
      } finally {
        setPending(false);
      }
    },
    [beginMutation, completeMutation, rollbackMutation, t],
  );

  const handleReset = useCallback(async () => {
    const token = beginMutation();
    setPending(true);
    try {
      const next = await window.electronAPI.maker.chatEmbeddingReset({
        dataOwnerId: token.dataOwnerId,
        ownerGeneration: token.ownerGeneration,
      });
      if (completeMutation(token, next)) toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('chatEmbeddingReset failed', err);
      if (rollbackMutation(token)) {
        toast.error(t('settings.defaults.restoreFailed'));
        void refreshChatEmbeddingFromMain();
      }
    } finally {
      setPending(false);
    }
  }, [beginMutation, completeMutation, rollbackMutation, t]);

  return (
    <SettingsRow
      {...setting.anchorProps}
      lead={
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <Database size={18} className="text-[var(--settings-section-title)]" />
        </span>
      }
      title={setting.title}
      hint={setting.description}
      trailing={
        <div className="flex items-center gap-2">
          <DefaultOverrideControls
            isCustomized={isCustomized}
            disabled={pending}
            onReset={() => void handleReset()}
          />
          <Switch
            {...setting.controlProps}
            checked={enabled}
            disabled={pending}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label={t('settings.chatEmbedding.toggleAria')}
          />
        </div>
      }
    />
  );
}
