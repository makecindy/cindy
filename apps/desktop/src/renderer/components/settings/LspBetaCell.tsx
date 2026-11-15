/**
 * LspBetaCell — Settings → 实验功能区块下的 "LSP 代码智能 (Beta)" 卡片。
 *
 * 实验功能卡片里的一行(与 ExperimentalFeatureRow 同样式): Switch + 副标题描述。
 * IPC + localStorage 同步对齐 CompatModeCell。
 *
 * 行为:
 *   - 启用: mcp providers 在新 session 启动时注入 6 个 lsp_* 工具
 *     (仍受 detectTypeScriptProject + workdir 双 gate; 非 TS 项目里开关无效果)
 *   - 关闭(默认): agent 工具列表里完全看不到 lsp_*, 跟没有 LSP 模块时一致
 *   - toggle: window.electronAPI.maker.lspModeSet(next) → main 落 JSON →
 *             setLspModeEnabled(next) 更新本地镜像 → toast 提示需新会话生效
 *
 * 注意: 仅对**新 session** 生效, 已存在 session 的 mcp providers 在 session.start
 * 时已 evaluate, 工具列表已固化, 不会动态变化 — toast 文案明示。
 */

import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { SettingsRow } from '@/components/ui/settings-rows';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { useLspMode } from '@/hooks/useLspMode';

const log = createLogger('LspBetaCell');

export function LspBetaCell() {
  const setting = useSettingDefinition(additionalSettings.lsp);
  const { t } = useTranslation();
  const { enabled, setEnabled } = useLspMode();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const prev = enabled;
      setEnabled(next);
      setPending(true);
      try {
        await window.electronAPI.maker.lspModeSet(next);
        toast.success(
          next
            ? t('settings.lspMode.toast.enabled')
            : t('settings.lspMode.toast.disabled'),
        );
      } catch (err) {
        log.warn('lspModeSet failed', err);
        toast.error(
          err instanceof Error
            ? err.message
            : t('settings.lspMode.toast.toggleFailed'),
        );
        setEnabled(prev);
      } finally {
        setPending(false);
      }
    },
    [enabled, setEnabled, t],
  );

  const title = setting.title;
  const description = setting.description;

  return (
    <SettingsRow
      {...setting.anchorProps}
      title={title}
      hint={description}
      trailing={
        <Switch
          {...setting.controlProps}
          checked={enabled}
          disabled={pending}
          onCheckedChange={(v) => void handleToggle(v)}
          aria-label={t('settings.lspMode.toggleAria')}
        />
      }
    />
  );
}
