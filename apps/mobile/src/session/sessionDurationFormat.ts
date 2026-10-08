/**
 * 会话页里展示给用户的时长(「已工作 3 分 25 秒」「思考 12 秒」、composer 工作状态计时)。
 *
 * 共享包 `formatDuration`(@cindy/maker-shared)固定输出 `3m 25s` 这种英文紧凑写法,
 * 移动端在这里按当前语言本地化,五语格式各自走 i18n。
 * 取整口径与共享包一致:按秒四舍五入,至少 1 秒;折算小时、天后始终保留分钟(含 0)。
 */
import { i18n } from '@/i18n';

/** 毫秒时长 → 本地化文案(至少 1 秒,与共享包 formatDuration 同取整)。 */
export function formatLocalizedDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return formatLocalizedSeconds(totalSec);
}

/**
 * 整秒时长 → 本地化文案(允许 0 秒,供实时计时从 0 起跳)。
 * alwaysShowSeconds:实时计时用,整分时保留 0 秒;超过一小时后始终保留分钟。
 */
export function formatLocalizedSeconds(
  seconds: number,
  { alwaysShowSeconds = false }: { alwaysShowSeconds?: boolean } = {},
): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (safe >= 86_400) {
    const days = Math.floor(safe / 86_400);
    const hours = Math.floor((safe % 86_400) / 3_600);
    const minutes = Math.floor((safe % 3_600) / 60);
    return i18n.t('message.renderer.durationDaysHoursMinutes', { days, hours, minutes });
  }
  if (safe >= 3_600) {
    const hours = Math.floor(safe / 3_600);
    const minutes = Math.floor((safe % 3_600) / 60);
    return i18n.t('message.renderer.durationHoursMinutes', { hours, minutes });
  }
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  if (minutes === 0) return i18n.t('message.renderer.durationSeconds', { seconds: rest });
  if (rest === 0 && !alwaysShowSeconds) return i18n.t('message.renderer.durationMinutes', { minutes });
  return i18n.t('message.renderer.durationMinutesSeconds', { minutes, seconds: rest });
}
