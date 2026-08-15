/**
 * StreamFadeSection — Settings → 个性化 下的「流式动效」开关。
 *
 * 控制流式输出时正文的淡入浮现动效(逐词淡入 + 列表圆点同帧浮现,见
 * rehypeStreamWordFade):开(默认)= 新内容淡入;关 = 文字直接显示。
 * 系统 reduced-motion 开启时动效无条件关闭,本开关不覆盖该行为。
 *
 * 存储走 useStreamFadePreference(localStorage 只存 override,切回默认即
 * 清除,规则 20)。切换即时生效,正在流式的消息也立刻应用。
 * 卡片样式与 ChipMetricsSection 对齐(rounded 12 / Card bg / 1px Board)。
 */

import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useStreamFadePreference } from '@/hooks/useStreamFadePreference';

export function StreamFadeSection() {
  const { t } = useTranslation();
  const { preference, setPreference } = useStreamFadePreference();
  const enabled = preference === 'on';

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.streamFade.title')}
      </h2>

      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl px-5 py-4',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.streamFade.label')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.streamFade.hint')}
          </p>
        </div>

        <Switch
          checked={enabled}
          onCheckedChange={(next) => setPreference(next ? 'on' : 'off')}
          aria-label={t('settings.streamFade.toggleAria')}
        />
      </div>
    </div>
  );
}
