/**
 * 上报目标（SLS project + logstore + 服务区域接入域名）—— **构建期注入，运行期只读**。
 *
 * 值的来源：`config/log-upload.json`（真值不进仓，唯一事实源在 cindy-build-scripts 仓根）
 * → `scripts/shared/log-upload-build-env.mjs` 校验并挑出**当前构建区域那一个**目标
 * → `apps/desktop/scripts/package-desktop.mjs` 塞进 forge env
 * → `apps/desktop/vite.main.config.ts` 的 `define` 烘焙成 `process.env.XDT_LOG_UPLOAD_TARGET`
 * → 本模块解析。
 *
 * 为什么是构建期而不是运行期配置（需求 §4.4，两条独立理由，与改成注入前一致）：
 *  1. 端点清单的离线缓存有「端点主机必须落在写死的受信任域内」这道约束
 *     （`endpointManifestCache.ts` 的 `REGION_ENDPOINT_DOMAIN`）。第三方日志服务域名不在
 *     其内，加进清单会让**整份**缓存被判不可信，连带影响离线启动出口。
 *  2. 免签写入的上报地址一旦可被远程改写，等于允许把用户日志改投他人的 logstore。
 *     信任锚点不能远程改——构建期烘焙保留了这条性质，远程配置不行。
 *
 * 只烘焙一个区域的目标：cn 包里物理上不含 global 的 logstore 地址，反之亦然。这比"包里带
 * 两份、运行时按 region 选"更强——后者只要选错一次就写到另一区去了（埋点有过这个事故）。
 *
 * fail-closed：解析不出合法目标（未注入 / 空串 / JSON 坏 / 字段缺失 / 区域不匹配）一律返回
 * null ⇒ 功能整体静默关闭，不报错、不降级到别的目标、不产生任何字节。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import type { LogUploadTarget } from './types';

/**
 * 注入的目标形状。比 `LogUploadTarget` 多一个 `region`，用于与本构建的区域身份交叉校验。
 */
interface InjectedTarget extends LogUploadTarget {
  region: CindyRegion;
}

/**
 * 构建期注入点。
 *
 * `vite.main.config.ts` 的 `define` 会把这个表达式**文本替换**成字面量，所以必须写成完整的
 * `process.env.XDT_LOG_UPLOAD_TARGET`，不能解构、不能改成变量间接读取——那样 define 匹配不到，
 * 打出来的包会在运行时去读一个不存在的环境变量，功能静默关闭。
 *
 * 单测里它是普通的 `process.env` 读取（vitest 不做这层 define），因此测试可以直接赋值。
 */
function injectedRaw(): string {
  return process.env.XDT_LOG_UPLOAD_TARGET ?? '';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * SLS 接入域名的形状：`<区域代号>.log.aliyuncs.com`。与构建脚本 `slsEndpointHost()` 的产物
 * 逐字对应，区域代号同 `SLS_REGION_RE`（`/^[a-z0-9][a-z0-9-]*$/`）。
 *
 * 运行期用它把 endpointHost 钉死在 SLS 域内：注入是文本替换，若有 dev `.env` 或异常打包链路
 * 绕过 `loadLogUploadTargets` 塞进一个任意域名（如 `evil.com`），`buildTrackUrl` 会把用户日志
 * 免签 POST 到 `https://<project>.<那个域>/` —— 直接改投他人域（2026-08-04 review P1）。这个形状
 * 也顺带挡掉带协议 / 带路径 / 带 project 前缀（多一个 label）的畸形值。
 */
const SLS_ENDPOINT_HOST_RE = /^[a-z0-9][a-z0-9-]*\.log\.aliyuncs\.com$/;

/**
 * SLS project / logstore 命名：小写字母数字与连字符，首字符不能是连字符。与构建脚本
 * `SLS_NAME_RE` 逐字对应。
 *
 * 同 endpointHost，这也是运行期第二道：`buildTrackUrl` 把 project 拼成
 * `https://<project>.<endpointHost>/logstores/<logstore>/track` 的**子域**位置——project 若含
 * `.` 或 `/`（如 `evil.com/p`），host 就被顶成 `evil.com`，endpointHost 校验通过也照样把日志
 * 改投他人域（2026-08-06 review）。logstore 含 `/` 则能改写请求路径。名字集限死后，注入串任一
 * 字段被写坏 / 被绕过塞进畸形值,都在这里判成"未配置"而不是照用。
 */
const SLS_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 解析注入串。任何不合法形态都返回 null（不抛）——调用点在启动路径上，
 * 一个配置问题不该让 App 起不来。
 */
export function parseInjectedTarget(raw: string): InjectedTarget | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (
    !isNonEmptyString(r.region) ||
    !isNonEmptyString(r.project) ||
    !isNonEmptyString(r.logstore) ||
    !isNonEmptyString(r.endpointHost)
  ) {
    return null;
  }
  // endpointHost 必须是 SLS 接入域名形状(见 SLS_ENDPOINT_HOST_RE)。构建脚本已按 slsRegion
  // 拼过一遍,这里是运行期第二道 —— 注入是文本替换,链路任何一环出错(或被绕过塞进任意域名)
  // 都该在这里判成"未配置"而不是照用,免得把用户日志改投他人域。
  const endpointHost = r.endpointHost.trim();
  if (!SLS_ENDPOINT_HOST_RE.test(endpointHost)) return null;
  // project / logstore 同样钉死在 SLS 名字集内(见 SLS_NAME_RE):否则 project 里的 `.`/`/`
  // 能把 buildTrackUrl 的 host 顶成任意域、把日志改投出去,单靠 endpointHost 校验挡不住。
  const project = r.project.trim();
  const logstore = r.logstore.trim();
  if (!SLS_NAME_RE.test(project) || !SLS_NAME_RE.test(logstore)) return null;

  return {
    region: r.region.trim() as CindyRegion,
    project,
    logstore,
    endpointHost,
  };
}

export interface ResolveTargetOptions {
  /** 本构建的区域身份（`CURRENT_CINDY_REGION`）。 */
  region: CindyRegion;
  /** 仅供测试注入；生产读构建期烘焙的注入串。 */
  raw?: string;
}

/**
 * 解析本构建的上报目标；未配置或与本构建区域不匹配返回 null（= 功能整体关闭）。
 *
 * 区域交叉校验是这一层的关键：注入串与 `VITE_CINDY_AUTH_REGION` 由同一次打包写入，二者必须
 * 一致。不一致说明注入链路串了（例如打包机 env 残留、或本地 `.env` 里放了另一区的目标），
 * 此时**宁可不上报**也不能往可能错误的 logstore 写——那是合规问题，不只是数据脏。
 */
export function resolveLogUploadTarget(options: ResolveTargetOptions): LogUploadTarget | null {
  const injected = parseInjectedTarget(options.raw ?? injectedRaw());
  if (!injected) return null;
  if (injected.region !== options.region) return null;
  return {
    project: injected.project,
    logstore: injected.logstore,
    endpointHost: injected.endpointHost,
  };
}

/** 目标是否可用（设置页据此判断入口可用性）。 */
export function isTargetConfigured(target: LogUploadTarget | null): target is LogUploadTarget {
  return target !== null;
}

export const __testing = { injectedRaw };
