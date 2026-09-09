// 拉 mobile-update-server 的 `/latest`(整包版本记录)。薄 IO 封装,判定逻辑在 bundleUpdate.ts。
import { i18n } from '@/i18n';
import { OTA_SERVER_BASE_URL } from '@/config/env';
import type { UpdateChannel } from '@cindy/maker-shared/update-channel';

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
 * @param channel 发布通道(默认 release;canary/beta 分别追加 &channel=canary/beta)
 */
export async function fetchLatestRelease(
  platform = 'ios',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = OTA_SERVER_BASE_URL,
  channel: UpdateChannel = 'release',
): Promise<unknown | null> {
  if (!baseUrl) return null; // 非自建变体,无自托管服务
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const channelQuery = channel === 'release' ? '' : `&channel=${channel}`;
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

/**
 * 探测 beta 渠道是否可达(整包 `/latest?channel=beta`)。
 * 打开 beta 开关前的预检,与桌面端 probeBetaManifest 对称。
 *
 * 判定口径(**只有 200 有记录才算可达**):
 * - 200 返回记录 → 可达;
 * - 404 → 不可达。fetchLatestRelease 对 404 返回 null;这里刻意把「无 beta 记录」
 *   也判为不可达——「服务端未部署 beta 路由」与「已部署但尚未发第一个 beta 版本」
 *   在 404 上不可区分,但两者都意味着「现在没有 beta 可测」,拒绝开启是一致的
 *   (与桌面端「文件不存在 = 404 = 不可开」对齐;用户诉求就是「取不到就提示无法开」)。
 * - 5xx / 网络 / 超时 → 不可达。
 *
 * 已知限制(如实说明,非密闭):`channel=beta` 是 query 参数,若服务端**忽略**该参数
 * 而返回 release 记录(200),本探测会误判为「已部署」——客户端无法区分「认识 beta」
 * 与「忽略 beta 返回 release」。这点做不到桌面端 `-beta.json` 那种泾渭分明的精度,
 * 但至少拦住「baseUrl 不可达」「channel=beta 返回 5xx」「无 beta 记录(404)」三类。
 * 是否部署 beta 分支仍以服务端为准。
 */
export async function probeBetaChannel(
  platform = 'ios',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = OTA_SERVER_BASE_URL,
): Promise<boolean> {
  if (!baseUrl) return false; // 非自建变体:无自托管服务,beta 不可用
  try {
    const record = await fetchLatestRelease(platform, timeoutMs, baseUrl, 'beta');
    return record !== null; // 200 有记录 = 可达;404(null) = 不可达
  } catch {
    return false;
  }
}
