/**
 * 个人飞书机器人设置页「回复格式」。
 * ---------------------------------------------------------------------------
 * 回答形态存在渠道设置里(channels.feishu.replyFormat), 传输层每轮现读:
 *   - card(默认): 流式卡片, 带折叠的过程记录(现状);
 *   - text: 纯文本, 整段一次性发送, 不建卡片、不出现过程记录; 授权 / 命令等
 *     交互卡片不受影响。
 * 切换即写设置, 下一轮生效, 不需要重连或重装 bot。
 *
 * 与「新会话配置」分开: 那里管新会话的 Agent / 模型 / 权限档, 这里管回答长什么样,
 * 对所有飞书会话立即生效。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsBlock, SettingsRow } from '@/components/ui/settings-rows';
import { toast } from '@/lib/toast';
import type { ImReplyFormat } from '../../../shared/imDefaultSettings';
import { imBotSettings } from './ImBotSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

export function FeishuReplyFormatSection() {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ImReplyFormat | null>(null);
  const [pending, setPending] = useState(false);
  const requestVersion = useRef(0);
  // 文案函数只用于报错; 放进 effect 依赖会让每次渲染(语言包热更新等)都重读设置,
  // 把用户刚点的选择覆盖回去。
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let cancelled = false;
    const version = ++requestVersion.current;
    setPending(false);
    void window.electronAPI.maker
      .imDefaultSettingsGet('feishu')
      .then((state) => {
        if (!cancelled && version === requestVersion.current) setFormat(state.replyFormat);
      })
      .catch((err) => {
        if (cancelled || version !== requestVersion.current) return;
        toast.error(
          err instanceof Error ? err.message : tRef.current('settings.imBot.defaults.loadFailed'),
        );
      });
    return () => {
      cancelled = true;
      if (version === requestVersion.current) requestVersion.current++;
    };
  }, []);

  const change = useCallback(
    async (next: ImReplyFormat) => {
      if (pending || format === null || format === next) return;
      const previous = format;
      const version = ++requestVersion.current;
      setPending(true);
      setFormat(next);
      try {
        const state = await window.electronAPI.maker.imDefaultSettingsSet(
          { replyFormat: next },
          'feishu',
        );
        if (version === requestVersion.current) setFormat(state.replyFormat);
      } catch (err) {
        if (version !== requestVersion.current) return;
        setFormat(previous);
        toast.error(err instanceof Error ? err.message : t('settings.imBot.defaults.saveFailed'));
      } finally {
        if (version === requestVersion.current) setPending(false);
      }
    },
    [format, pending, t],
  );

  return (
    <FeishuReplyFormatSectionView
      value={format}
      pending={pending}
      onChange={(next) => void change(next)}
    />
  );
}

/** 纯展示: 设置值、写入结果都由调用方给(云页面 / 单测同用)。 */
export function FeishuReplyFormatSectionView({
  value,
  pending,
  onChange,
  disabled = false,
}: {
  value: ImReplyFormat | null;
  pending: boolean;
  onChange(format: ImReplyFormat): void;
  disabled?: boolean;
}) {
  const setting = useSettingDefinition(imBotSettings.feishuReplyFormat);
  return (
    // 与同一张卡片里的其它设置行同一套排版(名称 + 说明在左, 控件在右)。
    <SettingsBlock {...setting.anchorProps} className="p-0">
      <SettingsRow
        title={setting.title}
        hint={setting.description}
        trailing={
          <SegmentedControl<ImReplyFormat>
            {...setting.controlProps}
            aria-label={setting.title}
            value={value}
            disabled={pending || disabled || value === null}
            onValueChange={onChange}
            options={setting.options.map((option) => ({
              value: option.value as ImReplyFormat,
              label: option.label,
            }))}
          />
        }
      />
    </SettingsBlock>
  );
}
