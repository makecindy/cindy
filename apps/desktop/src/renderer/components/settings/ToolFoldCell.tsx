/**
 * ToolFoldCell — Settings → 实验性功能区块下的「工具载荷折叠」一行。
 *
 * 开关决定**之后启动的 Pi Agent 会话**是否加载内置的 cindy-tool-fold 扩展:
 *   - 关闭(默认): 不写扩展、不 --extension,行为与没有该扩展时完全一致。
 *   - 开启: maker-core 把扩展写进会话 internal-extensions,较老的「工具调用 + 结果」
 *     在送给模型前折成一行,超大的输出入库前先截断,两者都能用 toolfold_read 取回原文。
 *
 * 与 LSP Beta 同一口径: pi 进程启动时一次性决定是否加载 —— 新会话和重新打开的
 * 历史会话都算「启动」,已在运行的会话不变,toggle 后 toast 明示。
 *
 * 没有独立 store/hook: main 是唯一真源(设置文件),这里直接 IPC + 本地镜像
 * (lib/toolFoldStore.ts),照搬 LspBetaCell 的形态。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { SettingsRow } from '@/components/ui/settings-rows';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { useToolFold } from '@/hooks/useToolFold';
import { toolFoldSettings } from './ToolFoldCell.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

const log = createLogger('ToolFoldCell');

export function ToolFoldCell() {
  const setting = useSettingDefinition(toolFoldSettings.enable);
  const { t } = useTranslation();
  const { enabled, setEnabled } = useToolFold();
  const [pending, setPending] = useState(false);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const prev = enabled;
      setEnabled(next);
      setPending(true);
      try {
        await window.electronAPI.maker.toolFoldSet(next);
        toast.success(
          next
            ? t('settings.toolFold.toast.enabled')
            : t('settings.toolFold.toast.disabled'),
        );
      } catch (err) {
        log.warn('toolFoldSet failed', err);
        toast.error(
          err instanceof Error
            ? err.message
            : t('settings.toolFold.toast.toggleFailed'),
        );
        setEnabled(prev);
      } finally {
        setPending(false);
      }
    },
    [enabled, setEnabled, t],
  );

  return (
    <SettingsRow
      {...setting.anchorProps}
      title={setting.title}
      hint={setting.description}
      trailing={
        <Switch
          {...setting.controlProps}
          checked={enabled}
          disabled={pending}
          onCheckedChange={(v) => void handleToggle(v)}
          aria-label={t('settings.toolFold.toggleAria')}
        />
      }
    />
  );
}
