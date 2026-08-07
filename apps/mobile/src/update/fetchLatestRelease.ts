// 拉 mobile-update-server 的 `/latest`(整包版本记录)。薄 IO 封装,判定逻辑在 bundleUpdate.ts。
import { i18n } from '@/i18n';
import { OTA_SERVER_BASE_URL } from '@/config/env';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 取最新整包版本记录。返回原始 JSON(交给 parseLatestRelease 校验)。
 * - 非自建变体 / 服务端 404(暂无记录)→ 返回 `null`(= 服务端确认无更新);
 * - 网络失败 / 超时 / 5xx 等服务异常 → **抛错**(连不上,调用方需区分于"无更新",
 *   否则手动检查会误报"已是最新")。
 * baseUrl 可注入,便于单测。
 *
 * **一律绕开缓存**(cache-buster + no-cache 头,与发布链侧读同一指针的 fetchJsonPointer
 * 同口径):`/latest` 背后是可变指针,`minVersion` 还会被原地改(set-mobile-min-version
 * 读改写同一个 key),边缘旧副本会造成两个方向的错判 —— 旧记录还带门槛时把用户**误挡**在
 * 强更闸门外,旧记录没门槛时又把该挡的用户**放行**。两者都不可接受,所以四条调用路径
 * (启动 / resume / 设置页 / 阻断屏核对)统一不吃缓存,代价只是每次多一个小 JSON 请求。
 * @param platform 目标平台(默认 ios)
 */
export async function fetchLatestRelease(
  platform = 'ios',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = OTA_SERVER_BASE_URL,
  isCanary = false,
): Promise<unknown | null> {
  if (!baseUrl) return null; // 非自建变体,无自托管服务
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const channelQuery = isCanary ? '&channel=canary' : '';
    const res = await fetch(`${baseUrl}/latest?platform=${encodeURIComponent(platform)}${channelQuery}&t=${Date.now()}`, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
    if (res.status === 404) return null; // 服务端确认暂无记录 = 无更新
    if (!res.ok) throw new Error(i18n.t('update.latestRequestFailed', { status: res.status })); // 5xx 等服务异常,不能当成"无更新"
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
